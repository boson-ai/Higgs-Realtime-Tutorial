# Higgs Realtime API — a tutorial

A progressive, build-it-yourself tutorial that takes a web developer with no audio
experience from zero to a working browser voice assistant on the
[Higgs Realtime API](https://docs.boson.ai/models/higgs-realtime/overview).

You need to be comfortable with JavaScript/TypeScript, React, and `fetch`. You do **not**
need to know anything about audio programming, and you do not need to have used WebSockets
before — both are explained where they first come up.

## The parts

| Part | What you build | Checkpoint |
| --- | --- | --- |
| [0](docs/part-0.md) | A token endpoint that keeps your API key off the browser | `part-0` |
| [1](docs/part-1.md) | The first WebSocket connection — type a message, hear it answered | `part-1` |
| [2](docs/part-2.md) | Live microphone, server-side turn detection, and interruptions | `part-2` |
| [3](docs/part-3.md) | A correct transcript, out of an out-of-order event stream | `part-3` |
| [4](docs/part-4.md) | Tool calling — a dummy web search the model actually uses | `part-4` |
| [5](docs/part-5.md) | Prompting — a testable structure for the system prompt | `part-5` |

Each part that adds code ends with an acceptance check you can run yourself. Do not move on until it
passes — every part builds directly on the one before it.

## Checkpoints

Every part is a git tag. To see the code as it stood at the end of any part:

```bash
git checkout part-1
npm install
npm run dev
```

`git checkout main` returns you to the latest state.

## Setup

```bash
npm install
cp .env.example .env    # then add your key
npm run dev
```

`npm run dev` starts the token server on `http://localhost:3000` and the Vite dev server
on `http://localhost:5173`. Open the second one.

[**How to use this repository**](docs/how-to-use.md) covers all of it in more detail —
driving the app, moving between the checkpoints, changing the catalogue and the prompt, and
what to do when something does not work.

## Other commands

```bash
npm test          # 31 unit tests
npm run typecheck # TypeScript, no emit
npm run build     # production build
npm run probe     # open a real session headlessly and print every event
```

`npm run probe` is the debugging instrument the tutorial builds alongside the app. It has no
audio hardware, which makes it the fastest way to tell a protocol bug from an audio bug — and
it can *speak*, synthesising an utterance and streaming it in exactly as the browser streams
microphone audio:

```bash
npm run probe -- --say "what's the weather this weekend in Willow Creek?"
```

## A note on scope

This is a teaching repository. It runs everything in the browser against local state, with
no database, no authentication, and no persistence — all of it resets on reload. Even the
web search is a dummy, on purpose: ten canned pages in one JSON file, which is what makes
"did the tool actually run?" checkable.
[Part 5](docs/part-5.md#beyond-the-tutorial) closes with what you would need to add before
any of this faces real users.

Every API fact in these pages was checked against the live documentation *and* against a
running session on 2026-08-07, with the read date recorded on each page. Several of them
contradict what the documentation says — those are called out where they occur, because
finding them is a large part of what building on a realtime API actually involves.
