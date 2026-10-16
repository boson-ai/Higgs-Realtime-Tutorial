"""Call a running agent.py the way the Agents Playground does, with no browser or microphone.

    uv run probe.py                                   # greeting only
    uv run probe.py --say "what's the capital of France?"

It signs a token with your LiveKit key, joins a fresh room (which dispatches the
agent into it), waits for the greeting, and with --say types a message into the
room's chat, as the playground's chat box does. It prints the agent's state
changes and transcripts with timestamps.
"""

import argparse
import asyncio
import os
import time
import uuid

from dotenv import load_dotenv
from livekit import api, rtc

RATE = 24_000
FRAME = RATE // 50  # 20 ms


def user_token(room: str) -> str:
    """What your backend gives a caller: a short-lived token for one room."""
    return (
        api.AccessToken(os.environ["LIVEKIT_API_KEY"], os.environ["LIVEKIT_API_SECRET"])
        .with_identity(f"probe-{uuid.uuid4().hex[:6]}")
        .with_grants(api.VideoGrants(room_join=True, room=room))
        .to_jwt()
    )


async def main(say: str | None, timeout: float):
    t0 = time.monotonic()
    log = lambda *a: print(f"{time.monotonic() - t0:6.2f}s", *a, flush=True)

    room = rtc.Room()
    turns = asyncio.Queue()
    tasks: list[asyncio.Task] = []

    @room.on("participant_attributes_changed")
    def on_attributes(changed, participant):
        # LiveKit Agents publish their state as a participant attribute.
        state = changed.get("lk.agent.state")
        if state:
            log("agent", state)

    async def read_transcript(reader, participant_identity):
        text = await reader.read_all()
        if reader.info.attributes.get("lk.transcription_final") == "true" and text.strip():
            if participant_identity == room.local_participant.identity:
                log("you said:", text.strip())
            else:
                log("agent said:", text.strip())
                # A turn is over when the agent's whole reply is in. Its "listening"
                # state is not enough: the agent also enters it once while starting up.
                turns.put_nowait(text.strip())

    room.register_text_stream_handler(
        "lk.transcription",
        lambda reader, identity: tasks.append(asyncio.ensure_future(read_transcript(reader, identity))),
    )

    name = f"probe-{uuid.uuid4().hex[:8]}"
    await room.connect(os.environ["LIVEKIT_URL"], user_token(name))
    source = rtc.AudioSource(RATE, 1)
    # Agents only listen to tracks published as a microphone.
    await room.local_participant.publish_track(
        rtc.LocalAudioTrack.create_audio_track("mic", source),
        rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE),
    )
    log(f"joined room {name}; waiting for the agent")

    async def microphone():
        # A silent microphone, sent in real time: the agent listens to a caller's track.
        silence = bytes(FRAME * 2)
        start, sent = time.monotonic(), 0
        while True:
            await asyncio.sleep(max(0, start + sent / RATE - time.monotonic()))
            await source.capture_frame(rtc.AudioFrame(silence, RATE, 1, FRAME))
            sent += FRAME

    tasks.append(asyncio.ensure_future(microphone()))
    try:
        await asyncio.wait_for(turns.get(), timeout)  # the greeting
        if say:
            await asyncio.sleep(1.0)
            log(f"typing: {say!r}")
            await room.local_participant.send_text(say, topic="lk.chat")
            await asyncio.wait_for(turns.get(), timeout)  # the answer
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await room.disconnect()
        await source.aclose()


if __name__ == "__main__":
    load_dotenv(override=True)
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--say", help="type this message after the greeting")
    parser.add_argument("--timeout", type=float, default=60)
    args = parser.parse_args()
    asyncio.run(main(args.say, args.timeout))
