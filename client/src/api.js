// ============================================================
// src/api.js — thin fetch wrapper for the Express API (server/index.js)
// ============================================================

const BASE = "/api";

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

  connections: () => request("/connections"),
};
