import { useState } from "react";
import type { LogEntry } from "../realtime/RealtimeClient";

/**
 * Every event, in order, verbatim.
 *
 * This is not a nice-to-have. The Realtime API is a stream of events you did not
 * write and cannot step through in a debugger; the drawer is how you find out
 * what the server actually said, as opposed to what you assumed. Keep it in the
 * app for the rest of the tutorial — every later part is easier to debug with it
 * open.
 */
export function DebugDrawer({ entries }: { entries: LogEntry[] }) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);

  return (
    <section className={`drawer ${open ? "open" : ""}`}>
      <button className="drawer-toggle" onClick={() => setOpen((o) => !o)}>
        {open ? "▼" : "▶"} Event log ({entries.length})
      </button>

      {open && (
        <ol className="drawer-list">
          {entries.map((e) => (
            <li key={e.id} className={`entry dir-${e.dir}`}>
              <button
                className="entry-head"
                onClick={() => setExpanded(expanded === e.id ? null : e.id)}
              >
                <span className="arrow">
                  {e.dir === "send" ? "↑" : e.dir === "recv" ? "↓" : "·"}
                </span>
                <code>{e.type}</code>
                <span className="time">
                  {new Date(e.at).toLocaleTimeString(undefined, { hour12: false })}
                </span>
              </button>
              {expanded === e.id && (
                <pre className="entry-body">{formatPayload(e.raw)}</pre>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/**
 * Audio deltas are ~1300 characters of base64 each and there are a hundred-odd
 * per reply. Printed in full they bury everything else, so shorten them to
 * something you can still recognise.
 */
function formatPayload(raw: unknown): string {
  if (typeof raw === "string") return raw;
  const replacer = (_key: string, value: unknown) =>
    typeof value === "string" && value.length > 120
      ? `${value.slice(0, 60)}… (${value.length} chars)`
      : value;
  return JSON.stringify(raw, replacer, 2);
}
