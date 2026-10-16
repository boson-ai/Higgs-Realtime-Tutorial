"""A Higgs Realtime voice agent for LiveKit Agents.

    caller audio ──► Higgs Realtime ──► caller
                     (hears, thinks, speaks)

The model runs on Boson's servers behind one WebSocket. This worker joins
LiveKit rooms and moves audio between the room and that WebSocket:

    uv run agent.py dev         # join rooms on LIVEKIT_URL; talk to it in the Agents Playground
"""

import logging
import os

from dotenv import load_dotenv
from livekit.agents import Agent, AgentServer, AgentSession, JobContext, RunContext, cli
from livekit.agents.llm import function_tool
from livekit.plugins import boson

import tools

logger = logging.getLogger("willow")

load_dotenv(override=True)

INSTRUCTIONS = """\
You are Willow, a friendly voice assistant. Keep every answer to one or two short
spoken sentences. Never use lists, markdown or emoji: everything you write is read
aloud. When the caller asks about anything current or local, use web_search instead of
guessing."""


class Willow(Agent):
    def __init__(self) -> None:
        super().__init__(instructions=INSTRUCTIONS)

    async def on_enter(self) -> None:
        # The model answers when the caller stops speaking. Speak first instead.
        self.session.generate_reply(instructions="Greet the caller in one short sentence.")

    # Tools. The model decides to call one; LiveKit runs the method here, in this
    # worker, and sends the result back to the model, which then answers out loud.
    # The docstring and type hints become the schema the model sees.
    @function_tool
    async def web_search(self, context: RunContext, query: str, topic: str | None = None) -> dict:
        """Search the web. Call this whenever the caller asks about anything current or local
        (news, weather, sport results, opening hours) or anything you are not sure of.

        Args:
            query: What the caller is looking for, in their own words.
            topic: Optional filter: news, weather, sports, science or travel.
        """
        logger.info("web_search(%r, topic=%r)", query, topic)
        return await tools.web_search(query, topic)

    @function_tool
    async def get_current_time(self, context: RunContext, timezone: str | None = None) -> dict:
        """Get the current date and time.

        Args:
            timezone: Optional IANA time zone, for example Europe/Paris. Omit it for the server's time.
        """
        return tools.current_time(timezone)


server = AgentServer()


@server.rtc_session()
async def entrypoint(ctx: JobContext) -> None:
    session = AgentSession(
        llm=boson.realtime.RealtimeModel(
            url=os.getenv("BOSON_REALTIME_URL", "wss://api.boson.ai/v1/realtime/"),
            api_key=os.environ["BOSON_API_KEY"],
            model=os.getenv("BOSON_REALTIME_MODEL", "higgs-realtime"),
            voice=os.getenv("BOSON_VOICE", "default"),
            # Optional: captions of what the caller said, for the playground. The
            # model hears the caller's audio directly and does not need them.
            input_audio_transcription_model=os.getenv("BOSON_CAPTION_MODEL", "higgs-stt-3.1"),
        ),
    )
    await session.start(agent=Willow(), room=ctx.room)


if __name__ == "__main__":
    cli.run_app(server)
