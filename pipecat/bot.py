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
from pipecat.frames.frames import LLMRunFrame
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
You are Willow, a friendly voice assistant. Keep every answer to one or two short
spoken sentences. Never use lists, markdown or emoji: everything you write is read
aloud. Greet the caller in one sentence when the call starts. When the caller asks about
anything current or local, use web_search instead of guessing."""


# Tools. The model decides to call one; Pipecat runs the function here, in this
# process, and sends the result back to the model, which then answers out loud.
# The docstring and type hints become the schema the model sees.
async def web_search(params: FunctionCallParams, query: str, topic: str | None = None) -> None:
    """Search the web. Call this whenever the caller asks about anything current or local
    (news, weather, sport results, opening hours) or anything you are not sure of.

    Args:
        query: What the caller is looking for, in their own words.
        topic: Optional filter: news, weather, sports, science or travel.
    """
    logger.info(f"web_search({query!r}, topic={topic!r})")
    await params.result_callback(await tools.web_search(query, topic))


async def get_current_time(params: FunctionCallParams, timezone: str | None = None) -> None:
    """Get the current date and time.

    Args:
        timezone: Optional IANA time zone, for example Europe/Paris. Omit it for the server's time.
    """
    await params.result_callback(tools.current_time(timezone))


TOOLS = [web_search, get_current_time]


def make_llm() -> BosonRealtimeLLMService:
    return BosonRealtimeLLMService(
        url=os.getenv("BOSON_REALTIME_URL", "wss://api.boson.ai/v1/realtime/"),
        api_key=os.environ["BOSON_API_KEY"],
        model=os.getenv("BOSON_REALTIME_MODEL", "higgs-realtime"),
        voice=os.getenv("BOSON_VOICE", "default"),
        instructions=INSTRUCTIONS,
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
    worker = PipelineWorker(
        pipeline,
        # Higgs Realtime takes and returns 24 kHz PCM; Pipecat's default input rate is 16 kHz.
        params=PipelineParams(enable_metrics=True, audio_in_sample_rate=24000, audio_out_sample_rate=24000),
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
