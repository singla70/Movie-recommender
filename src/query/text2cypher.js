// ============================================================
// src/query/text2cypher.js
//
// WHY THIS EXISTS: entitiesToTools() (graphSearch.js) aur
// AVAILABLE_TOOLS (queryRouter.js) ek FIXED tool-menu hain — har
// entity-combination (actor+director, actor+genre, director+award,
// ...) ke liye alag hand-written Cypher function. Ye 2-entity
// combos ke liye theek chalta hai, lekin queries combinatorially
// INFINITE hain — "director X jisne actor Y ke saath kaam kiya,
// award Z jeeta, aur 2000-2005 ke beech release hui" jaisi 4-entity
// query ke liye na koi tool exist karta hai, na har combination ke
// liye naya tool likhna scale karta hai (2^8 se zyada combinations
// possible hain 8 entity-types ke liye).
//
// FIX: jab koi bhi fixed tool/tier (direct LLM tool-picks,
// entitiesToTools) empty result de, LLM ko khud graph schema
// deke asli Cypher likhne do — parameterized (kabhi raw value
// Cypher text mein inline nahi), read-only (write keywords explicitly
// block), aur ek fixed RETURN-shape enforce karke taaki formatting
// generic reh sake. confidenceScore jaan-boojh kar hand-tuned tools
// se KAM hai (0.75) — ye best-effort hai, ek verified template nahi.
// ============================================================

import { chatCompletion } from "../utils/openrouterClient.js";
import { MODELS } from "../config/constants.js";
import { safeParseLLMJson } from "../utils/jsonRepair.js";
import { runQueryWithRetry } from "../utils/neo4jClient.js";

const SCHEMA = `
Graph schema (Neo4j):
Nodes:
  (:Movie {id, title, year, rating, oscarWon, oscarNominations, plot})
  (:Director {name})  (:Actor {name})  (:Genre {name})
  (:Award {name})      (:Language {name})  (:Country {name})
Relationships (all connect TO/FROM Movie unless noted):
  (m:Movie)-[:DIRECTED_BY]->(d:Director)
  (a:Actor)-[:ACTED_IN]->(m:Movie)
  (m:Movie)-[:HAS_GENRE]->(g:Genre)
  (m:Movie)-[:WON_AWARD]->(aw:Award)
  (m:Movie)-[:IN_LANGUAGE]->(l:Language)
  (m:Movie)-[:FROM_COUNTRY]->(c:Country)
  Aggregate only (NOT movie-specific, cross-movie stats): (Actor)-[:WORKED_IN_GENRE {count}]->(Genre), (Actor)-[:CO_STARRED_WITH {count}]-(Actor)
`.trim();

const FEW_SHOT = `
Example 1 — "Movies where both Leonardo DiCaprio and Christopher Nolan worked together":
{"cypher": "MATCH (a:Actor)-[:ACTED_IN]->(m:Movie)-[:DIRECTED_BY]->(d:Director) WHERE toLower(a.name) CONTAINS toLower($actor) AND toLower(d.name) CONTAINS toLower($director) RETURN m.id AS movieId, m.title AS title, m.year AS year, m.rating AS rating, m.oscarWon AS oscarWon, m.oscarNominations AS oscarNominations, m.plot AS plot, [d.name] AS directors, [] AS actors, [] AS genres LIMIT $limit", "params": {"actor": "Leonardo DiCaprio", "director": "Christopher Nolan", "limit": 10}}

Example 2 — "Directors who worked with Tom Hanks, won an Oscar, released between 2000 and 2010":
{"cypher": "MATCH (a:Actor)-[:ACTED_IN]->(m:Movie)-[:DIRECTED_BY]->(d:Director) WHERE toLower(a.name) CONTAINS toLower($actor) AND m.oscarWon = true AND m.year >= $startYear AND m.year <= $endYear RETURN m.id AS movieId, m.title AS title, m.year AS year, m.rating AS rating, m.oscarWon AS oscarWon, m.oscarNominations AS oscarNominations, m.plot AS plot, [d.name] AS directors, [a.name] AS actors, [] AS genres LIMIT $limit", "params": {"actor": "Tom Hanks", "startYear": 2000, "endYear": 2010, "limit": 10}}
`.trim();

// Defense-in-depth beyond the prompt's own "read-only" instruction —
// an LLM occasionally ignoring instructions is exactly why this
// exists as a hard code-level check, not just a prompt request.
const WRITE_KEYWORDS = /\b(CREATE|MERGE|DELETE|SET|REMOVE|DROP|DETACH|CALL\s+apoc\.|LOAD\s+CSV)\b/i;

export async function generateAndRunCypher(userQuery, limit = 10) {
  const prompt = `You are a Cypher query generator for a movie knowledge graph.

${SCHEMA}

${FEW_SHOT}

Rules:
- READ-ONLY. Never use CREATE, MERGE, DELETE, SET, REMOVE, DROP, or any write/procedure call.
- ALWAYS use $paramName placeholders for every value that came from the question — never inline a name/number/string directly into the Cypher text.
- The RETURN clause MUST always alias exactly these fields, even with empty defaults: movieId, title, year, rating, oscarWon, oscarNominations, plot, directors, actors, genres.
- Always end with "LIMIT $limit".
- Use toLower(x) CONTAINS toLower($param) for name matching (never exact =); use direct comparison for numeric/boolean fields (m.year, m.rating, m.oscarWon).

User's question: "${userQuery}"

Return ONLY this JSON shape — no markdown fences, no explanation, nothing else:
{"cypher": "...", "params": {...}}`;

  let response;
  try {
    response = await chatCompletion(MODELS.LLM, [{ role: "user", content: prompt }], 500);
  } catch (err) {
    console.error(`  ❌ text2cypher: LLM call failed: ${err.message}`);
    return [];
  }

  const parsed = safeParseLLMJson(response);
  if (!parsed?.cypher) {
    console.warn("  ⚠️  text2cypher: could not parse a Cypher query out of the LLM's response");
    return [];
  }

  if (WRITE_KEYWORDS.test(parsed.cypher)) {
    console.error(`  ❌ text2cypher: generated Cypher contained a write/procedure keyword — refused to run it.`);
    console.error(`     Rejected query: ${parsed.cypher}`);
    return [];
  }

  // Caller's limit always wins, even if the LLM's own params tried to set a bigger one.
  const params = { ...(parsed.params || {}), limit: Math.min(Number(parsed.params?.limit) || limit, limit) };

  try {
    const rows = await runQueryWithRetry(parsed.cypher, params);
    console.log(`  ✅ text2cypher: ${rows.length} result(s) for a query no fixed tool matched`);
    return rows.map((r) => {
      const directors = Array.isArray(r.directors) ? r.directors.filter(Boolean) : r.directors ? [r.directors] : [];
      return {
        movieId: r.movieId,
        title: r.title,
        year: r.year,
        rating: r.rating,
        oscarWon: r.oscarWon,
        oscarNominations: r.oscarNominations,
        plot: r.plot,
        directors,
        director: directors[0] || null,
        actors: Array.isArray(r.actors) ? r.actors.filter(Boolean) : [],
        genres: Array.isArray(r.genres) ? r.genres.filter(Boolean) : [],
        source: "graph-text2cypher",
        confidenceScore: 0.75, // best-effort, LLM-generated — not a hand-verified template, deliberately below the fixed tools' scores
        confidenceLabel: "Medium",
        confidenceExplanation: "Generated graph query — no pre-built tool matched this specific combination of filters",
      };
    });
  } catch (err) {
    console.error(`  ❌ text2cypher: generated Cypher failed to execute: ${err.message}`);
    console.error(`     Query was: ${parsed.cypher}`);
    return [];
  }
}