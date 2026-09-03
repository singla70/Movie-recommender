// ============================================================
// tests/testOpenRouter.js
//
// OpenRouter LLM (Llama 4 Scout) test karo
// Run: npm run test:llm
// ============================================================

import dotenv from "dotenv";
dotenv.config();

import { chatCompletion } from "../src/utils/openrouterClient.js";
import { MODELS } from "../src/config/constants.js";

async function testOpenRouter() {
  console.log("🧪 Testing OpenRouter LLM (Llama 4 Scout)...\n");

  try {
    // Test 1: Basic response
    console.log("Test 1: Basic response...");
    const basicReply = await chatCompletion(
      MODELS.LLM,
      [{ role: "user", content: "Reply with exactly: WORKING" }],
      20
    );
    console.log(`  ✅ Response: "${basicReply.trim()}"`);

    // Test 2: JSON output (query router jaisa)
    console.log("\nTest 2: JSON structured output...");
    const jsonReply = await chatCompletion(
      MODELS.LLM,
      [
        {
          role: "user",
          content:
            'Return ONLY this JSON, no explanation: {"status": "ok", "model": "working"}',
        },
      ],
      50
    );
    const cleaned = jsonReply.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    const parsed = JSON.parse(cleaned);
    console.log(`  ✅ JSON parsed: status=${parsed.status}, model=${parsed.model}`);

    // Test 3: Movie query routing simulation
    console.log("\nTest 3: Query routing simulation...");
    const routingReply = await chatCompletion(
      MODELS.LLM,
      [
        {
          role: "user",
          content: `Classify this movie query into "vector", "graph", or "hybrid". 
          Reply ONLY with one word.
          Query: "Tell me all movies by Christopher Nolan that won Oscar"`,
        },
      ],
      10
    );
    const queryType = routingReply.trim().toLowerCase();
    console.log(`  ✅ Query classified as: "${queryType}"`);
    if (["vector", "graph", "hybrid"].includes(queryType)) {
      console.log("  ✅ Valid routing type returned!");
    }

    console.log(`\n✅ ALL LLM TESTS PASSED`);
    console.log(`   Model: ${MODELS.LLM}`);
    console.log("   OpenRouter connection is working correctly!\n");

  } catch (err) {
    console.error("\n❌ LLM TEST FAILED:", err.message);
    if (err.message.includes("401")) {
      console.error("   → Check your OPENROUTER_API_KEY in .env file");
    } else if (err.message.includes("429")) {
      console.error("   → Rate limit hit — wait a minute and try again");
    } else if (err.message.includes("402")) {
      console.error("   → Insufficient credits on OpenRouter");
    }
    process.exit(1);
  }
}

testOpenRouter();
