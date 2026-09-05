// ============================================================
// server/index.js
//
// Express API — Cinegraph frontend (React) ke liye backend bridge.
// Existing CLI-based logic (app.js) ko touch nahi kiya — sab kuch
// src/query/queryEngine.js (stateless wrapper) aur existing
// ingestion modules ke through wire kiya hai.
//
// Endpoints:
//   POST /api/query              — { query_text, conversation_history } → { answer, movies, route }
//   POST /api/query/stream       — same, but Server-Sent Events with real pipeline-stage progress
//   GET  /api/stats              — Neo4j graph stats (movies/actors/directors/genres)
//   POST /api/upload             — multipart PDF → kicks off async ingestion job → { jobId }
//   GET  /api/upload/status/:id  — poll job progress → { stage, log, result? }
//   POST /api/upload/retry/:id   — retry a failed job on the same PDF (resumes via disk cache)
//   GET  /api/movies             — list/search movies (?search=&limit=)
//   GET  /api/movies/:id         — get one movie's full detail
//   POST /api/movies             — add a new movie
//   PUT  /api/movies/:id         — update an existing movie
//   DELETE /api/movies/:id       — delete a movie (Neo4j + Pinecone both)
//   GET  /api/connections        — quick health-check (Neo4j reachable?)
//
// Conversation history STATELESS hai server-side — frontend har
// request ke saath poora history bhejta hai (src/api.js dekho).
// Isse multiple browser clients ek hi server ko safely hit kar
// sakte hain, koi shared/global conversation state clash nahi
// hoti (app.js ke CLI-only single-user model se alag, jaanbujh kar).
// ============================================================

import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import rateLimit from "express-rate-limit";

import { processQuery } from "../src/query/queryEngine.js";
import { getNeo4jStats } from "../src/ingestion/neo4jLoader.js";
import { getNeo4jDriver, closeNeo4jDriver } from "../src/utils/neo4jClient.js";
import { runIngestJob, getJob, retryJob } from "./ingestJob.js";
import { upsertMovie, deleteMovie, getMovieById, listMovies } from "../src/ingestion/movieCrud.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = path.join(__dirname, "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();

// ── CORS ────────────────────────────────────────────────────
// Open by default (backward-compatible — no env var required to keep
// working exactly as before). Set ALLOWED_ORIGINS (comma-separated,
// e.g. "https://movie-recommender-singla2.vercel.app") in production
// to stop OTHER websites from calling this API directly with your
// browser's credentials/IP — cors() with no options reflects *any*
// origin, which is fine for local dev but means anyone could embed
// calls to this API (and burn the shared free-tier LLM quota) from
// their own site once the URL is public.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
app.use(
  cors(
    allowedOrigins.length > 0
      ? { origin: allowedOrigins }
      : undefined // no ALLOWED_ORIGINS set → unrestricted, same as before
  )
);

// Conversation history grows with every turn of a chat — Express's
// default express.json() limit (100kb) is comfortably enough for
// normal use but not generous; a handful of long turns could hit it
// and return an opaque 413 rather than an error the frontend explains.
app.use(express.json({ limit: "2mb" }));

// ── Rate limiting ────────────────────────────────────────────
// The LLM provider chain (src/utils/openrouterClient.js) shares a
// FREE-TIER daily/per-minute quota across every visitor — Groq
// (14,400/day) and OpenRouter's free tier (50/day, much tighter).
// Without a limit here, a single visitor (accidental refresh-spam,
// or a bot once the URL is public) could exhaust that shared quota
// for everyone else. This bounds it per-IP; tune via env if needed.
const queryLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: Number(process.env.QUERY_RATE_LIMIT_PER_MIN) || 12,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many queries from this address — please wait a moment and try again." },
});
const uploadLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: Number(process.env.UPLOAD_RATE_LIMIT_PER_10MIN) || 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many uploads from this address — please wait a few minutes and try again." },
});
// Single-movie add/edit/delete — lighter-weight than a PDF upload
// (one embedding call, not a whole batch pipeline) but still touches
// the shared LLM/embedding quota, so it gets its own bound rather
// than sharing uploadLimiter's tighter budget.
const adminWriteLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: Number(process.env.ADMIN_RATE_LIMIT_PER_MIN) || 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many admin operations from this address — please wait a moment and try again." },
});
// Movie search/list is a plain read-only Neo4j query — no LLM or
// embedding call at all, so it doesn't share the shared-quota concern
// the write limiter above exists for. A generous limit here mainly
// just guards against runaway request loops, not normal typing —
// the search box debounces (300ms) before firing, but if someone
// types with unusually long pauses between letters, each pause could
// still fire its own request; this budget comfortably absorbs that
// without ever getting in the way of legitimate use.
const movieSearchLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: Number(process.env.MOVIE_SEARCH_RATE_LIMIT_PER_MIN) || 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many searches from this address — please wait a moment and try again." },
});

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  fileFilter: (_req, file, cb) => {
    if (file.mimetype !== "application/pdf") return cb(new Error("Only PDF files are accepted"));
    cb(null, true);
  },
});

// ── POST /api/query ─────────────────────────────────────────
// Plain request/response — kept for simplicity/backward-compatibility
// (e.g. curl, non-browser clients). The web UI uses /api/query/stream
// below so it can show real pipeline stages instead of guessing.
app.post("/api/query", queryLimiter, async (req, res) => {
  const { query_text, conversation_history } = req.body;
  if (!query_text || !query_text.trim()) {
    return res.status(400).json({ error: "query_text is required" });
  }
  try {
    const history = (conversation_history || []).map((m) => ({ role: m.role, content: m.content }));
    const lastMovies = []; // frontend re-sends full history each turn; per-turn follow-up
    // context (lastMovies) is intentionally not tracked server-side —
    // see file header for why history stays stateless.
    const result = await processQuery(query_text.trim(), history, lastMovies);
    res.json(result);
  } catch (err) {
    console.error("Query error:", err);
    res.status(500).json({ error: err.message || "Query failed" });
  }
});

// ── POST /api/query/stream ───────────────────────────────────
// Same pipeline as /api/query, but streams real progress events as
// Server-Sent Events while processQuery runs, then a final "done"
// event with the same { answer, movies, route } payload. Each event
// reflects an actual transition in queryEngine.js (routing decided,
// which store is being searched, answer being composed) — not a
// simulated/fake timer on the client.
//
// HARD_TIMEOUT_MS is a safety net: the LLM provider chain inside
// chatCompletion() already retries across 3 providers at up to 75s
// each (see src/utils/openrouterClient.js) — so a SINGLE legitimate
// full-chain fallback can structurally take up to 225s, and
// processQuery can make two such calls per request (routing +
// answer). 240s is set comfortably above one full chain-exhaustion
// (225s) so a genuinely-recovering request is never killed
// mid-fallback — it only fires for something actually stuck well
// beyond the system's own worst case. Combined with the onRetry
// visibility above, the user sees *why* it's slow instead of a
// blank wait either way.
const STREAM_HARD_TIMEOUT_MS = 240000; // 240s

app.post("/api/query/stream", queryLimiter, async (req, res) => {
  const { query_text, conversation_history } = req.body;
  if (!query_text || !query_text.trim()) {
    return res.status(400).json({ error: "query_text is required" });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);

  let closed = false;
  let settled = false;
  req.on("close", () => { closed = true; }); // client cancelled — stop writing, let the query finish quietly

  const hardTimeout = setTimeout(() => {
    if (settled || closed) return;
    settled = true;
    console.error(`Query stream timed out after ${STREAM_HARD_TIMEOUT_MS / 1000}s: "${query_text.slice(0, 80)}"`);
    send({
      stage: "error",
      error: "This is taking much longer than expected — the LLM provider(s) may be unreachable right now. Check the server logs.",
    });
    res.end();
  }, STREAM_HARD_TIMEOUT_MS);

  try {
    const history = (conversation_history || []).map((m) => ({ role: m.role, content: m.content }));
    const result = await processQuery(query_text.trim(), history, [], (stage) => {
      if (!closed && !settled) send(stage);
    });
    if (!closed && !settled) {
      settled = true;
      clearTimeout(hardTimeout);
      send({ stage: "done", ...result });
      res.end();
    }
  } catch (err) {
    console.error("Query stream error:", err);
    if (!closed && !settled) {
      settled = true;
      clearTimeout(hardTimeout);
      send({ stage: "error", error: err.message || "Query failed" });
      res.end();
    }
  }
});

// ── GET /api/stats ───────────────────────────────────────────
app.get("/api/stats", async (_req, res) => {
  try {
    const stats = await getNeo4jStats();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/connections ─────────────────────────────────────
app.get("/api/connections", async (_req, res) => {
  try {
    const driver = getNeo4jDriver();
    await driver.verifyConnectivity();
    res.json({ ok: true });
  } catch (err) {
    res.status(503).json({ ok: false, error: err.message });
  }
});

// ── POST /api/upload ─────────────────────────────────────────
app.post("/api/upload", uploadLimiter, upload.single("pdf"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No PDF file uploaded" });

  const jobId = randomUUID();
  // .pdf extension zaroori hai — pdf-parse kabhi-kabhi extension-
  // aware hota hai, multer default extension-less temp filename deta hai.
  const destPath = req.file.path + ".pdf";
  fs.renameSync(req.file.path, destPath);

  runIngestJob(jobId, destPath);
  res.json({ jobId });
});

// ── GET /api/upload/status/:jobId ────────────────────────────
app.get("/api/upload/status/:jobId", (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json(job);
});

// ── POST /api/upload/retry/:jobId ────────────────────────────
// Re-runs ingestion on the SAME uploaded PDF a failed job used —
// the file is kept around specifically for this (see multer/rename
// above). runIngestJob's disk cache (server/ingestJob.js) is keyed
// by the file's content hash, so this resumes from whichever stage
// last completed instead of re-parsing/re-embedding from scratch.
app.post("/api/upload/retry/:jobId", (req, res) => {
  const newJobId = randomUUID();
  const started = retryJob(req.params.jobId, newJobId);
  if (!started) {
    return res.status(404).json({ error: "Original upload not found — its file may have been cleaned up. Upload the PDF again." });
  }
  res.json({ jobId: newJobId });
});

// ── Movie CRUD — admin's "manage individual movies" feature ────
// Each route captures its own step-by-step log (embedding, then
// Neo4j, then Pinecone) in the response, same reasoning as the PDF-
// ingestion job's log capture: the admin should see what's actually
// happening rather than the request just going quiet for a few
// seconds. These are synchronous (no job-polling needed) since a
// single movie is fast — typically one embedding call + two DB writes.

app.get("/api/movies", movieSearchLimiter, async (req, res) => {
  try {
    const movies = await listMovies(req.query.search || "", Number(req.query.limit) || 30);
    res.json({ movies });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/movies/:id", movieSearchLimiter, async (req, res) => {
  try {
    const movie = await getMovieById(req.params.id);
    if (!movie) return res.status(404).json({ error: "Movie not found" });
    res.json(movie);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/movies", adminWriteLimiter, async (req, res) => {
  const log = [];
  try {
    const movie = await upsertMovie(req.body, null, (line) => log.push(line));
    res.json({ movie, log });
  } catch (err) {
    res.status(500).json({ error: err.message, log });
  }
});

app.put("/api/movies/:id", adminWriteLimiter, async (req, res) => {
  const log = [];
  try {
    const existing = await getMovieById(req.params.id);
    if (!existing) return res.status(404).json({ error: "Movie not found", log });
    const movie = await upsertMovie(req.body, req.params.id, (line) => log.push(line));
    res.json({ movie, log });
  } catch (err) {
    res.status(500).json({ error: err.message, log });
  }
});

app.delete("/api/movies/:id", adminWriteLimiter, async (req, res) => {
  const log = [];
  try {
    const result = await deleteMovie(req.params.id, (line) => log.push(line));
    res.json({ ...result, log });
  } catch (err) {
    res.status(err.message === "Movie not found." ? 404 : 500).json({ error: err.message, log });
  }
});

// ── Error handler (multer file-type/size errors etc) ─────────
app.use((err, _req, res, _next) => {
  res.status(400).json({ error: err.message || "Unexpected error" });
});

const PORT = process.env.API_PORT || 4000;
const server = app.listen(PORT, () => {
  console.log(`🎬 Cinegraph API listening on http://localhost:${PORT}`);
});

// ── Don't let one bad async error silently kill the whole process ──
// Without these, an exception thrown outside a route's own try/catch
// (a genuine bug, a bad third-party promise, etc.) crashes the entire
// server with no clean log — on Render that means every in-flight
// request drops and the container restarts cold. This at least logs
// clearly what happened; the process still exits (Node's own guidance
// for unhandledRejection — the process is in an unknown state by then)
// but the restart is no longer a silent mystery in the logs.
process.on("unhandledRejection", (reason) => {
  console.error("💥 Unhandled promise rejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("💥 Uncaught exception:", err);
  process.exit(1);
});

// ── Graceful shutdown — close the Neo4j driver cleanly on redeploy ──
async function shutdown(signal) {
  console.log(`\n${signal} received — shutting down...`);
  server.close();
  await closeNeo4jDriver().catch(() => {});
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));