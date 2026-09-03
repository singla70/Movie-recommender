// ============================================================
// server/ingestJob.js
//
// scripts/ingest.js jaisa hi pipeline hai (parse → embed → load),
// bas console.log ki jagah in-memory job-state track karta hai —
// taaki Admin UI polling se progress dikha sake. Jobs process
// memory mein rakhe jaate hain (Map) — ek single-server-instance
// deployment ke liye theek hai; production-scale ke liye Redis/DB
// backed job-queue chahiye hoga (yahan scope se bahar).
// ============================================================

import { parsePDFToMovies } from "../src/ingestion/pdfParser.js";
import { generateMovieEmbeddings } from "../src/ingestion/embedder.js";
import { loadMoviesToPinecone } from "../src/ingestion/pineconeLoader.js";
import { loadMoviesToNeo4j } from "../src/ingestion/neo4jLoader.js";

const jobs = new Map(); // jobId -> { stage, log, error, result }

function newJob(jobId) {
  jobs.set(jobId, { stage: "queued", log: [], error: null, result: null });
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

export function runIngestJob(jobId, pdfPath) {
  newJob(jobId);
  // Fire-and-forget — caller turant jobId return karta hai, ye
  // background mein chalti hai, UI poll karta hai getJob() se.
  (async () => {
    try {
      updateJob(jobId, { stage: "parsing" });
      appendLog(jobId, `Reading ${pdfPath}...`);
      const movies = await parsePDFToMovies(pdfPath);
      appendLog(jobId, `Parsed ${movies.length} movies.`);

      updateJob(jobId, { stage: "embedding" });
      appendLog(jobId, "Generating embeddings...");
      const { embeddings, failedBatches } = await generateMovieEmbeddings(movies);
      appendLog(jobId, `Generated ${embeddings.length}/${movies.length} embeddings.`);
      if (failedBatches.length > 0) {
        appendLog(jobId, `${failedBatches.length} embedding batch(es) failed — some movies may be missing.`);
      }

      updateJob(jobId, { stage: "loading" });
      appendLog(jobId, "Writing to Pinecone + Neo4j...");
      const [pineconeCount, neo4jCount] = await Promise.all([
        loadMoviesToPinecone(movies, embeddings),
        loadMoviesToNeo4j(movies),
      ]);
      appendLog(jobId, `Pinecone: ${pineconeCount} vectors. Neo4j: ${movies.length} movies.`);

      updateJob(jobId, {
        stage: "done",
        result: { movies: movies.length, pineconeCount, neo4jCount },
      });
      appendLog(jobId, "Ingestion complete.");
    } catch (err) {
      updateJob(jobId, { stage: "error", error: err.message });
      appendLog(jobId, `Failed: ${err.message}`);
    }
  })();

  return jobId;
}
