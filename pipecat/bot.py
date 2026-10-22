"""A Higgs Realtime voice agent for Pipecat.

    caller audio ──► Higgs Realtime ──► caller
                     (hears, thinks, speaks)

The model runs on Boson's servers behind one WebSocket; this process only moves
audio between the caller and that WebSocket.

    uv run bot.py                   # Pipecat playground at http://localhost:7860
"""

import asyncio
import os

from dotenv import load_dotenv
from loguru import logger
from pipecat.adapters.schemas.tools_schema import AdapterType, ToolsSchema
from pipecat.frames.frames import EndWorkerFrame, FunctionCallResultProperties, LLMRunFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import LLMContextAggregatorPair
from pipecat.processors.frameworks.rtvi import RTVIProcessor
from pipecat.runner.types import RunnerArguments
from pipecat.runner.utils import create_transport
from pipecat.services.llm_service import FunctionCallParams
from pipecat.transports.base_transport import TransportParams
from pipecat.workers.runner import WorkerRunner
from pipecat_boson.realtime import BosonRealtimeLLMService

import tools

load_dotenv(override=True)

INSTRUCTIONS = """\
You are Willow, a friendly voice assistant developed by Boson AI. Keep every
answer to one or two short spoken sentences. Greet the caller in one sentence when the call
starts. Always speak the language the caller is speaking, including while you look something up."""


def instructions() -> str:
    """The instructions, plus where the caller probably is, read at the start of each call."""
    timezone = tools.local_timezone()
    return (
        f"{INSTRUCTIONS}\n\nThe caller is in the {timezone} time zone, so they are probably "
        "somewhere near there. When they say here without naming a place, assume they mean there."
    )


# Our own tool: Pipecat runs this function here, in this process, when the model
# calls it, and sends the result back to the model. The docstring and type hints
# become the schema the model sees.
async def get_current_time(params: FunctionCallParams, timezone: str | None = None) -> None:
    """Get the current date and time. Use it whenever the caller asks the time or the date, or what
    today or tomorrow is.

    Args:
        timezone: Optional IANA time zone, for example Europe/Paris. Omit it for the caller's own time zone.
    """
    await params.result_callback(tools.current_time(timezone))


async def end_call(params: FunctionCallParams) -> None:
    """Hang up the call. Use it when the caller is done or says goodbye, right after your own
    short goodbye."""
    logger.info("The agent is ending the call")
    # Record the result, but don't ask for another reply: the goodbye has been said.
    await params.result_callback({"ended": True}, properties=FunctionCallResultProperties(run_llm=False))
    # EndWorkerFrame flushes what is queued ahead of it, the goodbye audio
    # included, then ends the pipeline, which closes the caller's connection.
    await params.llm.push_frame(EndWorkerFrame())


# Web search is a server-side tool: declaring {"type": "web_search"} is all it takes.
# Higgs Realtime runs the search on Boson's servers and speaks the answer; there is
# no function to write and nothing to send back.
TOOLS = ToolsSchema(
    standard_tools=[get_current_time, end_call],
    custom_tools={AdapterType.OPENAI: [{"type": "web_search"}]},
)


def make_llm() -> BosonRealtimeLLMService:
    return BosonRealtimeLLMService(
        url=os.getenv("BOSON_REALTIME_URL", "wss://api.boson.ai/v1/realtime/"),
        api_key=os.environ["BOSON_API_KEY"],
        model=os.getenv("BOSON_REALTIME_MODEL", "higgs-realtime-1.5-preview"),
        voice=os.getenv("BOSON_VOICE", "default"),
        instructions=instructions(),
        tools=TOOLS,
        # Optional: captions of what the caller said, for the playground. The model
        # hears the caller's audio directly and does not need them.
        input_audio_transcription_model=os.getenv("BOSON_CAPTION_MODEL", "higgs-stt-3.1"),
    )


async def bot(runner_args: RunnerArguments):
    # The playground connects over WebRTC; the bot needs audio in and out.
    transport = await create_transport(
        runner_args,
        {"webrtc": lambda: TransportParams(audio_in_enabled=True, audio_out_enabled=True)},
    )

    llm = make_llm()
    # realtime_service_mode: the server decides when a turn starts and ends
    # (server VAD), so the aggregators follow its events instead of a local VAD.
    user_turns, bot_turns = LLMContextAggregatorPair(LLMContext(tools=TOOLS), realtime_service_mode=True)

    pipeline = Pipeline(
        [
            transport.input(),  # caller audio in
            user_turns,
            llm,  # Higgs Realtime, on Boson's servers
            transport.output(),  # bot audio out
            bot_turns,
        ]
    )

    # RTVI is the small protocol the playground uses for captions and status.
    rtvi = RTVIProcessor()

    @llm.event_handler("on_conversation_item_created")
    async def on_conversation_item_created(llm, item_id, item):
        # A server-side search shows up as conversation items: the call (with
        # executor "server") and, when the search is done, its result. Log the
        # pages it read; a client could show them as sources.
        if getattr(item, "type", None) == "function_call" and getattr(item, "executor", None) == "server":
            logger.info(f"Searching the web ({item.name})")
        elif getattr(item, "type", None) == "function_call_output":
            urls = tools.source_urls(getattr(item, "output", ""))
            if urls:
                logger.info("Web search sources: " + ", ".join(urls))

    worker = PipelineWorker(
        pipeline,
        params=PipelineParams(enable_metrics=True),
        rtvi_processor=rtvi,
        idle_timeout_secs=runner_args.pipeline_idle_timeout_secs,
    )

    @rtvi.event_handler("on_client_ready")
    async def on_client_ready(rtvi):
        # The server only answers after the caller speaks. To have the bot greet
        # first, ask for one response as soon as the client is listening.
        await asyncio.sleep(0.5)
        await worker.queue_frames([LLMRunFrame()])

    @transport.event_handler("on_client_disconnected")
    async def on_client_disconnected(transport, client):
        logger.info("Caller left; ending the session")
        await worker.cancel()

    runner = WorkerRunner(handle_sigint=runner_args.handle_sigint)
    await runner.add_workers(worker)
    await runner.run()


if __name__ == "__main__":
    from pipecat.runner.run import main

    main()
