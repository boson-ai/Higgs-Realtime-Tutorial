"""A two-stage Higgs voice agent for Pipecat.

    caller audio ──► higgs-realtime ──► higgs-realtime-tts ──► caller
                     (hears, thinks,     (speaks the reply)
                      writes the reply)

Both stages run on Boson's servers behind one WebSocket; this process only moves
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
from pipecat.transports.base_transport import TransportParams
from pipecat.workers.runner import WorkerRunner
from pipecat_boson.realtime import BosonRealtimeLLMService

load_dotenv(override=True)

INSTRUCTIONS = """\
You are Willow, a friendly voice assistant. Keep every answer to one or two short
spoken sentences. Never use lists, markdown or emoji: everything you write is read
aloud. Greet the caller in one sentence when the call starts."""


def make_llm() -> BosonRealtimeLLMService:
    return BosonRealtimeLLMService(
        url=os.getenv("BOSON_REALTIME_URL", "wss://api.boson.ai/v1/realtime/"),
        api_key=os.environ["BOSON_API_KEY"],
        # Stage 1: hears the caller's audio and writes the reply.
        model=os.getenv("BOSON_REALTIME_MODEL", "higgs-realtime"),
        # Stage 2: speaks the reply, in this voice.
        output_audio_model=os.getenv("BOSON_TTS_MODEL", "higgs-realtime-tts"),
        voice=os.getenv("BOSON_VOICE", "default"),
        instructions=INSTRUCTIONS,
        # Optional: a separate ASR model that only produces captions of what the
        # caller said. Stage 1 hears the audio itself and does not need it.
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
    user_turns, bot_turns = LLMContextAggregatorPair(LLMContext(), realtime_service_mode=True)

    pipeline = Pipeline(
        [
            transport.input(),  # caller audio in
            user_turns,
            llm,  # both stages, on Boson's servers
            transport.output(),  # bot audio out
            bot_turns,
        ]
    )

    # RTVI is the small protocol the playground uses for captions and status.
    rtvi = RTVIProcessor()
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
