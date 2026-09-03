// ============================================================
// tests/testFullPipeline.js
//
// Full pipeline test — 3 sample movies insert karo, phir
// query karo. PDF ki zarurat nahi — hardcoded data use hoga.
//
// Run: npm run test:pipeline
//
// Ye test karta hai:
//   ✅ Embedding generate hoti hai
//   ✅ Pinecone mein insert + search hota hai
//   ✅ Neo4j mein insert + Cypher query hoti hai
//   ✅ Query router kaam karta hai
//   ✅ Final response confidence score ke saath aata hai
// ============================================================

import dotenv from "dotenv";
dotenv.config();

import { generateMovieEmbeddings } from "../src/ingestion/embedder.js";
import { loadMoviesToPinecone } from "../src/ingestion/pineconeLoader.js";
import { loadMoviesToNeo4j } from "../src/ingestion/neo4jLoader.js";
import { routeQuery } from "../src/query/queryRouter.js";
import { vectorSearch } from "../src/query/vectorSearch.js";
import { graphSearch } from "../src/query/graphSearch.js";
import { buildResponse } from "../src/query/responseBuilder.js";
import { closeNeo4jDriver } from "../src/utils/neo4jClient.js";

// ── Sample movies — test ke liye ─────────────────────────────
const SAMPLE_MOVIES = [
  {
    id: "test-movie-001",
    title: "Inception",
    year: 2010,
    director: "Christopher Nolan",
    actors: ["Leonardo DiCaprio", "Joseph Gordon-Levitt", "Elliot Page"],
    genres: ["Sci-Fi", "Thriller", "Action"],
    plot: "A thief who steals corporate secrets through dream-sharing technology is given the task of planting an idea into the mind of a C.E.O.",
    rating: 8.8,
    oscarWon: true,
    oscarNominations: 8,
    awards: ["Oscar Win - Best Cinematography", "Oscar Win - Best Visual Effects"],
  },
  {
    id: "test-movie-002",
    title: "The Dark Knight",
    year: 2008,
    director: "Christopher Nolan",
    actors: ["Christian Bale", "Heath Ledger", "Aaron Eckhart"],
    genres: ["Action", "Crime", "Drama"],
    plot: "When the menace known as the Joker wreaks havoc on Gotham City, Batman must accept one of the greatest psychological and physical tests.",
    rating: 9.0,
    oscarWon: true,
    oscarNominations: 8,
    awards: ["Oscar Win - Best Supporting Actor (Heath Ledger)"],
  },
  {
    id: "test-movie-003",
    title: "Parasite",
    year: 2019,
    director: "Bong Joon-ho",
    actors: ["Song Kang-ho", "Lee Sun-kyun", "Cho Yeo-jeong"],
    genres: ["Thriller", "Drama", "Comedy"],
    plot: "Greed and class discrimination threaten the newly formed symbiotic relationship between the wealthy Park family and the destitute Kim clan.",
    rating: 8.5,
    oscarWon: true,
    oscarNominations: 6,
    awards: ["Oscar Win - Best Picture", "Oscar Win - Best Director", "Oscar Win - Best Original Screenplay"],
  },
];

async function runFullPipelineTest() {
  console.log("🧪 Full Pipeline Test — 3 Sample Movies\n");
  console.log("═".repeat(55));

  try {
    // ── Phase 1: Ingestion ────────────────────────────────────
    console.log("\n📥 PHASE 1: INGESTION");

    console.log("\nStep 1a: Generating embeddings...");
    const embeddings = await generateMovieEmbeddings(SAMPLE_MOVIES);
    console.log(`  ✅ ${embeddings.length} embeddings generated`);

    console.log("\nStep 1b: Loading to Pinecone + Neo4j (parallel)...");
    const [pineconeCount, neo4jCount] = await Promise.all([
      loadMoviesToPinecone(SAMPLE_MOVIES, embeddings),
      loadMoviesToNeo4j(SAMPLE_MOVIES),
    ]);
    console.log(`  ✅ Pinecone: ${pineconeCount} vectors inserted`);
    console.log(`  ✅ Neo4j: ${neo4jCount} movies inserted`);

    // Wait — Pinecone index ko thoda time do fresh data reflect karne mein
    console.log("\n⏳ Waiting 3s for Pinecone to index...");
    await new Promise((r) => setTimeout(r, 3000));

    // ── Phase 2: Query Testing ────────────────────────────────
    console.log("\n🔍 PHASE 2: QUERY TESTING");

    // Test Query 1: Graph query
    await runTestQuery(
      "Test Query 1 (Graph)",
      "Tell me all movies by Christopher Nolan"
    );

    // Test Query 2: Vector query
    await runTestQuery(
      "Test Query 2 (Vector)",
      "Movies about dreams and mind manipulation"
    );

    // Test Query 3: Hybrid query
    await runTestQuery(
      "Test Query 3 (Hybrid)",
      "Oscar winning thriller movies"
    );

    console.log("\n" + "═".repeat(55));
    console.log("✅ ALL PIPELINE TESTS PASSED!");
    console.log("   Your system is ready for full movie ingestion.\n");

  } catch (err) {
    console.error("\n❌ PIPELINE TEST FAILED:", err.message);
    console.error(err.stack);
    process.exit(1);
  } finally {
    await closeNeo4jDriver();
  }
}

// ── Single test query run karo ────────────────────────────────
async function runTestQuery(testName, query) {
  console.log(`\n--- ${testName} ---`);
  console.log(`Query: "${query}"`);

  const routing = await routeQuery(query);
  console.log(`Route: ${routing.type} | ${routing.reasoning}`);

  let vectorResults = [];
  let graphResults = [];

  if (routing.type === "vector" || routing.type === "hybrid") {
    vectorResults = await vectorSearch(query, 3, routing.vectorFilter);
    console.log(`Vector results: ${vectorResults.length}`);
  }

  if (routing.type === "graph" || routing.type === "hybrid") {
    graphResults = await graphSearch(routing.entities, 3);
    console.log(`Graph results: ${graphResults.length}`);
  }

  const response = await buildResponse(query, vectorResults, graphResults, routing);

  console.log(`\nAnswer: ${response.answer.substring(0, 150)}...`);

  if (response.movies.length > 0) {
    console.log("\nTop results:");
    response.movies.slice(0, 2).forEach((m) => {
      console.log(
        `  • ${m.title} (${m.year}) — ${m.confidence.stars} ${m.confidence.label} (${m.confidence.score}%) [${m.source}]`
      );
    });
  }

  console.log(`✅ ${testName} passed`);
}

runFullPipelineTest();
