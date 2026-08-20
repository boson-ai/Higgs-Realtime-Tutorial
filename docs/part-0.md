# Part 0 — Auth and the token endpoint

**By the end of this part** you will have a running server that hands your browser a
short-lived key for the Higgs Realtime API, and a page with a button that proves it.

No audio yet. No WebSocket yet. Just the one piece of plumbing that everything else
depends on.

---

## Why you cannot just use your API key

Your Boson API key is a bearer credential: whoever holds it can spend your money. That is
fine on a server you control. It is not fine in a browser.

There is no way to hide a value from the browser. Not in a JavaScript variable, not in an
environment variable baked in at build time, not behind a minifier. If the browser can
send it to the API, a visitor can read it out of the network tab.

So the Realtime API offers a second kind of credential: an **ephemeral key**. You mint one
on your server using your real key, hand it to the browser, and it expires on its own —
ten minutes by default. If one leaks, it is worthless by lunchtime.

The shape of the whole thing:

```
browser  ──GET /api/token──▶  your server  ──POST /v1/realtime/client_secrets──▶  Boson
                                    (Authorization: Bearer <your real key>)
browser  ◀──{value, expires_at}──   your server  ◀──{value: "bai-eph-…"}──────────  Boson
```

Your real key never moves off the middle box.

---

## The endpoint

The whole server is one route. From `server/index.ts`:

```ts
app.get("/api/token", async (_req, res) => {
  const upstream = await fetch(`${BOSON_BASE_URL}/v1/realtime/client_secrets`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${BOSON_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ expires_after: { seconds: 600 } }),
  });

  const data = await upstream.json();
  return res.json({ value: data.value, expires_at: data.expires_at });
});
```

`expires_after.seconds` accepts 10–7200 and defaults to 600. Ten minutes is a reasonable
starting point: long enough that a user can sit on the page and think before connecting,
short enough that a leaked key is a non-event.

The upstream response also contains a `session` object with an id. The browser does not
need it, so we do not forward it. Return the minimum.

> **⚠ This will bite you: do not cache the key.**
> It is tempting to mint one key at server start and hand out the same one to everybody.
> Don't — mint a fresh key per connection.
>
> Note that the API will not stop you. An ephemeral key is not tied to a single session:
> tested on 2026-08-07, one key opened several concurrent sessions and every one of them
> worked. So a cached key produces no error at all. It just means every visitor shares one
> credential with one expiry, and a leak affects all of them at once. The failure is
> silent, which is exactly why it is worth getting right now.

---

## Where the key comes from

`server/index.ts` reads it from either an environment variable or a file:

```ts
function loadApiKey(): string | undefined {
  const inline = process.env.BOSON_API_KEY?.trim();
  if (inline) return inline;

  const keyFile = process.env.BOSON_API_KEY_FILE;
  if (keyFile) return readFileSync(keyFile, "utf8").trim();

  return undefined;
}
```

Copy `.env.example` to `.env` and fill in **one** of them:

```bash
BOSON_API_KEY=bai-...
# or
BOSON_API_KEY_FILE=/path/to/your/bosonapi_key
```

`.env` is gitignored. The file option exists because a lot of people already keep keys in
one place outside their projects, and a path is much safer to accidentally commit than a
secret.

---

## The CORS non-problem

You would expect trouble here. The page is served by Vite on port 5173 and the token
server listens on 3000 — different origins, so the browser should refuse the request.

It doesn't, because `vite.config.ts` proxies the path:

```ts
server: {
  proxy: {
    "/api": { target: "http://localhost:3000", changeOrigin: true },
  },
}
```

Now the browser only ever talks to `localhost:5173`. Vite forwards `/api/*` to the token
server itself, server-to-server, where CORS does not apply. This is why you will not find
a single CORS header in this tutorial.

The same trick works in production: serve the built static files from the same server that
hosts `/api/token`, and there is still only one origin.

---

## Running it

```bash
npm install
npm run dev
```

That starts two processes: the token server on `http://localhost:3000` and Vite on
`http://localhost:5173`. Open the Vite URL and click **Mint ephemeral key**.

The page shows only the first twelve characters of the value. An ephemeral key is still a
credential, and this tutorial would rather not train you to print credentials to the
screen.

---

## ✅ Acceptance check

```bash
curl http://localhost:3000/api/token
```

You should get back something like:

```json
{ "value": "bai-eph-a023…", "expires_at": 1786140202 }
```

Check three things:

1. `value` starts with `bai-eph-`.
2. `expires_at` is a Unix timestamp roughly 600 seconds in the future.
3. Your real key appears **nowhere** in the response.

If you get a 500 with "No API key found", your `.env` is not being read — check that it
sits next to `package.json` and that you restarted the server after editing it.

If you get a 401 from upstream, the key itself is wrong. Test it directly:

```bash
curl -X POST https://api.boson.ai/v1/realtime/client_secrets \
  -H "Authorization: Bearer $BOSON_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"expires_after": {"seconds": 300}}'
```

---

**Next:** [Part 1 — First connection](part-1.md), where we open a WebSocket with that key,
send a typed message, and hear the model answer out loud.

---

*API facts on this page were verified against the live documentation on 2026-08-07:
[Create a client secret](https://docs.boson.ai/api-reference/realtime/client-secrets.md),
[Authentication](https://docs.boson.ai/authentication.md).*
