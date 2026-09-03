// ============================================================
// tests/testPineconeConnection.js
//
// Pinecone connection test karo
// Run: npm run test:pinecone
// ============================================================

import dotenv from "dotenv";
dotenv.config();

import { getPineconeClient } from "../src/utils/pineconeClient.js";

async function testPineconeConnection() {
  console.log("🧪 Testing Pinecone Connection...\n");

  try {
    // Test 1: Client create hota hai kya
    console.log("Test 1: Creating Pinecone client...");
    const client = getPineconeClient();
    console.log("  ✅ Client created");

    // Test 2: Indexes list kar sako
    console.log("Test 2: Listing indexes...");
    const indexes = await client.listIndexes();
    const indexList = indexes.indexes || [];
    console.log(`  ✅ Found ${indexList.length} existing indexes`);
    if (indexList.length > 0) {
      indexList.forEach((idx) => console.log(`     - ${idx.name} (${idx.status?.ready ? "ready" : "not ready"})`));
    }

    // Test 3: Describe index agar exist karta hai
    if (indexList.length > 0) {
      console.log(`Test 3: Describing index "${indexList[0].name}"...`);
      const desc = await client.describeIndex(indexList[0].name);
      console.log(`  ✅ Index dimension: ${desc.dimension}, metric: ${desc.metric}`);
    }

    console.log("\n✅ ALL PINECONE TESTS PASSED");
    console.log("   Your Pinecone connection is working correctly!\n");

  } catch (err) {
    console.error("\n❌ PINECONE TEST FAILED:", err.message);
    if (err.message.includes("401") || err.message.includes("403")) {
      console.error("   → Check your PINECONE_API_KEY in .env file");
    }
    process.exit(1);
  }
}

testPineconeConnection();
