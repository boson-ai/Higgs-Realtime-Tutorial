# Part 5 — Prompting

**By the end of this part** the system prompt stops being an afterthought: it has a
structure, and each line of it earns its place.

Everything else in this tutorial was code. This part is not, and that is exactly why it
gets a part: the prompt is the one piece of the app you will keep tuning after the code is
done, and it is the piece where well-intentioned changes backfire most quietly.

---

## How to prompt Higgs Realtime

Higgs Realtime prompts should describe how the assistant behaves in conversation, rather
than script every possible response. Keep the prompt focused on a few behaviors users can
actually hear.

### 1. Define the role and capabilities

Briefly state who the assistant is, what it is designed to do, and which tools it can use.
Avoid lengthy product descriptions or exhaustive capability lists.

### 2. Optimize for spoken interaction

Ask for responses that are natural, concise, and easy to follow aloud. Avoid
screen-oriented formatting such as tables, long lists, raw URLs, and notation that does not
translate well to speech.

### 3. Use concrete style instructions

Vague instructions such as "sound natural" are usually not enough. Describe observable
behavior instead — for example, matching the user's energy, avoiding excessive
acknowledgements, and not adding details the user did not request.

### 4. Guide turn-taking

Specify how proactive the assistant should be. Good voice assistants may ask a short
follow-up or suggest a next step, but should avoid interrogating the user, taking over the
conversation, or responding too aggressively to incomplete speech.

### 5. Define tool-use and freshness rules

If the assistant can search or use external tools, explain when it should do so. General
rules such as verifying time-sensitive or uncertain information are usually more robust
than enumerating every possible topic.

### 6. Keep rules prioritized and testable

Organize the prompt around a small number of priorities. Add narrow exceptions only when
they address a recurring failure mode. Test the prompt with short questions, vague
requests, interruptions, current-information queries, and casual conversation.

A practical structure is:

1. Role and capabilities
2. Speaking style
3. Turn-taking behavior
4. Tool-use policy
5. Spoken-output constraints

The goal is not to control every sentence. It is to establish a consistent conversational
policy while leaving the model enough flexibility to respond naturally.

---

## The structure, applied

This repo's prompt, in `src/realtime/sessionConfig.ts`, follows that structure line for
line:

```ts
export const SYSTEM_PROMPT = [
  // Role and capabilities.
  "You are a friendly voice assistant with one tool: a web search.",
  // Speaking style.
  "Keep every reply to one or two short sentences, matching the user's energy.",
  "You are speaking aloud, not writing — no lists, no markdown, no emoji, no URLs.",
  // Turn-taking.
  "A short follow-up question is fine; do not interrogate, and do not add",
  "detail the user did not ask for.",
  // Tool use.
  "When the user asks about anything current, local, or uncertain, search",
  "rather than guessing, and say a short acknowledgement before you do.",
  // Spoken-output constraints.
  "Never read more than three results aloud; say how many there were and offer",
  "to narrow it down. If the search finds nothing, say so plainly. Never invent",
  "a fact you have not just read from a result.",
].join(" ");
```

Every line describes something you can *hear* go wrong. "No lists" fails audibly the first
time the model reads eight results in a row. "Say a short acknowledgement" is the
difference between a lookup and what sounds like a dropped call. That is the test for
whether a line belongs: if you cannot describe the audible failure it prevents, it is
probably a product description.

---

## Beyond the tutorial

What this repo deliberately does not do, and what you would need before any of it faced
real users.

**Tools with real side effects.** Every tool here only reads. The day one of them writes —
sends a message, places an order, changes anything you cannot un-change — the rules
change: the action needs an explicit confirmation step the user can see, and it must be
enforced *server-side*, by a backend that holds the credentials and re-validates every
argument. A browser cannot be trusted to guard anything; anyone can open a console.

**Reconnection.** Sessions close: idle timeout after five minutes without speech, a
maximum duration, or a `1013` when the server is at capacity. Reconnecting means a new
socket, a new `session.update`, and an empty conversation history. If you replay the
previous turns verbatim to restore context, the model tends to re-narrate them — it reads
its own past replies as things it is about to say. A single system message summarising the
state works much better: *"Earlier: the user asked about the weekend weather in Willow
Creek."*

**Latency masking.** A slow tool leaves dead air, which in a voice interface reads as a
dropped call. The cheapest fix needs no code: ask for a preamble in the tool's
description — `web_search`'s says "Say a short acknowledgement before calling it" — and
the model speaks the filler itself. That is where "Let me check the forecast…" in Part 4's
recording comes from. For a tool slow enough that one sentence cannot cover it, the client
can play a canned phrase while the tool runs.

**Retry and backoff.** `1013` means try again later, and "later" should be exponential.
`3000` means mint a fresh key. `4429` means stop and tell the user about billing.

**Barge-in during tool execution.** If the user interrupts while a tool is running, the
result will arrive for a turn that no longer exists. Decide deliberately whether to
discard it or return it anyway.

**Cost.** Every reconnect starts a new session. Every filler phrase is generated audio. It
is worth watching before you find out from an invoice.

---

That is the tutorial. You have a browser voice assistant that listens, answers, handles
interruption correctly, keeps an accurate transcript, calls a tool when it does not know
something, and a prompt you can reason about instead of one you accreted.

← [Part 4 — Tool calling](part-4.md)
