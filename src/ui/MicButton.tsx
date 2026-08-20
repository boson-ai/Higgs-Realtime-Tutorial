/**
 * The microphone toggle, plus a level meter.
 *
 * The meter is not decoration. When the model does not respond, there are two
 * very different causes — the browser is not capturing anything, or it is
 * capturing fine and the server is not treating it as speech — and they need
 * completely different fixes. The meter tells them apart in one glance, which
 * is why it is here in Part 2 rather than being left as an exercise.
 */
export function MicButton({
  active,
  level,
  disabled,
  onToggle,
}: {
  active: boolean;
  level: number;
  disabled: boolean;
  onToggle: () => void;
}) {
  // RMS for speech sits around 0.02–0.2, so a linear bar barely moves. The
  // square root spreads the quiet end out where the interesting part is.
  const pct = Math.min(100, Math.sqrt(level) * 180);
  const silent = active && level < 0.001;

  return (
    <div className="mic">
      <button onClick={onToggle} disabled={disabled} className={active ? "mic-on" : ""}>
        {active ? "◼ Stop microphone" : "● Start microphone"}
      </button>

      <div className="meter" title={`RMS ${level.toFixed(4)}`}>
        <div className="meter-fill" style={{ width: `${pct}%` }} />
      </div>

      {silent && (
        <span className="meter-warn">
          silent — check the input device and the tab's mic permission
        </span>
      )}
    </div>
  );
}
