import { readFileSync } from "node:fs";
import express from "express";
import dotenv from "dotenv";

dotenv.config();

const PORT = Number(process.env.PORT ?? 3000);
const BOSON_BASE_URL = process.env.BOSON_BASE_URL ?? "https://api.boson.ai";

// How long a minted ephemeral key stays valid. The API accepts 10–7200 seconds
// and defaults to 600. Short is good: the key is handed to a browser, and a
// fresh one is minted for every connection anyway.
const EPHEMERAL_TTL_SECONDS = 600;

/**
 * The API key comes from BOSON_API_KEY, or from a file whose path is in
 * BOSON_API_KEY_FILE. Reading it from a file keeps the secret out of your shell
 * history and out of .env — useful if you already keep keys somewhere central.
 */
function loadApiKey(): string | undefined {
  const inline = process.env.BOSON_API_KEY?.trim();
  if (inline) return inline;

  const keyFile = process.env.BOSON_API_KEY_FILE;
  if (keyFile) {
    try {
      const fromFile = readFileSync(keyFile, "utf8").trim();
      if (fromFile) {
        console.log(`Loaded BOSON_API_KEY from ${keyFile}`);
        return fromFile;
      }
    } catch {
      console.warn(`Could not read BOSON_API_KEY_FILE at ${keyFile}`);
    }
  }
  return undefined;
}

const BOSON_API_KEY = loadApiKey();

const app = express();

/**
 * GET /api/token
 *
 * This server exists for exactly one reason: your real API key must never reach
 * the browser. Anything the browser can read, a visitor can read — and a leaked
 * key is billable until you rotate it.
 *
 * So the browser asks *us* for a key, and we ask Boson for a short-lived
 * "ephemeral" one (`bai-eph-…`) using the real key. The browser gets only the
 * ephemeral value, which expires on its own in ten minutes.
 *
 * A fresh key is minted per request. Do not cache them.
 */
app.get("/api/token", async (_req, res) => {
  if (!BOSON_API_KEY) {
    return res.status(500).json({
      error:
        "No API key found. Set BOSON_API_KEY in .env, or point BOSON_API_KEY_FILE at a key file.",
    });
  }

  try {
    const upstream = await fetch(`${BOSON_BASE_URL}/v1/realtime/client_secrets`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${BOSON_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ expires_after: { seconds: EPHEMERAL_TTL_SECONDS } }),
    });

    const text = await upstream.text();

    if (!upstream.ok) {
      console.error(`client_secrets failed: ${upstream.status} ${text}`);
      return res
        .status(upstream.status)
        .json({ error: `Upstream ${upstream.status}: ${text || upstream.statusText}` });
    }

    // The upstream response also carries a `session` object. The browser does
    // not need it, so we do not forward it — return the minimum.
    const data = JSON.parse(text);
    return res.json({ value: data.value, expires_at: data.expires_at });
  } catch (err) {
    console.error("Token mint error:", err);
    return res.status(502).json({
      error: err instanceof Error ? err.message : "Failed to reach the Boson API",
    });
  }
});

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Token server listening on http://localhost:${PORT}`);
  if (!BOSON_API_KEY) {
    console.warn(
      "  ⚠ No API key found (set BOSON_API_KEY or BOSON_API_KEY_FILE in .env) — /api/token will return 500.",
    );
  }
});
