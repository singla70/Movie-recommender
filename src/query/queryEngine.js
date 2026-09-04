// ============================================================
// src/query/queryEngine.js
//
// app.js (CLI) ki core query-handling logic yahan EXTRACT ki gayi
// hai as a stateless function — taaki naya Express API server
// (server/index.js) isi logic ko reuse kar sake, bina app.js ko
// chhede (jo already extensively live-tested/debugged hai — usse
// touch karna extra risk hota).
//
// app.js khud is file ko import nahi karta (jaanbujh kar) — uski
// module-level state (conversationHistory, lastMovies) already
// kaam kar rahi hai, usse refactor karna is round ke scope se
// bahar hai. Ye file bas same logic ka stateless-per-call version
// hai, jahan conversationHistory + lastMovies caller (server) se
// aate hain, module-level globals ki jagah — kyunki API server ko
// multiple browser clients (alag-alag conversations) handle karne
// hain, ek shared global state se nahi.
// ============================================================

import { routeQuery } from "./queryRouter.js";
import { vectorSearch, getVectorCandidates } from "./vectorSearch.js";
import { graphSearch, graphEnrichAndFilter } from "./graphSearch.js";
import { executeDecomposedQuery } from "./queryDecomposer.js";
import { executeToolsParallel } from "./toolExecutor.js";
import { buildResponse, buildMultiQueryResponse } from "./responseBuilder.js";
import { chatCompletion } from "../utils/openrouterClient.js";
import { MODELS } from "../config/constants.js";

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

async function executeSingleQuery(queryInfo, conversationHistory) {
  const { query_text, tools, topK, route, type, entities, vectorFilter } = queryInfo;
  const effectiveRoute = route || type || "hybrid";

  if (queryInfo.is_complex) {
    const decomposedResults = await executeDecomposedQuery(query_text, conversationHistory);
    if (decomposedResults && decomposedResults.length > 0) return decomposedResults;
  }

  if (tools && tools.length > 0) {
    const toolResults = await executeToolsParallel(tools);
    if (toolResults.length > 0) return toolResults;
  }

  const entitiesWithQuery = { ...(entities || {}), _originalQuery: query_text };

  if (effectiveRoute === "vector") {
    return await vectorSearch(query_text, topK, vectorFilter || {});
  }
  if (effectiveRoute === "graph") {
    return await graphSearch(entitiesWithQuery, topK);
  }

  const candidates = await getVectorCandidates(query_text, vectorFilter || {});
  const enriched = await graphEnrichAndFilter(candidates, entitiesWithQuery, topK);
  if (enriched.length > 0) return enriched;

  const gResults = await graphSearch(entitiesWithQuery, topK);
  return [...candidates.slice(0, topK), ...gResults];
}

// ── Public entry point ─────────────────────────────────────────
// Returns { answer, movies, route } — conversationHistory/lastMovies
// hamesha caller se aate hain (server per-request client se milte
// hain), koi module-level global state nahi.
//
// onStage(stage): optional progress callback, called synchronously at
// each real pipeline transition — NOT a fake/simulated timer. Default
// no-op, so app.js (CLI) and any other caller that doesn't pass it
// behaves exactly as before. Stages emitted:
//   {stage:"understanding"}                        — routing decision in flight
//   {stage:"responding", route:"greeting"}          — small-talk, single LLM call
//   {stage:"responding", route:"off_topic"}         — redirect, single LLM call
//   {stage:"searching",  route:"vector"|"graph"|"hybrid"|"multi_query"}
//   {stage:"composing",  route:<same as above>}     — results in hand, writing the answer
export async function processQuery(userQuery, conversationHistory = [], lastMovies = [], onStage = () => {}) {
  onStage({ stage: "understanding" });
  const routing = await routeQuery(userQuery, conversationHistory);

  if (routing.query_type === "greeting") {
    onStage({ stage: "responding", route: "greeting" });
    return { answer: await handleGreeting(userQuery), movies: [], route: "greeting" };
  }
  if (routing.query_type === "off_topic") {
    onStage({ stage: "responding", route: "off_topic" });
    return { answer: await handleOffTopic(userQuery), movies: [], route: "off_topic" };
  }

  if (routing.is_multi_query && routing.queries.length > 1) {
    onStage({ stage: "searching", route: "multi_query" });
    const queryPromises = routing.queries.map((q) =>
      executeSingleQuery(q, conversationHistory)
        .then((results) => ({ queryText: q.query_text, intent: q.intent, results }))
        .catch(() => ({ queryText: q.query_text, intent: q.intent, results: [] }))
    );
    const subQueryResults = await Promise.all(queryPromises);
    onStage({ stage: "composing", route: "multi_query" });
    const sections = await buildMultiQueryResponse(subQueryResults, conversationHistory);
    const combinedAnswer = sections.map((s) => s.answer).join("\n\n");
    const allMovies = sections.flatMap((s) => s.movies || []);
    return { answer: combinedAnswer, movies: allMovies, route: "multi_query" };
  }

  const defaultQuery = {
    query_text: userQuery, intent: "casual",
    is_complex: false, tools: [], topK: 5,
    route: "hybrid", type: "hybrid",
    entities: { directors: [], actors: [], genres: [], awards: [], years: [], movieTitles: [], language: [], country: [] },
    vectorFilter: {},
  };
  const rawQueryInfo = routing.queries?.[0] || defaultQuery;
  const queryInfo = {
    ...defaultQuery,
    ...rawQueryInfo,
    route: rawQueryInfo.route || rawQueryInfo.type || "hybrid",
    type: rawQueryInfo.route || rawQueryInfo.type || "hybrid",
    entities: rawQueryInfo.entities || defaultQuery.entities,
  };

  onStage({ stage: "searching", route: queryInfo.route });
  const results = await executeSingleQuery(queryInfo, conversationHistory);
  const vectorResults = results.filter((r) => r.source === "vector" || r.source === "both");
  const graphResults = results.filter((r) => r.source === "graph" || r.source === "graph-text2cypher");

  onStage({ stage: "composing", route: queryInfo.route });
  const response = await buildResponse(
    userQuery,
    vectorResults.length > 0 ? vectorResults : [],
    graphResults.length > 0 ? graphResults : results,
    { ...queryInfo, entities: queryInfo.entities || {} },
    conversationHistory,
    lastMovies
  );

  return { answer: response.answer, movies: response.movies || [], route: queryInfo.route };
}