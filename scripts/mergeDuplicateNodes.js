// ============================================================
// scripts/mergeDuplicateNodes.js
//
// ROOT CAUSE: createIndexes() (neo4jClient.js) pehle sirf Movie.id
// pe UNIQUE CONSTRAINT lagati thi — Actor/Director/Genre/Award/
// Language/Country sirf plain INDEX the. Plain index duplicate-
// creation ko ROKTA nahi. Parallel Neo4j batch insertion
// (MAX_PARALLEL_BATCHES=3) ke saath, jab do transactions EK HI
// nayi entity (jaise "Action" Genre, jo abhi tak exist nahi karti)
// ko SAME TIME pe MERGE karne ki koshish karte hain, dono ek-
// dusre ka not-yet-committed write nahi dekh paate — result:
// duplicate nodes. High-frequency entities (Genre — sirf ~30
// unique names 307+ movies ke against) is race ke liye sabse
// zyada vulnerable hain.
//
// Ye script:
//   1. Har duplicate-prone label (Actor, Director, Genre, Award,
//      Language, Country) ke liye same-name duplicate nodes
//      dhundhta hai, APOC (`apoc.refactor.mergeNodes`) se merge
//      karta hai — saare relationships (kisi bhi type/direction
//      ke) automatically ek node pe consolidate ho jaate hain,
//      duplicate nodes delete ho jaate hain.
//   2. Movie nodes ko bhi (title+year) se check karta hai —
//      Movie ka unique key `id` hai (title nahi), toh alag-alag
//      ingestion runs mein positional IDs match na hone ki wajah
//      se duplicate Movie nodes bhi ban sakte the.
//   3. Cleanup ke baad naya UNIQUE CONSTRAINT create karta hai
//      (jo pehle is data-violation ki wajah se fail hota).
//
// REQUIRES: APOC Core procedures (Neo4j AuraDB — free tier
// included — mein by default available hote hain). Agar APOC
// available nahi hai, ye script clear error dega aur manual
// cleanup instructions dega.
//
// Run: node scripts/mergeDuplicateNodes.js --confirm
// ============================================================

import { runQueryWithRetry, createIndexes, closeNeo4jDriver } from "../src/utils/neo4jClient.js";

const DUPLICATE_PRONE_LABELS = ["Actor", "Director", "Genre", "Award", "Language", "Country"];

async function checkApocAvailable() {
  try {
    await runQueryWithRetry("RETURN apoc.version() AS version");
    return true;
  } catch {
    return false;
  }
}

async function mergeDuplicatesForLabel(label) {
  const cypher = `
    MATCH (n:${label})
    WITH n.name AS name, collect(n) AS nodes
    WHERE size(nodes) > 1
    CALL apoc.refactor.mergeNodes(nodes, {properties: "combine", mergeRels: true}) YIELD node
    RETURN name, count(*) AS merged
  `;
  const result = await runQueryWithRetry(cypher);
  if (result.length > 0) {
    console.log(`  ✅ ${label}: merged ${result.length} duplicate group(s) — ${result.map(r => r.name).join(", ")}`);
  } else {
    console.log(`  ✓ ${label}: no duplicates found`);
  }
  return result.length;
}

async function mergeDuplicateMovies() {
  // Movie ka unique key `id` hai, title nahi — isliye alag ingestion
  // runs (jinke positional IDs match nahi hue) se duplicate Movie
  // nodes ban sakte the (same title+year, alag id).
  const cypher = `
    MATCH (m:Movie)
    WITH toLower(m.title) AS titleKey, m.year AS year, collect(m) AS nodes
    WHERE size(nodes) > 1
    CALL apoc.refactor.mergeNodes(nodes, {properties: "combine", mergeRels: true}) YIELD node
    RETURN titleKey, year, count(*) AS merged
  `;
  const result = await runQueryWithRetry(cypher);
  if (result.length > 0) {
    console.log(`  ✅ Movie: merged ${result.length} duplicate group(s) — ${result.map(r => `${r.titleKey} (${r.year})`).join(", ")}`);
  } else {
    console.log(`  ✓ Movie: no duplicates found`);
  }
  return result.length;
}

async function main() {
  const confirmed = process.argv.includes("--confirm");
  if (!confirmed) {
    console.log("⚠️  Ye script duplicate nodes ko permanently merge kar dega (relationships consolidate honge, duplicate nodes delete honge).");
    console.log("   Confirm karne ke liye dobara chalao: node scripts/mergeDuplicateNodes.js --confirm");
    process.exit(0);
  }

  console.log("🔧 Checking APOC availability...");
  const apocAvailable = await checkApocAvailable();
  if (!apocAvailable) {
    console.error("❌ APOC procedures available nahi hain is Neo4j instance pe.");
    console.error("   Neo4j AuraDB (free tier included) mein APOC Core by default hona chahiye —");
    console.error("   agar self-hosted/Community edition use kar rahe ho, APOC plugin install karo:");
    console.error("   https://neo4j.com/docs/apoc/current/installation/");
    process.exit(1);
  }
  console.log("✅ APOC available.\n");

  try {
    console.log("🔧 Merging duplicate entity nodes...");
    let totalMerged = 0;
    for (const label of DUPLICATE_PRONE_LABELS) {
      totalMerged += await mergeDuplicatesForLabel(label);
    }

    console.log("\n🔧 Merging duplicate Movie nodes (by title+year)...");
    totalMerged += await mergeDuplicateMovies();

    console.log(`\n✅ Total duplicate groups merged: ${totalMerged}`);

    console.log("\n🔧 Re-creating indexes + unique constraints (should succeed now, data is clean)...");
    await createIndexes();

    console.log("\n✅ Cleanup complete. Future ingestion runs are now protected from this race condition.");
  } catch (err) {
    console.error("\n❌ Merge failed:", err.message);
    process.exit(1);
  } finally {
    await closeNeo4jDriver();
  }
}

main();