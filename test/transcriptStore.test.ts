import { describe, expect, it } from "vitest";
import type { ServerEvent } from "../src/realtime/events";
import {
  emptyTranscript,
  replay,
  toList,
  toPlainText,
  transcriptReducer,
} from "../src/state/transcriptStore";
import recorded from "./fixtures/three-turn.json";

/**
 * The highest-value test in this project.
 *
 * `three-turn.json` is not hand-written. It is a real event stream, recorded
 * from a real session with `npm run probe` (see docs/part-3.md), with the
 * base64 audio payloads stripped out so it stays readable. Because the reducer
 * is a pure function, replaying that stream reproduces exactly the transcript a
 * user would have seen — no browser, no network, no microphone.
 *
 * Hand-written fixtures test the protocol you *think* you are getting.
 * Recorded ones test the protocol you have.
 */
describe("transcriptReducer, against a recorded session", () => {
  const state = replay(recorded as ServerEvent[]);
  const items = toList(state);

  it("renders three user turns and three assistant turns, in order", () => {
    expect(items.map((i) => i.kind)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
  });

  it("fills in each user turn from its transcription event", () => {
    const users = items.filter((i) => i.kind === "user");
    expect(users.map((u) => (u.kind === "user" ? u.text : null))).toEqual([
      "Hi. My name is Sam.",
      "Recite the alphabet slowly, one letter at a time.",
      "What is my name?",
    ]);
    expect(users.every((u) => u.status === "complete")).toBe(true);
  });

  it("assembles assistant turns and marks them complete", () => {
    const assistants = items.filter((i) => i.kind === "assistant");
    expect(assistants[0].kind === "assistant" && assistants[0].text).toBe(
      "Hi Sam, nice to meet you. How can I help you today?",
    );
    expect(assistants[2].kind === "assistant" && assistants[2].text).toBe("Your name is Sam.");
    expect(assistants.every((a) => a.status === "complete")).toBe(true);
  });

  it("is a pure function — replaying twice gives the same result", () => {
    expect(toPlainText(replay(recorded as ServerEvent[]))).toEqual(toPlainText(state));
  });
});

/**
 * Cases the recording cannot contain.
 *
 * A genuine barge-in is surprisingly hard to record headlessly: the server
 * finishes GENERATING a reply long before a person would finish HEARING it, so
 * by the time a scripted interruption arrives there is usually no response left
 * in flight to interrupt. In a browser you are interrupting playback, not
 * generation. These sequences are therefore constructed by hand, from the event
 * shapes the recording confirms.
 */
describe("transcriptReducer, constructed sequences", () => {
  const evt = (e: Record<string, unknown>) => e as ServerEvent;

  it("marks an in-flight assistant turn as interrupted when the user cuts in", () => {
    let s = emptyTranscript;
    s = transcriptReducer(
      s,
      evt({ type: "response.output_item.added", item: { id: "a1", type: "message", role: "assistant" } }),
      1,
    );
    s = transcriptReducer(
      s,
      evt({ type: "response.output_audio_transcript.delta", item_id: "a1", delta: "One, two, three, " }),
      2,
    );
    s = transcriptReducer(s, evt({ type: "input_audio_buffer.speech_started", item_id: "u1" }), 3);

    const [assistant, user] = toList(s);
    expect(assistant.kind === "assistant" && assistant.status).toBe("interrupted");
    expect(assistant.kind === "assistant" && assistant.text).toBe("One, two, three, ");
    // The user's bubble exists immediately, with no text yet — there are no
    // streaming deltas for user speech, so without this the UI would sit blank
    // while they are still talking.
    expect(user.kind === "user" && user.text).toBe(null);
    expect(user.kind === "user" && user.status).toBe("pending");
  });

  it("keeps a turn interrupted even if late deltas arrive afterwards", () => {
    let s = emptyTranscript;
    s = transcriptReducer(
      s,
      evt({ type: "response.output_item.added", item: { id: "a1", type: "message", role: "assistant" } }),
      1,
    );
    s = transcriptReducer(s, evt({ type: "input_audio_buffer.speech_started", item_id: "u1" }), 2);
    // In flight when the user barged in, delivered just after.
    s = transcriptReducer(
      s,
      evt({ type: "response.output_audio_transcript.delta", item_id: "a1", delta: "four, five" }),
      3,
    );
    s = transcriptReducer(
      s,
      evt({ type: "response.output_audio_transcript.done", item_id: "a1", transcript: "four, five" }),
      4,
    );
    const assistant = toList(s)[0];
    expect(assistant.kind === "assistant" && assistant.status).toBe("interrupted");
  });

  it("places a late user transcript at its own position, not at the end", () => {
    // The user's transcription can land after the assistant has already begun
    // replying. Appending on arrival would print the answer above the question.
    let s = emptyTranscript;
    s = transcriptReducer(s, evt({ type: "input_audio_buffer.speech_started", item_id: "u1" }), 1);
    s = transcriptReducer(
      s,
      evt({ type: "response.output_item.added", item: { id: "a1", type: "message", role: "assistant" } }),
      2,
    );
    s = transcriptReducer(
      s,
      evt({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "u1",
        transcript: "hello",
      }),
      3,
    );
    expect(toList(s).map((i) => i.itemId)).toEqual(["u1", "a1"]);
    const first = toList(s)[0];
    expect(first.kind === "user" && first.text).toBe("hello");
  });

  it("prefers the authoritative transcript in .done over accumulated deltas", () => {
    let s = emptyTranscript;
    s = transcriptReducer(
      s,
      evt({ type: "response.output_audio_transcript.delta", item_id: "a1", delta: "teh cat" }),
      1,
    );
    s = transcriptReducer(
      s,
      evt({ type: "response.output_audio_transcript.done", item_id: "a1", transcript: "the cat" }),
      2,
    );
    const a = toList(s)[0];
    expect(a.kind === "assistant" && a.text).toBe("the cat");
    expect(a.kind === "assistant" && a.status).toBe("complete");
  });

  it("shows something when transcription fails, rather than a stuck bubble", () => {
    let s = emptyTranscript;
    s = transcriptReducer(s, evt({ type: "input_audio_buffer.speech_started", item_id: "u1" }), 1);
    s = transcriptReducer(
      s,
      evt({ type: "conversation.item.input_audio_transcription.failed", item_id: "u1" }),
      2,
    );
    const u = toList(s)[0];
    expect(u.kind === "user" && u.text).toBe("[transcription failed]");
    expect(u.kind === "user" && u.status).toBe("complete");
  });

  it("ignores unknown event types instead of throwing", () => {
    const before = replay(recorded as ServerEvent[]);
    const after = transcriptReducer(
      before,
      evt({ type: "some.future.event.we.have.never.seen", payload: { nested: true } }),
      99,
    );
    expect(after).toBe(before); // same object — genuinely unchanged
  });

  it("adds a system note when the session times out", () => {
    const s = transcriptReducer(emptyTranscript, evt({ type: "session.idle_timeout" }), 1);
    const item = toList(s)[0];
    expect(item.kind).toBe("system");
    expect(item.kind === "system" && item.text).toMatch(/timed out/);
  });
});
