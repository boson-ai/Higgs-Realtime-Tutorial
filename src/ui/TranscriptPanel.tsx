import { useEffect, useRef } from "react";
import {
  toList,
  toPlainText,
  type TranscriptItem,
  type TranscriptState,
} from "../state/transcriptStore";

export function TranscriptPanel({ state }: { state: TranscriptState }) {
  const items = toList(state);
  const endRef = useRef<HTMLDivElement>(null);

  // Follow the conversation as it grows.
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [items.length, items[items.length - 1]]);

  if (items.length === 0) {
    return <p className="empty">Start the microphone and say something.</p>;
  }

  return (
    <section className="transcript-panel">
      <div className="transcript-head">
        <span>Transcript</span>
        <button
          className="link"
          onClick={() => void navigator.clipboard.writeText(toPlainText(state))}
        >
          copy
        </button>
      </div>
      {items.map((item) => (
        <TurnBubble key={item.itemId} item={item} />
      ))}
      <div ref={endRef} />
    </section>
  );
}

function TurnBubble({ item }: { item: TranscriptItem }) {
  if (item.kind === "system") {
    return <div className="turn system">— {item.text} —</div>;
  }

  if (item.kind === "tool") {
    const summary =
      item.result && typeof item.result === "object" && "summary" in item.result
        ? String((item.result as { summary: unknown }).summary)
        : null;
    return (
      <div className={`turn tool ${item.status}`}>
        <span className="who">
          {item.name}
          {item.ms != null && <span className="ms"> {item.ms}ms</span>}
        </span>
        <code className="args">{item.args ? JSON.stringify(item.args) : "…"}</code>
        {item.status === "running" && <span className="pending"> running…</span>}
        {summary && <div className="tool-result">{summary}</div>}
      </div>
    );
  }

  if (item.kind === "user") {
    return (
      <div className="turn user">
        <span className="who">you</span>
        {/* text is null until the transcription arrives — which is seconds
            after the words were spoken. Showing the placeholder is what makes
            the UI feel responsive rather than broken. */}
        {item.text === null ? <span className="pending">transcribing…</span> : item.text}
      </div>
    );
  }

  return (
    <div className={`turn assistant ${item.status}`}>
      <span className="who">assistant</span>
      {item.text}
      {item.status === "streaming" && <span className="caret" />}
      {item.status === "interrupted" && <span className="badge">interrupted</span>}
    </div>
  );
}
