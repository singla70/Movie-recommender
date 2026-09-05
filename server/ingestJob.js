// ============================================================
// server/ingestJob.js
//
// scripts/ingest.js jaisa hi pipeline hai (parse → reconcile → embed
// → load), bas console.log ki jagah in-memory job-state track karta
// hai — taaki Admin UI polling se progress dikha sake. Jobs process
// memory mein rakhe jaate hain (Map) — ek single-server-instance
// deployment ke liye theek hai; production-scale ke liye Redis/DB
// backed job-queue chahiye hoga (yahan scope se bahar).
//
// PIPELINE ORDER — RECONCILE BEFORE EMBED (naya): pehle version
// parse → embed (SABKE liye, chahe already DB mein ho) → reconcile
// tha — matlab already-existing movies ke liye bhi embedding API
// calls waste hoti thi. Ab reconcile pehle chalta hai (sirf ek Neo4j
// read, sasta), aur embedding SIRF genuinely-new movies ke liye
// generate hoti hai. Already-existing movies ko is bulk-upload path
// se bilkul touch nahi kiya jaata — unhe update karna ho toh admin
// ke naya single-movie edit feature (src/ingestion/movieCrud.js,
// server/index.js ke /api/movies/:id routes) se hota hai, jahan
// admin explicitly decide karta hai kya badalna hai.
//
// RESUMABLE INGESTION — scripts/ingest.js ka CACHE_FILE pattern yahan
// bhi laaya gaya hai (pehle sirf CLI script mein tha, Admin-UI path
// mein bilkul nahi tha): PDF ka SHA-256 hash cache-key hai. Parsing
// (LLM calls) aur embedding (embedding-API calls) — dono expensive
// steps — har ek complete hote hi disk pe cache ho jaate hain. Agar
// koi baad ka step fail ho (rate limit, DB down, whatever), retry
// (same PDF) seedha jahan se rukha wahin se resume karta hai. Success
// pe cache delete ho jaata hai.
//
// FULL LOG VISIBILITY (naya) — pdfParser.js/embedder.js/
// pineconeLoader.js/neo4jLoader.js/idReconciler.js sab already
// console.log/warn/error se rich batch-level progress print karte
// hain ("batch 3/7", "upserting...", etc) — pehle ye sirf Render ke
// server logs mein jaate the, Admin UI ko sirf humare manual
// milestone-summaries dikhte the. Ab is job ke chalte waqt console.*
// ko temporarily wrap kiya jaata hai taaki HAR line job ke apne log
// mein bhi capture ho (aur asli console pe bhi print hoti rahe —
// Render ke logs silent nahi hote). Assumption: ek waqt mein sirf EK
// ingestion job chalti hai (single-admin portfolio app ke liye
// realistic) — concurrent jobs hui toh unke logs mix ho sakte hain.
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
  if (job.log.length > 500) job.log.shift(); // cap — UI ek badi list ke liye scroll kar sakta hai
}

export function getJob(jobId) {
  return jobs.get(jobId) || null;
}

// ── Console.* ko temporarily capture karo isi job ke log mein ──
async function withCapturedConsole(jobId, fn) {
  const original = { log: console.log, warn: console.warn, error: console.error };
  const capture = (prefix) => (...args) => {
    const line = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ").trim();
    if (line) appendLog(jobId, line);
    original[prefix](...args); // Render ke apne logs bhi chalte rahen
  };
  console.log = capture("log");
  console.warn = capture("warn");
  console.error = capture("error");
  try {
    return await fn();
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  }
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
  withCapturedConsole(jobId, () => runPipeline(jobId, pdfPath)).catch((err) => {
    // withCapturedConsole ke bahar ka fallback — agar console-wrap
    // khud hi kabhi throw kare (nahi hona chahiye, safety net hai)
    updateJob(jobId, { stage: "error", error: err.message });
  });
  return jobId;
}

async function runPipeline(jobId, pdfPath) {
  let hash = null;
  try {
    hash = await hashFile(pdfPath);
    const cache = readCache(hash);

    let parsedMovies, embeddings, failedBatches;

    if (cache?.parsedMovies) {
      parsedMovies = cache.parsedMovies;
      appendLog(jobId, `Resuming from a previous attempt — ${parsedMovies.length} movies were already parsed. Skipping PDF parsing.`);
    } else {
      updateJob(jobId, { stage: "parsing" });
      appendLog(jobId, `Reading ${path.basename(pdfPath)}...`);
      parsedMovies = await parsePDFToMovies(pdfPath);
      appendLog(jobId, `Parsed ${parsedMovies.length} movies.`);
      writeCache(hash, { parsedMovies });
    }

    // Reconcile BEFORE embedding — sirf genuinely-new movies ke liye
    // embedding API calls lagengi. Already-existing movies is path se
    // bilkul touch nahi hote (unhe badalna ho toh admin ke single-
    // movie edit feature se hota hai).
    updateJob(jobId, { stage: "reconciling" });
    appendLog(jobId, "Checking which movies already exist in the database...");
    const { newMovieList, matched } = await reconcileMovieIds(parsedMovies);
    appendLog(jobId, `${matched} movie(s) already exist — skipped (no re-embedding, no re-write). ${newMovieList.length} new movie(s) to add.`);

    if (newMovieList.length === 0) {
      updateJob(jobId, { stage: "done", result: { total: parsedMovies.length, matched, added: 0, pineconeCount: 0, neo4jCount: 0 } });
      appendLog(jobId, "Nothing new to add — every movie in this PDF is already in the database.");
      clearCache(hash);
      return;
    }

    if (cache?.embeddings) {
      embeddings = cache.embeddings;
      failedBatches = cache.failedBatches || [];
      appendLog(jobId, `Resuming — embeddings for the new movies were already generated in a previous attempt.`);
    } else {
      updateJob(jobId, { stage: "embedding" });
      appendLog(jobId, `Generating embeddings for ${newMovieList.length} new movie(s)...`);
      const embedResult = await generateMovieEmbeddings(newMovieList);
      embeddings = embedResult.embeddings;
      failedBatches = embedResult.failedBatches;
      writeCache(hash, { parsedMovies, embeddings, failedBatches });
      appendLog(jobId, `Generated ${embeddings.length}/${newMovieList.length} embeddings.`);
    }

    if (failedBatches?.length > 0) {
      appendLog(jobId, `${failedBatches.length} embedding batch(es) failed — those movies won't be searchable yet: ${failedBatches.flatMap((b) => b.movieIds).join(", ")}`);
    }

    // Embed ho chuki movies hi load karo — agar koi batch permanently
    // fail hui (failedBatches), uska embedding nahi bana, isliye use
    // load bhi nahi karna (loadMoviesToPinecone khud bhi ismein
    // movieId-not-found pe warn karke skip kar deta, ye extra check
    // sirf load-step ko sirf-relevant movies tak seedha limit karta hai).
    const embeddedIds = new Set(embeddings.map((e) => e.movieId));
    const moviesToLoad = newMovieList.filter((m) => embeddedIds.has(m.id));

    updateJob(jobId, { stage: "loading" });
    appendLog(jobId, `Writing ${moviesToLoad.length} movie(s) to Pinecone + Neo4j...`);
    const [pineconeCount, neo4jCount] = await Promise.all([
      loadMoviesToPinecone(moviesToLoad, embeddings),
      loadMoviesToNeo4j(moviesToLoad),
    ]);
    appendLog(jobId, `Pinecone: ${pineconeCount} vectors. Neo4j: ${neo4jCount} movies.`);

    updateJob(jobId, {
      stage: "done",
      result: {
        total: parsedMovies.length,
        matched,
        added: pineconeCount,
        pineconeCount,
        neo4jCount,
        failedMovies: failedBatches?.flatMap((b) => b.movieIds) || [],
      },
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
}

// ── Retry a failed job — reuses the same uploaded PDF, so the hash-
// keyed cache above kicks in and skips whatever already succeeded. ──
export function retryJob(oldJobId, newJobId) {
  const oldJob = jobs.get(oldJobId);
  if (!oldJob || !oldJob.pdfPath || !fs.existsSync(oldJob.pdfPath)) return null;
  return runIngestJob(newJobId, oldJob.pdfPath);
}