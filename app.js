// ============================================================
// app.js
//
// Complete flow:
//   1. Query → routeQuery → multi-query detect
//   2. Single query:
//      - vector  → direct Pinecone
//      - graph   → tools parallel execute
//      - hybrid  → vector 50 candidates → graph enrich
//      - complex → queryDecomposer → step-by-step
//   3. Multi-query → parallel execute → alag sections display
//   4. Smart history — last 6 messages
//   5. lastMovies — followup context
// ============================================================

import readline from "readline";
import { routeQuery } from "./src/query/queryRouter.js";
import { vectorSearch, getVectorCandidates } from "./src/query/vectorSearch.js";
import { graphSearch, graphEnrichAndFilter } from "./src/query/graphSearch.js";
import { executeDecomposedQuery } from "./src/query/queryDecomposer.js";
import { executeToolsParallel } from "./src/query/toolExecutor.js";
import { buildResponse, buildMultiQueryResponse } from "./src/query/responseBuilder.js";
import { closeNeo4jDriver } from "./src/utils/neo4jClient.js";
import { chatCompletion } from "./src/utils/openrouterClient.js";
import { MODELS } from "./src/config/constants.js";

// ── State ─────────────────────────────────────────────────────
const MAX_HISTORY = 6;
const conversationHistory = [];
let lastMovies = [];

function addToHistory(role, content, movies = []) {
  const compressed = content.length > 200 ? content.substring(0, 200) + "..." : content;
  const movieTitles = movies.length > 0
    ? ` [Movies shown: ${movies.map(m => m.title).join(", ")}]` : "";
  conversationHistory.push({ role, content: compressed + movieTitles });
  if (conversationHistory.length > MAX_HISTORY)
    conversationHistory.splice(0, conversationHistory.length - MAX_HISTORY);
  if (movies.length > 0) lastMovies = movies;
}

async function handleGreeting(query) {
  return chatCompletion(MODELS.LLM, [{
    role: "user",
    content: `You are a friendly movie recommendation chatbot. User said: "${query}". Respond warmly. Ask what kind of movies they'd like. SHORT (2-3 lines). English only.`
  }], 150);
}

async function handleOffTopic(query) {
  return chatCompletion(MODELS.LLM, [{
    role: "user",
    content: `You are a movie recommendation chatbot. User asked off-topic: "${query}". Politely redirect to movies. SHORT (2 lines). English only.`
  }], 100);
}

// ── Execute a single query ────────────────────────────────────
async function executeSingleQuery(queryInfo, originalQuery) {
  const { query_text, intent, is_complex, tools, topK, route, type, entities, vectorFilter } = queryInfo;
  const effectiveRoute = route || type || "hybrid";

  console.log(`🗺️  Route: ${effectiveRoute.toUpperCase()} | Intent: ${intent}${is_complex ? " | Complex: YES" : ""}`);

  // Complex query → decompose into steps
  if (is_complex) {
    console.log("🔀 Complex query — decomposing...");
    const decomposedResults = await executeDecomposedQuery(query_text, conversationHistory);
    if (decomposedResults && decomposedResults.length > 0) {
      return decomposedResults;
    }
    console.log("  Decomposition failed — falling back to standard search");
  }

  // Tool-based execution (from queryRouter tool selection)
  if (tools && tools.length > 0) {
    console.log(`🔧 Executing ${tools.length} tools...`);
    const toolResults = await executeToolsParallel(tools);
    if (toolResults.length > 0) return toolResults;
  }

  // Route-based fallback
  const entitiesWithQuery = { ...(entities || {}), _originalQuery: query_text };

  if (effectiveRoute === "vector") {
    return await vectorSearch(query_text, topK, vectorFilter || {});
  }

  if (effectiveRoute === "graph") {
    return await graphSearch(entitiesWithQuery, topK);
  }

  // Hybrid — vector candidates → graph enrich
  console.log("🔀 Hybrid: fetching 50 vector candidates...");
  const candidates = await getVectorCandidates(query_text, vectorFilter || {});
  console.log(`   Got ${candidates.length} candidates → enriching...`);
  const enriched = await graphEnrichAndFilter(candidates, entitiesWithQuery, topK);

  if (enriched.length > 0) return enriched;

  // Both fallback — pehle yahan dobara vectorSearch() call hota tha,
  // jo already-fetched `candidates` (50 results) ko discard karke
  // Pinecone ko dobara hit karta tha (wasteful — same embedding query
  // dobara bhejta tha). Ab already-fetched candidates reuse karte hain,
  // sirf graph ko independently query karte hain.
  const gResults = await graphSearch(entitiesWithQuery, topK);
  return [...candidates.slice(0, topK), ...gResults];
}

// ── Display single response ───────────────────────────────────
function displayResponse(response, intent) {
  console.log("\n" + response.answer);

  if (intent === "detail" && response.movies?.length > 0) {
    const m = response.movies[0];
    console.log(`\n📽️  ${m.title} (${m.year || "N/A"})`);
    if (m.directors?.length) console.log(`   Director : ${m.directors.join(", ")}`);
    else if (m.director) console.log(`   Director : ${m.director}`);
    if (m.rating)   console.log(`   Rating   : ${m.rating}/10`);
    console.log(`   Oscar    : ${m.oscarWon ? "🏆 Won" : "Not won"}${m.oscarNominations > 0 ? ` (${m.oscarNominations} nominations)` : ""}`);
    if (m.actors?.length > 0) console.log(`   Cast     : ${m.actors.slice(0, 4).join(", ")}`);
    if (m.plot) console.log(`   Plot     : ${m.plot}`);
  }

  console.log();
}

// ── Display multi-query sections ──────────────────────────────
function displayMultiResponse(sections) {
  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    if (sections.length > 1) {
      console.log(`\n--- Query ${i + 1}: "${section.query}" ---`);
    }
    console.log("\n" + section.answer);
    console.log();
  }
}

// ── Main query handler ────────────────────────────────────────
async function handleQuery(userQuery) {
  console.log("\n⏳ Processing...\n");

  try {
    const routing = await routeQuery(userQuery, conversationHistory);

    // Non-movie queries
    if (routing.query_type === "greeting") {
      const reply = await handleGreeting(userQuery);
      console.log("\n" + reply + "\n");
      addToHistory("user", userQuery);
      addToHistory("assistant", reply);
      return;
    }

    if (routing.query_type === "off_topic") {
      const reply = await handleOffTopic(userQuery);
      console.log("\n" + reply + "\n");
      addToHistory("user", userQuery);
      addToHistory("assistant", reply);
      return;
    }

    // ── Multi-query ───────────────────────────────────────────
    if (routing.is_multi_query && routing.queries.length > 1) {
      console.log(`📋 Multi-query detected: ${routing.queries.length} separate queries`);

      // Execute all queries in parallel
      const queryPromises = routing.queries.map(q =>
        executeSingleQuery(q, userQuery)
          .then(results => ({ queryText: q.query_text, intent: q.intent, results }))
          .catch(err => {
            console.error(`  ❌ Sub-query failed: ${err.message}`);
            return { queryText: q.query_text, intent: q.intent, results: [] };
          })
      );

      const subQueryResults = await Promise.all(queryPromises);
      const sections = await buildMultiQueryResponse(subQueryResults, conversationHistory);

      displayMultiResponse(sections);

      // History update
      const combinedAnswer = sections.map(s => s.answer).join(" | ");
      const allMovies = sections.flatMap(s => s.movies || []);
      addToHistory("user", userQuery);
      addToHistory("assistant", combinedAnswer, allMovies);
      return;
    }

    // ── Single query ──────────────────────────────────────────
    const defaultQuery = {
      query_text: userQuery, intent: "casual",
      is_complex: false, tools: [], topK: 5,
      route: "hybrid", type: "hybrid",
      entities: { directors: [], actors: [], genres: [], awards: [], years: [], movieTitles: [], language: [], country: [] },
      vectorFilter: {},
    };
    const rawQueryInfo = routing.queries?.[0] || defaultQuery;
    // Ensure route is always set
    const queryInfo = {
      ...defaultQuery,
      ...rawQueryInfo,
      route: rawQueryInfo.route || rawQueryInfo.type || "hybrid",
      type: rawQueryInfo.route || rawQueryInfo.type || "hybrid",
      entities: rawQueryInfo.entities || defaultQuery.entities,
    };

    const results = await executeSingleQuery(queryInfo, userQuery);

    // Split into vector and graph for responseBuilder
    const vectorResults = results.filter(r => r.source === "vector" || r.source === "both");
    const graphResults = results.filter(r => r.source === "graph" || r.source === "graph-text2cypher");

    const response = await buildResponse(
      userQuery,
      vectorResults.length > 0 ? vectorResults : [],
      graphResults.length > 0 ? graphResults : results, // if no split, all to graph
      { ...queryInfo, entities: queryInfo.entities || {} },
      conversationHistory,
      lastMovies
    );

    displayResponse(response, queryInfo.intent);

    addToHistory("user", userQuery);
    addToHistory("assistant", response.answer, response.movies);

  } catch (err) {
    console.error("❌ Error:", err.message || err);
    console.error("   Stack:", err.stack?.split("\n").slice(0,3).join("\n"));
    if (err.message?.includes("402")) console.error("   💳 OpenRouter credit issue");
    else if (err.message?.includes("429")) console.error("   ⏱️  Rate limit — wait karo");
  }
}

// ── Main loop ─────────────────────────────────────────────────
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
function ask(q) { return new Promise(resolve => rl.question(q, resolve)); }

async function main() {
  console.log("╔════════════════════════════════════════════════════╗");
  console.log("║       🎬 Movie Graph RAG — AI Recommendation       ║");
  console.log("╚════════════════════════════════════════════════════╝");
  console.log('\nType "exit" to quit\n');

  while (true) {
    const query = await ask("🎤 You: ");
    if (!query.trim()) continue;
    if (["exit", "quit"].includes(query.toLowerCase())) {
      console.log("\n👋 Goodbye!");
      break;
    }
    await handleQuery(query.trim());
  }

  await closeNeo4jDriver();
  rl.close();
  process.exit(0);
}

main().catch(async err => {
  console.error("Fatal:", err);
  await closeNeo4jDriver();
  process.exit(1);
});