import { describe, expect, it } from "vitest";
import { createResampler, floatTo16BitPCM } from "../src/audio/resample";

/** A sine wave at `freq` Hz, `n` samples long, sampled at `rate`. */
function sine(freq: number, rate: number, n: number, phase = 0): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.sin(2 * Math.PI * freq * ((i + phase) / rate));
  return out;
}

describe("createResampler", () => {
  it("halves the sample count going 48k -> 24k", () => {
    const r = createResampler(48000, 24000);
    const out = r.process(sine(440, 48000, 4800));
    // Allow a sample of slack: the fractional read position carries between
    // blocks, so an individual block can come up one short.
    expect(out.length).toBeGreaterThanOrEqual(2399);
    expect(out.length).toBeLessThanOrEqual(2400);
  });

  it("passes audio through unchanged when the rates match", () => {
    const r = createResampler(24000, 24000);
    const input = sine(440, 24000, 240);
    expect(Array.from(r.process(input))).toEqual(Array.from(input));
  });

  it("keeps the sample budget over many blocks", () => {
    // Ten blocks of 100 ms at 48 kHz should yield ~1 s of 24 kHz audio. If the
    // fractional position were reset each block, the count would drift.
    const r = createResampler(48000, 24000);
    let total = 0;
    for (let i = 0; i < 10; i++) total += r.process(sine(440, 48000, 4800, i * 4800)).length;
    expect(Math.abs(total - 24000)).toBeLessThanOrEqual(2);
  });

  it("does not click at block boundaries", () => {
    // The real regression this guards. Resample a continuous sine in two
    // blocks; if state were dropped between them, the seam would show up as a
    // sample-to-sample jump far larger than the wave's own slope.
    const r = createResampler(48000, 24000);
    const a = r.process(sine(440, 48000, 4800));
    const b = r.process(sine(440, 48000, 4800, 4800));
    const joined = Float32Array.from([...a, ...b]);

    let maxStep = 0;
    for (let i = 1; i < joined.length; i++) {
      maxStep = Math.max(maxStep, Math.abs(joined[i] - joined[i - 1]));
    }
    // A 440 Hz sine at 24 kHz moves at most ~0.115 per sample.
    expect(maxStep).toBeLessThan(0.2);
  });

  it("attenuates content above the output Nyquist instead of aliasing it", () => {
    // 11 kHz survives a 24 kHz stream (Nyquist is 12 kHz); 20 kHz cannot, and
    // without the low-pass it would fold back in as a loud spurious tone.
    const rms = (x: Float32Array) =>
      Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);

    const low = createResampler(48000, 24000).process(sine(1000, 48000, 9600));
    const high = createResampler(48000, 24000).process(sine(20000, 48000, 9600));

    expect(rms(low)).toBeGreaterThan(0.5);
    expect(rms(high)).toBeLessThan(0.1);
  });
});

describe("floatTo16BitPCM", () => {
  it("maps the full range without wrapping", () => {
    const pcm = new Int16Array(floatTo16BitPCM(Float32Array.from([0, 1, -1, 0.5])));
    expect(pcm[0]).toBe(0);
    expect(pcm[1]).toBe(32767);
    expect(pcm[2]).toBe(-32768);
    expect(pcm[3]).toBe(16383);
  });

  it("clamps out-of-range samples rather than wrapping them", () => {
    // Wrapping instead of clamping turns a slightly-too-loud sample into a
    // full-scale sample of the opposite sign: a click, not a quiet moment.
    const pcm = new Int16Array(floatTo16BitPCM(Float32Array.from([1.5, -1.5])));
    expect(pcm[0]).toBe(32767);
    expect(pcm[1]).toBe(-32768);
  });

  it("produces two bytes per sample", () => {
    expect(floatTo16BitPCM(new Float32Array(100)).byteLength).toBe(200);
  });
});
