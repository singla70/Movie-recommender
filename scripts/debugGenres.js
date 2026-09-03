// ============================================================
// scripts/debugGenres.js
//
// Diagnostic — kyun "Action" akela kaam karta hai lekin
// ["Action","Romance"] "not available in database" deta hai,
// jabki searchByGenre() ka Cypher (UNWIND-based) OR semantics
// hona chahiye (Action akela 10 deta hai toh dono-genres wali
// query kam se kam wahi 10 deni chahiye, zero nahi).
//
// Ye script:
//   1. Graph mein ACTUAL saare Genre node names dikhata hai
//      (exact spelling/casing — LLM extraction se koi variation
//      aa sakta hai jaise "Romance" vs "Romantic")
//   2. searchByGenre() ka EXACT wahi Cypher single-genre aur
//      multi-genre dono ke saath directly run karke raw count
//      dikhata hai — taaki pata chale bug Cypher mein hai ya
//      kahin aur (routing/formatting)
//
// Run: node scripts/debugGenres.js
// ============================================================

import { runQueryWithRetry, closeNeo4jDriver } from "../src/utils/neo4jClient.js";

async function main() {
  try {
    console.log("━━━ 1. Graph mein saare Genre nodes ━━━━━━━━━━━━━");
    const allGenres = await runQueryWithRetry(
      "MATCH (g:Genre) RETURN g.name AS name, size([(g)<-[:HAS_GENRE]-(m) | m]) AS movieCount ORDER BY movieCount DESC"
    );
    allGenres.forEach(g => console.log(`  "${g.name}" — ${g.movieCount} movies`));

    console.log("\n━━━ 2. searchByGenre() ka EXACT Cypher — single genre ━━━");
    const singleCypher = `
      UNWIND $genres AS genreName
      MATCH (g:Genre) WHERE toLower(g.name) CONTAINS toLower(genreName)
      MATCH (m:Movie)-[:HAS_GENRE]->(g)
      RETURN m.title AS title, g.name AS matchedGenre
      LIMIT 10
    `;
    const single = await runQueryWithRetry(singleCypher, { genres: ["Action"] });
    console.log(`  ["Action"] → ${single.length} results`);
    single.forEach(r => console.log(`    - ${r.title} (matched genre node: "${r.matchedGenre}")`));

    console.log("\n━━━ 3. searchByGenre() ka EXACT Cypher — do genres ━━━");
    const multi = await runQueryWithRetry(singleCypher, { genres: ["Action", "Romance"] });
    console.log(`  ["Action", "Romance"] → ${multi.length} results`);
    multi.forEach(r => console.log(`    - ${r.title} (matched genre node: "${r.matchedGenre}")`));

    console.log(`\n━━━ 4. Kya "Romance" (ya milta-julta) koi genre node hai? ━━━`);
    const romanceCheck = await runQueryWithRetry(
      "MATCH (g:Genre) WHERE toLower(g.name) CONTAINS 'roman' RETURN g.name AS name"
    );
    console.log(romanceCheck.length > 0
      ? `  ✅ Mila: ${romanceCheck.map(r => `"${r.name}"`).join(", ")}`
      : `  ❌ Koi Genre node nahi hai jisme "roman" substring ho — "Romance" tag ki koi movie parse nahi hui thi (307/688 partial dataset ki wajah se)`);
  } catch (err) {
    console.error("❌ Diagnostic failed:", err.message);
  } finally {
    await closeNeo4jDriver();
  }
}

main();