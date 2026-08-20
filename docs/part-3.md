# Part 3 — Transcript state

**By the end of this part** the conversation appears on screen: your words and the model's,
in the right order, with the assistant's text arriving as it speaks and interruptions
visibly marked.

This part has almost no API surface. It is about turning an event stream into state, which
is where most of the real bugs in a realtime app live.

---

## Switching on transcription

One field:

```ts
audio: {
  input: {
    transcription: { model: "higgs-stt-3.1", language: "en" },
  },
}
```

This is only so *you* can read what was said. The model understands your speech either way
— the transcript is a separate service running alongside it.

The model name is validated when you send `session.update`: a name the endpoint does not
serve (say `whisper-1`) fails the update with an `error` event naming the invalid model,
rather than being accepted and then silently producing no transcripts. As of this writing,
`higgs-stt-3.1` is the name that works.

---

## Why an array does not work

The obvious implementation is an array you push onto as events arrive. It does not survive
contact with the protocol, for three reasons.

**One item is built by several events.** An assistant turn is created by
`response.output_item.added`, filled by a run of `…transcript.delta` events, and finalised
by `…transcript.done`. Four events, one bubble.

**Events do not arrive in display order.** Transcribing your speech takes time, so your own
transcript can land *after* the model has started replying. Append on arrival and the answer
appears above the question.

**Items get amended after the fact.** An assistant turn you interrupted has to be marked as
interrupted, in place, after it was already rendered.

So the transcript is an **ordered list keyed by `item_id`**: a map from id to item, plus an
explicit order array.

```ts
export interface TranscriptState {
  order: string[];
  items: Record<string, TranscriptItem>;
}
```

Every event finds its item by id and edits it. Nothing is ever appended blindly.

And the reducer is a **pure function** of `(state, event, now)` — no sockets, no React, no
clock of its own. That is not architectural taste; it is what makes the next section
possible.

---

## The placeholder bubble

Here is the asymmetry that makes user turns awkward.

Assistant text **streams**: `response.output_audio_transcript.delta` arrives repeatedly as
the model speaks, and you render each piece. From the recording used in this part's test:

```
[13257ms] …transcript.delta   "A. B. C. D. E. F. G. H."
[14161ms] …transcript.delta   " I. J. K. L. M. N. O."
[15105ms] …transcript.delta   " P. Q. R. S. T. U. V. W. X. Y. Z."
[16183ms] …transcript.done    "A. B. C. D. E. F. G. …  X. Y. Z."
```

User speech has **no deltas at all**. There is nothing until the whole transcription lands
at once, seconds after you finished the sentence.

If you wait for it, the UI sits blank while the user is still talking, then jumps. So the
bubble is created the moment the server tells you speech started:

```ts
case SERVER.speechStarted: {
  const itemId = str(evt.item_id);
  const s = markStreamingInterrupted(state);
  return addItem(s, { kind: "user", itemId, text: null, status: "pending", at: now }, prevId);
}
```

The key is that `input_audio_buffer.speech_started` carries the **same `item_id`** the
transcription will arrive against later:

```json
{ "type": "input_audio_buffer.speech_started", "item_id": "776e44f0", "audio_start_ms": 244 }
```

So the placeholder and the eventual text are the same row. `text: null` renders as
*transcribing…*, and gets replaced when the transcription arrives.

---

## Interruptions

`speech_started` does double duty. As well as creating the user's bubble it means any
assistant turn still streaming was cut off:

```ts
function markStreamingInterrupted(state: TranscriptState): TranscriptState {
  // …every assistant item with status "streaming" becomes "interrupted"
}
```

And the mark has to **stick**. Deltas already in flight when the user barged in will land a
moment later, and must not quietly un-mark the turn:

```ts
status: it.status === "interrupted" ? "interrupted" : "streaming",
```

That line looks like paranoia until you see a turn flip back to "complete" half a second
after being interrupted, which is a genuinely baffling thing to watch.

> **An aside worth knowing.** The server generates far faster than it speaks. In the
> recordings here, a full alphabet recitation was *generated* in about 3.5 seconds while
> being 20-odd seconds of audio. So when a user interrupts, there is frequently no response
> left in flight for the server to cancel — it finished long ago, and what you are
> interrupting is playback out of your own ring buffer.
>
> That is why Part 2's client-side `conversation.item.truncate` is not a nicety. It is
> usually the *only* thing correcting the record.

---

## Testing it with a recording

Because the reducer is pure, you can test it by replaying a real session.

`npm run probe` writes every event it receives to `captures/`. Take one of those files,
strip the base64 audio payloads (the reducer ignores them and they are 95% of the bytes),
and you have a fixture:

```bash
npm run probe -- --say "Hi, my name is Sam." \
                 --say "Please recite the alphabet slowly, one letter at a time." \
                 --say "What is my name?" \
                 --out test/fixtures/three-turn.json
```

`test/fixtures/three-turn.json` in this repo is exactly that — 55 real events from a real
session — and the test replays it:

```ts
const state = replay(recorded as ServerEvent[]);
expect(toList(state).map((i) => i.kind)).toEqual([
  "user", "assistant", "user", "assistant", "user", "assistant",
]);
```

**Record the fixture the same day you write the store.** A hand-written fixture tests the
protocol you *think* you are getting. A recorded one tests the protocol you have.

The test file also covers the cases a recording cannot contain — a genuine barge-in among
them, for the reason in the aside above — using hand-built sequences whose event shapes the
recording confirms. Those are labelled as such, because it matters which is which.

---

## Wiring it up

The entire integration is four lines in `App.tsx`:

```tsx
onServerEvent: (evt) => {
  setTranscript((s) => transcriptReducer(s, evt, Date.now()));
},
```

`RealtimeClient` knows nothing about the transcript, and the transcript knows nothing about
sockets. `Date.now()` is passed in rather than called inside the reducer, which is what
keeps it pure and its tests deterministic.

---

## ✅ Acceptance check

```bash
npm test
```

20 tests, including the twelve reducer tests replaying the recorded fixture.

```bash
npm run dev
```

Then, with the microphone on:

1. **Have a three-turn conversation.** Both sides appear in order. Say your name in the
   first turn and ask for it back in the third — if the model answers correctly, the
   ordering is genuinely right rather than accidentally right.
2. **Watch a user bubble.** It should appear as *transcribing…* the instant you start
   talking, and fill in a second or two later. If it appears already-filled, you are
   waiting for the transcription and your UI will feel laggy under load.
3. **Interrupt a long answer.** Ask it to recite the alphabet, talk over it, and check the
   assistant bubble is marked **interrupted** and keeps only the text you actually heard.

---

**Next:** [Part 4 — Tool calling](part-4.md), where the model stops just talking and starts
doing things.

---

*API facts on this page were verified against the live documentation and against live
sessions on 2026-08-07:
[Server events](https://docs.boson.ai/api-reference/realtime/server-events.md),
[Audio and voices](https://docs.boson.ai/models/higgs-realtime/guides/audio-and-voices.md).*
