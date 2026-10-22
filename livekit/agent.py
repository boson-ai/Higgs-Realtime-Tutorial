"""A Higgs Realtime voice agent for LiveKit Agents.

    caller audio ──► Higgs Realtime ──► caller
                     (hears, thinks, speaks)

The model runs on Boson's servers behind one WebSocket. This worker joins
LiveKit rooms and moves audio between the room and that WebSocket:

    uv run agent.py dev         # join rooms on LIVEKIT_URL; talk to it in the Agents Playground
"""

import os

from dotenv import load_dotenv
from livekit.agents import Agent, AgentServer, AgentSession, JobContext, RunContext, cli, get_job_context
from livekit.agents.llm import function_tool

import server_tools
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


class Willow(Agent):
    def __init__(self) -> None:
        super().__init__(instructions=instructions())

    async def on_enter(self) -> None:
        # The model answers when the caller stops speaking. Speak first instead.
        self.session.generate_reply(instructions="Greet the caller in one short sentence.")

    # Our own tool: LiveKit runs this method here, in this worker, when the model
    # calls it, and sends the result back to the model. The docstring and type
    # hints become the schema the model sees.
    @function_tool
    async def get_current_time(self, context: RunContext, timezone: str | None = None) -> dict:
        """Get the current date and time. Use it whenever the caller asks the time or the date, or what
        today or tomorrow is.

        Args:
            timezone: Optional IANA time zone, for example Europe/Paris. Omit it for the caller's own time zone.
        """
        return tools.current_time(timezone)

    @function_tool
    async def end_call(self, context: RunContext) -> None:
        """Hang up the call. Use it when the caller is done or says goodbye, right after your own
        short goodbye."""
        # Let the goodbye finish playing, then close the room, which disconnects
        # the caller. Returning None asks for no further reply.
        await context.wait_for_playout()
        get_job_context().delete_room()


server = AgentServer()


@server.rtc_session()
async def entrypoint(ctx: JobContext) -> None:
    session = AgentSession(
        llm=server_tools.RealtimeModel(
            url=os.getenv("BOSON_REALTIME_URL", "wss://api.boson.ai/v1/realtime/"),
            api_key=os.environ["BOSON_API_KEY"],
            model=os.getenv("BOSON_REALTIME_MODEL", "higgs-realtime-1.5-preview"),
            voice=os.getenv("BOSON_VOICE", "default"),
            # Web search is a server-side tool: Higgs Realtime runs the search on
            # Boson's servers and speaks the answer; there is no method to write.
            server_tools=[{"type": "web_search"}],
            # Optional: captions of what the caller said, for the playground. The
            # model hears the caller's audio directly and does not need them.
            input_audio_transcription_model=os.getenv("BOSON_CAPTION_MODEL", "higgs-stt-3.1"),
        ),
    )
    await session.start(agent=Willow(), room=ctx.room)


if __name__ == "__main__":
    cli.run_app(server)
