// ============================================================
// scripts/testAllConnections.js
//
// Ek hi run mein SAB connections test karo:
//   1. Neo4j        (graph DB)
//   2. Pinecone      (vector DB)
//   3. LLM chain     (Groq primary, OpenRouter free+paid fallback)
//   4. OpenRouter Embedding (qwen3-embedding-8b)
//
// Run: npm run test:all   (ya: node scripts/testAllConnections.js)
//
// Individual test files (tests/test*.js) granular debugging ke
// liye already hain — ye file sirf ek quick "sab theek hai?" check
// deta hai, ek clean pass/fail summary ke saath.
// ============================================================

import dotenv from "dotenv";
dotenv.config();

import { getNeo4jDriver, runQuery, closeNeo4jDriver } from "../src/utils/neo4jClient.js";
import { getPineconeClient } from "../src/utils/pineconeClient.js";
import { chatCompletion, createEmbeddings } from "../src/utils/openrouterClient.js";
import { MODELS } from "../src/config/constants.js";

const results = []; // { name, ok, detail }

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(ok ? `  ✅ ${name}: ${detail}` : `  ❌ ${name}: ${detail}`);
}

async function testNeo4j() {
  console.log("\n🧪 [1/4] Neo4j...");
  try {
    const driver = getNeo4jDriver();
    await driver.verifyConnectivity();
    const result = await runQuery("RETURN 1 AS num");
    if (result[0]?.num !== 1) throw new Error("unexpected query result");
    record("Neo4j", true, "connected + query executed successfully");
  } catch (err) {
    record("Neo4j", false, err.message);
  }
}

async function testPinecone() {
  console.log("\n🧪 [2/4] Pinecone...");
  try {
    const client = getPineconeClient();
    const indexes = await client.listIndexes();
    const names = indexes.indexes?.map((i) => i.name) || [];
    record("Pinecone", true, `connected — ${names.length} index(es) found: [${names.join(", ") || "none yet"}]`);
  } catch (err) {
    record("Pinecone", false, err.message);
  }
}

async function testLLMChain() {
  console.log("\n🧪 [3/4] LLM chain (Groq primary → OpenRouter free → OpenRouter paid)...");
  const groqEnabled = Boolean(process.env.GROQ_API_KEY);
  try {
    const response = await chatCompletion(
      MODELS.LLM,
      [{ role: "user", content: "Reply with exactly one word: OK" }],
      10
    );
    record(
      "LLM chain",
      true,
      `responded: "${response.trim().substring(0, 40)}" (${groqEnabled ? "Groq enabled — check above for which tier answered" : "GROQ_API_KEY not set, used OpenRouter only"})`
    );
  } catch (err) {
    record("LLM chain", false, err.message);
  }
}

async function testOpenRouterEmbedding() {
  console.log("\n🧪 [4/4] OpenRouter Embedding...");
  try {
    const embeddings = await createEmbeddings(MODELS.EMBEDDING, ["test movie about space exploration"]);
    const dim = embeddings[0]?.length || 0;
    const expected = MODELS.EMBEDDING_DIMENSIONS;
    if (dim !== expected) {
      record(
        "OpenRouter Embedding",
        false,
        `dimension mismatch — got ${dim}, expected ${expected} (check MODELS.EMBEDDING_DIMENSIONS in constants.js matches "${MODELS.EMBEDDING}")`
      );
    } else {
      record("OpenRouter Embedding", true, `model "${MODELS.EMBEDDING}" returned ${dim}-dim vector`);
    }
  } catch (err) {
    record("OpenRouter Embedding", false, err.message);
  }
}

async function main() {
  console.log("🔌 Testing ALL connections (Neo4j, Pinecone, OpenRouter LLM, OpenRouter Embedding)...");

  await testNeo4j();
  await testPinecone();
  await testLLMChain();
  await testOpenRouterEmbedding();

  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("📋 SUMMARY");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  const passed = results.filter((r) => r.ok).length;
  results.forEach((r) => console.log(`  ${r.ok ? "✅" : "❌"} ${r.name}`));
  console.log(`\n  ${passed}/${results.length} connections OK`);

  await closeNeo4jDriver();

  if (passed < results.length) {
    console.log("\n⚠️  Some connections failed — check .env values and the error details above.");
    process.exit(1);
  } else {
    console.log("\n✅ ALL CONNECTIONS WORKING — safe to run: node scripts/ingest.js ./scripts/movies.pdf");
  }
}

main();