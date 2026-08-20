import { SERVER, type ServerEvent } from "../realtime/events";

// The transcript, as a pure function of the event stream.
//
// The naive version of this is an array you push onto, and it does not survive
// contact with the protocol. Three things break it:
//
//  1. One conversation item is built by SEVERAL events. An assistant turn is
//     created by response.output_item.added, filled by a run of transcript
//     deltas, and finalised by transcript.done. A user turn appears when speech
//     starts and only gets its text later, from a separate transcription event.
//
//  2. Events do not arrive in display order. The user's transcript can land
//     after the assistant has already started replying, because transcribing
//     takes time. Appending on arrival would put the answer above the question.
//
//  3. Items get amended after the fact. An interrupted assistant turn has to be
//     marked as interrupted, in place.
//
// So the transcript is an ORDERED LIST KEYED BY item_id: a map from id to item,
// plus an explicit order array. Every event finds its item by id and edits it.
//
// The reducer is a pure function of (state, event, now) — no sockets, no React,
// no clock of its own. That is what makes it testable: feed it a recorded event
// stream and assert the result. See test/transcriptStore.test.ts.

/**
 * PART 4 — a synthetic event type of our own.
 *
 * A tool result is not a server event; we produced it locally. But it belongs
 * in the transcript alongside everything else, so rather than bolting on a
 * second update path, the client emits it through `onServerEvent` with this
 * type and the reducer treats it like any other event.
 */
export const CLIENT_TOOL_RESULT = "client.tool_result";

export type TurnStatus = "pending" | "streaming" | "complete" | "interrupted";
export type ToolStatus = "running" | "ok" | "error";

export interface UserItem {
  kind: "user";
  itemId: string;
  /** null until the transcription arrives. */
  text: string | null;
  status: TurnStatus;
  at: number;
}

export interface AssistantItem {
  kind: "assistant";
  itemId: string;
  text: string;
  status: TurnStatus;
  at: number;
}

export interface SystemItem {
  kind: "system";
  itemId: string;
  text: string;
  at: number;
}

/** PART 4: a tool call, from request through to result. */
export interface ToolItem {
  kind: "tool";
  itemId: string;
  callId: string;
  name: string;
  args: unknown;
  result: unknown | null;
  status: ToolStatus;
  ms: number | null;
  at: number;
}

export type TranscriptItem = UserItem | AssistantItem | SystemItem | ToolItem;

export interface TranscriptState {
  order: string[];
  items: Record<string, TranscriptItem>;
}

export const emptyTranscript: TranscriptState = { order: [], items: {} };

/** The items, in display order. */
export function toList(state: TranscriptState): TranscriptItem[] {
  return state.order.map((id) => state.items[id]);
}

// --- immutable helpers -------------------------------------------------------

/**
 * Add an item, optionally after a given id.
 *
 * `previous_item_id` is on several server events and is how the server tells
 * you where an item belongs. Using it is what keeps a late-arriving item in the
 * right place instead of at the bottom.
 */
function addItem(
  state: TranscriptState,
  item: TranscriptItem,
  prevId?: string | null,
): TranscriptState {
  // Never create the same id twice. Several different events can be the first
  // to mention an item, and whichever gets there first wins.
  if (state.items[item.itemId]) return state;

  let order: string[];
  if (prevId && state.items[prevId]) {
    const idx = state.order.indexOf(prevId);
    order = [...state.order.slice(0, idx + 1), item.itemId, ...state.order.slice(idx + 1)];
  } else {
    order = [...state.order, item.itemId];
  }
  return { order, items: { ...state.items, [item.itemId]: item } };
}

function updateItem(
  state: TranscriptState,
  itemId: string,
  fn: (item: TranscriptItem) => TranscriptItem,
): TranscriptState {
  const cur = state.items[itemId];
  if (!cur) return state;
  const next = fn(cur);
  if (next === cur) return state;
  return { order: state.order, items: { ...state.items, [itemId]: next } };
}

/** Mark any still-streaming assistant turn as interrupted (used on barge-in). */
function markStreamingInterrupted(state: TranscriptState): TranscriptState {
  let changed = false;
  const items = { ...state.items };
  for (const id of state.order) {
    const it = items[id];
    if (it.kind === "assistant" && it.status === "streaming") {
      items[id] = { ...it, status: "interrupted" };
      changed = true;
    }
  }
  return changed ? { order: state.order, items } : state;
}

/** Tool items are addressed by call_id, which is not their item id. */
function findToolByCallId(state: TranscriptState, callId: string): ToolItem | undefined {
  for (const id of state.order) {
    const it = state.items[id];
    if (it.kind === "tool" && it.callId === callId) return it;
  }
  return undefined;
}

function updateToolByCallId(
  state: TranscriptState,
  callId: string,
  fn: (item: ToolItem) => ToolItem,
): TranscriptState {
  const found = findToolByCallId(state, callId);
  if (!found) return state;
  return updateItem(state, found.itemId, (it) => (it.kind === "tool" ? fn(it) : it));
}

function addSystem(state: TranscriptState, text: string, now: number): TranscriptState {
  // System notes are ours, not the server's, so they need an id we invent.
  const itemId = `system-${now}-${state.order.length}`;
  return addItem(state, { kind: "system", itemId, text, at: now });
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

// --- the reducer -------------------------------------------------------------

export function transcriptReducer(
  state: TranscriptState,
  evt: ServerEvent,
  now: number,
): TranscriptState {
  const prevId = (evt.previous_item_id as string | null | undefined) ?? undefined;

  switch (evt.type) {
    case SERVER.speechStarted: {
      const itemId = str(evt.item_id);
      if (!itemId) return state;

      // Two things at once. The user talking means any assistant turn still in
      // flight was cut off...
      const s = markStreamingInterrupted(state);

      // ...and we create the user's bubble immediately, with no text in it.
      //
      // This is the asymmetry that makes user turns awkward: assistant text
      // streams in as it is spoken, but there are NO deltas for user speech.
      // The transcript arrives in one piece, seconds later. Wait for it and the
      // UI looks frozen while you are still talking. So we create a placeholder
      // now, keyed by the item_id this event carries, and fill it in when the
      // transcription lands against that same id.
      return addItem(
        s,
        { kind: "user", itemId, text: null, status: "pending", at: now },
        prevId,
      );
    }

    case SERVER.transcriptionCompleted: {
      const itemId = str(evt.item_id);
      if (!itemId) return state;
      const text = str(evt.transcript) ?? "";

      // Create on demand if we never saw speech_started for this item — e.g.
      // when the store is fed a stream that started mid-conversation.
      let s = state;
      if (!s.items[itemId]) {
        s = addItem(s, { kind: "user", itemId, text: null, status: "pending", at: now }, prevId);
      }
      return updateItem(s, itemId, (it) =>
        it.kind === "user" ? { ...it, text, status: "complete" } : it,
      );
    }

    case SERVER.transcriptionFailed: {
      const itemId = str(evt.item_id);
      if (!itemId) return state;
      // Say so rather than leaving a bubble stuck on "…" forever. The turn
      // still happened; only our text of it is missing.
      return updateItem(state, itemId, (it) =>
        it.kind === "user" ? { ...it, text: "[transcription failed]", status: "complete" } : it,
      );
    }

    case SERVER.outputItemAdded: {
      const item = evt.item as
        | { id?: string; type?: string; role?: string; name?: string; call_id?: string }
        | undefined;
      if (!item?.id) return state;
      if (item.type === "message" && item.role === "assistant") {
        return addItem(
          state,
          { kind: "assistant", itemId: item.id, text: "", status: "streaming", at: now },
          prevId,
        );
      }
      // PART 4: a tool call is an output item too.
      if (item.type === "function_call" && item.name && item.call_id) {
        return addItem(
          state,
          {
            kind: "tool",
            itemId: item.id,
            callId: item.call_id,
            name: item.name,
            args: null,
            result: null,
            status: "running",
            ms: null,
            at: now,
          },
          prevId,
        );
      }
      return state;
    }

    case SERVER.functionCallArgsDone: {
      const callId = str(evt.call_id);
      if (!callId) return state;
      let args: unknown;
      const raw = str(evt.arguments);
      try {
        args = raw !== undefined ? JSON.parse(raw) : undefined;
      } catch {
        args = raw; // show the malformed string rather than dropping it
      }

      // Create on demand: it is not guaranteed that output_item.added arrived
      // first, and this event carries everything needed to build the item.
      const existing = findToolByCallId(state, callId);
      const name = str(evt.name);
      if (!existing && name) {
        return addItem(state, {
          kind: "tool",
          itemId: str(evt.item_id) ?? callId,
          callId,
          name,
          args: args ?? null,
          result: null,
          status: "running",
          ms: null,
          at: now,
        });
      }
      return updateToolByCallId(state, callId, (t) => ({ ...t, args }));
    }

    case CLIENT_TOOL_RESULT: {
      const callId = str(evt.call_id);
      if (!callId) return state;
      const result = evt.result ?? null;
      const obj = result !== null && typeof result === "object" ? (result as Record<string, unknown>) : null;
      const status: ToolStatus = obj && "error" in obj ? "error" : "ok";

      return updateToolByCallId(state, callId, (t) => ({
        ...t,
        result,
        status,
        ms: typeof evt.ms === "number" ? evt.ms : null,
      }));
    }

    case SERVER.audioTranscriptDelta: {
      const itemId = str(evt.item_id);
      if (!itemId) return state;
      const delta = str(evt.delta) ?? "";

      let s = state;
      if (!s.items[itemId]) {
        s = addItem(
          s,
          { kind: "assistant", itemId, text: "", status: "streaming", at: now },
          prevId,
        );
      }
      return updateItem(s, itemId, (it) =>
        it.kind === "assistant"
          ? {
              ...it,
              text: it.text + delta,
              // An interruption sticks. Deltas already in flight when the user
              // barged in must not quietly un-mark the turn.
              status: it.status === "interrupted" ? "interrupted" : "streaming",
            }
          : it,
      );
    }

    case SERVER.audioTranscriptDone: {
      const itemId = str(evt.item_id);
      if (!itemId) return state;
      // `.done` carries the authoritative full text. Prefer it over our
      // accumulated deltas — if we joined them wrongly, this is the fix.
      const authoritative = str(evt.transcript);
      return updateItem(state, itemId, (it) =>
        it.kind === "assistant"
          ? {
              ...it,
              text: authoritative ?? it.text,
              status: it.status === "interrupted" ? "interrupted" : "complete",
            }
          : it,
      );
    }

    case SERVER.idleTimeout:
      return addSystem(state, "session timed out after five minutes of silence", now);
    case SERVER.maxDuration:
      return addSystem(state, "session reached its maximum duration", now);

    default:
      // Unknown events change nothing. The debug drawer still shows them.
      return state;
  }
}

/** Replay a whole event stream. Handy in tests and for loading a capture. */
export function replay(
  events: ServerEvent[],
  startAt = 0,
  state: TranscriptState = emptyTranscript,
): TranscriptState {
  return events.reduce((s, evt, i) => transcriptReducer(s, evt, startAt + i), state);
}

/** The transcript as plain text, for a copy-to-clipboard button. */
export function toPlainText(state: TranscriptState): string {
  return toList(state)
    .map((it) => {
      const t = new Date(it.at).toLocaleTimeString(undefined, { hour12: false });
      switch (it.kind) {
        case "user":
          return `[${t}] You: ${it.text ?? "(transcribing…)"}`;
        case "assistant":
          return `[${t}] Assistant: ${it.text}${it.status === "interrupted" ? " — interrupted" : ""}`;
        case "tool": {
          const args = it.args !== null ? JSON.stringify(it.args) : "";
          const res = it.result !== null ? ` -> ${JSON.stringify(it.result)}` : "";
          return `[${t}] · ${it.name}(${args}) [${it.status}${it.ms != null ? `, ${it.ms}ms` : ""}]${res}`;
        }
        case "system":
          return `[${t}] — ${it.text} —`;
      }
    })
    .join("\n");
}
