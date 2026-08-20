# Part 2 — Live microphone and interruptions

**By the end of this part** you will talk to the model and it will talk back, with no
buttons and no typing. You will be able to cut it off mid-sentence, and — this is the part
that takes real care — it will correctly remember only what you actually heard.

---

## The two pipelines

Everything in this part is one of these two flows.

**Input — your voice to the server:**

```
  microphone
      │  getUserMedia
      ▼
  AudioContext at the browser-selected rate (usually 48000 Hz)
      │
      ▼
  capture-processor.js  ──► collect into ~100 ms frames (Float32)
      │  postMessage
      ▼
  resample.ts  ──► low-pass filter, then interpolate down to 24000 Hz
      │
      ▼
  floatTo16BitPCM  ──► −1..1 floats become −32768..32767 integers
      │
      ▼
  base64  ──► because JSON cannot carry raw bytes
      │
      ▼
  input_audio_buffer.append   ~10 events per second
```

**Output — the server's voice to your speakers:**

```
  response.output_audio.delta   arriving ~6x faster than real time
      │
      ▼
  atob  ──► base64 back to bytes
      │
      ▼
  playback-processor.js ring buffer
      │  the audio thread drains it at exactly 24000 samples/sec
      ▼
  speakers
```

The output side you built in Part 1. This part builds the input side, and then connects
the two so that one can interrupt the other.

---

## Turn detection: letting the server decide when you have finished

In Part 1 you sent `response.create` to ask for a reply. In a spoken conversation nobody
presses a button to say "I've finished talking" — so the server listens for it.

That is **VAD**, voice activity detection: continuously judging whether the incoming audio
is someone speaking or just room noise. Switch it on in `session.update`:

```ts
audio: {
  input: {
    format: { type: "audio/pcm", rate: 24000 },
    turn_detection: { type: "server_vad" },
  },
}
```

> **⚠ This will bite you: the default is `null`.**
> There is no turn detection unless you ask for it. Leave the field out and you can stream
> audio all day while the model waits politely for a turn that never comes — no error, no
> event, nothing in the log. This is the single most likely reason your first attempt at
> this part is silent. Check `session.created` first.

### Read the ack (again)

Here is what the server echoes back for that bare `{ type: "server_vad" }`:

```json
{
  "type": "server_vad",
  "threshold": 0.55,
  "prefix_padding_ms": 300,
  "silence_duration_ms": 500,
  "min_speech_duration": 0.125
}
```

Everything except the `type` you asked for by omission — they are the documented defaults:

- **`threshold`** (0.55) — how confident the VAD must be that this is speech. Raise it in a
  noisy room; lower it if quiet speech gets missed.
- **`prefix_padding_ms`** (300) — how much audio from *before* the trigger point to keep,
  so your first syllable is not clipped.
- **`silence_duration_ms`** (500) — how long you must stop talking before the turn is
  considered over. This is the knob you will actually want. Too low and you get cut off
  mid-thought; too high and the model feels sluggish.
- **`min_speech_duration`** (0.125) — how much speech is needed to trigger at all, which
  keeps coughs and door slams from starting a turn.

> **⚠ This will bite you: `min_speech_duration` is in seconds.**
> The three fields next to it are milliseconds. `0.125` means an eighth of a second. Set it
> to `125` expecting milliseconds and you have asked for a two-minute minimum utterance.

Two behaviors come with server-side turn detection, and they shape the rest of the
client:

- **The server starts each response itself** when it detects end of turn. This is the
  formal reason you now stop sending `response.create`. Send one anyway and you are asking
  for a second reply on top of the one already coming.
- **Server VAD handles the active response; your client handles local playback.** If the
  response is still being generated, detected speech can cancel it server-side. But the
  server often finishes generating long before you finish listening — measured on
  2026-08-07, a roughly twenty-second alphabet recitation was fully generated in about
  3.5 seconds. Audio already queued in your ring buffer does not stop by itself, and only
  your client knows how much of it reached the output. On `speech_started`, flush that
  queue and truncate the stored item to the local playback position.

### An honest caveat about the ack

The ack tells you what the server *stored*, not that what you sent was sensible. Model
names are the exception — a `model` or `transcription.model` the endpoint does not serve
fails the update with an `error` event naming it — but a semantically poor value (a
`threshold` of 0.99, a `silence_duration_ms` of 30) is stored and echoed back quite
happily.

Genuinely invalid *structure* does get rejected, loudly and usefully — sending
`{ type: "banana_vad" }` produces an `error` event containing a full validation report
naming the field and the allowed values. Which is exactly why `RealtimeClient` surfaces
`error` events instead of swallowing them.

So: the ack proves acceptance, the `error` event proves rejection, and neither proves
correctness. Your ears remain part of the test suite.

### The other VAD

There is a second mode, `semantic_vad`, which uses the content of what you are saying to
judge whether you have finished a thought rather than just gone quiet. It accepts the same
parameters — verified: send `threshold: 0.6` and `silence_duration_ms: 700` and both come
back honoured — plus a `timeout_sec` of its own.

Worth knowing before you switch: its default `silence_duration_ms` is **100**, not 500. It
is deliberately quicker off the mark, and it relies on understanding you rather than on
waiting. Try it once the plain version is working, and change one thing at a time.

---

## Capturing the microphone

```ts
const stream = await navigator.mediaDevices.getUserMedia({
  audio: {
    echoCancellation: true,
    noiseSuppression: false,
    autoGainControl: true,
    channelCount: 1,
  },
});
```

Those values are preferences rather than guarantees. Browsers normally honour them, but
`stream.getAudioTracks()[0].getSettings()` is where you inspect the settings actually in
use when a device behaves differently.

**`echoCancellation: true`** matters more than it looks. Without it the microphone hears
the model coming out of your speakers, the server's VAD decides that is you talking, and
the conversation interrupts itself in a loop. Headphones make the problem disappear; most
of your users will not be wearing any.

**`noiseSuppression: false`** is the deliberate one. Browser noise suppression is tuned for
a human on a phone call and it happily removes quiet speech along with the hiss. The model
is better at deciding what matters than a general-purpose filter is. If you later find a
genuinely noisy environment hurting accuracy, this is the first thing to try — but start
raw.

Note also what is *not* in the `AudioContext` constructor:

```ts
const ctx = new AudioContext(); // no sampleRate — use the browser-selected graph rate
```

With no explicit rate, an AudioContext normally uses the output device's preferred rate.
That is not necessarily the microphone's native rate: if the microphone track differs,
the browser converts it as the track enters the audio graph. We read the graph's actual
`ctx.sampleRate` and own the final conversion from that rate to the API's 24 kHz. That
last conversion is the one in `resample.ts`, where we can see it, test it, and fix it.

---

## Sample rate conversion, and why it needs a filter

The capture AudioContext commonly runs at 48000 Hz. The API wants 24000. In that common
case, halving is the easy part — take every other sample — and doing exactly that is a bug.

A 24 kHz stream can only represent frequencies up to 12 kHz. That ceiling is half the
sample rate and it is called the **Nyquist frequency**; the reason is intuitive enough,
since it takes at least two samples to describe one cycle of a wave, one for the peak and
one for the trough.

So what becomes of the 15 kHz content that was in the original? It does not disappear. It
**folds back** into the audible range and reappears as a frequency that was never there —
15 kHz arrives as a spurious 9 kHz. This is **aliasing**, the audio equivalent of the
moiré pattern you get photographing a striped shirt.

The fix is to remove those frequencies *before* discarding samples, with a low-pass filter
— one that lets low frequencies through and progressively blocks high ones. `resample.ts`
uses a second-order Butterworth, cut just below the output Nyquist:

```ts
const lowpass = ratio > 1 ? createLowpass(outputRate * 0.45, inputRate) : null;
```

> **⚠ This will bite you, in a way that sends you to the wrong file.**
> If you skip the filter, the speech-to-speech model copes with the added noise reasonably
> well — but the *transcript* degrades noticeably. So the app appears to understand you
> while printing something garbled, and you go hunting for a bug in your transcription
> code. The bug is in your resampler, forty lines upstream.

With the filter in place, `test/resample.test.ts` shows the difference directly: a 1 kHz
tone comes through at full strength, a 20 kHz tone arrives at under a tenth of it, instead
of folding back in as a loud 4 kHz whine.

### Streaming state

The subtle part of `createResampler` is that it is called once per 100 ms block, and it
has to carry state between calls: the filter's memory, the last sample of the previous
block, and the fractional read position.

```ts
let prev = 0;        // last sample of the previous block
let havePrev = false;
let pos = 0;         // fractional read position, carried across blocks
```

Reset any of those per block and you get a small discontinuity at every seam — ten audible
clicks per second, sounding like a bad connection rather than like a bug in your code.
There is a test for this specifically: resample a continuous sine in two blocks, join the
results, and assert that no sample-to-sample step is larger than the wave's own slope.

---

## Interruption: the part that is easy to get half-right

You are talking over the model. Two things must happen.

**One: stop playing.** You may be holding several seconds of audio it has not spoken yet —
remember, the server sends about six times faster than real time. Without this it keeps
talking over you.

That is `flush()`, and it is why playback lives in a ring buffer. Discarding the queue is
two assignments on the audio thread and takes effect on the very next render quantum —
currently about 5.3 ms in the 24 kHz playback context, plus message scheduling:

```js
this.available = 0;
this.read = this.write;
```

**Two: tell the server what reached the output.** This is the one people miss. Server VAD
can cancel a response that is still being generated, but it cannot infer the playback
position of audio already queued in your browser. If generation already finished, there
is no in-flight response to cancel at all.

The conversation item can contain more of the reply than reached your speakers. The server
cannot know that your browser stopped a local queue after four seconds; leave the extra
content in its history and the model may refer back to words you never heard. Ask "sorry,
what was that last bit?" and it can answer from that unheard text.

So you send `conversation.item.truncate` with `audio_end_ms`: cut this item at exactly the
point I stopped hearing it.

### Where `audio_end_ms` comes from

This is the bit worth slowing down for, because there are three plausible numbers and two
of them are wrong.

- **Not** how much audio arrived — that is seconds ahead of the speakers.
- **Not** how long since the turn started — playback may have begun late, or underrun.
- **Yes:** how many samples the audio thread actually handed to the output.

Only the worklet knows that number, so the worklet counts it. That is the entire Part 2
diff to `playback-processor.js`: one counter, incremented where a sample is handed to the
audio output. This is the best local proxy for what was heard; device output latency means
it is not a literal measurement at the listener's ear.

```js
out[i] = this.ring[this.read];
this.read = (this.read + 1) % this.size;
this.available--;
this.played++;          // <- this sample was handed to the audio output
```

Converting to milliseconds is a division:

```ts
const ms = ((d.played ?? 0) / AUDIO_RATE) * 1000;
```

...and this is where Part 1's insistence on `rate: 24000` pays off. Because the API sends
at 24000 and the AudioContext runs at 24000, one sample out is one sample in, and that
division is exact. Let the browser resample between them and this number quietly drifts —
producing a truncation point that is subtly wrong in a way nothing will ever flag.

The counter is zeroed on `response.created`, so in the Part 2 flow it measures into the
current reply rather than into the whole session. When server VAD reports
`speech_started`, the old reply is flushed before the next spoken turn proceeds.

### The handler

```ts
private async handleBargeIn(): Promise<void> {
  this.setActivity("listening");
  const playedMs = await this.player.flush();
  if (this.currentAssistantItemId && playedMs > 0) {
    this.send(truncateItem(this.currentAssistantItemId, playedMs));
  }
  this.currentAssistantItemId = null;
}
```

Note the `await`. `flush()` returns a promise because the sample count lives on the audio
thread and has to come back by message. And note what is *absent*: no `response.create`.
The server's VAD is already starting your new turn. Sending one here gets you two replies
racing each other.

---

## Diagnosing silence

At some point the model will not answer and you will need to know why. There are two
completely different causes with the same symptom, and the level meter tells them apart.

**Meter is flat.** The browser is not capturing. Check the tab's microphone permission,
check the OS input device, and check that the worklet node is connected into the graph —
it only runs if something pulls on it:

```ts
this.source.connect(this.node);
this.node.connect(ctx.destination); // required, even though it outputs nothing
```

Leave that second line out and `process()` is simply never called. No error.

**Meter moves, but no `input_audio_buffer.speech_started` in the drawer.** Audio is being
captured and sent; the server is not calling it speech. In order of likelihood:

1. `turn_detection` is `null` in the ack — you did not enable it.
2. `threshold` is too high for how quietly you are speaking.
3. Something is filtering the audio before the model hears it. Check `noise_reduction` in
   the ack. It defaults to `null` (verified 2026-08-07) and this tutorial never sets it —
   but if you have been experimenting, a server-side noise reducer set for the wrong
   environment can remove your speech entirely. The audio is captured, the audio is sent,
   and the model hears nothing. It is a genuinely disorienting failure, because every
   piece of your own code is working.

And if you want to remove the browser from the question altogether, `npm run probe` runs
the same session with no audio code in it at all.

---

## ✅ Acceptance check

```bash
npm run dev
```

Connect, click **Start microphone**, and:

1. **Speak a question and get a spoken answer.** Check the drawer: there should be
   `input_audio_buffer.speech_started`, then `speech_stopped`, then `response.created` —
   and **no `response.create` sent by you**. If you see one, you are still on Part 1's
   path.
2. **Interrupt it.** Ask for something long ("tell me about the history of the metre"),
   then talk over it. Playback should stop within about 150 ms of `speech_started`. In the
   drawer you should see your `conversation.item.truncate` with a plausible `audio_end_ms`
   — roughly the number of seconds you actually listened, times a thousand.
3. **Check its memory.** Right after interrupting, ask "what was the last thing you said?"
   The answer should cover only what you heard, and stop where you cut it off. This is the
   check the whole truncate machinery exists for, and the only one that can tell you
   whether `audio_end_ms` was right.

```bash
npm test
```

The resampler tests should pass — including the anti-aliasing one and the
no-clicks-at-block-boundaries one.

---

**Next:** Part 3 turns this stream of events into a real transcript UI. The events arrive
out of order and the same item gets mutated by several of them, so it needs an actual
reducer rather than an array you push onto.

---

*API facts on this page were verified against the live documentation and against live
sessions on 2026-08-07:
[Turn detection and interruptions](https://docs.boson.ai/models/higgs-realtime/guides/turn-detection-and-interruptions.md),
[Audio and voices](https://docs.boson.ai/models/higgs-realtime/guides/audio-and-voices.md),
[Client events](https://docs.boson.ai/api-reference/realtime/client-events.md).*
