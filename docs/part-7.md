# Part 7 — The same agent on LiveKit

**By the end of this part** the agent from Part 6 will be talking to you through a
[LiveKit](https://livekit.io/) room, and `bot.py` will not have changed.

Checked against `api.boson.ai`, `livekit-server` 1.13.10 and Pipecat 1.12.0 on 2026-10-15.

---

## Why a second transport

In Part 6 the browser connected straight to `bot.py`. Pipecat calls that transport
*SmallWebRTC*: one caller, one peer-to-peer connection, nothing else to run. It is ideal
for development and it is what the playground uses by default.

LiveKit puts a media server in the middle:

```
browser ──► LiveKit server (a "room") ◄── bot.py ──► wss://api.boson.ai/v1/realtime/
```

The caller and the bot both *join a room*. That one extra hop buys several things you will
want sooner or later:

- **Real networks.** LiveKit handles NAT traversal, TURN and reconnection. SmallWebRTC
  needs both ends to reach each other directly.
- **Clients.** LiveKit has SDKs for iOS, Android, Flutter, Unity and the web, all of which
  can join the same room as your bot.
- **Phone calls.** LiveKit SIP brings a phone number into a room as just another
  participant.
- **Scale.** Rooms can be spread across many LiveKit nodes, independently of your bots.

The agent does not care about any of this. A transport only moves audio frames in and out
of the pipeline.

---

## Run a LiveKit server

For development, LiveKit's server runs as a single binary in dev mode. Install it:

```bash
brew install livekit                          # macOS
curl -sSL https://get.livekit.io | bash       # Linux
```

Then start it:

```bash
livekit-server --dev --bind 127.0.0.1 --node-ip 127.0.0.1
```

`--dev` gives it the fixed credentials `devkey` / `secret`. Put them in `pipecat/.env`:

```bash
LIVEKIT_URL=ws://127.0.0.1:7880
LIVEKIT_API_KEY=devkey
LIVEKIT_API_SECRET=secret
```

> **⚠ This will bite you: `--node-ip` on a machine with more than one network.**
> In dev mode LiveKit advertises the machine's *primary* IP address for media, even with
> `--bind 127.0.0.1`. If that address is not reachable from the bot, the bot's join hangs,
> and after 20 seconds the LiveKit SDK panics
> (`timed out waiting for ReadyForRoomEventRequest`) and takes `bot.py` down with it.
> `--node-ip 127.0.0.1` keeps everything on loopback.

[LiveKit Cloud](https://cloud.livekit.io/) works the same way: put its `wss://` URL, API
key and secret in `.env` instead, and skip the local server.

---

## Run the agent on LiveKit

```bash
uv run bot.py -t livekit
```

That is the whole change. Open `http://localhost:7860` again; the playground now joins
through LiveKit.

Here is what happens when you press Connect:

1. The playground calls `POST /start` with `{"transport": "livekit"}`.
2. The development runner creates a room, signs two tokens with your LiveKit key — one for
   the bot and one for you — and starts the bot with its token.
3. The playground receives `{url, token}` and joins the same room.
4. Audio and RTVI messages now travel through the LiveKit server, as LiveKit data packets
   instead of a WebRTC data channel.

### What changed in `bot.py`

Only the transport parameters, which Part 6 already declared for both:

```python
transport = await create_transport(
    runner_args,
    {
        "webrtc": lambda: TransportParams(audio_in_enabled=True, audio_out_enabled=True),
        "livekit": lambda: LiveKitParams(audio_in_enabled=True, audio_out_enabled=True),
    },
)
```

> **⚠ This will bite you: each transport has its own params class.**
> Passing the generic `TransportParams` to LiveKit looks fine until the bot joins, then
> fails with `'TransportParams' object has no attribute 'audio_out_queue_size_ms'`. It is
> logged as a connection error, and the room stays silent.

---

## Acceptance check

```bash
# terminal 1
livekit-server --dev --bind 127.0.0.1 --node-ip 127.0.0.1

# terminal 2
uv run bot.py -t livekit

# terminal 3
uv run probe.py --transport livekit --say "What is the capital of Japan? One sentence please."
```

Expected output (run on 2026-10-15):

```
  4.50s bot-ready
  5.38s bot-started-speaking
  7.93s bot-stopped-speaking
  7.93s bot said: Hi there, I'm Willow. How can I help you today?
  8.93s speaking 4.0s of audio: 'What is the capital of Japan? One sentence please.'
  9.87s user-started-speaking
 13.51s user-stopped-speaking
 13.77s user-transcription What is the capital of Japan? One sentence, please.
 13.91s bot-started-speaking
 15.34s bot-stopped-speaking
 15.34s bot said: The capital of Japan is Tokyo.
```

The turn latency, from `user-stopped-speaking` to `bot-started-speaking`, is 0.40 s here.
That is the same as Part 6. On one machine, the extra hop through the LiveKit server costs
nothing you can measure.

---

## Where to go from here

- **Deploy.** `bot.py` is an ordinary Python process. Put it in a container next to a
  LiveKit server, or use LiveKit Cloud and run only the bot. Replace the development
  runner's `/start` with your own endpoint that creates rooms and signs tokens for your
  users.
- **Phones.** Configure LiveKit SIP to send inbound calls to a room, and have your
  endpoint start a bot in it.
- **The other way round.** If your stack is already built on LiveKit Agents rather than
  Pipecat, Boson has a LiveKit Agents plugin as well. It is in review upstream as
  [livekit/agents#6340](https://github.com/livekit/agents/pull/6340).

← [Part 6 — A two-stage voice agent with Pipecat](part-6.md)
