/**
 * A headless Realtime session, in one file.
 *
 * It mints an ephemeral key, opens the socket, sends the same session config
 * the browser app sends, takes one or more turns, prints every server event as
 * it arrives, and writes the whole stream to `captures/`.
 *
 * This is not part of the app — it is a debugging instrument, and it earns its
 * place three times over:
 *
 *  1. When something breaks, it tells you whether the problem is in your audio
 *     code or your protocol code. The probe has no audio hardware at all.
 *  2. `session.created` echoes the *resolved* session — every default the
 *     server filled in. That is the only way to see what you actually got.
 *  3. The captured event stream is a fixture. Real recorded events, replayed in
 *     a unit test, beat hand-written ones every time. Part 3's reducer test is
 *     built on exactly that.
 *
 * Usage:
 *   npm run probe                                  ask a default question as text
 *   npm run probe -- --text "hello"                a typed turn
 *   npm run probe -- --say "hello there"           SPEAK a turn (synthesised, streamed
 *                                                  in as microphone audio)
 *   npm run probe -- --say "a" --say "b"           several spoken turns in order
 *   npm run probe -- --audio recording.wav         stream a WAV file you already have
 *   npm run probe -- --say "hi" --out captures/x.json
 *
 * `--say` uses the text-to-speech API to synthesise the utterance, then feeds it
 * to the Realtime session the same way the browser feeds microphone audio:
 * 24 kHz PCM16, base64, ~100 ms at a time, paced in real time. That means it
 * exercises the whole input path — turn detection, transcription, tool calls —
 * with no microphone and no human in the loop.
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import dotenv from "dotenv";
import { buildSessionConfig, AUDIO_RATE } from "../src/realtime/sessionConfig";
import {
  describeClose,
  functionCallOutput,
  inputAudioAppend,
  responseCreate,
  userTextItem,
} from "../src/realtime/events";
import { dispatch as dispatchTool } from "../src/tools/registry";

dotenv.config();

const BOSON_BASE_URL = process.env.BOSON_BASE_URL ?? "https://api.boson.ai";
const WS_URL = "wss://api.boson.ai/v1/realtime?model=higgs-realtime";

// ~100 ms per chunk, matching what the browser sends.
const CHUNK_SAMPLES = AUDIO_RATE / 10;
// Trailing silence after each utterance. The server's VAD needs to *hear*
// silence to decide your turn is over — silence_duration_ms defaults to 500,
// so a comfortable margin over that ends the turn promptly.
const TRAILING_SILENCE_MS = 900;

/**
 * `barge` is `say` that does not wait its turn: it starts talking 1.5 s into
 * the previous reply instead of after it. That is how you produce a genuine
 * interruption without a human, which Part 2 needs to verify truncation and
 * Part 3 needs in order to record a realistic fixture.
 */
type Turn =
  | { kind: "text"; value: string }
  | { kind: "say"; value: string }
  | { kind: "barge"; value: string }
  | { kind: "audio"; value: string };

function parseArgs(argv: string[]): { turns: Turn[]; out: string | null } {
  const turns: Turn[] = [];
  let out: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--text") turns.push({ kind: "text", value: argv[++i] });
    else if (a === "--say") turns.push({ kind: "say", value: argv[++i] });
    else if (a === "--barge") turns.push({ kind: "barge", value: argv[++i] });
    else if (a === "--audio") turns.push({ kind: "audio", value: argv[++i] });
    else if (a === "--out") out = argv[++i];
    else if (!a.startsWith("--")) turns.push({ kind: "text", value: a });
  }
  if (turns.length === 0) {
    turns.push({ kind: "text", value: "In one short sentence, what is a sample rate?" });
  }
  return { turns, out };
}

function loadApiKey(): string {
  const inline = process.env.BOSON_API_KEY?.trim();
  if (inline) return inline;
  const keyFile = process.env.BOSON_API_KEY_FILE;
  if (keyFile) {
    const fromFile = readFileSync(keyFile, "utf8").trim();
    if (fromFile) return fromFile;
  }
  throw new Error("No API key. Set BOSON_API_KEY or BOSON_API_KEY_FILE in .env.");
}

async function mintEphemeralKey(apiKey: string): Promise<string> {
  const res = await fetch(`${BOSON_BASE_URL}/v1/realtime/client_secrets`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ expires_after: { seconds: 600 } }),
  });
  if (!res.ok) throw new Error(`client_secrets ${res.status}: ${await res.text()}`);
  return ((await res.json()) as { value: string }).value;
}

// --- audio in ---------------------------------------------------------------

/**
 * Pull the PCM16 samples out of a WAV file.
 *
 * A WAV is a sequence of labelled chunks, so we walk them rather than assuming
 * the header is 44 bytes — plenty of encoders insert extra chunks before the
 * audio, and skipping a fixed 44 bytes would feed you metadata as if it were
 * sound.
 */
function decodeWav(buf: Buffer): { samples: Int16Array; rate: number } {
  if (buf.toString("ascii", 0, 4) !== "RIFF") throw new Error("not a WAV file");
  let rate = AUDIO_RATE;
  let pos = 12;
  while (pos + 8 <= buf.length) {
    const id = buf.toString("ascii", pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === "fmt ") {
      const bits = buf.readUInt16LE(body + 14);
      const channels = buf.readUInt16LE(body + 2);
      rate = buf.readUInt32LE(body + 4);
      if (bits !== 16 || channels !== 1) {
        throw new Error(`need 16-bit mono, got ${bits}-bit ${channels}-channel`);
      }
    } else if (id === "data") {
      const slice = buf.subarray(body, body + size);
      return {
        samples: new Int16Array(slice.buffer, slice.byteOffset, slice.length / 2),
        rate,
      };
    }
    pos = body + size + (size % 2); // chunks are word-aligned
  }
  throw new Error("no data chunk in WAV");
}

async function synthesize(apiKey: string, text: string): Promise<Int16Array> {
  const res = await fetch(`${BOSON_BASE_URL}/v1/audio/speech`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "higgs-tts-3",
      input: text,
      voice: "default",
      response_format: "wav",
    }),
  });
  if (!res.ok) throw new Error(`speech ${res.status}: ${await res.text()}`);
  const { samples, rate } = decodeWav(Buffer.from(await res.arrayBuffer()));
  if (rate !== AUDIO_RATE) {
    throw new Error(`TTS returned ${rate} Hz, session expects ${AUDIO_RATE} Hz`);
  }
  return samples;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Stream samples into the session the way a microphone would: ~100 ms at a
 * time, paced in real time, followed by silence so the VAD closes the turn.
 *
 * The pacing matters. Dump the whole utterance at once and the server sees
 * several seconds of speech arrive in one instant, which is not what turn
 * detection is designed around.
 */
async function streamSamples(
  send: (evt: unknown) => void,
  samples: Int16Array,
): Promise<void> {
  const silence = new Int16Array(CHUNK_SAMPLES);
  const chunks: Int16Array[] = [];
  for (let i = 0; i < samples.length; i += CHUNK_SAMPLES) {
    chunks.push(samples.subarray(i, Math.min(i + CHUNK_SAMPLES, samples.length)));
  }
  for (let i = 0; i < Math.round(TRAILING_SILENCE_MS / 100); i++) chunks.push(silence);

  for (const chunk of chunks) {
    const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.length * 2);
    send(inputAudioAppend(bytes.toString("base64")));
    await sleep(100);
  }
}

// --- reporting --------------------------------------------------------------

/** One line per event: the type, plus whichever field carries the payload. */
function summarize(evt: Record<string, unknown>): string {
  const type = String(evt.type);
  if (type === "response.output_audio.delta") {
    const b64 = typeof evt.delta === "string" ? evt.delta : "";
    const samples = Math.round((b64.length * 0.75) / 2);
    return `${type}  ${b64.length} b64 chars ≈ ${samples} samples ≈ ${((samples / AUDIO_RATE) * 1000).toFixed(0)}ms`;
  }
  if (type === "response.function_call_arguments.done") {
    return `${type}  ${String(evt.name)}(${String(evt.arguments)})  call_id=${String(evt.call_id)}`;
  }
  if (typeof evt.delta === "string") return `${type}  ${JSON.stringify(evt.delta)}`;
  if (typeof evt.transcript === "string") return `${type}  ${JSON.stringify(evt.transcript)}`;
  if (type === "error") return `${type}  ${JSON.stringify(evt.error ?? evt)}`;
  return type;
}

async function main() {
  const { turns, out } = parseArgs(process.argv.slice(2));
  const apiKey = loadApiKey();
  const key = await mintEphemeralKey(apiKey);
  console.log(`minted ${key.slice(0, 12)}…\nconnecting to ${WS_URL}\n`);

  const events: unknown[] = [];
  const startedAt = Date.now();
  let audioChunks = 0;
  let audioSamples = 0;
  let sessionReady!: () => void;
  const ready = new Promise<void>((r) => (sessionReady = r));
  let responseDone: (() => void) | null = null;
  // Counters rather than one-shot callbacks: a barge-in needs to ask "is a
  // response in flight *right now*", which a promise created after the fact
  // cannot answer.
  let responsesCreated = 0;
  let responsesDone = 0;
  const handledCallIds = new Set<string>();
  /**
   * How many extra response.done events to expect because we answered a tool
   * call and asked for another reply.
   *
   * Counting *responses* rather than in-flight dispatches matters: a tool here
   * finishes in under a millisecond, so any "is a tool still running" flag is
   * already false by the time the tool turn's response.done arrives over the
   * network, and the probe would stop one reply too early.
   */
  let extraResponsesExpected = 0;

  const ws = new WebSocket(WS_URL, ["realtime", `bai-client-secret.${key}`]);
  const send = (evt: unknown) => ws.send(JSON.stringify(evt));

  ws.addEventListener("open", () => {
    console.log("open — sending session.update\n");
    send(buildSessionConfig());
  });

  ws.addEventListener("message", (ev) => {
    const evt = JSON.parse(String(ev.data)) as Record<string, unknown>;
    events.push(evt);

    if (evt.type === "response.output_audio.delta") {
      const b64 = typeof evt.delta === "string" ? evt.delta : "";
      audioChunks++;
      audioSamples += Math.round((b64.length * 0.75) / 2);
      if (audioChunks > 1) return; // print the first, then count quietly
    }

    console.log(`[${String(Date.now() - startedAt).padStart(6)}ms] ${summarize(evt)}`);

    if (evt.type === "session.created") {
      // The resolved session: our fields plus every default the server filled
      // in. The single most useful thing the probe prints.
      console.log("\n--- resolved session (server defaults included) ---");
      console.log(JSON.stringify(evt.session, null, 2));
      console.log("---\n");
      sessionReady();
    }
    if (evt.type === "response.created") responsesCreated++;

    // Run tools, the same way the browser does — same registry, same
    // handled-call_id guard. Without this the probe would stop at the tool
    // call and never see the answer the model gives afterwards.
    if (evt.type === "response.function_call_arguments.done") {
      const callId = String(evt.call_id ?? "");
      const name = String(evt.name ?? "");
      if (callId && name && !handledCallIds.has(callId)) {
        handledCallIds.add(callId);
        extraResponsesExpected++;
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(String(evt.arguments ?? "{}"));
        } catch {
          /* run it empty and let the handler complain */
        }
        void (async () => {
          const result = await dispatchTool(name, args);
          console.log(`        ↳ ${name} -> ${result.summary}`);
          send(functionCallOutput(callId, JSON.stringify(result)));
          send(responseCreate());
        })();
      }
    }

    if (evt.type === "response.done") {
      responsesDone++;
      // A turn that only asked for a tool is not the turn we are waiting for —
      // the real answer comes in the response that follows the tool result.
      //
      // Note we cannot detect that from response.done itself: verified
      // 2026-08-07, its `output` array lists only the spoken message, NOT the
      // function_call. So we count dispatches instead.
      if (extraResponsesExpected > 0) {
        extraResponsesExpected--;
        return;
      }
      responseDone?.();
      responseDone = null;
    }
  });

  ws.addEventListener("close", (ev) => {
    const info = describeClose(ev.code, ev.reason);
    console.log(`\nclosed: ${info.message}`);
    console.log(
      `audio received: ${audioChunks} chunks, ${audioSamples} samples ≈ ${(audioSamples / AUDIO_RATE).toFixed(2)}s`,
    );
    mkdirSync("captures", { recursive: true });
    const path = out ?? `captures/probe-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    writeFileSync(path, JSON.stringify(events, null, 2));
    console.log(`${events.length} events written to ${path}`);
    process.exit(info.code === 1000 ? 0 : 1);
  });

  ws.addEventListener("error", () => {
    console.error("socket error — see the close code below");
  });

  await ready;

  for (let ti = 0; ti < turns.length; ti++) {
    const turn = turns[ti];
    if (turn.kind === "barge") {
      // Synthesise FIRST. Text-to-speech takes a second or two, and the window
      // we are aiming at is only a couple of seconds wide.
      const samples = await synthesize(apiKey, turn.value);

      // Wait for a response to actually be in flight — created but not done.
      const deadline = Date.now() + 20_000;
      while (responsesCreated <= responsesDone && Date.now() < deadline) await sleep(25);

      if (responsesCreated <= responsesDone) {
        console.log("\n>>> no response in flight to interrupt — speaking normally\n");
      } else {
        // Let it get a little way in, so there is something to cut off.
        await sleep(700);
        console.log(`\n>>> BARGING IN: ${JSON.stringify(turn.value)}\n`);
      }

      const waitForNewReply = new Promise<void>((r) => (responseDone = r));
      await streamSamples(send, samples);
      await Promise.race([waitForNewReply, sleep(45_000)]);
      continue;
    }

    const waitForReply = new Promise<void>((r) => (responseDone = r));

    if (turn.kind === "text") {
      console.log(`\n>>> typing: ${JSON.stringify(turn.value)}\n`);
      send(userTextItem(turn.value));
      // A typed turn has no speech for the VAD to detect, so we ask explicitly.
      send(responseCreate());
    } else {
      const samples =
        turn.kind === "say"
          ? await synthesize(apiKey, turn.value)
          : decodeWav(readFileSync(turn.value)).samples;
      console.log(
        `\n>>> speaking (${(samples.length / AUDIO_RATE).toFixed(1)}s): ${JSON.stringify(turn.value)}\n`,
      );
      // No response.create here: turn detection starts the reply itself.
      await streamSamples(send, samples);
    }

    // If the next turn is a barge-in, do NOT wait for this reply to finish —
    // there would be nothing left to interrupt.
    if (turns[ti + 1]?.kind === "barge") continue;
    await Promise.race([waitForReply, sleep(45_000)]);
  }

  // Let any trailing events land before closing.
  await sleep(500);
  ws.close(1000, "probe complete");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
