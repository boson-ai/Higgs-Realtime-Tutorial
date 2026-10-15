"""Call a running bot.py the way the playground does, with no browser or microphone.

    uv run probe.py                                   # greeting only
    uv run probe.py --say "what's the capital of France?"
    uv run probe.py --transport livekit --say "..."  # against bot.py -t livekit
    uv run probe.py --save reply.wav                  # keep what the bot said

It starts a call through the same endpoint the playground uses (POST /start),
waits for the greeting, and with --say speaks a sentence synthesised by Boson's
TTS into the call as if it were a microphone. Everything the bot sends back over
RTVI is printed with a timestamp.
"""

import argparse
import asyncio
import fractions
import json
import os
import time
import wave

import aiohttp
import numpy as np
from aiortc import MediaStreamTrack, RTCPeerConnection, RTCSessionDescription
from aiortc.mediastreams import MediaStreamError
from av import AudioFrame
from dotenv import load_dotenv
from livekit import rtc

RATE = 24_000
FRAME = RATE // 50  # 20 ms
SHOWN = {
    "bot-ready",
    "user-started-speaking",
    "user-stopped-speaking",
    "user-transcription",
    "bot-started-speaking",
    "bot-stopped-speaking",
}


class Microphone:
    """Silence until it is given speech; hands out 20 ms chunks in real time."""

    def __init__(self):
        self.queue = np.zeros(0, dtype=np.int16)
        self.sent = 0
        self.start = None

    def say(self, pcm: bytes):
        self.queue = np.concatenate([self.queue, np.frombuffer(pcm, dtype=np.int16)])

    async def next_chunk(self) -> np.ndarray:
        if self.start is None:
            self.start = time.monotonic()
        wait = self.start + self.sent / RATE - time.monotonic()
        if wait > 0:
            await asyncio.sleep(wait)
        chunk, self.queue = self.queue[:FRAME], self.queue[FRAME:]
        self.sent += FRAME
        return np.pad(chunk, (0, FRAME - len(chunk)))


class MicrophoneTrack(MediaStreamTrack):
    """The Microphone as an aiortc track, for the WebRTC transport."""

    kind = "audio"

    def __init__(self, mic: Microphone):
        super().__init__()
        self.mic = mic

    async def recv(self):
        pts = self.mic.sent
        frame = AudioFrame.from_ndarray((await self.mic.next_chunk()).reshape(1, -1), format="s16", layout="mono")
        frame.sample_rate, frame.pts, frame.time_base = RATE, pts, fractions.Fraction(1, RATE)
        return frame


class Call:
    """What both transports share: the RTVI messages and the turn count."""

    def __init__(self, turns_wanted: int):
        self.t0 = time.monotonic()
        self.turns_wanted = turns_wanted
        self.turns = 0
        self.greeted = asyncio.Event()
        self.done = asyncio.Event()
        self.failure: str | None = None
        self.bot_text: list[str] = []
        self.received = bytearray()

    def log(self, *args):
        print(f"{time.monotonic() - self.t0:6.2f}s", *args, flush=True)

    # RTVI handshake: the bot greets once the client says it is ready.
    CLIENT_READY = json.dumps(
        {"id": "probe", "label": "rtvi-ai", "type": "client-ready", "data": {"version": "1.0.0"}}
    )

    def on_rtvi(self, raw: str | bytes):
        message = json.loads(raw)
        kind, data = message.get("type"), message.get("data") or {}
        if kind == "bot-llm-text":
            self.bot_text.append(data.get("text", ""))
        elif kind == "bot-stopped-speaking":
            self.log(kind)
            self.log("bot said:", "".join(self.bot_text).strip())
            self.bot_text.clear()
            self.turns += 1
            self.greeted.set()
            if self.turns >= self.turns_wanted:
                self.done.set()
        elif kind == "user-transcription":
            if data.get("final"):
                self.log(kind, data.get("text", ""))
        elif kind == "error":
            self.log("error:", data.get("error"))
            if data.get("fatal"):
                self.failure = data.get("error") or "fatal error"
                self.greeted.set()
                self.done.set()
        elif kind in SHOWN:
            self.log(kind)


async def start(url: str, transport: str) -> dict:
    """POST /start — the same call the playground makes when you press Connect."""
    async with aiohttp.ClientSession() as http, http.post(f"{url}/start", json={"transport": transport}) as response:
        response.raise_for_status()
        return await response.json()


async def connect_webrtc(url: str, call: Call, mic: Microphone):
    pc = RTCPeerConnection()
    pc.addTrack(MicrophoneTrack(mic))
    channel = pc.createDataChannel("rtvi")
    channel.on("open", lambda: channel.send(Call.CLIENT_READY))
    channel.on("message", call.on_rtvi)

    @pc.on("track")
    def on_track(track):
        async def drain():
            try:
                while True:
                    frame = await track.recv()
                    call.received.extend(frame.to_ndarray().astype(np.int16).tobytes())
            except MediaStreamError:
                pass  # the call ended

        asyncio.ensure_future(drain())

    session_id = (await start(url, "webrtc"))["sessionId"]
    await pc.setLocalDescription(await pc.createOffer())
    offer = {"sdp": pc.localDescription.sdp, "type": "offer"}
    async with (
        aiohttp.ClientSession() as http,
        http.post(f"{url}/sessions/{session_id}/api/offer", json=offer) as response,
    ):
        response.raise_for_status()
        answer = await response.json()
    await pc.setRemoteDescription(RTCSessionDescription(answer["sdp"], answer["type"]))
    call.log("WebRTC connected; waiting for the greeting")
    # WebRTC delivers the bot as 48 kHz stereo.
    return pc.close, (2, 48_000)


async def connect_livekit(url: str, call: Call, mic: Microphone):
    session = await start(url, "livekit")  # {url, token}: a room and a user token
    room = rtc.Room()
    room.on("data_received", lambda packet: call.on_rtvi(packet.data))
    streams: list[rtc.AudioStream] = []
    tasks: list[asyncio.Task] = []
    bot_publishing = asyncio.Event()

    @room.on("track_subscribed")
    def on_track(track, publication, participant):
        stream = rtc.AudioStream(track, sample_rate=RATE, num_channels=1)
        streams.append(stream)
        bot_publishing.set()

        async def drain():
            async for event in stream:
                call.received.extend(bytes(event.frame.data))

        tasks.append(asyncio.ensure_future(drain()))

    await room.connect(session["url"], session["token"])
    source = rtc.AudioSource(RATE, 1)
    await room.local_participant.publish_track(rtc.LocalAudioTrack.create_audio_track("mic", source))

    async def pump():
        while True:
            chunk = await mic.next_chunk()
            await source.capture_frame(rtc.AudioFrame(chunk.tobytes(), RATE, 1, FRAME))

    tasks.append(asyncio.ensure_future(pump()))
    # Data packets are not kept for participants who join later. The bot may
    # still be joining, so wait until it is publishing before saying ready.
    await bot_publishing.wait()
    await room.local_participant.publish_data(Call.CLIENT_READY, reliable=True)
    call.log(f"joined LiveKit room {room.name}; waiting for the greeting")

    async def close():
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        for stream in streams:
            await stream.aclose()
        await room.disconnect()
        await source.aclose()

    return close, (1, RATE)


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


async def main(url: str, transport: str, say: str | None, save: str | None, timeout: float):
    speech = await synthesise(say) if say else None
    call = Call(turns_wanted=2 if say else 1)
    mic = Microphone()
    connect = connect_livekit if transport == "livekit" else connect_webrtc
    close, (channels, rate) = await connect(url, call, mic)
    try:
        if speech:
            await asyncio.wait_for(call.greeted.wait(), timeout)
            if call.failure:
                raise SystemExit(f"FAIL: {call.failure}")
            await asyncio.sleep(1.0)
            call.log(f"speaking {len(speech) / 2 / RATE:.1f}s of audio: {say!r}")
            mic.say(speech)
        await asyncio.wait_for(call.done.wait(), timeout)
    finally:
        await close()
    if call.failure:
        raise SystemExit(f"FAIL: {call.failure}")

    if save:
        with wave.open(save, "wb") as out:
            out.setnchannels(channels)
            out.setsampwidth(2)
            out.setframerate(rate)
            out.writeframes(bytes(call.received))
        call.log(f"saved what the bot said to {save}")


if __name__ == "__main__":
    load_dotenv(override=True)
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--url", default="http://localhost:7860", help="where bot.py is running")
    parser.add_argument("--transport", choices=["webrtc", "livekit"], default="webrtc")
    parser.add_argument("--say", help="speak this sentence after the greeting")
    parser.add_argument("--save", help="write everything the bot said to this WAV file")
    parser.add_argument("--timeout", type=float, default=60)
    args = parser.parse_args()
    asyncio.run(main(args.url.rstrip("/"), args.transport, args.say, args.save, args.timeout))
