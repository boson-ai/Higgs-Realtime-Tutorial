"""Call a running agent.py the way the Agents Playground does, with no browser or microphone.

    uv run probe.py                                   # greeting only
    uv run probe.py --say "what's the capital of France?"

It signs a token with your LiveKit key, joins a fresh room (which dispatches the
agent into it), waits for the greeting, and with --say speaks a sentence
synthesised by Boson's TTS into the room as if it were a microphone. It prints
the agent's state changes and both sides' transcripts with timestamps.
"""

import argparse
import asyncio
import os
import time
import uuid

import aiohttp
import numpy as np
from dotenv import load_dotenv
from livekit import api, rtc

RATE = 24_000
FRAME = RATE // 50  # 20 ms


async def synthesise(text: str) -> bytes:
    """Turn text into 24 kHz 16-bit mono PCM with Boson's TTS."""
    base = os.getenv("BOSON_API_BASE", "https://api.boson.ai/v1")
    async with (
        aiohttp.ClientSession() as http,
        http.post(
            f"{base}/audio/speech",
            headers={"Authorization": f"Bearer {os.environ['BOSON_API_KEY']}"},
            json={"model": "higgs-realtime-tts", "input": text, "voice": "default", "response_format": "pcm"},
        ) as response,
    ):
        response.raise_for_status()
        return await response.read()


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
    speech = await synthesise(say) if say else None

    room = rtc.Room()
    turns = asyncio.Queue()
    tasks: list[asyncio.Task] = []

    @room.on("participant_attributes_changed")
    def on_attributes(changed, participant):
        # LiveKit Agents publish their state as a participant attribute.
        state = changed.get("lk.agent.state")
        if state:
            log("agent", state)
            if state == "listening":
                turns.put_nowait(state)

    async def read_transcript(reader, participant_identity):
        text = await reader.read_all()
        if reader.info.attributes.get("lk.transcription_final") == "true" and text.strip():
            who = "agent said:" if participant_identity != room.local_participant.identity else "you said:"
            log(who, text.strip())

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

    queue = np.zeros(0, dtype=np.int16)

    async def microphone():
        nonlocal queue
        start, sent = time.monotonic(), 0
        while True:
            wait = start + sent / RATE - time.monotonic()
            if wait > 0:
                await asyncio.sleep(wait)
            chunk, queue = queue[:FRAME], queue[FRAME:]
            await source.capture_frame(
                rtc.AudioFrame(np.pad(chunk, (0, FRAME - len(chunk))).tobytes(), RATE, 1, FRAME)
            )
            sent += FRAME

    tasks.append(asyncio.ensure_future(microphone()))
    try:
        # The agent goes back to listening after each reply; the first is the greeting.
        await asyncio.wait_for(turns.get(), timeout)
        if speech:
            await asyncio.sleep(1.0)
            log(f"speaking {len(speech) / 2 / RATE:.1f}s of audio: {say!r}")
            queue = np.frombuffer(speech, dtype=np.int16)
            await asyncio.wait_for(turns.get(), timeout)
        await asyncio.sleep(0.5)  # let the last transcript arrive
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await room.disconnect()
        await source.aclose()


if __name__ == "__main__":
    load_dotenv(override=True)
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--say", help="speak this sentence after the greeting")
    parser.add_argument("--timeout", type=float, default=60)
    args = parser.parse_args()
    asyncio.run(main(args.say, args.timeout))
