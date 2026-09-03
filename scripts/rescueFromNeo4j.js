// ============================================================
// scripts/rescueFromNeo4j.js
//
// SCENARIO: PDF parsing + Neo4j load already succeeded (movies
// are safely in Neo4j), but Pinecone load failed/never happened —
// aur us waqt ingestion-cache.json wala safety-net (loadFromCache.js)
// abhi tak nahi tha, isliye raw parsed-movies+embeddings cache
// mein save nahi hue. PDF/LLM dobara parse karne ki zaroorat NAHI —
// Neo4j mein already poora structured data hai (title, year, plot,
// directors, actors, genres, awards, language, country) — bas
// dobara PDF parse karne jaisa expensive LLM-call step SKIP ho
// jaata hai.
//
// Ye script:
//   1. Neo4j se saare movies + unke relationships read karta hai
//      (koi LLM call nahi — sirf ek Cypher query)
//   2. Embeddings generate karta hai (movie.plot se, kyunki
//      sourceExcerpt — jo Pinecone-specific raw-excerpt field hai —
//      Neo4j mein kabhi store nahi hota, sirf Pinecone ke liye tha.
//      movieToEmbeddableText() already plot pe fallback karta hai
//      jab sourceExcerpt na ho — same fallback yahan bhi apply
//      hota hai, koi extra code nahi chahiye)
//   3. Pinecone mein upsert karta hai
//
// COST NOTE: embedding step (qwen3-embedding-8b) OpenRouter ka
// PAID model hai — koi free-tier variant available nahi hai iske
// liye. 307 movies ke liye cost negligible hai (~$0.0003 total,
// ek cent se bhi kam) — lekin agar account balance EXACTLY $0 hai
// aur bilkul bhi credit add nahi kar sakte, ye step bhi 402 error
// dega. Us case mein PINECONE_FREE_EMBEDDING_ALTERNATIVE.md dekho
// (README mein bhi documented hai) — Pinecone ke apne free
// integrated-inference embedding se ye kaam bina OpenRouter ke
// bhi ho sakta hai.
//
// Run: node scripts/rescueFromNeo4j.js
// ============================================================

import { runQueryWithRetry, closeNeo4jDriver } from "../src/utils/neo4jClient.js";
import { generateMovieEmbeddings } from "../src/ingestion/embedder.js";
import { loadMoviesToPinecone } from "../src/ingestion/pineconeLoader.js";

async function fetchMoviesFromNeo4j() {
  console.log("📖 Reading movies from Neo4j (no PDF/LLM calls)...");
  const cypher = `
    MATCH (m:Movie)
    OPTIONAL MATCH (m)-[:DIRECTED_BY]->(d:Director)
    OPTIONAL MATCH (a:Actor)-[:ACTED_IN]->(m)
    OPTIONAL MATCH (m)-[:HAS_GENRE]->(g:Genre)
    OPTIONAL MATCH (m)-[:WON_AWARD]->(aw:Award)
    WITH m, collect(DISTINCT d.name) AS directors,
         collect(DISTINCT a.name) AS actors,
         collect(DISTINCT g.name) AS genres,
         collect(DISTINCT aw.name) AS awards
    RETURN m.id AS id, m.title AS title, m.year AS year, m.plot AS plot,
           m.rating AS rating, m.oscarWon AS oscarWon,
           m.oscarNominations AS oscarNominations,
           m.language AS language, m.country AS country,
           directors, actors, genres, awards
  `;
  const records = await runQueryWithRetry(cypher);
  console.log(`  ✅ Found ${records.length} movies in Neo4j`);
  // sourceExcerpt yahan nahi hai (Neo4j mein kabhi stored nahi hua) —
  // movieToEmbeddableText() khud plot pe fallback kar lega.
  return records.map(r => ({ ...r, sourceExcerpt: null }));
}

async function main() {
  console.log("🚑 Rescuing already-ingested Neo4j data into Pinecone...\n");
  const startTime = Date.now();

  try {
    const movies = await fetchMoviesFromNeo4j();
    if (movies.length === 0) {
      throw new Error("Neo4j mein koi movie nahi mili — pehle ingestion chalao.");
    }

    console.log("\n🔢 Generating embeddings (from movie.plot — sourceExcerpt Neo4j mein store nahi hota)...");
    const { embeddings, failedBatches } = await generateMovieEmbeddings(movies);

    if (embeddings.length === 0) {
      throw new Error(
        "Koi embedding generate nahi hui — agar error '402 exceed credits' hai, matlab OpenRouter " +
        "balance $0 hai (embedding paid model hai, iska free-tier variant nahi hai). " +
        "README ka 'Pinecone free embedding alternative' section dekho."
      );
    }

    console.log("\n📌 Upserting to Pinecone...");
    const pineconeCount = await loadMoviesToPinecone(movies, embeddings);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n✅ Rescue complete in ${elapsed}s`);
    console.log(`   Movies found in Neo4j: ${movies.length}`);
    console.log(`   Vectors upserted to Pinecone: ${pineconeCount}`);
    if (failedBatches.length > 0) {
      console.warn(`   ⚠️  ${failedBatches.length} embedding batch(es) failed — some movies may be missing from Pinecone.`);
    }
    console.log("\n🚀 Now run: node app.js");
  } catch (err) {
    console.error("\n❌ Rescue failed:", err.message);
    process.exit(1);
  } finally {
    await closeNeo4jDriver();
  }
}

main();