// ============================================================
// src/query/queryDecomposer.js
//
// Complex queries ko LangGraph StateGraph ke through step-by-step
// execute karo.
//
// PEHLE (fragile): sirf 2 hardcoded categories track hote the
//   (stepTitles, stepActors — plain JS objects), "PREV_TITLES"/
//   "PREV_ACTORS" string-matching se resolve hote the. Koi teesri
//   category (directors, genres) chahiye ho toh silently fail
//   ho jaata — naya tracking-dict manually add karna padta.
//
// AB (LangGraph StateGraph): typed state channels — TITLES,
//   ACTORS, DIRECTORS, GENRES sab generically track hote hain
//   (accumulator reducer ke saath), aur PREV_<CATEGORY> placeholder
//   generically resolve hota hai ek lookup map se — nayi category
//   add karna ab sirf state-schema + lookup-map mein ek line hai.
//
// NOTE (research-driven decision): LLM planning call (decomposeQuery)
// ab bhi EK hi call hai — routing se merge NAHI kiya (README §3, §5
// mein reasoning — humara free-tier LLM ki JSON-reliability documented
// kharab hai, bada/merged schema zyada fail-prone hota). Safety
// safeParseLLMJson() (jsonRepair.js) se aati hai, LangGraph se nahi —
// LangGraph sirf EXECUTION ki robustness improve karta hai, LLM output
// ki nahi.
// ============================================================

import { Annotation, StateGraph, START, END } from "@langchain/langgraph";
import { chatCompletion } from "../utils/openrouterClient.js";
import { MODELS } from "../config/constants.js";
import { safeParseLLMJson } from "../utils/jsonRepair.js";
import { executeTool } from "./toolExecutor.js";

// ── Placeholder → state-key mapping ───────────────────────────
// Naya placeholder chahiye? Bas yahan ek line add karo — execution
// engine ya state-schema mein kahin aur kuch change nahi karna padega.
const PLACEHOLDER_MAP = {
  PREV_TITLES: "titles",
  PREV_ACTORS: "actors",
  PREV_DIRECTORS: "directors",
  PREV_GENRES: "genres",
};

// ── LangGraph state schema ────────────────────────────────────
// Har accumulator array ek "concat + dedupe" reducer use karta hai —
// naye step ka data purane mein add hota hai (overwrite nahi).
function dedupeConcatReducer(existing = [], incoming = []) {
  const merged = [...existing, ...(Array.isArray(incoming) ? incoming : [incoming])];
  return [...new Set(merged.filter(Boolean))];
}

const DecomposerState = Annotation.Root({
  plan: Annotation({ default: () => null, reducer: (_prev, next) => next }),
  currentStepIdx: Annotation({ default: () => 0, reducer: (_prev, next) => next }),
  titles: Annotation({ default: () => [], reducer: dedupeConcatReducer }),
  actors: Annotation({ default: () => [], reducer: dedupeConcatReducer }),
  directors: Annotation({ default: () => [], reducer: dedupeConcatReducer }),
  genres: Annotation({ default: () => [], reducer: dedupeConcatReducer }),
  finalResults: Annotation({ default: () => [], reducer: (_prev, next) => next }),
  errors: Annotation({ default: () => [], reducer: (prev, next) => [...prev, ...next] }),
});

// ── Step 1: LLM se plan generate karo ─────────────────────────
async function decomposeQuery(queryText, conversationHistory = []) {
  const recentHistory = conversationHistory.slice(-4)
    .map(m => `${m.role === "user" ? "User" : "Assistant"}: ${m.content.substring(0, 100)}`)
    .join("\n");

  const prompt = `You are a query planner for a movie database. Break complex queries into 2-3 sequential steps.

${recentHistory ? `Context:\n${recentHistory}\n` : ""}
Query: "${queryText}"

Available tools:
- search_by_director(directors[])
- search_by_actor(actors[])
- search_oscar_movies()
- search_by_genre(genres[])
- search_movie_direct_data(titles[])
- search_actor_other_movies(movieTitles[])
- search_by_director_and_award(directors[])
- search_coactors(actor)
- search_common_movies(actor1, actor2)
- search_franchise_movies(keyword)
- search_top_rated(limit, filters)

IMPORTANT RULES:
1. Max 3 steps — keep it simple
2. For "actors in Nolan Oscar movies then their other movies":
   Step 1: search_by_director_and_award → get Oscar movies
   Step 2: search_movie_direct_data with titles from step 1 → get cast
   Step 3: search_by_actor with actors from step 2 → get their movies
3. Placeholders available (use the exact string as the param value when this step needs data from a PREVIOUS step):
   "PREV_TITLES", "PREV_ACTORS", "PREV_DIRECTORS", "PREV_GENRES"
4. Every step MUST have a valid tool name

Return ONLY valid JSON:
{
  "steps": [
    {
      "step": 1,
      "description": "what this step does",
      "tool": "tool_name_here",
      "params": { "directors": ["Christopher Nolan"] }
    },
    {
      "step": 2,
      "description": "get cast of those movies",
      "tool": "search_movie_direct_data",
      "params": { "titles": "PREV_TITLES" }
    },
    {
      "step": 3,
      "description": "get movies of those actors",
      "tool": "search_by_actor",
      "params": { "actors": "PREV_ACTORS" }
    }
  ]
}`;

  const response = await chatCompletion(MODELS.LLM, [{ role: "user", content: prompt }], 400);

  // safeParseLLMJson — gpt-oss-120b ki documented JSON-unreliability
  // ke against repair-layer (jsonRepair.js). Null mile toh caller
  // (executeDecomposedQuery) already null-safe fallback karta hai.
  return safeParseLLMJson(response);
}

// ── Ek step ke results se state-accumulators update karo ──────
function extractFromResults(results) {
  const titles = results.map(r => r.title).filter(t => t && !t.includes("(Actor)") && !t.includes("(Director)"));
  const actors = [
    ...results.map(r => r.actors || []).flat(),
    ...results.filter(r => r.plot?.includes("Worked in")).map(r => r.title),
  ].filter(Boolean);
  const directors = results.flatMap(r => r.directors?.length ? r.directors : (r.director ? [r.director] : []));
  const genres = results.flatMap(r => r.genres || []);
  return { titles, actors, directors, genres };
}

// ── Params mein PREV_<X> placeholders resolve karo (generic) ──
function resolveParams(params, state) {
  const resolved = { ...params };
  for (const [key, value] of Object.entries(resolved)) {
    if (typeof value === "string" && PLACEHOLDER_MAP[value]) {
      resolved[key] = state[PLACEHOLDER_MAP[value]] || [];
    } else if (typeof value === "string" && value.startsWith("{{") && value.endsWith("}}")) {
      // Legacy template syntax support
      const refKey = value.slice(2, -2);
      if (refKey.includes("title")) resolved[key] = state.titles;
      else if (refKey.includes("actor")) resolved[key] = state.actors;
    }
  }
  return resolved;
}

function hasEmptyRequiredParam(params) {
  for (const value of Object.values(params)) {
    if (Array.isArray(value) && value.length === 0) return true;
    if (value === null || value === undefined || value === "") return true;
  }
  return false;
}

// ── LangGraph node: ek step execute karo ──────────────────────
async function executeStepNode(state) {
  const step = state.plan.steps[state.currentStepIdx];

  if (!step?.tool || step.tool === "null") {
    console.warn(`  ⚠️  Step ${step?.step ?? "?"} has no tool — skipping`);
    return { currentStepIdx: state.currentStepIdx + 1 };
  }

  console.log(`  ▶ Step ${step.step}: ${step.description}`);
  const params = resolveParams(step.params || {}, state);

  if (hasEmptyRequiredParam(params)) {
    console.warn(`  ⚠️  Step ${step.step} params empty after resolution — skipping`);
    return { currentStepIdx: state.currentStepIdx + 1 };
  }

  try {
    const results = await executeTool(step.tool, params);
    const { titles, actors, directors, genres } = extractFromResults(results);
    console.log(`    ✅ Step ${step.step} returned ${results.length} results`);
    return {
      currentStepIdx: state.currentStepIdx + 1,
      titles, actors, directors, genres,
      finalResults: results, // last successful step ka results = final (agla step overwrite karega agar chale)
    };
  } catch (err) {
    console.error(`    ❌ Step ${step.step} failed: ${err.message}`);
    return { currentStepIdx: state.currentStepIdx + 1, errors: [`Step ${step.step}: ${err.message}`] };
  }
}

// ── Conditional edge: aur steps baaki hain? ────────────────────
function shouldContinue(state) {
  return state.currentStepIdx < (state.plan?.steps?.length || 0) ? "executeStep" : END;
}

// ── Graph compile karo (module load pe ek baar) ────────────────
const decomposerGraph = new StateGraph(DecomposerState)
  .addNode("executeStep", executeStepNode)
  .addEdge(START, "executeStep")
  .addConditionalEdges("executeStep", shouldContinue, { executeStep: "executeStep", [END]: END })
  .compile();

// ── Public entry point ─────────────────────────────────────────
export async function executeDecomposedQuery(queryText, conversationHistory = []) {
  console.log(`\n🔀 Decomposing complex query: "${queryText}"`);

  const plan = await decomposeQuery(queryText, conversationHistory);
  if (!plan?.steps?.length) {
    console.log("  ⚠️  Could not decompose");
    return null;
  }

  console.log(`  📋 Plan: ${plan.steps.length} steps`);

  const result = await decomposerGraph.invoke({ plan, currentStepIdx: 0 });

  if (result.errors?.length > 0) {
    console.warn(`  ⚠️  ${result.errors.length} step(s) had errors:`, result.errors);
  }

  return result.finalResults?.length > 0 ? result.finalResults : null;
}