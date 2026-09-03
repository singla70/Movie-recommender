// ============================================================
// tests/testNeo4jConnection.js
//
// Neo4j connection test karo
// Run: npm run test:neo4j
// ============================================================

import dotenv from "dotenv";
dotenv.config();

import { getNeo4jDriver, runQuery, closeNeo4jDriver } from "../src/utils/neo4jClient.js";

async function testNeo4jConnection() {
  console.log("🧪 Testing Neo4j Connection...\n");

  try {
    // Test 1: Driver create + connectivity verify
    console.log("Test 1: Verifying connectivity...");
    const driver = getNeo4jDriver();
    await driver.verifyConnectivity();
    console.log("  ✅ Connected to Neo4j successfully");

    // Test 2: Simple query run karo
    console.log("Test 2: Running simple query...");
    const result = await runQuery("RETURN 1 AS num, 'hello' AS msg");
    console.log(`  ✅ Query result: num=${result[0].num}, msg=${result[0].msg}`);

    // Test 3: DB version check
    console.log("Test 3: Checking Neo4j version...");
    const versionResult = await runQuery("CALL dbms.components() YIELD name, versions RETURN name, versions[0] AS version LIMIT 1");
    if (versionResult.length > 0) {
      console.log(`  ✅ Neo4j ${versionResult[0].name} version: ${versionResult[0].version}`);
    }

    // Test 4: Existing data check
    console.log("Test 4: Checking existing movie data...");
    const countResult = await runQuery("MATCH (m:Movie) RETURN count(m) AS count");
    const movieCount = countResult[0]?.count || 0;
    console.log(`  ✅ Existing movies in DB: ${movieCount}`);

    console.log("\n✅ ALL NEO4J TESTS PASSED");
    console.log("   Your Neo4j connection is working correctly!\n");

  } catch (err) {
    console.error("\n❌ NEO4J TEST FAILED:", err.message);
    if (err.message.includes("authentication")) {
      console.error("   → Check NEO4J_USERNAME and NEO4J_PASSWORD in .env");
    } else if (err.message.includes("ECONNREFUSED") || err.message.includes("ServiceUnavailable")) {
      console.error("   → Check NEO4J_URI in .env — is the database running?");
    }
    process.exit(1);
  } finally {
    await closeNeo4jDriver();
  }
}

testNeo4jConnection();
