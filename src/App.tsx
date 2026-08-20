import { useCallback, useEffect, useRef, useState } from "react";
import {
  RealtimeClient,
  type Activity,
  type ConnectionState,
  type LogEntry,
} from "./realtime/RealtimeClient";
import {
  emptyTranscript,
  transcriptReducer,
  type TranscriptState,
} from "./state/transcriptStore";
import { DebugDrawer } from "./ui/DebugDrawer";
import { MicButton } from "./ui/MicButton";
import { StatusBar } from "./ui/StatusBar";
import { TranscriptPanel } from "./ui/TranscriptPanel";

/** Ask our own server for a fresh ephemeral key. One per connection. */
async function fetchToken(): Promise<string> {
  const res = await fetch("/api/token");
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body.value as string;
}

export default function App() {
  const [connection, setConnection] = useState<ConnectionState>("idle");
  const [activity, setActivity] = useState<Activity>("idle");
  const [log, setLog] = useState<LogEntry[]>([]);
  const [closeMessage, setCloseMessage] = useState<string | null>(null);
  const [text, setText] = useState("Hi! Say something short so I can check my speakers.");
  const [transcript, setTranscript] = useState<TranscriptState>(emptyTranscript);
  const [micActive, setMicActive] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [micError, setMicError] = useState<string | null>(null);

  // The client outlives re-renders, so it lives in a ref rather than state.
  const clientRef = useRef<RealtimeClient | null>(null);
  if (!clientRef.current) {
    clientRef.current = new RealtimeClient({
      tokenProvider: fetchToken,
      onConnectionState: setConnection,
      onActivity: setActivity,
      onLog: (entry) => setLog((l) => [...l, entry]),
      onClose: (info) => setCloseMessage(info.message),
      onMicChange: setMicActive,
      onMicLevel: setMicLevel,
      // Every server event goes through the reducer. That is the whole wiring:
      // the client knows nothing about the transcript, and the transcript knows
      // nothing about sockets.
      onServerEvent: (evt) => {
        setTranscript((s) => transcriptReducer(s, evt, Date.now()));
      },
    });
  }

  useEffect(() => {
    const client = clientRef.current!;
    return () => void client.close();
  }, []);

  const connect = useCallback(async () => {
    setCloseMessage(null);
    await clientRef.current!.connect();
  }, []);

  const send = useCallback(() => {
    if (!text.trim()) return;
    clientRef.current!.sendUserText(text);
  }, [text]);

  const toggleMic = useCallback(async () => {
    const client = clientRef.current!;
    setMicError(null);
    try {
      if (client.micActive) await client.stopMic();
      else await client.startMic();
    } catch (e) {
      // Denied permission, no input device, or an insecure origin. All three
      // land here and all three are worth telling the user about explicitly.
      setMicError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const isOpen = connection === "open";

  return (
    <main className="app">
      <h1>Higgs Realtime Tutorial</h1>
      <p className="lede">
        The finished app. Ask about something it could not know — the weekend
        weather in Willow Creek, say — and it will search for it and speak what
        it found.
      </p>

      <StatusBar connection={connection} activity={activity} closeMessage={closeMessage} />

      <div className="row">
        <button onClick={connect} disabled={connection === "connecting" || isOpen}>
          {connection === "connecting" ? "Connecting…" : "Connect"}
        </button>
        <button onClick={() => clientRef.current!.disconnect()} disabled={!isOpen}>
          Disconnect
        </button>
      </div>

      <MicButton
        active={micActive}
        level={micLevel}
        disabled={!isOpen}
        onToggle={toggleMic}
      />
      {micError && <p className="error">{micError}</p>}

      <details className="typed">
        <summary>…or type instead (Part 1's path, still here)</summary>
        <div className="row">
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && isOpen && send()}
            placeholder="Type something for the model to say back…"
            disabled={!isOpen}
          />
          <button onClick={send} disabled={!isOpen}>
            Send
          </button>
        </div>
      </details>

      <TranscriptPanel state={transcript} />

      <DebugDrawer entries={log} />
    </main>
  );
}
