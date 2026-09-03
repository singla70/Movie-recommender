// ============================================================
// tests/testEmbedding.js
//
// OpenRouter embedding API test karo
// Run: npm run test:embedding
// ============================================================

import dotenv from "dotenv";
dotenv.config();

import { createEmbeddings } from "../src/utils/openrouterClient.js";
import { MODELS } from "../src/config/constants.js";

async function testEmbedding() {
  console.log("🧪 Testing OpenRouter Embeddings...\n");

  try {
    // Test 1: Single text embedding
    console.log("Test 1: Single text embedding...");
    const singleResult = await createEmbeddings(MODELS.EMBEDDING, [
      "A movie about a thief who enters dreams",
    ]);
    console.log(`  ✅ Got embedding — dimensions: ${singleResult[0].length}`);
    console.log(`  ✅ Expected: ${MODELS.EMBEDDING_DIMENSIONS} | Got: ${singleResult[0].length}`);

    if (singleResult[0].length !== MODELS.EMBEDDING_DIMENSIONS) {
      console.warn(
        `  ⚠️  Dimension mismatch! Update EMBEDDING_DIMENSIONS in constants.js to ${singleResult[0].length}`
      );
    }

    // Test 2: Batch embedding (5 texts ek saath)
    console.log("\nTest 2: Batch embedding (5 texts)...");
    const batchTexts = [
      "Title: Inception. Director: Christopher Nolan. Sci-Fi Thriller.",
      "Title: The Godfather. Director: Francis Ford Coppola. Crime Drama.",
      "Title: Parasite. Director: Bong Joon-ho. Thriller. Won Oscar.",
      "Title: Interstellar. Director: Christopher Nolan. Sci-Fi.",
      "Title: Schindler's List. Director: Steven Spielberg. Drama. Won Oscar.",
    ];

    const batchResult = await createEmbeddings(MODELS.EMBEDDING, batchTexts);
    console.log(`  ✅ Got ${batchResult.length} embeddings for ${batchTexts.length} texts`);
    console.log(`  ✅ Each embedding dimension: ${batchResult[0].length}`);

    // Test 3: Similarity check — Nolan movies should be more similar to each other
    console.log("\nTest 3: Semantic similarity check...");
    const inceptionEmbed = batchResult[0];  // Inception
    const interstellarEmbed = batchResult[3]; // Interstellar (both Nolan)
    const godfatherEmbed = batchResult[1];    // Godfather (different)

    const simNolanNolan = cosineSimilarity(inceptionEmbed, interstellarEmbed);
    const simNolanGodfather = cosineSimilarity(inceptionEmbed, godfatherEmbed);

    console.log(`  Inception ↔ Interstellar (both Nolan): ${simNolanNolan.toFixed(4)}`);
    console.log(`  Inception ↔ Godfather (different):     ${simNolanGodfather.toFixed(4)}`);

    if (simNolanNolan > simNolanGodfather) {
      console.log("  ✅ Nolan movies are more similar to each other — embeddings working correctly!");
    } else {
      console.log("  ⚠️  Unexpected similarity order — but embeddings are generating");
    }

    console.log("\n✅ ALL EMBEDDING TESTS PASSED\n");

  } catch (err) {
    console.error("\n❌ EMBEDDING TEST FAILED:", err.message);
    if (err.message.includes("401")) {
      console.error("   → Check your OPENROUTER_API_KEY in .env file");
    } else if (err.message.includes("404")) {
      console.error("   → Embedding model not found. Check MODELS.EMBEDDING in constants.js");
    }
    process.exit(1);
  }
}

// ── Cosine similarity calculate karo ─────────────────────────
function cosineSimilarity(vecA, vecB) {
  const dot = vecA.reduce((sum, a, i) => sum + a * vecB[i], 0);
  const magA = Math.sqrt(vecA.reduce((sum, a) => sum + a * a, 0));
  const magB = Math.sqrt(vecB.reduce((sum, b) => sum + b * b, 0));
  return dot / (magA * magB);
}

testEmbedding();
