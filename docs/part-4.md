# Part 4 — Tool calling

**By the end of this part** the model can look things up. Ask "what's the weather this
weekend in Willow Creek?" and it will run a search, and tell you what it found, out loud,
with the actual facts from the results.

The "web" it searches is `src/tools/searchIndex.json` — ten short pages about a fictional
town. One file, no network, everything resets on reload.

**The tool is a dummy, and that is deliberate.** This part is about the tool-calling
*protocol* — how a tool is registered, how the model asks for it, how you answer — and none
of that changes when the implementation behind it does. The handler is the one place a real
app would differ: where this repo greps a JSON file, you would call a real search API. Every
line around it stays the same.

Making the results fictional also buys you something a real search API cannot: **proof the
tool ran.** Nothing on the real internet knows who won the Willow Creek regional final. If
the model tells you the Otters took it 3 to 2, it read your file — it cannot have known.

---

## Registering a tool

Tools go in `session.update` as ordinary JSON Schema:

```ts
{
  type: "function",
  name: "web_search",
  description:
    "Search the web. Call this whenever the user asks about anything current " +
    "or local — news, weather, sport results, opening hours — or anything you " +
    "are not sure of, rather than guessing. …",
  parameters: {
    type: "object",
    properties: { query: { type: "string", description: "…" } },
    required: ["query"],
  },
}
```

That is the whole registration. There is no callback to attach and nothing that says "this
one runs on the client" — the server has no way to run your code, so *every* tool is
client-executed by definition. (The server does label them: the `function_call` item it
sends back carries `"executor": "client"`. You do not send that; it tells you.)

**Write the description for the model, not for a reader.** The most useful sentence in the
one above is not what the tool does — it is *when to call it*. "Call this whenever the user
asks about anything current or local … rather than guessing" is what stops the model
answering from stale memory instead of looking something up.

---

## The loop

```
model decides to call a tool
        │
        ▼
response.function_call_arguments.done   ← name, call_id, arguments (a JSON string)
        │
        ▼
you run the tool
        │
        ▼
conversation.item.create { type: "function_call_output", call_id, output }
        │
        ▼
response.create          ← mandatory
        │
        ▼
model speaks the answer
```

Two things in that diagram cause most of the bugs.

**`output` is a string.** It carries structured data, but the field is a string, so it
needs `JSON.stringify`. Pass an object and the model receives the characters
`[object Object]`, which it will do its confident best with.

**`response.create` is mandatory.** Without it, the model has your result and simply says
nothing. There is no error and no event — the same silent failure as forgetting it in
Part 1, in a place where you are less likely to suspect it.

---

## Parallel calls

The model can ask for several tools in one turn. The rule is: **one
`function_call_output` per `call_id`, then exactly one `response.create`.**

```ts
private async flushToolBatch(): Promise<void> {
  const batch = this.toolBatch;
  this.toolBatch = null;

  // Promise.all, not a loop with await: two independent lookups should take as
  // long as the slower one, not as long as both.
  await Promise.all(batch.promises);

  for (const out of batch.outputs) this.send(out);
  this.send(responseCreate());  // ONE, after all of them
}
```

Miss an output and the model waits forever for a `call_id` it never hears back about. Send
`response.create` once per tool instead of once per turn, and you get two replies talking
over each other — which in a voice app is immediately, audibly wrong.

---

## ⚠ Gotcha: guard against running a call twice

Keep a `Set` of `call_id`s you have already started:

```ts
private startToolCall(callId: string, name: string, args: Record<string, unknown>): void {
  if (this.handledCallIds.has(callId)) return;
  this.handledCallIds.add(callId);
  // …
}
```

The reason is that tool calls can be announced twice — once by
`function_call_arguments.done` and again in `response.done`'s `output` array.

---

## Shaping results for a voice

Every tool returns the same shape:

```ts
export interface ToolResult {
  summary: string;   // written to be SPOKEN
  detail?: unknown;  // the structured data behind it
  error?: string;
}
```

Both halves go back to the model, and the split does real work.

**Cap the list and put the count in the summary.** A search matching eight pages must not
send eight back — the model will try to read them out, and a spoken list of eight results
is useless to a human. Three, plus the true total:

```ts
summary:
  `${hits.length} results. ` +
  shown.map(describe).join("; ") +
  (more > 0 ? `; and ${more} more.` : "."),
```

The count belongs in the **summary**, not only in `detail`. Truncate silently and the model
says "I found three" about eight — technically it read what you gave it, but you made it
lie.

Here is that working, recorded live on 2026-08-17:

> **You:** "What's the weather this weekend in Willow Creek?"
> **Assistant:** "Let me check the forecast for Willow Creek this weekend."
> *`web_search({"query":"Willow Creek weather this weekend","topic":"weather"})`*
> **Assistant:** "Saturday looks a bit rainy with a high of 16 degrees, but Sunday clears
> up nicely to 19."

Two things worth noticing. The acknowledgement before the tool call — "let me check" —
comes from one line in the system prompt, and it is what keeps a slow lookup from sounding
like a dropped connection. And the answer is *composed from* the result rather than read
off it: the summary said "light rain", the model said "a bit rainy". That is the division
of labour working — you supply the facts, it supplies the conversation.

**Never throw.** A tool that throws leaves the model waiting on a `call_id` that never
comes back. Return the failure as a result instead:

```ts
result = { summary: "That lookup failed.", error: "tool_failed" };
```

The model can recover from an answer. It cannot recover from silence.

---

## In the transcript

Tool calls are conversation items like any other, so they go through the same reducer. The
one wrinkle is that they are addressed by **`call_id`**, which is not their `item_id` —
`function_call_arguments.done` and the result carry the former, `output_item.added` carries
both.

The result is not a server event at all; we computed it locally. Rather than add a second
update path, the client emits it through the same callback with a type of our own:

```ts
export const CLIENT_TOOL_RESULT = "client.tool_result";
```

One event stream in, one reducer, one transcript.

---

## ✅ Acceptance check

```bash
npm test
```

31 tests, including the tool handler and its transcript items.

**Without a browser**, the whole loop:

```bash
npm run probe -- --say "what's the weather this weekend in Willow Creek?"
```

The probe runs tools through the same registry the browser uses, so you should see the
call, the result, and then the model speaking the answer. Recorded on 2026-08-17:

```
[  4930ms] response.function_call_arguments.done  web_search({"query": "Willow Creek weather this weekend", "topic": "weather"})
        ↳ web_search -> 1 result. Willow Creek weekend forecast: Saturday brings light rain and a high of 16 degrees; …
[  5338ms] …transcript.done  "Let me check the forecast for Willow Creek this weekend."
[  7122ms] …transcript.done  "Saturday looks a bit rainy with a high of 16 degrees, but Sunday clears up nicely to 19."
```

**In the browser** (`npm run dev`):

1. **Ask about something in the index.** "Who won the Willow Creek regional final?" The
   transcript should show a `web_search` chip with its arguments and timing, then a spoken
   answer with the facts from `searchIndex.json`. Change the score in that file, reload,
   and ask again — the answer must change. That check is worth doing once, because a model
   that is *not* calling the tool sounds exactly the same.
2. **Ask something that matches many pages.** "What's going on in Willow Creek?" It should
   say how many results there were and read at most three.
3. **Ask about something absent.** "What's the price of bitcoin?" It should say the search
   found nothing, not invent an answer.

---

**Next:** [Part 5 — Prompting](part-5.md), where the system prompt stops being an
afterthought.

---

*API facts on this page were verified against the live documentation on 2026-08-07 and
against live sessions on 2026-08-07 and 2026-08-17:
[Tool use](https://docs.boson.ai/models/higgs-realtime/guides/tool-calling.md),
[Client events](https://docs.boson.ai/api-reference/realtime/client-events.md),
[Server events](https://docs.boson.ai/api-reference/realtime/server-events.md).*
