# Part 7 — A voice agent with LiveKit Agents

**By the end of this part** you will have the agent from Part 6 — the same Higgs
Realtime model, the same Willow — built with [LiveKit Agents](https://docs.livekit.io/agents/)
instead of Pipecat, and you will be talking to it in the LiveKit Agents Playground.

This part does not depend on Part 6. Read [What Higgs Realtime does](part-6.md#what-higgs-realtime-does)
there if you skipped it; everything else is here.

Checked against `api.boson.ai`, `livekit-server` 1.13.10 and LiveKit Agents 1.8.2 on
2026-10-15.

---

## How LiveKit is different

Pipecat's playground connects your browser straight to `bot.py`. LiveKit puts a media
server in the middle, and both sides *join a room* on it:

```
browser (Agents Playground) ──► LiveKit server ◄── agent.py (worker) ──WebSocket──► wss://api.boson.ai/v1/realtime/
                                 (a "room")
```

Three processes, then:

| Process | Role |
| --- | --- |
| `livekit-server` | Routes audio between everyone in a room. Handles NAT, TURN and reconnection. |
| `agent.py` | A **worker**. It registers with the server and is sent into each new room as the agent. |
| A client | Anything that can join a room: the Agents Playground here; LiveKit's web, iOS, Android, Flutter or Unity SDKs in your product; a phone call through LiveKit SIP. |

The extra hop buys you LiveKit's clients and its networking, and costs you a server to
run. If you already run LiveKit, this is the track for you. If you do not, Part 6 has
fewer moving parts.

The Boson integration is a LiveKit Agents plugin, `livekit-plugins-boson`. It is in review
upstream as [livekit/agents#6340](https://github.com/livekit/agents/pull/6340), so
`livekit/pyproject.toml` installs it, and the matching `livekit-agents`, from that PR's
commit. When it is released, those three lines become ordinary version pins.

---

## The agent

Everything is in [`livekit/agent.py`](../livekit/agent.py):

```python
class Willow(Agent):
    def __init__(self) -> None:
        super().__init__(instructions=INSTRUCTIONS)

    async def on_enter(self) -> None:
        self.session.generate_reply(instructions="Greet the caller in one short sentence.")


@server.rtc_session()
async def entrypoint(ctx: JobContext) -> None:
    session = AgentSession(
        llm=boson.realtime.RealtimeModel(
            api_key=os.environ["BOSON_API_KEY"],
            model="higgs-realtime-1.5-preview",
            voice="default",
            input_audio_transcription_model="higgs-stt-3.1",
        ),
    )
    await session.start(agent=Willow(), room=ctx.room)
```

Compare it with Part 6's `bot.py`. The parts map one to one:

| | Pipecat (Part 6) | LiveKit Agents (Part 7) |
| --- | --- | --- |
| Higgs Realtime | `BosonRealtimeLLMService` | `boson.realtime.RealtimeModel` |
| Wiring | a `Pipeline` you assemble | `AgentSession` assembles it |
| Speaking first | `LLMRunFrame` on `client-ready` | `generate_reply()` in `on_enter` |
| Tools | functions in `TOOLS`, given to the service and the context | `@function_tool` methods on the `Agent` |
| Turn detection | the server's, via `realtime_service_mode=True` | the server's, by default |
| Who it talks to | one browser, peer to peer | a LiveKit room |

There is no STT or TTS plugin in the session, and you should not add one. `RealtimeModel`
hears, thinks and speaks, the same way `BosonRealtimeLLMService` does in Part 6.

`input_audio_transcription_model` only produces captions of what the caller said, which
the playground shows in its chat. The model hears the audio itself and does not need it.

### Tools: web search and the time

```python
session = AgentSession(
    llm=server_tools.RealtimeModel(
        api_key=os.environ["BOSON_API_KEY"],
        model="higgs-realtime-1.5-preview",
        voice="default",
        server_tools=[{"type": "web_search"}],
    ),
)
```

Willow has the same two tools as in Part 6, and the same split: who runs it.

**Web search runs on Boson's servers.** Declaring `{"type": "web_search"}` is all it
takes. When a question needs current information, the model says a short "let me check",
the server searches the web, and the model speaks the answer. There is no method to write
and nothing to send back.

**`get_current_time` runs in this worker.** A method decorated with `@function_tool` is a
tool. LiveKit reads its type hints and docstring as the schema, runs it here when the
model calls it, and sends the return value back.

The Boson LiveKit plugin does not know about server-side tools yet, so
[`livekit/server_tools.py`](../livekit/server_tools.py) adds what it needs, in about
forty lines: it puts `server_tools` into the session, and it skips calls marked
`"executor": "server"` instead of handing them to the agent, which would otherwise answer
them with an error. It also logs each search and the pages it read, as Part 6's `bot.py`
does:

```
Searching the web (web_search)
Web search sources: https://weather.com/weather/today/l/…, https://www.accuweather.com/…
```

---

## Run it

You need Python 3.11 or newer, [uv](https://docs.astral.sh/uv/getting-started/installation/),
and Node.js with `pnpm` for the playground. Use three terminals.

### 1. The LiveKit server

```bash
brew install livekit                          # macOS
curl -sSL https://get.livekit.io | bash       # Linux

livekit-server --dev --bind 127.0.0.1 --node-ip 127.0.0.1
```

`--dev` gives it the fixed key `devkey` and secret `secret`.

> **⚠ This will bite you: `--node-ip` on a machine with more than one network.**
> In dev mode LiveKit advertises the machine's *primary* IP address for media, even with
> `--bind 127.0.0.1`. If that address is not reachable, joining a room hangs; we saw the
> LiveKit SDK give up after 20 seconds and take the joining process down with it.
> `--node-ip 127.0.0.1` keeps everything on loopback.

### 2. The agent

```bash
cd livekit
cp .env.example .env      # then set BOSON_API_KEY; the LiveKit values are --dev's
uv run agent.py dev
```

When it prints `registered worker`, it is waiting for rooms.

### 3. The Agents Playground

The [Agents Playground](https://github.com/livekit/agents-playground) is LiveKit's
open-source test client, the counterpart of Pipecat's playground. Run it against your
local server:

```bash
git clone https://github.com/livekit/agents-playground.git
cd agents-playground
cp .env.example .env.local
# in .env.local:
#   LIVEKIT_API_KEY=devkey
#   LIVEKIT_API_SECRET=secret
#   NEXT_PUBLIC_LIVEKIT_URL=ws://127.0.0.1:7880
pnpm install
pnpm dev
```

Open `http://localhost:3000`, press **Connect** and allow the microphone. The playground
creates a room, the server sends your worker into it, and Willow greets you.

![The LiveKit Agents Playground after one question: Willow's greeting, the spoken question and the answer in the chat, and the room and agent details on the right](images/livekit-agents-playground.png)

> **⚠ This will bite you: the hosted playground needs LiveKit Cloud.**
> `agents-playground.livekit.io` now signs you in to LiveKit Cloud, so it cannot reach a
> server on your laptop. Run the playground locally as above, or use a LiveKit Cloud
> project for both the agent and the playground.

---

## Acceptance check

`probe.py` joins a room the way the playground does, without a browser. It signs a token
with your LiveKit key, waits for the greeting, and types a question into the room's chat,
as the playground's chat box does. Keep `livekit-server` and `agent.py dev` running, and open a fourth terminal
in the tutorial's `livekit/` folder (the playground can stay open or be stopped):

```bash
cd livekit
uv run probe.py --say "What's the weather in Tokyo today?"
```

Expected output:

```
  9.34s agent said: Hello, how can I help you today?
 10.34s typing: "What's the weather in Tokyo today?"
 12.74s agent said: Let me check that for you real quick.
 17.14s agent said: It's currently fair and 72 degrees Fahrenheit in Tokyo.
```

and the worker logs the search and the pages it read. A "let me check" followed by today's
weather means the web search ran. Ask "What time is it in Tokyo?" to try
`get_current_time`.

The probe also prints `agent speaking` / `agent listening` lines. They come from the `lk.agent.state` attribute
that every LiveKit agent publishes. The agent's words come from LiveKit's
`lk.transcription` text streams, and the typed question goes in on `lk.chat`. Your own
client can use all three. Then talk to it in the playground, which tests the spoken path.

> **⚠ This will bite you: publish the microphone as a microphone.**
> An agent only listens to audio tracks whose source is `SOURCE_MICROPHONE`. A custom
> client that publishes a track without setting the source joins the room fine, and the
> agent never hears it. `probe.py` sets it in `publish_track`.

---

## Where to go from here

- **More tools.** Add another `@function_tool` method to `Willow`, or narrow the web
  search with `allowed_domains`, `excluded_domains` or `location` on `{"type": "web_search"}`.
- **Deploy.** The worker is an ordinary process: run it next to your LiveKit server, or
  against LiveKit Cloud. Your backend signs room tokens for your users, as
  `probe.py`'s `user_token()` does.
- **Phones.** Configure LiveKit SIP to send inbound calls to a room, and your worker
  answers them.

← [Part 6 — A voice agent with Pipecat](part-6.md)
