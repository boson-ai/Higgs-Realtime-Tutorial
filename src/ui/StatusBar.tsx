import type { Activity, ConnectionState } from "../realtime/RealtimeClient";

export function StatusBar({
  connection,
  activity,
  closeMessage,
}: {
  connection: ConnectionState;
  activity: Activity;
  closeMessage: string | null;
}) {
  return (
    <div className="status">
      <span className={`dot dot-${connection}`} aria-hidden />
      <span className="status-text">
        {connection}
        {connection === "open" && activity !== "idle" && ` · ${activity}`}
      </span>
      {/* The close message is the whole point of the close-code table: the user
          should be told "your key expired", not "disconnected". */}
      {closeMessage && <span className="status-close">{closeMessage}</span>}
    </div>
  );
}
