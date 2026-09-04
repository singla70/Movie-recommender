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
//   GET  /api/stats              — Neo4j graph stats (movies/actors/directors/genres)
//   POST /api/upload             — multipart PDF → kicks off async ingestion job → { jobId }
//   GET  /api/upload/status/:id  — poll job progress → { stage, log, result? }
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

import { processQuery } from "../src/query/queryEngine.js";
import { getNeo4jStats } from "../src/ingestion/neo4jLoader.js";
import { getNeo4jDriver } from "../src/utils/neo4jClient.js";
import { runIngestJob, getJob } from "./ingestJob.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = path.join(__dirname, "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();
app.use(cors());
app.use(express.json());

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
app.post("/api/query", async (req, res) => {
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
app.post("/api/query/stream", async (req, res) => {
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
  req.on("close", () => { closed = true; }); // client cancelled — stop writing, let the query finish quietly

  try {
    const history = (conversation_history || []).map((m) => ({ role: m.role, content: m.content }));
    const result = await processQuery(query_text.trim(), history, [], (stage) => {
      if (!closed) send(stage);
    });
    if (!closed) {
      send({ stage: "done", ...result });
      res.end();
    }
  } catch (err) {
    console.error("Query stream error:", err);
    if (!closed) {
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
app.post("/api/upload", upload.single("pdf"), (req, res) => {
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

// ── Error handler (multer file-type/size errors etc) ─────────
app.use((err, _req, res, _next) => {
  res.status(400).json({ error: err.message || "Unexpected error" });
});

const PORT = process.env.API_PORT || 4000;
app.listen(PORT, () => {
  console.log(`🎬 Cinegraph API listening on http://localhost:${PORT}`);
});