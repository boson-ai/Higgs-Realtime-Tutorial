# Part 1 — First connection

**By the end of this part** you will type a sentence into a box, and a voice will read a
reply out loud through your speakers. No microphone yet — this part is about the
connection and the protocol.

You will also have a debug drawer that logs every event the server sends. Keep it. It is
the most useful thing you build today.

---

## Digital audio in thirty seconds

You need three ideas, and only three.

**A sample is a number.** Sound is air pressure going up and down. To store it, you
measure the pressure at some instant and write down the number. That number is a sample.

**Sample rate is how often you measure.** 24000 samples per second — written 24 kHz —
means you took a measurement every 1/24000th of a second. Play those numbers back at the
same rate and you get the original sound. Play them back at the wrong rate and you get a
chipmunk or a demon. This is why the rate has to match at both ends.

**Bit depth is how precise each number is.** "PCM16" means each sample is a 16-bit signed
integer, somewhere from −32768 to 32767. PCM stands for pulse-code modulation, which is a
1930s name for "just write the numbers down." There is no compression and no file header —
a PCM16 stream is literally a list of integers.

So when this tutorial says the API sends "PCM16 at 24 kHz, mono", it means: a list of
whole numbers between −32768 and 32767, twenty-four thousand of them per second, one
channel. One second of audio is 48,000 bytes.

That is the entire audio background you need. Two more concepts appear in Part 2, at the
point where you need them.

---

## What a WebSocket is

`fetch` is a letter: you send a request, you get a response, the exchange is over. A
WebSocket is a phone call — one connection stays open, and both sides can say something
whenever they have something to say, in either direction, for as long as the line is up.

That is what a voice conversation needs. The model cannot wait for you to ask before it
starts producing audio, and you cannot wait for it to finish before you interrupt.

Over that open connection, both sides send **events**: JSON objects with a `type` field.
You send `session.update`; the server sends `response.output_audio.delta`. That is the
whole protocol — a stream of typed JSON messages in both directions.

---

## Opening the connection

```ts
const key = await fetchToken(); // the ephemeral key from Part 0
const ws = new WebSocket(WS_URL, ["realtime", `bai-client-secret.${key}`]);
```

The second argument is the list of **subprotocols**, and it is doing something unusual
here: carrying a credential.

The reason is a browser limitation. You cannot set headers on a WebSocket handshake from
JavaScript — there is no equivalent of `fetch`'s `headers` option, so there is nowhere to
put `Authorization: Bearer …`. The subprotocol list is one of the few fields the browser
does let you control, so the API uses it. `"realtime"` names the protocol; the second entry
is your key.

(Server-side, where you *can* set headers, you use a normal `Authorization: Bearer` header
with your real key and skip the ephemeral-key dance entirely.)

---

## Configuring the session

The first thing to send once the socket opens is `session.update`. From
`src/realtime/sessionConfig.ts`:

```ts
{
  type: "session.update",
  session: {
    model: "higgs-realtime",
    instructions: SYSTEM_PROMPT,
    output_modalities: ["audio"],
    audio: {
      input:  { format: { type: "audio/pcm", rate: 24000 } },
      output: { format: { type: "audio/pcm", rate: 24000 }, voice: "default" },
    },
  },
}
```

A few notes on the fields:

- **`output_modalities`** is exactly `["audio"]` or exactly `["text"]`. It is not a list
  you mix. Asking for audio still gets you the text of what was said, through the
  `response.output_audio_transcript.*` events — you do not have to choose between hearing
  it and displaying it.
- **`rate: 24000`** is the documented default for `audio/pcm`, and we set it explicitly
  anyway. The API also accepts 8000, 16000 and 48000, plus `audio/pcmu` (G.711 µ-law, for
  telephony) and `audio/opus` (compressed). PCM is right while you are learning: nothing
  to decode, nothing to go wrong.
- Fields we do not need are simply **absent**. No turn detection yet (Part 2), no tools
  yet (Part 4). They take the server's defaults.

---

## 🔧 Technique: read the ack

This is the habit that will save you the most time across the rest of the tutorial.

When you send `session.update`, the server replies with `session.created` — and that reply
contains the **resolved** session: your fields, plus every default the server filled in.
Not what you asked for. What you got.

Open the debug drawer, click `session.created`, and look. Here is the real reply to the
config above:

```json
{
  "audio": {
    "input": {
      "format": { "rate": 24000, "type": "audio/pcm" },
      "noise_reduction": null,
      "transcription": { "language": null, "model": "", "prompt": "", "temperature": null },
      "turn_detection": null
    },
    "output": {
      "format": { "rate": 24000, "type": "audio/pcm" },
      "voice": "default",
      "speed": 1
    }
  },
  "max_output_tokens": "inf",
  "output_modalities": ["audio"],
  "temperature": 0.7,
  "tools": [],
  "truncation": "auto"
}
```

Three things in there are worth knowing before you need them:

- `turn_detection` is **`null`**. There is no voice-activity detection unless you ask for
  it. That is fine now — we are typing — but it means Part 2 has to switch it on
  explicitly, and if you forget, the model will simply never take a turn.
- `transcription.model` is **`""`**. Transcription of *your* speech is off by default.
  Part 3 switches it on.
- `noise_reduction` is **`null`**. Off by default.

None of that is guesswork or documentation-reading. It is the server telling you what it
did. Whenever a session field does not seem to be working, read the ack before you read
anything else — and if the server rejected a field outright, you will find out through an
`error` event, which is why `RealtimeClient` logs those loudly instead of swallowing them.

---

## Sending a turn

```ts
this.send(userTextItem(text));  // conversation.item.create
this.send(responseCreate());    // response.create
```

Two events, and both are required. `conversation.item.create` puts your message into the
conversation; it does not ask for anything. `response.create` is what tells the model to
actually respond.

> **⚠ This will bite you.**
> Forgetting `response.create` produces the most confusing possible symptom: no error, no
> event, nothing in the log after your own message. The model has your text and is waiting
> to be asked. (In Part 2, once the server is detecting turns from your voice, you stop
> sending `response.create` altogether — it starts responses on its own. Sending both is
> its own kind of bug.)

---

## Playing the reply

Here is the event stream for one short answer, timestamps from the first byte:

```
[  516ms] session.created
[  518ms] response.created
[  993ms] response.output_item.added
[  994ms] response.output_audio_transcript.delta   "A sample rate is how many times…"
[  994ms] response.output_audio.delta              1280 b64 chars ≈ 480 samples ≈ 20ms
   … 120 more audio deltas …
[ 2231ms] response.output_audio.done
[ 2231ms] response.done
```

Look at the arithmetic, because it determines the design. Those 121 chunks add up to
**7.2 seconds of audio, delivered in 1.24 seconds**. The server sends about six times
faster than real time.

So "play each chunk as it arrives" cannot work. You would be starting a new sound every
ten milliseconds while five previous ones were still going. What you need is a buffer: put
audio in as fast as it arrives, take it out at exactly 24000 samples per second.

That is a **ring buffer** — a fixed-size array with two positions moving through it, a
`write` pointer where new samples land and a `read` pointer where playback pulls from. Both
wrap around to the start when they hit the end, which is what makes it a ring. Because
`read` and `write` can sit at the same position when the buffer is either empty or full,
the worklet keeps an `available` count to distinguish those states. If the buffer fills,
it advances `read` and overwrites the oldest samples instead of blocking.

Ours lives in `src/audio/worklets/playback-processor.js`, and the core of it is
unglamorous:

```js
process(_inputs, outputs) {
  const out = outputs[0][0];
  for (let i = 0; i < out.length; i++) {
    if (this.available > 0) {
      out[i] = this.ring[this.read];
      this.read = (this.read + 1) % this.size;
      this.available--;
    } else {
      out[i] = 0;   // nothing buffered — output silence, not stale audio
    }
  }
  return true;
}
```

### Why an AudioWorklet

An **AudioWorklet** is JavaScript that runs on the browser's audio thread instead of the
main thread. The browser calls `process()` once per render quantum — currently 128 samples,
or roughly 5.3 ms in our 24 kHz playback context — and it must return quickly. This is a
real-time deadline, and missing it means an audible glitch. The code uses the arrays'
actual length rather than assuming that render quanta will always stay at 128 samples.

That is exactly why the buffer belongs there. The audio thread is not affected by React
re-rendering, by a slow WebSocket handler, or by garbage collection on the main thread.
Audio that stutters whenever your UI is busy is not usable, and no amount of optimising the
main thread fixes it properly.

Two small things that will otherwise cost you an afternoon:

- **`process()` must return `true`.** Return `false` and the browser is entitled to
  garbage-collect your node. Playback stops permanently and nothing is logged.
- **The AudioContext must be created inside a user gesture.** Browsers refuse to start
  audio otherwise. `RealtimeClient.connect()` calls `player.resume()` before anything else
  for this reason — it runs inside the click handler. Create the context outside a gesture
  and it sits in state `suspended`, silently, with no error anywhere.

### From base64 to samples

Audio cannot travel through a JSON protocol as raw bytes, so the API base64-encodes it.
Decoding is two steps:

```ts
const binary = atob(base64);              // text -> bytes
const bytes = new Uint8Array(binary.length);
for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
```

and then, in the worklet, integers to floats:

```js
this.ring[this.write] = int16[i] / 32768;
```

The Web Audio API works in floats from −1 to 1; PCM16 is integers from −32768 to 32767.
Dividing by 32768 converts between them. Get this wrong and you get either silence or
extremely loud noise, with nothing in between.

---

## ⚠ Gotcha: StrictMode opens two sockets, and nothing complains

React StrictMode mounts every component twice in development, deliberately, to surface
bugs in setup/teardown code. If `connect()` is called from an effect — or if a user
double-clicks the button — you open two sockets.

Here is the part that makes this nasty. You might expect the API to reject the second
connection, and it does not. Tested against the live API on 2026-08-07: two sockets
opened with the **same ephemeral key**, both sending `session.update`, both got a
`session.created` — with *different* session ids:

```
A1: opened, sending session.update
A2: opened, sending session.update
A1: session.created id=7df7354d
A2: session.created id=ef2c0c3e
A1: still open after 20000ms
A2: still open after 20000ms
```

An ephemeral key is not tied to one session. It authorises connections, and you may open
as many as you like.

So there is no error to see. Instead you get two live sessions that both work: two
conversations with two separate histories, two streams of audio playing over each other,
and two sessions on your bill. It sounds like the model is stuttering or echoing, and you
will look everywhere except at your connect path.

The fix is four lines, and it belongs in `RealtimeClient` from its very first commit:

```ts
async connect(): Promise<void> {
  if (this.connecting || this.state === "open" || this.state === "connecting") {
    this.info("connect() ignored — a connection is already active.");
    return;
  }
  this.connecting = true;
  // …
}
```

Guarding inside the client rather than inside the component means it also covers a user
double-clicking the button, and a reconnect racing a manual connect later on.

Do not be tempted to "fix" this by turning StrictMode off. The double-mount is a smoke
detector, not a fire — and since the API will happily give you two working sessions, it is
the only detector you have.

To check your guard is doing its job, click Connect twice fast and count the
`session.created` events in the drawer. There should be exactly one.

---

## Close codes

Every WebSocket close carries a numeric code, and this API uses specific ones to tell you
why. Mapping them to distinct messages is the difference between a user seeing
"disconnected" and seeing "your key expired."

| Code | Meaning | Retry? |
| --- | --- | --- |
| `1000` | Normal closure — including session-limit closes (idle timeout, max duration), which arrive with the reason in the close frame | Yes |
| `1013` | Max concurrency exceeded | Yes, after a wait |
| `3000` | Invalid API key, or invalid/expired ephemeral key | No — mint a new key |
| `4429` | Billing entitlement refused: quota exhausted, spending cap, contract ended | No |

Two of these have a detail worth knowing:

- **`1000` is not always boring.** An idle timeout closes normally. You will get a
  `session.idle_timeout` event first (the API idles you out after five minutes with no
  user speech), then a clean 1000 with the reason attached. If you treat every 1000 as "the
  user meant to leave," idle disconnects will look like intentional ones.
- **`4429` is always preceded by an `error` event** carrying the upstream message. If you
  are not surfacing `error` events, you get a bare close code and no idea why.

The one you can trigger on demand is `3000` — connect with a made-up key and the server
closes immediately with `3000 "Invalid ephemeral key"`. Worth doing once, so you have seen
your own error path work.

`describeClose()` in `src/realtime/events.ts` maps each of these to a legible sentence.

---

## Why the event types are loosely typed

`ServerEvent` is an interface with one known field:

```ts
export interface ServerEvent {
  type: string;
  event_id?: string;
  [key: string]: unknown;
}
```

That is deliberate. The server emits more event types than any one part of this tutorial
handles — a single reply produced `conversation.item.added`, `response.content_part.added`,
and `response.output_audio_transcript.length`, none of which we act on. It will emit more
as the API grows.

Code that throws on an unrecognised `type` would break the moment that happened. So: type
the envelope, log everything, `switch` on the events you care about, and let the `default`
branch do nothing. The debug drawer is how you discover the rest.

---

## ✅ Acceptance check

```bash
npm run dev
```

Open <http://localhost:5173>, click **Connect**, type a message, and press **Send**.

1. **You hear a spoken reply.** If the log shows `response.output_audio.delta` events but
   you hear nothing, the AudioContext is suspended — make sure `connect()` is running from
   inside the click.
2. **Every server event appears in the drawer.** Open `session.created` and find
   `turn_detection: null` in it. That is the ack-reading habit, and it matters in Part 2.
3. **Each close code produces its own message.** Test the two you can trigger easily:
   - Stop the token server (`Ctrl-C` on the `dev:server` process) and click Connect. You
     should see a token error, not a socket error.
   - Click Connect twice quickly. The guard should log `connect() ignored`, and the drawer
     should contain exactly one `session.created`.

### Without a browser

`npm run probe` runs the same session headlessly — mint, connect, configure, ask, print
every event, save the stream to `captures/`. It has no audio code at all, which makes it
the fastest way to answer "is my protocol wrong, or is my audio wrong?" It is also how the
`session.created` output above was captured.

```bash
npm run probe
npm run probe -- "tell me a two-sentence story"
```

---

**Next:** [Part 2 — Live microphone and interruptions](part-2.md), where the typing stops
and you talk to it.

---

*API facts on this page were verified against the live documentation and against a live
session on 2026-08-07:
[Connections and sessions](https://docs.boson.ai/models/higgs-realtime/guides/connections-and-sessions.md),
[Client events](https://docs.boson.ai/api-reference/realtime/client-events.md),
[Server events](https://docs.boson.ai/api-reference/realtime/server-events.md),
[Realtime overview](https://docs.boson.ai/api-reference/realtime/overview.md).*
