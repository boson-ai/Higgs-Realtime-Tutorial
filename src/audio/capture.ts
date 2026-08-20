import captureWorkletSource from "./worklets/capture-processor.js?raw";
import { addWorkletModule } from "./loadWorklet";
import { createResampler, floatTo16BitPCM, type Resampler } from "./resample";
import { AUDIO_RATE } from "../realtime/sessionConfig";

/**
 * base64-encode an ArrayBuffer.
 *
 * The chunking is not decoration. `String.fromCharCode(...bytes)` spreads every
 * byte into a separate argument, and a 100 ms frame is ~4800 of them. Push a
 * large enough frame through and you get "Maximum call stack size exceeded"
 * from a line that looks completely innocent.
 */
function base64FromBuffer(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * The input half of the pipeline:
 *
 *   getUserMedia -> AudioWorklet -> resample to 24 kHz -> PCM16 -> base64
 *
 * Each ~100 ms frame is handed to `onChunk`, which sends it as
 * `input_audio_buffer.append`.
 */
export class MicCapture {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: AudioWorkletNode | null = null;
  private resampler: Resampler | null = null;
  private readonly onChunk: (base64: string) => void;
  private readonly onLevel?: (rms: number) => void;

  constructor(onChunk: (base64: string) => void, onLevel?: (rms: number) => void) {
    this.onChunk = onChunk;
    this.onLevel = onLevel;
  }

  get active(): boolean {
    return this.node !== null;
  }

  async start(): Promise<void> {
    if (this.node) return;

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        // Echo cancellation on: without it the microphone hears the model
        // through your speakers, the server's VAD treats that as you talking,
        // and the conversation interrupts itself. Wear headphones and it stops
        // mattering; most people will not.
        echoCancellation: true,
        // Browser noise suppression off. It is tuned for human listeners on a
        // call, and it removes quiet speech along with the noise. Leave the
        // audio raw and let the model decide what matters.
        noiseSuppression: false,
        autoGainControl: true,
        channelCount: 1,
      },
    });

    // No sampleRate here on purpose: use the browser-selected graph rate,
    // normally the output device's preferred rate. A microphone track at a
    // different rate is converted as it enters the graph; we then resample the
    // context's actual rate to the API's 24 kHz ourselves.
    const ctx = new AudioContext();
    this.ctx = ctx;
    await addWorkletModule(ctx, captureWorkletSource);

    this.resampler = createResampler(ctx.sampleRate, AUDIO_RATE);
    this.source = ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(ctx, "capture-processor", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });

    this.node.port.onmessage = (e: MessageEvent) => {
      const frame = new Float32Array(e.data as ArrayBuffer);

      if (this.onLevel) {
        // RMS — root mean square — is the standard way to measure "how loud is
        // this block". Square every sample (so negatives count), average, take
        // the square root. It powers the level meter, which is the single most
        // useful diagnostic in this part: it tells you whether the microphone
        // is producing anything at all, separately from whether the model is
        // hearing you.
        let sum = 0;
        for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
        this.onLevel(Math.sqrt(sum / frame.length));
      }

      const resampled = this.resampler!.process(frame);
      if (resampled.length === 0) return;
      this.onChunk(base64FromBuffer(floatTo16BitPCM(resampled)));
    };

    // The worklet only runs if it is connected to something that pulls on it.
    // Our node produces no output, so the destination stays silent — this
    // connection exists purely to keep the graph alive. Skip it and `process()`
    // is never called, with no error to tell you why.
    this.source.connect(this.node);
    this.node.connect(ctx.destination);

    if (ctx.state === "suspended") await ctx.resume();
  }

  async stop(): Promise<void> {
    this.node?.port.close();
    this.source?.disconnect();
    this.node?.disconnect();
    // Stopping the tracks is what turns off the browser's recording indicator.
    // Leave them running and the tab looks like it is still listening.
    this.stream?.getTracks().forEach((t) => t.stop());
    if (this.ctx) await this.ctx.close();
    this.ctx = null;
    this.stream = null;
    this.source = null;
    this.node = null;
    this.resampler = null;
  }
}
