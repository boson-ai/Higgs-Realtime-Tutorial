import playbackWorkletSource from "./worklets/playback-processor.js?raw";
import { addWorkletModule } from "./loadWorklet";
import { AUDIO_RATE } from "../realtime/sessionConfig";

/** base64 text -> the raw bytes it encodes. */
function base64ToBytes(base64: string): ArrayBuffer {
  // Audio cannot travel through a JSON protocol as raw bytes, so the API
  // base64-encodes it. `atob` reverses that, giving a string whose character
  // codes are the byte values.
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/**
 * Plays the audio the model sends us.
 *
 * The interesting work happens in the worklet (see
 * `worklets/playback-processor.js`); this class is the main-thread handle for
 * it — set up the AudioContext, decode base64, hand the bytes over.
 */
export class RingPlayer {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private initPromise: Promise<void> | null = null;
  private readonly onSpeakingChange?: (speaking: boolean) => void;
  /** Resolvers waiting for a `flushed` reply from the worklet. */
  private pendingFlush: Array<(ms: number) => void> = [];

  constructor(onSpeakingChange?: (speaking: boolean) => void) {
    this.onSpeakingChange = onSpeakingChange;
  }

  private ensureInit(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      // Request the same rate the API is sending. If the context ran at a
      // different rate the browser would resample for us, which sounds fine but
      // breaks the sample-counting we rely on in Part 2.
      const ctx = new AudioContext({ sampleRate: AUDIO_RATE });
      await addWorkletModule(ctx, playbackWorkletSource);

      const node = new AudioWorkletNode(ctx, "playback-processor", {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });

      node.port.onmessage = (e: MessageEvent) => {
        const d = e.data as { type: string; played?: number };
        if (d.type === "flushed") {
          // Samples -> milliseconds. This division is only correct because the
          // context runs at the same rate the API sends at (see AUDIO_RATE).
          const ms = ((d.played ?? 0) / AUDIO_RATE) * 1000;
          this.pendingFlush.shift()?.(ms);
          this.onSpeakingChange?.(false);
        } else if (d.type === "drained") {
          this.onSpeakingChange?.(false);
        }
      };

      node.connect(ctx.destination);
      this.ctx = ctx;
      this.node = node;

      if (ctx.sampleRate !== AUDIO_RATE) {
        console.warn(
          `AudioContext is running at ${ctx.sampleRate} Hz, not ${AUDIO_RATE}. ` +
            `Playback will still work, but Part 2's truncate timing will drift.`,
        );
      }
    })();
    return this.initPromise;
  }

  /**
   * Browsers refuse to start audio until the user has interacted with the page,
   * so this has to be called from inside a click handler — we call it from
   * "Connect". Creating the context outside a gesture leaves it `suspended` and
   * everything is silent with no error anywhere.
   */
  async resume(): Promise<void> {
    await this.ensureInit();
    if (this.ctx?.state === "suspended") await this.ctx.resume();
  }

  /** Hand one base64 PCM16 chunk to the ring buffer. */
  enqueueBase64(base64: string): void {
    if (!this.node) return;
    const buf = base64ToBytes(base64);
    // The second argument transfers ownership of the buffer to the audio thread
    // instead of copying it. At ~120 chunks per reply the copies would add up.
    this.node.port.postMessage({ type: "samples", payload: buf }, [buf]);
    this.onSpeakingChange?.(true);
  }

  /**
   * Zero the played-sample counter. Call at the start of each assistant turn,
   * so `flush()` reports milliseconds into *this* reply rather than into the
   * whole session.
   */
  reset(): void {
    this.node?.port.postMessage({ type: "reset" });
  }

  /**
   * Stop playing immediately, discarding whatever is queued.
   *
   * Resolves with how many milliseconds were actually played since the last
   * `reset()` — the number the server needs in `conversation.item.truncate`.
   * It has to come back asynchronously because only the audio thread knows it.
   */
  flush(): Promise<number> {
    if (!this.node) return Promise.resolve(0);
    return new Promise((resolve) => {
      this.pendingFlush.push(resolve);
      this.node!.port.postMessage({ type: "flush" });
    });
  }

  async close(): Promise<void> {
    if (this.ctx) {
      await this.ctx.close();
      this.ctx = null;
      this.node = null;
      this.initPromise = null;
    }
  }
}
