# How to use this repository

The README tells you what the tutorial covers. This page tells you how to actually work
with it — how to get it running, how to drive the app once it is, how to move between the
parts, and what to do when something does not work.

If you only want to check that a part works, each part's page ends with its ✅ acceptance
check. This page is about using the thing.

---

## What you need

- **Node 18 or newer** (20+ recommended). The token server uses the built-in `fetch`, and
  Vite 6 will not run on anything older.
- **A Boson AI API key.** Everything past `npm test` talks to the live API, and live calls
  cost money.
- **A browser with a microphone**, from Part 2 onwards. Chrome, Edge, Firefox and Safari
  all work.
- Comfort with JavaScript/TypeScript, React and `fetch`. No audio experience — that is the
  point of the tutorial.

You do not need Docker, a database, or any cloud account beyond the API key. Nothing is
persisted; every reload starts from a clean slate.

---

## First run

```bash
npm install
cp .env.example .env     # then put your key in it
npm run dev
```

Open **http://localhost:5173**.

`npm run dev` starts two processes under one command, colour-coded in your terminal:

| | | |
| --- | --- | --- |
| `server` | `localhost:3000` | the token endpoint — the only thing that ever sees your real key |
| `client` | `localhost:5173` | the Vite dev server, which serves the React app |

Open the **client**. Vite proxies `/api/*` through to the token server, so as far as the
browser is concerned everything is same-origin and there is no CORS to configure. Opening
`:3000` directly gets you a bare JSON endpoint and no app.

### Two ways to give it your key

`.env` accepts either. Inline wins if both are set:

```bash
BOSON_API_KEY=bai-...                        # simplest
BOSON_API_KEY_FILE=/path/to/bosonapi_key     # if you already keep keys somewhere central
```

The second form keeps the secret out of your shell history and out of `.env` entirely,
which matters if you ever share a screen. `.env` is gitignored either way — and because it
is gitignored, it survives every `git checkout` below, so you set it up once.

Restart the server after editing `.env`. `tsx watch` reloads on source changes, not on
environment changes.

### Confirm it worked before going further

```bash
curl http://localhost:3000/api/token
```

You want a `value` starting with `bai-eph-` and an `expires_at` about ten minutes out. If
this returns 500, stop here and fix it — nothing downstream can work until it does.

---

## Using the app

The finished app on `main` has every feature the tutorial builds. Left to right, top to
bottom:

**Connect** opens the WebSocket. It has to be a real click — the browser will not let an
`AudioContext` start any other way, and this is the single most common reason people hear
silence. **Disconnect** closes the socket cleanly.

**Start microphone** begins streaming your voice. The bar beside it is a level meter, and
it is a diagnostic rather than decoration: if it moves while you talk, the browser is
capturing and any problem is on the server side of the wire. If it stays flat you get a
`silent` warning, and the problem is your input device or the tab's permission.

**…or type instead** is Part 1's path, still wired up. Type a sentence, press Send or
Enter, and the model reads a reply aloud. It is the fastest way to check your speakers
without saying anything out loud, and it works with the microphone off.

**The transcript** shows both sides of the conversation. User bubbles say *transcribing…*
the moment you start speaking and fill in a second later. Assistant bubbles you talk over
are marked **interrupted** and keep only the words you actually heard. Tool calls appear as
chips with their arguments, result and timing.

**The debug drawer** at the bottom logs every event in both directions, and you can click
any of them open. Keep it open while you are learning — most of what the tutorial explains
is visible in there.

### A five-minute tour

1. Click **Connect**. The status bar goes to *open*.
2. Type "say something short so I can check my speakers", press **Send**, and listen.
3. Click **Start microphone** and grant permission. Watch the meter move while you talk.
4. Ask *"what's the weather this weekend in Willow Creek?"* — a `web_search` chip appears,
   then a spoken answer with the facts from `src/tools/searchIndex.json`.
5. Ask for something long — *"tell me about the history of the metre"* — and then talk over
   it. Playback stops; the bubble is marked interrupted.
6. Edit a fact in `searchIndex.json` — change the forecast, say — reload, and ask again.
   The spoken answer must change. That is how you know the model is reading your file
   rather than inventing an answer.

---

## Working through the parts

Each part is a git tag, so you can read the code exactly as it stood when that part ended.

```bash
git checkout part-1
npm install        # dependencies change between parts
npm run dev
```

Two things worth knowing. Checking out a tag leaves you on a **detached HEAD** — fine for
reading, but if you intend to edit, branch instead:

```bash
git checkout -b my-part-2 part-2
```

And `git checkout main` returns you to the finished app whenever you want to see where a
part is heading.

There are two reasonable ways to use the tutorial, and they suit different people:

**Read and run.** Stay on `main`, keep the app running, and read the parts in order with
the debug drawer open. Fastest route to understanding the protocol. You will not build
muscle memory for the audio code.

**Build it yourself.** Start from `part-0`, follow each page, and write the code as you go.
Use the tags as an answer key when you get stuck — `git diff part-1 part-2 -- src/` shows
you exactly what a part added. Slower, and the only way the audio pipeline really sticks.

Either way: **do not skip a part's acceptance check.** Every part builds directly on the
one before it, and a subtly broken Part 2 shows up as an inexplicable Part 3.

---

## The probe

`npm run probe` opens a real session with no browser and no audio hardware, prints every
event as it arrives, and writes the full stream to `captures/`.

It is the fastest way to answer "is my protocol wrong or is my audio wrong?", because it
has no audio code to be wrong. It is also how the Part 3 test fixture was recorded.

```bash
npm run probe                                     # a default question, as text
npm run probe -- --text "hello"                   # a typed turn
npm run probe -- --say "hello there"              # SPEAK a turn — synthesised, streamed in
npm run probe -- --say "a" --say "b"              # several turns, in order
npm run probe -- --audio recording.wav            # stream a WAV you already have
npm run probe -- --barge "stop!"                  # start talking over the reply in progress
npm run probe -- --say "hi" --out captures/x.json # choose where the capture lands
```

`--say` synthesises the utterance and feeds it in exactly as the browser feeds microphone
audio — 24 kHz PCM16, base64, 100 ms at a time, paced in real time. So it exercises turn
detection, transcription and the whole tool loop with no microphone and no human.

What it cannot test is playback, and therefore barge-in. The server finishes generating
long before you finish listening, so a scripted interruption usually arrives when there is
nothing left to interrupt. `--barge` will tell you when that happens.

---

## Every command

| Command | What it does | Live API? |
| --- | --- | --- |
| `npm run dev` | Token server + Vite dev server | on connect |
| `npm run dev:server` | Just the token server, on `:3000` | on request |
| `npm run dev:client` | Just Vite, on `:5173` | no |
| `npm test` | 31 unit tests | no |
| `npm run typecheck` | TypeScript across app, server and tools | no |
| `npm run build` | Production build into `dist/` | no |
| `npm run preview` | Serve that build — note the `/api` proxy is dev-only | no |
| `npm run probe` | A headless session, printing every event | **yes** |

---

## Making it yours

Four files hold nearly everything you would want to change:

**`src/tools/searchIndex.json`** — the entire "web" the search tool can see. Ten short
pages about a fictional town, deliberately fictional so nothing in them can come from the
model's own knowledge. Edit a fact, reload, ask about it: if the spoken answer changes, the
model is genuinely reading your file rather than inventing an answer. That is a check worth
doing once, because a model that is *not* calling the tool sounds exactly the same.

**`src/realtime/sessionConfig.ts`** — the system prompt, the voice, the audio format, and
turn detection and transcription settings. The prompt follows the structure in
[Part 5](part-5.md), and one warning in that file was learned the hard way: a longer
prompt made the model stop calling tools altogether.

**`src/tools/definitions.ts` and `handlers.ts`** — add a tool by writing its JSON Schema in
the first and its implementation in the second. There is no executor field in the protocol;
running tools is entirely your code's job. The search handler is also where a real app
would swap the canned index for a real search API — nothing else changes.

Everything is in-memory and resets on reload, which makes experimenting cheap.

---

## When it does not work

| Symptom | Almost always |
| --- | --- |
| `/api/token` returns 500, "No API key found" | `.env` is not beside `package.json`, or the server was not restarted after you edited it |
| Connect fails with a token error | The token server is not running — `npm run dev` starts both |
| Close code `3000` | The ephemeral key was invalid or expired. Mint a fresh one; do not cache them |
| Close code `1013` | The server is at capacity. Wait and retry |
| Closed "normally" after five idle minutes | The documented idle timeout. Reconnect starts a new, empty session |
| Audio deltas in the drawer but no sound | The `AudioContext` is suspended — `connect()` must run inside the click handler |
| Level meter flat while you speak | Permission denied, wrong input device, or an insecure origin. `localhost` counts as secure; a LAN IP does not |
| Meter moves, but the model never replies | The audio is arriving and not being heard as speech. Check `turn_detection` in the `session.created` ack — the server default is `null` |
| User bubbles never fill in | Transcription is off — set `transcription.model` (`higgs-stt-3.1`). A wrong name fails the `session.update` with an `error` event naming it |
| It answers with "facts" that are not in `searchIndex.json`, and no `web_search` chip appears | It narrated a tool call instead of making one, and invented the answer. You cannot fix this in your code — the chips are how you tell it happened |

---

## Where to go next

- [Part 0](part-0.md) if you are starting the tutorial.
- [Beyond the tutorial](part-5.md#beyond-the-tutorial) for what this repo deliberately does
  not do — reconnection, retry and backoff, tools with real side effects — and what you
  would need before any of it faced real users.
