// Playback worklet — a ring buffer living on the audio render thread.
//
// WHY A RING BUFFER
//
// The server sends audio much faster than the audio plays. A seven-second reply
// arrives in about one and a quarter seconds, in ~120 separate messages. So you
// cannot "play each chunk as it arrives" — you would be starting a new sound
// every ten milliseconds while the previous one is still going.
//
// Instead the chunks go into a fixed-size buffer as they arrive, and the audio
// hardware pulls samples out of it at a steady 24000 per second. Two pointers:
// `write` (where the next arriving sample goes) and `read` (where the next
// sample to play comes from). Both wrap around the end of the array — hence
// "ring". `read` and `write` can coincide when the buffer is empty or full, so
// `available` distinguishes the two states. If the buffer fills, `read` moves
// forward and the oldest samples are overwritten instead of blocking.
//
// WHY A WORKLET
//
// `process()` is called by the audio hardware itself, on a dedicated real-time
// thread, once per render quantum — currently about 5.3 ms at 24 kHz. It is not
// affected by React re-rendering, a slow network handler, or garbage collection
// on the main thread. That isolation is the whole point: audio that glitches
// whenever the UI is busy is unusable.
//
// PART 2 ADDITION — counting what was handed to the audio output.
//
// `played` counts samples handed from this buffer to the audio output. It is the
// best local proxy for what was heard and the basis of interruption handling:
// when the user talks over the model, the server needs that playback position,
// and only this thread knows it. How much arrived or was queued is a different,
// wrong number.
//
// Messages from the main thread:
//   { type: 'samples', payload: <ArrayBuffer of Int16> }  enqueue audio
//   { type: 'reset' }   zero the played counter (at the start of each response)
//   { type: 'flush' }   drop queued audio, reply { type: 'flushed', played }

class PlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // Twelve seconds of headroom at 24 kHz. Generous on purpose: the model can
    // send a long reply in one burst, and running out of room means dropping
    // audio the user was supposed to hear.
    this.size = 24000 * 12;
    this.ring = new Float32Array(this.size);
    this.read = 0;
    this.write = 0;
    this.available = 0;
    this.played = 0; // samples actually output since the last reset
    this.wasPlaying = false;

    this.port.onmessage = (e) => {
      const d = e.data;
      if (d.type === "samples") {
        this.push(new Int16Array(d.payload));
      } else if (d.type === "flush") {
        // Discard everything queued by moving the read pointer up to the write
        // pointer. Playback stops on the very next render quantum — within a
        // few milliseconds — which is what makes barge-in feel immediate.
        this.available = 0;
        this.read = this.write;
        this.wasPlaying = false;
        this.port.postMessage({ type: "flushed", played: this.played });
      } else if (d.type === "reset") {
        this.played = 0;
      }
    };
  }

  push(int16) {
    for (let i = 0; i < int16.length; i++) {
      // PCM16 samples are integers from -32768 to 32767. The Web Audio API
      // works in floats from -1 to 1. Dividing by 32768 converts between them.
      this.ring[this.write] = int16[i] / 32768;
      this.write = (this.write + 1) % this.size;
      if (this.available < this.size) {
        this.available++;
      } else {
        // Buffer full: overwrite the oldest sample. Dropping the *oldest* audio
        // rather than the newest keeps playback moving forward instead of
        // stalling, which is the less-bad failure.
        this.read = (this.read + 1) % this.size;
      }
    }
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    if (!out) return true;

    let playedAny = false;
    for (let i = 0; i < out.length; i++) {
      if (this.available > 0) {
        out[i] = this.ring[this.read];
        this.read = (this.read + 1) % this.size;
        this.available--;
        this.played++; // <- Part 2: this sample was handed to the audio output
        playedAny = true;
      } else {
        // Nothing buffered. Write silence, not stale data — an "underrun".
        out[i] = 0;
      }
    }

    if (playedAny) {
      this.wasPlaying = true;
    } else if (this.wasPlaying) {
      this.wasPlaying = false;
      this.port.postMessage({ type: "drained" });
    }

    // Returning true keeps the node alive. Return false and the browser is
    // free to garbage-collect it, permanently.
    return true;
  }
}

registerProcessor("playback-processor", PlaybackProcessor);
