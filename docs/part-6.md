# Part 6 — A two-stage voice agent with Pipecat

**By the end of this part** you will have a voice agent running in the Pipecat
playground: open a page, press Connect, and talk to Higgs. The agent is about a hundred lines
of Python, it uses Boson's public production API, and it never shows your API key to the
browser.

Parts 0–5 built everything by hand, in the browser. This part does the opposite: it hands
the audio plumbing to a framework, so you can see how little is left once someone else
owns the microphone, the resampling and the interruptions. You do not need Parts 1–5 to
follow it, but Part 0's warning about API keys still applies.

API facts on this page were checked against `api.boson.ai` on 2026-10-15.

---

## What "two-stage" means

A voice agent needs to do three things: hear the caller, decide what to say, and say it.
Higgs Realtime does the first two in one model and the third in a second one:

```
                 ┌──────────────── Boson's servers ────────────────┐
caller audio ──► │ higgs-realtime ──► text ──► higgs-realtime-tts  │ ──► bot audio
                 │ hears + thinks              speaks              │
                 └─────────────────────────────────────────────────┘
```

That is the **two-stage** pipeline. The more familiar three-stage pipeline splits the first
box into speech recognition and a text LLM. Hearing the audio directly is faster and keeps
what a transcript throws away — tone, hesitation, a name spelled out letter by letter.

Both stages run behind the one WebSocket you used in Part 1. Your code never calls a TTS
endpoint; it tells the session which TTS model to use, and audio comes back.

You can check that your key can reach both models:

```bash
curl -s https://api.boson.ai/v1/models -H "Authorization: Bearer $BOSON_API_KEY" \
  | python3 -c "import sys, json; print([m['id'] for m in json.load(sys.stdin)['data'] if 'realtime' in m['id']])"
# ['higgs-realtime', 'higgs-realtime-tts', ...]
```

---

## Where Pipecat fits

[Pipecat](https://docs.pipecat.ai/) is an open-source Python framework for voice agents.
A Pipecat agent is a **pipeline** of processors that frames flow through — audio frames,
text frames, control frames — and a **transport** that connects the pipeline to a caller.

Two packages do the work:

| Package | What it gives you |
| --- | --- |
| `pipecat-ai` | Pipelines, transports (WebRTC, LiveKit, phone, …), and a development runner with a browser playground |
| `pipecat-boson` | `BosonRealtimeLLMService`: the whole two-stage pipeline as one Pipecat processor |

The shape of the whole thing:

```
browser (playground) ──WebRTC──► bot.py ──WebSocket──► wss://api.boson.ai/v1/realtime/
        mic + speakers           your server            (Authorization: Bearer <your real key>)
```

Compare that with Part 0's diagram. There, the browser talked to Boson directly and needed
an ephemeral key. Here the browser talks only to *your* server, and your server talks to
Boson. **The real key never leaves your server, so there is no ephemeral key to mint.**

---

## Run it

You need Python 3.11 or newer and [uv](https://docs.astral.sh/uv/getting-started/installation/).

```bash
cd pipecat
cp .env.example .env      # then set BOSON_API_KEY
uv run bot.py
```

The first run installs the dependencies. When you see

```
🚀 Bot ready! (WebRTC)
   → Open: http://localhost:7860
```

open that page in Chrome, press **Connect**, and allow the microphone. Willow greets you;
answer it. Interrupt a long answer and it stops.

That page is the **Pipecat playground**: a prebuilt client that ships with
`pipecat-ai[runner]`. It shows captions for both sides, a microphone picker and a
connection log. You did not write any of it.

> **⚠ This will bite you: open it on `localhost`, from the same machine.**
> Browsers only allow the microphone on `https://` pages or on `localhost`. If `bot.py`
> runs on a remote dev box, an SSH tunnel for port 7860 gets you the page but usually not
> the audio: WebRTC media travels over UDP, which `ssh -L` does not carry. Run `bot.py`
> on the laptop whose browser you are using.

---

## The agent, line by line

Everything is in [`pipecat/bot.py`](../pipecat/bot.py). There are three pieces.

### 1. The service: both stages in one object

```python
BosonRealtimeLLMService(
    url="wss://api.boson.ai/v1/realtime/",
    api_key=os.environ["BOSON_API_KEY"],
    model="higgs-realtime",                   # stage 1: hears and thinks
    output_audio_model="higgs-realtime-tts",  # stage 2: speaks
    voice="default",
    instructions=INSTRUCTIONS,
    input_audio_transcription_model="higgs-stt-3.1",
)
```

`model` and `output_audio_model` are the two stages. On the wire they become the
`session.update` you wrote by hand in Part 1, with `session.model = "higgs-realtime"` and
`session.audio.output.model = "higgs-realtime-tts"`.

`input_audio_transcription_model` is optional, and it is *not* a third stage. Stage 1 hears
your audio directly; this separate ASR model only writes captions of what you said, which
the playground displays. Leave it out and the agent still understands you — you just lose
the captions.

> **⚠ This will bite you: an unknown model ends the session.**
> If your key cannot use the TTS model you name, the server does not fall back to a
> default. It closes the session with
> `400 Invalid audio.output.model '…': not available on this endpoint`, and the
> playground shows a call that connects and then goes silent. The message is in
> `bot.py`'s terminal; read it there first.

### 2. The pipeline

```python
Pipeline([
    transport.input(),   # caller audio in
    user_turns,
    llm,                 # both stages, on Boson's servers
    transport.output(),  # bot audio out
    bot_turns,
])
```

Frames flow top to bottom. `transport.input()` produces 20 ms audio frames from the caller.
`llm` forwards them to Boson and pushes the bot's audio frames downstream to
`transport.output()`, which plays them to the caller.

`user_turns` and `bot_turns` keep the conversation history Pipecat's other processors can
read. They are built with `realtime_service_mode=True`, which means: *the server decides
when a turn ends*. Boson runs the voice-activity detection you met in Part 2, and the
aggregators follow its events. There is no local VAD in this pipeline, and you should not
add one.

> **⚠ This will bite you: do not add STT or TTS services.**
> Pipecat examples for other providers put `stt`, `llm` and `tts` in a row. Here `llm`
> already contains all of it. A Pipecat TTS service after it would speak every reply a
> second time.

### 3. Speaking first

```python
@rtvi.event_handler("on_client_ready")
async def on_client_ready(rtvi):
    await asyncio.sleep(0.5)
    await worker.queue_frames([LLMRunFrame()])
```

Higgs answers when the caller stops speaking. To have the bot speak first, ask for one
response as soon as the client is ready: `LLMRunFrame` is Pipecat's "respond now",
which the service turns into `response.create`.

Why wait for *client ready* and not just *connected*? A WebRTC connection is up before the
browser is playing audio. Speak at "connected" and the caller hears the greeting with its
first word cut off. RTVI — the small message protocol the playground speaks over the WebRTC
data channel — sends `client-ready` once the client is listening.

---

## Acceptance check

`probe.py` makes the same call the playground makes, without a browser or a microphone. It
calls `POST /start` the way the Connect button does, sets up WebRTC, waits for the
greeting, and then speaks a sentence it synthesised with Boson's TTS — exactly as if you
had said it:

```bash
# terminal 1
uv run bot.py

# terminal 2
uv run probe.py --say "What is the capital of France? Answer in one sentence."
```

It should print something like this (run on 2026-10-15):

```
  8.00s bot-ready
  8.81s bot-started-speaking
 12.85s bot-stopped-speaking
 12.85s bot said: Hello, this is Willow. How can I help you today?
 13.93s speaking 3.8s of audio: 'What is the capital of France? Answer in one sentence.'
 14.96s user-started-speaking
 18.50s user-stopped-speaking
 18.76s user-transcription What is the capital of France? Answer in one sentence.
 18.95s bot-started-speaking
 21.26s bot-stopped-speaking
 21.26s bot said: The capital of France is Paris.
```

Three things to check:

1. **The bot speaks first.** If nothing happens after `bot-ready`, look in `bot.py`'s
   terminal for an authentication or model error.
2. **`user-transcription` matches what was said.** That is the caption model at work.
3. **The gap from `user-stopped-speaking` to `bot-started-speaking`** is the latency a
   caller feels. Here it is 0.45 s, measured from when the server decided the turn was over.

Add `--save reply.wav` to keep what the bot said.

When this passes, open the playground and have a real conversation, preferably with
headphones on.

---

## Things to change

| To change | Set |
| --- | --- |
| The voice | `BOSON_VOICE` in `.env`: a preset name or a voice ID |
| The personality | `INSTRUCTIONS` in `bot.py`. Part 5's advice on structuring prompts applies unchanged |
| Captions | `BOSON_CAPTION_MODEL=` (empty) turns them off |
| The endpoint | `BOSON_REALTIME_URL`, for example an on-premises deployment's `ws://…/v1/realtime` |

Tools work the same way as in Part 4: write an async Python function, then pass it to
`BosonRealtimeLLMService(tools=[...])` and to the `LLMContext`. The
[pipecat-boson README](https://github.com/boson-ai/pipecat-boson#call-python-functions)
has a complete example.

The [next part](part-7.md) changes one line in the run command to take the same agent
through LiveKit.

← [Part 5 — Prompting](part-5.md) · [Part 7 — The same agent on LiveKit](part-7.md) →
