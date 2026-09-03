// ============================================================
// scripts/loadFromCache.js
//
// Agar ingest.js STEP 3 (DB load — Pinecone/Neo4j) mein fail ho
// jaaye, lekin STEP 1-2 (PDF parse + embed) already complete ho
// chuke the — ye script ingestion-cache.json se movies+embeddings
// seedha load karke SIRF DB-load step retry karta hai. PDF dobara
// parse nahi hota, embeddings dobara generate nahi hoti — matlab
// koi LLM/embedding API call dobara nahi lagti (cost + time bachta
// hai — exactly wahi scenario jo is round mein hua tha: Pinecone
// upsert bug ki wajah se 307 movies ka parse+embed work waste ho
// gaya tha).
//
// Run: node scripts/loadFromCache.js
// ============================================================

import fs from "fs";
import { loadMoviesToPinecone } from "../src/ingestion/pineconeLoader.js";
import { loadMoviesToNeo4j, getNeo4jStats } from "../src/ingestion/neo4jLoader.js";
import { closeNeo4jDriver } from "../src/utils/neo4jClient.js";

const CACHE_FILE = "./ingestion-cache.json";

async function main() {
  if (!fs.existsSync(CACHE_FILE)) {
    console.error(`❌ ${CACHE_FILE} nahi mila.`);
    console.error(`   Ye script sirf tab kaam karta hai jab pehle ek "node scripts/ingest.js <pdf>"`);
    console.error(`   run ne PDF parse + embed complete kiya ho lekin DB-load step fail ho gaya ho`);
    console.error(`   (cache us stage pe automatically save hoti hai).`);
    process.exit(1);
  }

  console.log(`💾 Loading cached data from ${CACHE_FILE}...`);
  const { movies, embeddings, timestamp } = JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8"));
  console.log(`   Cached at: ${timestamp}`);
  console.log(`   ${movies.length} movies, ${embeddings.length} embeddings\n`);

  const startTime = Date.now();

  try {
    console.log("━━━ Loading to Databases (Parallel) ━━━━━━━━━━━━━━━━");
    const [pineconeCount, neo4jCount] = await Promise.all([
      loadMoviesToPinecone(movies, embeddings),
      loadMoviesToNeo4j(movies),
    ]);

    const stats = await getNeo4jStats();
    console.log("\n📊 Neo4j Stats:", stats);
    console.log(`📌 Pinecone: ${pineconeCount} vectors`);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n✅ Cache-load complete in ${elapsed}s`);

    if (pineconeCount === movies.length && stats.movies) {
      // Sab kuch successfully load ho gaya — cache ab discard kar sakte hain
      fs.unlinkSync(CACHE_FILE);
      console.log(`   🗑️  Cache file cleaned up (${CACHE_FILE})`);
    } else {
      console.warn(`   ⚠️  Kuch mismatch dikh raha hai (expected ${movies.length}) — cache file abhi rakha hai, dobara chala sakte ho.`);
    }

    console.log('\n🚀 Now run: node app.js');
  } catch (err) {
    console.error("\n❌ Cache-load failed:", err.message);
    console.error(`   Cache file ${CACHE_FILE} safe hai — dobara try kar sakte ho.`);
    process.exit(1);
  } finally {
    await closeNeo4jDriver();
  }
}

main();