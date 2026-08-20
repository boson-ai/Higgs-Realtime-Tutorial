// Capture worklet. Runs on the audio render thread.
//
// It does exactly one job: collect incoming microphone samples into ~100 ms
// frames and post each frame to the main thread.
//
// It deliberately does NOT resample or convert to PCM16. Those happen on the
// main thread in resample.ts, for two reasons: there is then a single
// implementation of the DSP rather than one here and one in a test, and that
// implementation can be unit-tested with ordinary tooling. The audio thread
// should do the least work that gets the job done.
//
// Why 100 ms frames? The audio thread hands us 128 samples at a time, which at
// 48 kHz is 2.7 ms. Sending a WebSocket message every 2.7 ms is a lot of
// messages for no benefit. 100 ms is small enough that the model responds
// promptly and large enough that the overhead disappears. (The API's ceiling is
// far away: one input_audio_buffer.append event may carry up to 1,048,576
// base64 characters, about 15 seconds of 24 kHz audio.)

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // `sampleRate` is a global inside the worklet scope — the real rate of the
    // context, whatever the hardware chose. Do not assume 48000.
    this.frameSize = Math.round(sampleRate * 0.1);
    this.buf = new Float32Array(this.frameSize);
    this.len = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    // No input this quantum. Return true anyway — returning false would let the
    // browser garbage-collect this node and capture would stop for good.
    if (!channel) return true;

    for (let i = 0; i < channel.length; i++) {
      this.buf[this.len++] = channel[i];
      if (this.len === this.frameSize) {
        const frame = this.buf.slice(0, this.frameSize);
        // The second argument transfers the buffer instead of copying it.
        this.port.postMessage(frame.buffer, [frame.buffer]);
        this.buf = new Float32Array(this.frameSize);
        this.len = 0;
      }
    }
    return true;
  }
}

registerProcessor("capture-processor", CaptureProcessor);
