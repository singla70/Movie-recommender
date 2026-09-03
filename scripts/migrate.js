// ============================================================
// scripts/migrate.js
//
// FULL migration — purane (already-inserted) data ko naye schema
// ke mutabik update karta hai:
//   ✅ Multi-director support (co-directed movies)
//   ✅ IN_LANGUAGE / FROM_COUNTRY relationships + Movie properties
//   ✅ Real award names (Award nodes se, generic "Academy Award"
//      sirf fallback)
//   ✅ WORKED_IN_GENRE + CO_STARRED_WITH (in dono ke liye ye script
//      technically zaroori nahi hai — scripts/backfillGraphRelations.js
//      inhe bina PDF ke bhi kar deta hai — lekin ye pura re-run
//      unhe bhi correctly re-derive kar dega, extra safe)
//   ✅ Pinecone vectors — raw-excerpt-based embeddings se re-embed
//      (purane templated-text embeddings replace ho jayenge)
//
// Kyun PDF dobara parse karna padta hai: upar wali sab cheezein
// (sourceExcerpt, directors[], asli award names, language, country)
// purani ingestion run mein EXTRACT hi nahi hui thi — data kabhi
// stored hi nahi hua, sirf PDF mein hai. Inhe wapas paane ka sirf
// ek tareeka hai — PDF ko dobara LLM se parse karna.
//
// DUPLICATION SAFETY: fresh parse se naye positional movie IDs
// bante hain jo purane IDs se match nahi karenge (LLM ka extraction
// order run-to-run same nahi hota). Isliye idReconciler.js har
// fresh-parsed movie ko (title+year) se match karta hai existing
// Neo4j records se, aur match milne pe PURANA id reuse karta hai —
// taaki MERGE (Neo4j) aur upsert (Pinecone) existing record ko hi
// UPDATE karein, duplicate na banayein.
//
// Ye script safe hai baar-baar chalane ke liye (idempotent) —
// Neo4j MERGE-based hai, Pinecone upsert hamesha overwrite karta
// hai same id pe.
//
// Run: node scripts/migrate.js <path-to-pdf>
// Example: node scripts/migrate.js ./scripts/movies.pdf
// ============================================================

import fs from "fs";
import { parsePDFToMovies } from "../src/ingestion/pdfParser.js";
import { reconcileMovieIds } from "../src/ingestion/idReconciler.js";
import { generateMovieEmbeddings } from "../src/ingestion/embedder.js";
import { loadMoviesToPinecone } from "../src/ingestion/pineconeLoader.js";
import { loadMoviesToNeo4j, getNeo4jStats } from "../src/ingestion/neo4jLoader.js";
import { runGraphOnlyBackfill } from "../src/ingestion/graphOnlyBackfill.js";
import { closeNeo4jDriver } from "../src/utils/neo4jClient.js";

const PROGRESS_FILE = "./migration-progress.json";

async function main() {
  const pdfPath = process.argv[2];

  if (!pdfPath) {
    console.error("❌ Usage: node scripts/migrate.js <path-to-pdf>");
    console.error("   Example: node scripts/migrate.js ./scripts/movies.pdf");
    process.exit(1);
  }

  console.log("🔄 Movie Graph RAG — Migration (updating already-inserted data)...\n");
  console.log("   This re-parses the PDF to recover fields the old ingestion");
  console.log("   never captured, then safely UPDATES existing records\n");
  const startTime = Date.now();

  try {
    // ── Step 1: PDF Parse (fresh — captures directors[], sourceExcerpt,
    //            real awards, language, country) ─────────────────────
    console.log("━━━ STEP 1: Re-parsing PDF ━━━━━━━━━━━━━━━━━━━━━━━━━");
    const freshMovies = await parsePDFToMovies(pdfPath);

    if (freshMovies.length === 0) {
      throw new Error("No movies could be extracted from PDF");
    }
    saveProgress({ stage: "reparsed", movieCount: freshMovies.length });

    // ── Step 2: ID Reconciliation — match against existing data ──────
    console.log("\n━━━ STEP 2: Matching Against Existing Records ━━━━━");
    const { movies, matched, newMovies } = await reconcileMovieIds(freshMovies);
    saveProgress({ stage: "reconciled", matched, newMovies });

    // ── Step 3: Re-embed (raw-excerpt-based, replaces old templated
    //            embeddings) ──────────────────────────────────────────
    console.log("\n━━━ STEP 3: Re-generating Embeddings (raw excerpt) ━");
    const { embeddings, failedBatches } = await generateMovieEmbeddings(movies);
    saveProgress({ stage: "reembedded", embeddingCount: embeddings.length, failedBatches });

    // ── Step 4: Update Pinecone + Neo4j (parallel) ────────────────────
    // Pinecone: upsert overwrites vectors at the SAME id (matched movies)
    //           or creates new ones (new movies) — no duplicates.
    // Neo4j: MERGE updates existing Movie/Actor/Director/etc nodes,
    //        ADDS missing relationships (IN_LANGUAGE, FROM_COUNTRY,
    //        WORKED_IN_GENRE, CO_STARRED_WITH, multi-director,
    //        real award names) — no duplicate nodes created because
    //        MERGE keys (id for Movie, name for Actor/Director/etc)
    //        already existed for matched movies.
    console.log("\n━━━ STEP 4: Updating Databases (Parallel) ━━━━━━━━━━");
    const [pineconeCount, neo4jCount] = await Promise.all([
      loadMoviesToPinecone(movies, embeddings),
      loadMoviesToNeo4j(movies),
    ]);

    // ── Step 5: Graph-only backfill too (covers any movies that were
    //            in Neo4j but weren't in this PDF pass for some reason,
    //            e.g. if PDF changed) — safe/idempotent, cheap re-run ──
    console.log("\n━━━ STEP 5: Final Graph-Only Relationship Pass ━━━━━");
    await runGraphOnlyBackfill();

    // ── Step 6: Verify ─────────────────────────────────────────────
    console.log("\n━━━ STEP 6: Verification ━━━━━━━━━━━━━━━━━━━━━━━━━━");
    const stats = await getNeo4jStats();
    console.log("📊 Neo4j Stats:", stats);
    console.log(`📌 Pinecone: ${pineconeCount} vectors upserted`);

    if (fs.existsSync(PROGRESS_FILE)) fs.unlinkSync(PROGRESS_FILE);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n✅ Migration complete in ${elapsed}s`);
    console.log(`   Matched (updated existing): ${matched}`);
    console.log(`   New (freshly inserted):     ${newMovies}`);
    console.log(`   Vectors upserted:           ${pineconeCount}`);
    if (failedBatches.length > 0) {
      const failedMovieCount = failedBatches.reduce((n, b) => n + b.movieIds.length, 0);
      console.warn(`   ⚠️  ${failedBatches.length} embedding batch(es) failed (${failedMovieCount} movies) — see migration-progress.json trail above before it's deleted.`);
    }
  } catch (err) {
    console.error("\n❌ Migration failed:", err.message);
    console.error("   Progress saved to migration-progress.json — check .env and retry.");
    process.exit(1);
  } finally {
    await closeNeo4jDriver();
  }
}

function saveProgress(data) {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify({ ...data, timestamp: new Date().toISOString() }, null, 2));
}

main();