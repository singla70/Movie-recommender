// ============================================================
// src/utils/rateLimiter.js
//
// Generic sliding-window rate limiter — key ke against RPM cap
// enforce karta hai. Pehle sirf OpenRouter ke ":free" models ke
// liye tha (20RPM hardcoded); ab Groq bhi provider-chain mein aa
// gaya (30RPM) — isliye key-based generic bana diya, taaki har
// provider apni sahi limit ke against throttle ho, ek hi shared
// window mein sab mil ke na ulझें.
// ============================================================

import { RATE_LIMIT } from "../config/constants.js";

// Har rate-limited key (provider+model) ke liye alag timestamp-window
const requestWindows = new Map(); // key -> array of timestamps (ms)

// ── Free-tier provider/model call se pehle call karo ──────────
// key: unique identifier — jaise "groq:llama-3.3-70b-versatile" ya
//      "openrouter:meta-llama/llama-3.3-70b-instruct:free"
// limitPerMin: is key ki RPM cap (safety-buffered value pass karo)
export async function waitForRateLimit(key, limitPerMin) {
  if (!limitPerMin) return; // paid/unlimited keys ke liye no-op

  const windowMs = 60 * 1000;

  if (!requestWindows.has(key)) requestWindows.set(key, []);
  let timestamps = requestWindows.get(key);

  while (true) {
    const now = Date.now();
    timestamps = timestamps.filter((t) => now - t < windowMs);
    requestWindows.set(key, timestamps);

    if (timestamps.length < limitPerMin) {
      timestamps.push(now);
      return;
    }

    const oldest = timestamps[0];
    const waitMs = windowMs - (now - oldest) + 50;
    console.log(
      `  ⏳ Rate limit (${limitPerMin}RPM) reached for "${key}" — waiting ${(waitMs / 1000).toFixed(1)}s...`
    );
    await new Promise((r) => setTimeout(r, Math.max(waitMs, 100)));
  }
}

// ── Testing/monitoring ke liye current usage dekho ───────────
export function getRateLimitStatus(key) {
  const timestamps = requestWindows.get(key) || [];
  const now = Date.now();
  const active = timestamps.filter((t) => now - t < 60000);
  return { key, requestsInLastMinute: active.length };
}