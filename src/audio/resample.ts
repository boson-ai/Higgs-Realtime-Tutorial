// Turning microphone audio into what the API wants.
//
// Two conversions happen here, and both are pure functions of their input,
// which is why they live in a plain module with a unit test rather than inside
// the worklet.

export interface Resampler {
  /** Resample one block of input. Call repeatedly; state carries across calls. */
  process(input: Float32Array): Float32Array;
}

interface Biquad {
  process(input: Float32Array): Float32Array;
}

/**
 * A second-order Butterworth low-pass filter (the RBJ cookbook formulation),
 * holding its state across blocks.
 *
 * WHY YOU NEED THIS
 *
 * Your microphone almost certainly runs at 48 kHz, and we are sending 24 kHz.
 * A 24 kHz stream can only represent frequencies up to 12 kHz — that limit is
 * half the sample rate, and it is called the Nyquist frequency. The reason is
 * intuitive enough: it takes at least two samples to describe one cycle of a
 * wave, one for the peak and one for the trough.
 *
 * So what happens to the 15 kHz content that was in the original? It does not
 * vanish. It *folds back* into the audible range and reappears as a lower
 * frequency that was never there — 15 kHz becomes a spurious 9 kHz. This is
 * called aliasing, and it is the audio equivalent of the moiré pattern you get
 * photographing a striped shirt.
 *
 * The fix is to remove those frequencies before throwing samples away. That is
 * what this filter does.
 *
 * The symptom if you skip it is genuinely confusing: the speech-to-speech model
 * copes with the added noise fairly well, but the *transcript* gets noticeably
 * worse. So your app appears to understand you while printing something
 * garbled, and you go looking for a bug in the transcription code.
 */
function createLowpass(cutoff: number, sampleRate: number, q = 0.707): Biquad {
  const w0 = (2 * Math.PI * cutoff) / sampleRate;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const alpha = sin / (2 * q);
  const a0 = 1 + alpha;
  const b0 = (1 - cos) / 2 / a0;
  const b1 = (1 - cos) / a0;
  const b2 = (1 - cos) / 2 / a0;
  const a1 = (-2 * cos) / a0;
  const a2 = (1 - alpha) / a0;

  // The filter's memory: the last two inputs and the last two outputs. These
  // persist between blocks — reset them and you get a click at every boundary.
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;

  return {
    process(input: Float32Array): Float32Array {
      const out = new Float32Array(input.length);
      for (let i = 0; i < input.length; i++) {
        const x = input[i];
        const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        x2 = x1;
        x1 = x;
        y2 = y1;
        y1 = y;
        out[i] = y;
      }
      return out;
    },
  };
}

/**
 * Convert a stream of audio from one sample rate to another.
 *
 * Resampling is interpolation. To go from 48000 to 24000 you want the value at
 * every 2nd input sample; to go from 44100 to 24000 you want the value at every
 * 1.8375th sample — which does not exist, so you estimate it from its two
 * neighbours. That is linear interpolation, and for speech it is plenty.
 *
 * The important word above is *stream*. This is called once per ~100 ms block,
 * and the fractional read position and the filter state have to carry from one
 * block to the next. If each block were resampled independently you would get a
 * tiny discontinuity at every boundary — ten audible clicks per second.
 */
export function createResampler(inputRate: number, outputRate: number): Resampler {
  // How many input samples to advance for each output sample.
  const ratio = inputRate / outputRate;

  // Anti-aliasing only applies when downsampling. Cut just under the output
  // Nyquist (0.45 rather than 0.5) to leave the filter room to roll off.
  const lowpass = ratio > 1 ? createLowpass(outputRate * 0.45, inputRate) : null;

  let prev = 0; // last sample of the previous block
  let havePrev = false;
  let pos = 0; // fractional read position carried across blocks

  return {
    process(rawInput: Float32Array): Float32Array {
      if (rawInput.length === 0) return new Float32Array(0);
      if (ratio === 1) return rawInput.slice();

      const input = lowpass ? lowpass.process(rawInput) : rawInput;

      // Prepend the previous block's final sample so interpolation can span the
      // seam between blocks.
      let buf: Float32Array;
      if (havePrev) {
        buf = new Float32Array(input.length + 1);
        buf[0] = prev;
        buf.set(input, 1);
      } else {
        buf = input;
      }

      const out: number[] = [];
      let p = pos;
      while (p + 1 < buf.length) {
        const i = p | 0; // integer part: the sample before our position
        const frac = p - i; // fractional part: how far between it and the next
        out.push(buf[i] * (1 - frac) + buf[i + 1] * frac);
        p += ratio;
      }

      prev = buf[buf.length - 1];
      havePrev = true;
      // Where we landed, relative to the start of the next block.
      pos = Math.max(0, p - (buf.length - 1));

      return Float32Array.from(out);
    },
  };
}

/**
 * Float samples (−1 to 1, what the Web Audio API uses) to PCM16 bytes (−32768
 * to 32767, what the API wants).
 *
 * Note the asymmetry: negative values scale by 32768 and positive by 32767,
 * because a signed 16-bit integer has one more step below zero than above it.
 * The clamp matters too — a sample slightly over 1.0 would wrap around to a
 * large negative number and produce a loud click instead of a quiet one.
 */
export function floatTo16BitPCM(input: Float32Array): ArrayBuffer {
  const pcm = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return pcm.buffer;
}
