// ============================================================
// scripts/ingest.js
//
// ONE-TIME script — PDF → Neo4j + Pinecone
//
// Run: node scripts/ingest.js <path-to-pdf>
// Example: node scripts/ingest.js ./movies.pdf
//
// Kya karta hai:
//   1. PDF parse karo → structured movie JSON
//   2. Embeddings generate karo (batch)
//   3. Pinecone + Neo4j mein parallel insert karo
//   4. Progress file save karo (resume support)
// ============================================================

import fs from "fs";
import path from "path";
import { parsePDFToMovies } from "../src/ingestion/pdfParser.js";
import { generateMovieEmbeddings } from "../src/ingestion/embedder.js";
import { loadMoviesToPinecone } from "../src/ingestion/pineconeLoader.js";
import { loadMoviesToNeo4j, getNeo4jStats } from "../src/ingestion/neo4jLoader.js";
import { closeNeo4jDriver } from "../src/utils/neo4jClient.js";

// Progress file — crash hone pe yahan se resume karo
const PROGRESS_FILE = "./ingestion-progress.json";
// Cache file — parsed movies + embeddings yahan save hote hain
// STEP 2 complete hote hi. Isse agar STEP 3 (DB load) kisi bhi
// wajah se fail ho (jaisa is round mein Pinecone bug ki wajah se
// hua tha — 307 movies parse+embed karne ki poori LLM-cost waste
// ho gayi thi kyunki upsert fail hua), toh scripts/loadFromCache.js
// se seedha DB-load retry ho sakta hai — PDF dobara parse/embed
// NAHI karna padta (LLM/embedding API calls dobara nahi lagti,
// cost aur time dono bachte hain).
const CACHE_FILE = "./ingestion-cache.json";

async function main() {
  const pdfPath = process.argv[2];

  if (!pdfPath) {
    console.error("❌ Usage: node scripts/ingest.js <path-to-pdf>");
    console.error("   Example: node scripts/ingest.js ./movies.pdf");
    process.exit(1);
  }

  console.log("🎬 Movie Graph RAG — Ingestion Pipeline Starting...\n");
  const startTime = Date.now();

  try {
    // ── Step 1: PDF Parse ─────────────────────────────────────
    console.log("━━━ STEP 1: PDF Parsing ━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    const movies = await parsePDFToMovies(pdfPath);

    if (movies.length === 0) {
      throw new Error("No movies could be extracted from PDF");
    }

    // Progress save karo
    saveProgress({ stage: "parsed", movieCount: movies.length });

    // ── Step 2: Embeddings Generate ───────────────────────────
    console.log("\n━━━ STEP 2: Generating Embeddings ━━━━━━━━━━━━━━━━━━");
    const { embeddings, failedBatches } = await generateMovieEmbeddings(movies);

    saveProgress({
      stage: "embedded",
      embeddingCount: embeddings.length,
      // Permanently-failed batches (MAX_ATTEMPTS retries ke baad bhi) —
      // resume script inhe dobara try kar sakta hai.
      failedBatches,
    });

    // Cache save karo — DB-load step (STEP 3) fail ho jaaye toh bhi
    // ye expensive parsing+embedding work discard nahi hoga.
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ movies, embeddings, timestamp: new Date().toISOString() }));
    console.log(`  💾 Cached ${movies.length} movies + embeddings → ${CACHE_FILE} (safety net agar DB-load fail ho)`);

    // ── Step 3: Parallel DB Insert ────────────────────────────
    // Pinecone + Neo4j inserts parallel chalao — time half hoga
    console.log("\n━━━ STEP 3: Loading to Databases (Parallel) ━━━━━━━━");
    console.log("   Running Pinecone + Neo4j inserts simultaneously...");

    const [pineconeCount, neo4jCount] = await Promise.all([
      loadMoviesToPinecone(movies, embeddings),
      loadMoviesToNeo4j(movies),
    ]);

    // ── Step 4: Verify ────────────────────────────────────────
    console.log("\n━━━ STEP 4: Verification ━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    const stats = await getNeo4jStats();
    console.log("📊 Neo4j Stats:", stats);
    console.log(`📌 Pinecone: ${pineconeCount} vectors`);

    // Progress + cache file delete karo — ingestion complete, ab
    // inki zaroorat nahi (cache sirf DB-load-failure ka safety net tha)
    if (fs.existsSync(PROGRESS_FILE)) {
      fs.unlinkSync(PROGRESS_FILE);
    }
    if (fs.existsSync(CACHE_FILE)) {
      fs.unlinkSync(CACHE_FILE);
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n✅ Ingestion complete in ${elapsed}s`);
    console.log(`   Movies parsed:    ${movies.length}`);
    console.log(`   Vectors in Pinecone: ${pineconeCount}`);
    console.log(`   Nodes in Neo4j:   ${stats.movies || 0} movies`);
    if (failedBatches.length > 0) {
      const failedMovieCount = failedBatches.reduce((n, b) => n + b.movieIds.length, 0);
      console.warn(
        `   ⚠️  ${failedBatches.length} embedding batch(es) failed permanently (${failedMovieCount} movies missing from Pinecone). See ingestion-progress.json before it's deleted, or re-run ingestion for those movies.`
      );
    }
    console.log('\n🚀 Now run: node app.js');

  } catch (err) {
    console.error("\n❌ Ingestion failed:", err.message);
    console.error("   Check your .env file and try again.");
    if (fs.existsSync(CACHE_FILE)) {
      console.error(`   💾 Parsed movies + embeddings are cached in ${CACHE_FILE} — if parsing/embedding`);
      console.error(`      already succeeded, run "node scripts/loadFromCache.js" instead of re-running`);
      console.error(`      the full pipeline (saves LLM/embedding API calls and cost).`);
    }
    process.exit(1);
  } finally {
    await closeNeo4jDriver();
  }
}

function saveProgress(data) {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify({ ...data, timestamp: new Date().toISOString() }, null, 2));
}

main();