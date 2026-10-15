"""A two-stage Higgs voice agent for LiveKit Agents.

    caller audio ──► higgs-realtime ──► higgs-realtime-tts ──► caller
                     (hears, thinks,     (speaks the reply)
                      writes the reply)

Both stages run on Boson's servers behind one WebSocket. This worker joins
LiveKit rooms and moves audio between the room and that WebSocket:

    uv run agent.py dev         # join rooms on LIVEKIT_URL; talk to it in the Agents Playground
"""

import os

from dotenv import load_dotenv
from livekit.agents import Agent, AgentServer, AgentSession, JobContext, cli
from livekit.plugins import boson

load_dotenv(override=True)

INSTRUCTIONS = """\
You are Willow, a friendly voice assistant. Keep every answer to one or two short
spoken sentences. Never use lists, markdown or emoji: everything you write is read
aloud."""


class Willow(Agent):
    def __init__(self) -> None:
        super().__init__(instructions=INSTRUCTIONS)

    async def on_enter(self) -> None:
        # The model answers when the caller stops speaking. Speak first instead.
        self.session.generate_reply(instructions="Greet the caller in one short sentence.")


server = AgentServer()


@server.rtc_session()
async def entrypoint(ctx: JobContext) -> None:
    session = AgentSession(
        llm=boson.realtime.RealtimeModel(
            url=os.getenv("BOSON_REALTIME_URL", "wss://api.boson.ai/v1/realtime/"),
            api_key=os.environ["BOSON_API_KEY"],
            # Stage 1: hears the caller's audio and writes the reply. Stage 2,
            # the TTS model that speaks it, is the server default:
            # higgs-realtime-tts.
            model=os.getenv("BOSON_REALTIME_MODEL", "higgs-realtime"),
            voice=os.getenv("BOSON_VOICE", "default"),
            # Optional: a separate ASR model that only produces captions of what
            # the caller said. Stage 1 hears the audio itself and does not need it.
            input_audio_transcription_model=os.getenv("BOSON_CAPTION_MODEL", "higgs-stt-3.1"),
        ),
    )
    await session.start(agent=Willow(), room=ctx.room)


if __name__ == "__main__":
    cli.run_app(server)
