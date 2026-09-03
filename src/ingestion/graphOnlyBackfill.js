// ============================================================
// src/ingestion/graphOnlyBackfill.js
//
// Kuch naye relationships PURELY existing Neo4j graph data se
// derive ho sakte hain — bina PDF dobara parse kiye, bina LLM
// call kiye. Ye fast, free, aur safe hai already-inserted data
// pe turant chalane ke liye.
//
//   WORKED_IN_GENRE  = (Actor)-[:ACTED_IN]->(Movie)-[:HAS_GENRE]->(Genre)
//                       se directly compute ho sakta hai — humein
//                       sirf count karna hai actor ne kitni movies
//                       kis genre mein ki hain, jo already stored hai.
//
//   CO_STARRED_WITH  = (Actor)-[:ACTED_IN]->(Movie)<-[:ACTED_IN]-(Actor)
//                       se directly derive ho sakta hai — jo actors
//                       same movie mein ACTED_IN hain, wo co-stars hain.
//
// In dono ke liye PDF ka koi naya data NAHI chahiye — sab kuch
// already graph mein maujood hai. Isliye ye backfill turant, bina
// kisi re-ingestion ke, chal sakta hai.
//
// NOTE: IN_LANGUAGE, FROM_COUNTRY, multi-director, real award
// names, aur raw-excerpt embeddings — in sabke liye original PDF
// data chahiye (purani run mein ye extract hi nahi hua tha,
// isliye graph mein hai hi nahi). Unke liye scripts/migrate.js
// use karo (PDF dobara parse karta hai).
//
// Idempotent: dobara chalane se duplicate nahi banega — MERGE
// aur exact-count SET (increment nahi) use kiya hai, isliye jitni
// baar chalao, result same rahega.
// ============================================================

import { runQueryWithRetry } from "../utils/neo4jClient.js";

export async function backfillWorkedInGenre() {
  console.log("  🔧 Backfilling WORKED_IN_GENRE from existing ACTED_IN + HAS_GENRE...");
  const cypher = `
    MATCH (a:Actor)-[:ACTED_IN]->(m:Movie)-[:HAS_GENRE]->(g:Genre)
    WITH a, g, count(DISTINCT m) AS movieCount
    MERGE (a)-[wig:WORKED_IN_GENRE]->(g)
    SET wig.count = movieCount
    RETURN count(*) AS relationshipsSet
  `;
  const result = await runQueryWithRetry(cypher);
  const count = result[0]?.relationshipsSet || 0;
  console.log(`  ✅ WORKED_IN_GENRE: ${count} (actor, genre) relationships set/updated`);
  return count;
}

export async function backfillCoStarredWith() {
  console.log("  🔧 Backfilling CO_STARRED_WITH from existing ACTED_IN pairs...");
  // a1.name < a2.name se har pair sirf ek baar milta hai
  // (self-pairs aur reverse-duplicates dono avoid ho jaate hain)
  const cypher = `
    MATCH (a1:Actor)-[:ACTED_IN]->(m:Movie)<-[:ACTED_IN]-(a2:Actor)
    WHERE a1.name < a2.name
    MERGE (a1)-[:CO_STARRED_WITH]-(a2)
    RETURN count(*) AS relationshipsSet
  `;
  const result = await runQueryWithRetry(cypher);
  const count = result[0]?.relationshipsSet || 0;
  console.log(`  ✅ CO_STARRED_WITH: ${count} actor-pair relationships set/updated`);
  return count;
}

export async function runGraphOnlyBackfill() {
  console.log("\n🕸️  Graph-only backfill starting (no PDF/LLM needed)...");
  const workedInGenreCount = await backfillWorkedInGenre();
  const coStarredCount = await backfillCoStarredWith();
  console.log("✅ Graph-only backfill complete.\n");
  return { workedInGenreCount, coStarredCount };
}