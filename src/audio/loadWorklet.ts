/**
 * Register an AudioWorklet module from a source string.
 *
 * `audioWorklet.addModule()` wants a URL, not code — the worklet runs in its own
 * global scope on the audio thread and has to be fetched. We import the worklet
 * files with Vite's `?raw` suffix (which gives us the source as a string) and
 * wrap it in a Blob URL here.
 *
 * The alternative, `?url`, works in dev and can break in production: Vite may
 * inline small assets as `data:` URLs depending on a size threshold, and
 * `addModule` does not reliably accept those. Going through a Blob behaves
 * identically either way.
 */
export async function addWorkletModule(
  ctx: BaseAudioContext,
  source: string,
): Promise<void> {
  const blob = new Blob([source], { type: "application/javascript" });
  const url = URL.createObjectURL(blob);
  try {
    await ctx.audioWorklet.addModule(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}
