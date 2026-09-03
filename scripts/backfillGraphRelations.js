// ============================================================
// scripts/backfillGraphRelations.js
//
// FAST path — sirf WORKED_IN_GENRE aur CO_STARRED_WITH add karta
// hai, existing Neo4j data se hi (koi PDF/LLM call nahi).
//
// Run: node scripts/backfillGraphRelations.js
//
// Kab use karo: agar aapko sirf ye do relationships chahiye aur
// baaki (multi-director, IN_LANGUAGE, FROM_COUNTRY, real awards,
// raw-excerpt embeddings) abhi nahi chahiye — ye sabse fast/free
// migration hai.
//
// Poori migration (sab kuch) ke liye scripts/migrate.js use karo.
// ============================================================

import { runGraphOnlyBackfill } from "../src/ingestion/graphOnlyBackfill.js";
import { getNeo4jStats } from "../src/ingestion/neo4jLoader.js";
import { closeNeo4jDriver } from "../src/utils/neo4jClient.js";

async function main() {
  console.log("🔧 Graph-only relationship backfill (no PDF re-parse needed)\n");
  const startTime = Date.now();

  try {
    const { workedInGenreCount, coStarredCount } = await runGraphOnlyBackfill();

    const stats = await getNeo4jStats();
    console.log("📊 Current Neo4j stats:", stats);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n✅ Backfill complete in ${elapsed}s`);
    console.log(`   WORKED_IN_GENRE relationships: ${workedInGenreCount}`);
    console.log(`   CO_STARRED_WITH relationships: ${coStarredCount}`);
    console.log(`\n   Still missing (need PDF re-parse — run scripts/migrate.js):`);
    console.log(`   - IN_LANGUAGE / FROM_COUNTRY relationships + Movie.language/.country properties`);
    console.log(`   - Multi-director support (co-directed movies)`);
    console.log(`   - Real award names (currently only generic "Academy Award" if oscarWon)`);
    console.log(`   - Raw-excerpt-based vector embeddings in Pinecone (currently templated text)`);
  } catch (err) {
    console.error("\n❌ Backfill failed:", err.message);
    process.exit(1);
  } finally {
    await closeNeo4jDriver();
  }
}

main();