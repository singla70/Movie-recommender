// ============================================================
// scripts/cleanTestData.js
//
// Test pipeline se jo 3 sample movies insert hui thi unhe
// Neo4j aur Pinecone dono se delete karo
//
// Run: node scripts/cleanTestData.js
// ============================================================

import dotenv from "dotenv";
dotenv.config();

import { runQuery, closeNeo4jDriver } from "../src/utils/neo4jClient.js";
import { getPineconeIndex } from "../src/utils/pineconeClient.js";
import { PINECONE, MODELS } from "../src/config/constants.js";

const TEST_IDS = ["test-movie-001", "test-movie-002", "test-movie-003"];
const TEST_TITLES = ["Inception", "The Dark Knight", "Parasite"];

async function cleanTestData() {
  console.log("🧹 Cleaning test data from both databases...\n");

  try {
    // ── Neo4j: test IDs wali movies delete karo ───────────────
    console.log("Step 1: Removing test movies from Neo4j...");
    const result = await runQuery(
      `MATCH (m:Movie) WHERE m.id IN $ids
       DETACH DELETE m
       RETURN count(m) AS deleted`,
      { ids: TEST_IDS }
    );
    console.log(`  ✅ Neo4j: removed test movie nodes`);

    // ── Pinecone: test IDs delete karo ────────────────────────
    console.log("Step 2: Removing test vectors from Pinecone...");
    const index = await getPineconeIndex(PINECONE.INDEX_NAME, MODELS.EMBEDDING_DIMENSIONS);
    await index.deleteMany({ ids: TEST_IDS });
    console.log(`  ✅ Pinecone: removed ${TEST_IDS.length} test vectors`);

    console.log("\n✅ Test data cleaned! Now only real PDF movies remain.");

  } catch (err) {
    console.error("❌ Cleanup failed:", err.message);
  } finally {
    await closeNeo4jDriver();
  }
}

cleanTestData();