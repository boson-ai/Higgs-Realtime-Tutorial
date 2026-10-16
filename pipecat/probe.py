"""Call a running bot.py the way the playground does, with no browser or microphone.

    uv run probe.py                                   # greeting only
    uv run probe.py --say "who won the Willow Creek regional final?"

It starts a call through the same endpoint the playground uses (POST /start),
connects over WebRTC, sends the RTVI client-ready message and waits for the
bot's greeting. With --say it then types a message into the call, as the
playground's text box does. Everything the bot sends back over RTVI, including
the tools it calls, is printed with a timestamp.
"""

import argparse
import asyncio
import json
import time

import aiohttp
from aiortc import RTCPeerConnection, RTCSessionDescription
from aiortc.mediastreams import AudioStreamTrack

SHOWN = {"bot-ready", "bot-started-speaking"}


class Call:
    """The RTVI messages the bot sends, and the turn count."""

    def __init__(self):
        self.t0 = time.monotonic()
        self.turns = asyncio.Queue()
        self.bot_text: list[str] = []
        self.failure: str | None = None

    def log(self, *args):
        print(f"{time.monotonic() - self.t0:6.2f}s", *args, flush=True)

    def on_rtvi(self, raw: str):
        message = json.loads(raw)
        kind, data = message.get("type"), message.get("data") or {}
        if kind == "bot-llm-text":
            self.bot_text.append(data.get("text", ""))
        elif kind == "bot-stopped-speaking":
            reply = "".join(self.bot_text).strip()
            self.bot_text.clear()
            self.log("bot said:", reply)
            self.turns.put_nowait(reply)
        elif kind == "error":
            self.log("error:", data.get("error"))
            if data.get("fatal"):
                self.failure = data.get("error") or "fatal error"
                self.turns.put_nowait(None)
        elif kind == "llm-function-call-started":
            # Pipecat sends no tool names or arguments to clients by default
            # (RTVIObserverParams.function_call_report_level); bot.py logs them.
            self.log("tool call", data.get("function_name") or "")
        elif kind in SHOWN:
            self.log(kind)


def rtvi(kind: str, data: dict) -> str:
    return json.dumps({"id": f"probe-{kind}", "label": "rtvi-ai", "type": kind, "data": data})


async def main(url: str, say: str | None, timeout: float):
    call = Call()
    pc = RTCPeerConnection()
    pc.addTrack(AudioStreamTrack())  # a silent microphone: WebRTC needs a track to send
    channel = pc.createDataChannel("rtvi")
    # RTVI handshake: the bot greets once the client says it is ready.
    channel.on("open", lambda: channel.send(rtvi("client-ready", {"version": "1.0.0"})))
    channel.on("message", call.on_rtvi)

    async with aiohttp.ClientSession() as http:
        # POST /start: what the playground's Connect button does.
        async with http.post(f"{url}/start", json={"transport": "webrtc"}) as response:
            response.raise_for_status()
            session_id = (await response.json())["sessionId"]
        await pc.setLocalDescription(await pc.createOffer())
        offer = {"sdp": pc.localDescription.sdp, "type": "offer"}
        async with http.post(f"{url}/sessions/{session_id}/api/offer", json=offer) as response:
            response.raise_for_status()
            answer = await response.json()
    await pc.setRemoteDescription(RTCSessionDescription(answer["sdp"], answer["type"]))
    call.log("WebRTC connected; waiting for the greeting")

    try:
        await asyncio.wait_for(call.turns.get(), timeout)  # the greeting
        if say and not call.failure:
            await asyncio.sleep(1.0)
            call.log(f"typing: {say!r}")
            channel.send(rtvi("send-text", {"content": say, "options": {"audio_response": True}}))
            await asyncio.wait_for(call.turns.get(), timeout)  # the answer
    finally:
        await pc.close()
    if call.failure:
        raise SystemExit(f"FAIL: {call.failure}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--url", default="http://localhost:7860", help="where bot.py is running")
    parser.add_argument("--say", help="type this message after the greeting")
    parser.add_argument("--timeout", type=float, default=60)
    args = parser.parse_args()
    asyncio.run(main(args.url.rstrip("/"), args.say, args.timeout))
