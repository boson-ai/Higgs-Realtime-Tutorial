import { describe, expect, it } from "vitest";
import { dispatch } from "../src/tools/registry";
import { webSearch, allPages } from "../src/tools/handlers";
import {
  CLIENT_TOOL_RESULT,
  emptyTranscript,
  toList,
  transcriptReducer,
} from "../src/state/transcriptStore";
import type { ServerEvent } from "../src/realtime/events";

describe("web_search", () => {
  it("finds a page by a spoken description", () => {
    const r = webSearch({ query: "ferry schedule" });
    expect(r.summary).toContain("ferry");
    expect(r.error).toBeUndefined();
  });

  it("never reads more than three results aloud, but says the real total", () => {
    // Nearly every page mentions the town, so this matches well over three.
    const r = webSearch({ query: "willow creek" });
    const detail = r.detail as { results: unknown[]; total: number; truncated: boolean };
    expect(detail.total).toBeGreaterThan(3);
    expect(detail.results.length).toBeLessThanOrEqual(3);
    // The count must be in the SUMMARY — that is the part the model speaks.
    // Truncating silently would have it claim there were only three.
    expect(r.summary).toMatch(new RegExp(`^${detail.total} result`));
    expect(r.summary).toContain("more.");
  });

  it("accepts the topic shapes models actually send", () => {
    // An enum in the schema is a hint, not a constraint: live models send
    // enum values capitalised, pluralised, or both. A strict comparison would
    // report no results while the index is full of them.
    for (const sent of ["news", "News", "NEWS", " news ", "sport", "Sports", "sciences"]) {
      const r = webSearch({ query: "willow", topic: sent });
      const detail = r.detail as { total: number };
      expect(detail.total, `topic ${JSON.stringify(sent)}`).toBeGreaterThan(0);
    }
  });

  it("ignores an unrecognisable topic instead of filtering everything out", () => {
    const r = webSearch({ query: "willow", topic: "gossip" });
    expect((r.detail as { total: number }).total).toBeGreaterThan(0);
  });

  it("filters by topic", () => {
    const r = webSearch({ query: "willow creek", topic: "sports" });
    const detail = r.detail as { results: { topic: string }[]; total: number };
    expect(detail.total).toBeGreaterThan(0);
    expect(detail.results.every((p) => p.topic === "sports")).toBe(true);
    // The filter must actually exclude something.
    expect(allPages().some((p) => p.topic !== "sports")).toBe(true);
  });

  it("says so plainly when nothing matches", () => {
    const r = webSearch({ query: "cryptocurrency" });
    expect(r.summary).toMatch(/nothing/i);
    expect((r.detail as { total: number }).total).toBe(0);
  });

  it("matches on any word, which is what makes it usable over speech", () => {
    // "flux funicular" is nonsense, but "funicular" is in the index, and
    // returning that page is far more useful than returning nothing. This
    // forgiveness is deliberate: what reaches this function has been through
    // speech recognition, so requiring an exact phrase match would fail
    // constantly on perfectly clear requests.
    const r = webSearch({ query: "flux funicular" });
    expect((r.detail as { total: number }).total).toBeGreaterThan(0);
  });

  it("returns an error result rather than throwing on an empty query", () => {
    expect(webSearch({}).error).toBe("empty_query");
  });
});

describe("dispatch", () => {
  it("answers for a tool that does not exist instead of throwing", async () => {
    // The model can recover from an answer. It cannot recover from silence.
    const r = await dispatch("order_a_pizza", {});
    expect(r.error).toBe("unknown_tool");
    expect(r.summary).toContain("order_a_pizza");
  });
});

describe("tool calls in the transcript", () => {
  const evt = (e: Record<string, unknown>) => e as ServerEvent;

  it("goes running -> ok, keyed by call_id", () => {
    let s = emptyTranscript;
    s = transcriptReducer(
      s,
      evt({
        type: "response.output_item.added",
        item: { id: "i1", type: "function_call", name: "web_search", call_id: "c1" },
      }),
      1,
    );
    expect(toList(s)[0].kind === "tool" && toList(s)[0].kind).toBe("tool");

    s = transcriptReducer(
      s,
      evt({
        type: "response.function_call_arguments.done",
        call_id: "c1",
        name: "web_search",
        arguments: '{"query":"ferry schedule"}',
      }),
      2,
    );
    s = transcriptReducer(
      s,
      evt({ type: CLIENT_TOOL_RESULT, call_id: "c1", result: { summary: "1 result." }, ms: 4 }),
      3,
    );

    const item = toList(s)[0];
    expect(item.kind === "tool" && item.status).toBe("ok");
    expect(item.kind === "tool" && item.ms).toBe(4);
    expect(item.kind === "tool" && (item.args as { query: string }).query).toBe("ferry schedule");
  });

  it("marks a failed tool as an error", () => {
    let s = emptyTranscript;
    s = transcriptReducer(
      s,
      evt({
        type: "response.function_call_arguments.done",
        call_id: "c1",
        name: "web_search",
        arguments: "{}",
      }),
      1,
    );
    s = transcriptReducer(
      s,
      evt({ type: CLIENT_TOOL_RESULT, call_id: "c1", result: { error: "tool_failed" }, ms: 1 }),
      2,
    );
    expect(toList(s)[0].kind === "tool" && toList(s)[0].kind).toBe("tool");
    const item = toList(s)[0];
    expect(item.kind === "tool" && item.status).toBe("error");
  });

  it("shows malformed arguments rather than dropping them", () => {
    let s = emptyTranscript;
    s = transcriptReducer(
      s,
      evt({
        type: "response.function_call_arguments.done",
        call_id: "c1",
        name: "web_search",
        arguments: "{not json",
      }),
      1,
    );
    const item = toList(s)[0];
    expect(item.kind === "tool" && item.args).toBe("{not json");
  });
});
