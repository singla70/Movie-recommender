// ============================================================
// src/api.js — thin fetch wrapper for the Express API (server/index.js)
// ============================================================

// BASE resolves to the deployed backend's absolute URL (VITE_API_URL,
// set in Vercel's Environment Variables) in production, and falls back
// to the relative "/api" — which vite.config.js proxies to localhost:4000
// — only for local `npm run client:dev`. Without VITE_API_URL set,
// production requests would hit Vercel's own domain instead of Render,
// and (now that vercel.json has a SPA catch-all rewrite) get back
// index.html instead of JSON.
const BASE = import.meta.env.VITE_API_URL || "/api";

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  return res.json();
}

export const api = {
  query: (query_text, conversation_history = []) =>
    request("/query", {
      method: "POST",
      body: JSON.stringify({ query_text, conversation_history }),
    }),

  // Streams real pipeline stages (Server-Sent Events) as the backend
  // actually moves through routing → search → answer composition.
  // onStage({stage, route}) fires for each real transition — this is
  // not a client-side timer/simulation. Resolves with the same
  // { answer, movies, route } shape as api.query. Pass `signal` (an
  // AbortController's signal) to support cancellation.
  queryStream: async (query_text, conversation_history = [], onStage, signal) => {
    const res = await fetch(`${BASE}/query/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query_text, conversation_history }),
      signal,
    });
    if (!res.ok || !res.body) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Request failed (${res.status})`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let finalResult = null;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const frames = buffer.split("\n\n");
      buffer = frames.pop(); // last (possibly incomplete) frame carries over

      for (const frame of frames) {
        const line = frame.trim();
        if (!line.startsWith("data:")) continue;
        let payload;
        try {
          payload = JSON.parse(line.slice(5).trim());
        } catch {
          continue; // malformed/partial frame — skip rather than crash the stream
        }
        if (payload.stage === "error") {
          throw new Error(payload.error || "Query failed");
        }
        if (payload.stage === "done") {
          finalResult = payload;
        } else {
          onStage?.(payload);
        }
      }
    }

    if (!finalResult) throw new Error("Stream ended unexpectedly");
    const { stage: _stage, ...result } = finalResult;
    return result;
  },

  stats: () => request("/stats"),

  uploadPdf: async (file, onProgress) => {
    const formData = new FormData();
    formData.append("pdf", file);
    const res = await fetch(`${BASE}/upload`, { method: "POST", body: formData });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Upload failed (${res.status})`);
    }
    return res.json(); // { jobId }
  },

  jobStatus: (jobId) => request(`/upload/status/${jobId}`),

  // Re-runs a failed upload on the same PDF — the backend's disk
  // cache resumes from whatever stage last completed rather than
  // re-parsing/re-embedding from scratch.
  retryUpload: (jobId) => request(`/upload/retry/${jobId}`, { method: "POST" }),

  connections: () => request("/connections"),
};