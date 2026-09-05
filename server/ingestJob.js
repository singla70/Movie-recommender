// ============================================================
// server/ingestJob.js
//
// scripts/ingest.js jaisa hi pipeline hai (parse → embed → reconcile
// → load), bas console.log ki jagah in-memory job-state track karta
// hai — taaki Admin UI polling se progress dikha sake. Jobs process
// memory mein rakhe jaate hain (Map) — ek single-server-instance
// deployment ke liye theek hai; production-scale ke liye Redis/DB
// backed job-queue chahiye hoga (yahan scope se bahar).
//
// RESUMABLE INGESTION — scripts/ingest.js ka CACHE_FILE pattern yahan
// bhi laaya gaya hai (pehle sirf CLI script mein tha, Admin-UI path
// mein bilkul nahi tha): PDF ka SHA-256 hash cache-key hai. Parsing
// (LLM calls) aur embedding (embedding-API calls) — dono expensive
// steps — har ek complete hote hi disk pe cache ho jaate hain. Agar
// koi baad ka step fail ho (rate limit, DB down, whatever), retry
// (same PDF) seedha jahan se rukha wahin se resume karta hai — parse/
// embed dobara nahi hota, koi LLM/embedding cost dobara waste nahi
// hoti. Success pe cache delete ho jaata hai.
//
// DUPLICATE MOVIES — agar upload ki gayi PDF mein koi movie already
// DB mein hai (same title+year), pehle woh naya Movie node/vector ban
// jaata (fresh positional ID = fresh MERGE = duplicate). Ab load se
// pehle reconcileMovieIds() (src/ingestion/idReconciler.js — pehle
// sirf scripts/migrate.js use karta tha, is live path mein kabhi wire
// nahi hua tha) existing DB se title+year match karke purana ID reuse
// karta hai — duplicate ki jagah UPDATE hota hai.
// ============================================================

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { parsePDFToMovies } from "../src/ingestion/pdfParser.js";
import { generateMovieEmbeddings } from "../src/ingestion/embedder.js";
import { loadMoviesToPinecone } from "../src/ingestion/pineconeLoader.js";
import { loadMoviesToNeo4j } from "../src/ingestion/neo4jLoader.js";
import { reconcileMovieIds } from "../src/ingestion/idReconciler.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, "uploads", ".cache");

const jobs = new Map(); // jobId -> { stage, log, error, result, pdfPath }

function newJob(jobId, pdfPath) {
  jobs.set(jobId, { stage: "queued", log: [], error: null, result: null, pdfPath });
}

function updateJob(jobId, patch) {
  const job = jobs.get(jobId);
  if (!job) return;
  Object.assign(job, patch);
}

function appendLog(jobId, line) {
  const job = jobs.get(jobId);
  if (!job) return;
  job.log.push(line);
  if (job.log.length > 200) job.log.shift(); // cap — UI sirf recent lines dikhata hai
}

export function getJob(jobId) {
  return jobs.get(jobId) || null;
}

// ── Resumability cache — keyed by PDF content hash ─────────────
async function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex").slice(0, 16)));
    stream.on("error", reject);
  });
}

function cachePathFor(hash) {
  return path.join(CACHE_DIR, `${hash}.json`);
}

function readCache(hash) {
  const p = cachePathFor(hash);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return null; // corrupt/partial cache — treat as no cache, don't crash the job over it
  }
}

function writeCache(hash, data) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(cachePathFor(hash), JSON.stringify({ ...data, timestamp: new Date().toISOString() }));
}

function clearCache(hash) {
  const p = cachePathFor(hash);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

export function runIngestJob(jobId, pdfPath) {
  newJob(jobId, pdfPath);
  // Fire-and-forget — caller turant jobId return karta hai, ye
  // background mein chalti hai, UI poll karta hai getJob() se.
  (async () => {
    let hash = null;
    try {
      hash = await hashFile(pdfPath);
      const cache = readCache(hash);

      let movies, embeddings, failedBatches;

      if (cache?.embeddings) {
        // Parse AND embed already done in a previous attempt — skip both.
        movies = cache.movies;
        embeddings = cache.embeddings;
        failedBatches = cache.failedBatches || [];
        updateJob(jobId, { stage: "embedding" });
        appendLog(jobId, `Resuming from a previous attempt — ${movies.length} movies were already parsed and embedded. Skipping straight to the database write.`);
      } else if (cache?.movies) {
        // Parse done, embedding wasn't — skip parse only.
        movies = cache.movies;
        appendLog(jobId, `Resuming from a previous attempt — ${movies.length} movies were already parsed. Skipping PDF parsing.`);

        updateJob(jobId, { stage: "embedding" });
        appendLog(jobId, "Generating embeddings...");
        const embedResult = await generateMovieEmbeddings(movies);
        embeddings = embedResult.embeddings;
        failedBatches = embedResult.failedBatches;
        writeCache(hash, { movies, embeddings, failedBatches });
        appendLog(jobId, `Generated ${embeddings.length}/${movies.length} embeddings.`);
      } else {
        // Fresh run — nothing cached yet.
        updateJob(jobId, { stage: "parsing" });
        appendLog(jobId, `Reading ${path.basename(pdfPath)}...`);
        movies = await parsePDFToMovies(pdfPath);
        appendLog(jobId, `Parsed ${movies.length} movies.`);
        writeCache(hash, { movies });

        updateJob(jobId, { stage: "embedding" });
        appendLog(jobId, "Generating embeddings...");
        const embedResult = await generateMovieEmbeddings(movies);
        embeddings = embedResult.embeddings;
        failedBatches = embedResult.failedBatches;
        writeCache(hash, { movies, embeddings, failedBatches });
        appendLog(jobId, `Generated ${embeddings.length}/${movies.length} embeddings.`);
      }

      if (failedBatches?.length > 0) {
        appendLog(jobId, `${failedBatches.length} embedding batch(es) failed — those movies may be missing from semantic search.`);
      }

      updateJob(jobId, { stage: "loading" });
      appendLog(jobId, "Checking for movies that already exist in the database...");
      const { movies: reconciled, matched, newMovies } = await reconcileMovieIds(movies);
      appendLog(jobId, `${matched} movie(s) already existed — will update, not duplicate. ${newMovies} new movie(s) will be added.`);

      appendLog(jobId, "Writing to Pinecone + Neo4j...");
      const [pineconeCount, neo4jCount] = await Promise.all([
        loadMoviesToPinecone(reconciled, embeddings),
        loadMoviesToNeo4j(reconciled),
      ]);
      appendLog(jobId, `Pinecone: ${pineconeCount} vectors. Neo4j: ${neo4jCount} movies.`);

      updateJob(jobId, {
        stage: "done",
        result: { movies: movies.length, matched, newMovies, pineconeCount, neo4jCount },
      });
      appendLog(jobId, "Ingestion complete.");

      clearCache(hash); // success — nothing left to resume, safe to drop
    } catch (err) {
      updateJob(jobId, { stage: "error", error: err.message });
      appendLog(jobId, `Failed: ${err.message}`);
      if (hash) {
        appendLog(jobId, "Progress so far is cached — hit Retry and it'll resume instead of starting over.");
      }
    }
  })();

  return jobId;
}

// ── Retry a failed job — reuses the same uploaded PDF, so the hash-
// keyed cache above kicks in and skips whatever already succeeded. ──
export function retryJob(oldJobId, newJobId) {
  const oldJob = jobs.get(oldJobId);
  if (!oldJob || !oldJob.pdfPath || !fs.existsSync(oldJob.pdfPath)) return null;
  return runIngestJob(newJobId, oldJob.pdfPath);
}