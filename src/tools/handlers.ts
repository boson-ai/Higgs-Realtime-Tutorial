import index from "./searchIndex.json";

export interface Page {
  title: string;
  topic: string;
  snippet: string;
}

/**
 * The result shape every tool returns.
 *
 * `summary` is written to be SPOKEN. `detail` is the structured data behind it.
 * Both go back to the model, and the split matters more than it looks — see the
 * "shaping results for a voice" section of docs/part-4.md.
 */
export interface ToolResult {
  summary: string;
  detail?: unknown;
  error?: string;
}

// The whole "web", loaded from the single JSON file.
//
// This tool is a dummy on purpose. The tutorial is about the tool-calling
// PROTOCOL — registering a tool, running it, answering the model — and none of
// that changes when the implementation behind it does. In a real app this file
// is where you would call a real search API; everything around it stays the
// same.
const PAGES: Page[] = (index as { pages: Page[] }).pages;

export function allPages(): Page[] {
  return PAGES;
}

/** How many results the model may hear about at once. */
const MAX_SPOKEN_RESULTS = 3;

function describe(p: Page): string {
  return `${p.title}: ${p.snippet}`;
}

/**
 * Normalise a topic the model sent us.
 *
 * ⚠ An `enum` in the schema is a strong hint, not a constraint. Live models
 * routinely send an enum value capitalised, pluralised, or both — we have
 * watched it happen with a schema exactly like this one.
 *
 * A strict `p.topic === args.topic` comparison would then match nothing and
 * report "no results" about an index full of them. That is the worst class of
 * bug in a voice app: a confident, wrong, spoken answer.
 *
 * So normalise on the way in, and treat anything unrecognised as "no filter"
 * rather than as "filter everything out".
 */
function normalizeTopic(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim().toLowerCase();
  const known = new Set(PAGES.map((p) => p.topic));
  if (known.has(t)) return t; // "News" -> "news"
  const stripped = t.replace(/e?s$/, "");
  if (known.has(stripped)) return stripped; // "sciences" -> "science"
  if (known.has(`${stripped}s`)) return `${stripped}s`; // "sport" -> "sports"
  return null; // unknown: don't filter
}

export function webSearch(args: Record<string, unknown>): ToolResult {
  const query = String(args.query ?? "").trim().toLowerCase();
  const topic = normalizeTopic(args.topic);

  if (!query && !topic) {
    return { summary: "I need something to search for.", error: "empty_query" };
  }

  // Deliberately forgiving matching. What arrives here has been through speech
  // recognition, so "ferry schedule" may well turn up as "fairy schedule".
  // Splitting the query into words and requiring any of them to hit is far
  // more useful than an exact match.
  const words = query.split(/\s+/).filter((w) => w.length > 1);
  let hits = PAGES.filter((p) => {
    if (topic && p.topic !== topic) return false;
    if (words.length === 0) return true;
    const haystack = `${p.title} ${p.topic} ${p.snippet}`.toLowerCase();
    return words.some((w) => haystack.includes(w));
  });

  // Best matches first: more query words hit = better.
  hits = hits.sort((a, b) => score(b, words) - score(a, words));

  if (hits.length === 0) {
    return {
      summary: `The search found nothing about "${args.query}".`,
      detail: { results: [], total: 0 },
    };
  }

  const shown = hits.slice(0, MAX_SPOKEN_RESULTS);
  const more = hits.length - shown.length;

  return {
    // The count goes in the summary so the model can say "six results, here
    // are the closest three" instead of either reading six aloud or pretending
    // there were only three.
    summary:
      `${hits.length} result${hits.length === 1 ? "" : "s"}. ` +
      shown.map(describe).join("; ") +
      (more > 0 ? `; and ${more} more.` : "."),
    detail: { results: shown, total: hits.length, truncated: more > 0 },
  };
}

function score(p: Page, words: string[]): number {
  const haystack = `${p.title} ${p.topic} ${p.snippet}`.toLowerCase();
  return words.filter((w) => haystack.includes(w)).length;
}

export const handlers: Record<string, (args: Record<string, unknown>) => ToolResult> = {
  web_search: webSearch,
};
