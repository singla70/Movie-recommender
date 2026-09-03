// ============================================================
// src/query/queryRouter.js
//
// Key changes:
//   1. Multi-query detection — "Nolan movies aur Gippy movies"
//   2. Tool selection — LLM decides which tools to call
//   3. Complex query detection — needs decomposition?
//   4. Alias resolution in entities
// ============================================================

import { chatCompletion } from "../utils/openrouterClient.js";
import { MODELS } from "../config/constants.js";
import { safeParseLLMJson } from "../utils/jsonRepair.js";

// ── Available tools list — LLM inhi mein se choose karega ────
const AVAILABLE_TOOLS = `
AVAILABLE TOOLS (use exact tool names):
1.  search_by_director(directors: string[])
2.  search_by_actor(actors: string[])
3.  search_oscar_movies()
4.  search_by_genre(genres: string[])
5.  search_movie_direct_data(titles: string[])
6.  search_actor_other_movies(movieTitles: string[])
7.  search_by_director_and_award(directors: string[])
8.  search_actors_by_genre(genres: string[])
9.  search_by_actor_and_genre(actors: string[], genres: string[])
10. search_by_language(languages: string[])
11. search_by_country(countries: string[])
12. search_coactors(actor: string)
13. search_actor_in_multiple_genres(genres: string[], operator: "AND"|"OR")
14. search_by_year_range(startYear: number, endYear: number, filters?: {genre?, language?, oscarWon?})
15. search_top_rated(limit: number, filters?: {genre?, language?, oscarWon?, minRating?})
16. search_common_movies(actor1: string, actor2: string)
17. search_actor_aggregates(sortBy: "movieCount"|"oscarCount", limit: number)
18. search_director_aggregates(sortBy: "movieCount"|"oscarCount", limit: number)
19. search_genre_oscar_stats()
20. search_by_rating_range(minRating: number, maxRating: number, filters?: {genre?, language?})
21. search_franchise_movies(keyword: string)
22. search_director_filmography(director: string)
`;

export async function routeQuery(userQuery, conversationHistory = []) {
  const recentHistory = conversationHistory.slice(-6)
    .map(m => `${m.role === "user" ? "User" : "Assistant"}: ${m.content.substring(0, 120)}`)
    .join("\n");

  const prompt = `You are a query classifier for a movie recommendation chatbot.

RULE 1 — Alias Resolution: Convert ALL nicknames to full real names in entities.
SRK→Shah Rukh Khan, Nolan→Christopher Nolan, Leo→Leonardo DiCaprio,
Big B→Amitabh Bachchan, Sallu→Salman Khan, RDJ→Robert Downey Jr,
The Rock→Dwayne Johnson, SLB→Sanjay Leela Bhansali, KJo→Karan Johar,
Tarantino→Quentin Tarantino, Scorsese→Martin Scorsese, Aamir→Aamir Khan.

RULE 2 — Multi-query detection: If user asks about 2+ completely different topics
in one message, split into separate queries. Each query gets its own tool calls.
Example: "Nolan ki movies aur Gippy Grewal ki comedy movies" → 2 separate queries.

RULE 3 — Tool selection: Choose the most specific tools for each query.
Multiple tools can be called — they run in parallel.

RULE 4 — Followup context: Use conversation history to carry forward entities.

${recentHistory ? `Conversation history:\n${recentHistory}\n` : ""}
Current query: "${userQuery}"

${AVAILABLE_TOOLS}

Return ONLY valid JSON:
{
  "query_type": "greeting" | "off_topic" | "movie_query",
  "is_multi_query": false,
  "queries": [
    {
      "query_text": "original sub-query text",
      "intent": "yes_no" | "list" | "detail" | "comparison" | "casual",
      "is_complex": false,
      "tools": [
        {
          "name": "tool_name",
          "params": {}
        }
      ],
      "topK": 5,
      "route": "vector" | "graph" | "hybrid"
    }
  ]
}

ROUTE RULES — very important:
- "graph":  query has specific named entity (director, actor, award, language, country, year)
            Examples: "Nolan movies", "Gippy movies", "Oscar winners", "Punjabi movies", "2020 movies"
- "vector": query is PURELY about mood/feeling/theme with NO specific entity at all
            Examples: "scary movies", "feel good movies", "movies about friendship"
            NOTE: "similar to X" is NOT pure vector — it is HYBRID (see below)
- "hybrid": DEFAULT for most queries. Use hybrid when:
            * "similar to [movie title]" — ALWAYS hybrid, not vector
            * "movies like X" — ALWAYS hybrid
            * similarity + any filter (genre, Oscar, language, year, actor, director)
            * vague recommendation requests — hybrid gives better results
            RULE: When in doubt between vector and hybrid → always choose HYBRID

TOOL SELECTION for hybrid:
- Always include both vector search intent (route=hybrid) AND relevant graph tools
- For "similar to X": use search_movie_direct_data(X) to get graph context + vector for similarity

is_complex rules:
- true: query requires chaining — "movies of actor who worked with Nolan in Oscar films"
- false: direct lookups (actor movies, director movies, genre search, similar movies)

Other notes:
- For cast/crew queries use search_movie_direct_data tool
- Single query → queries array with 1 item
- Multi query → queries array with multiple items  
- For yes_no intent, topK: 3
- For list intent, topK: 5-10
- For cast/detail intent, topK: 3
- For detail intent, topK: 1-3`;

  const response = await chatCompletion(
    MODELS.LLM,
    [{ role: "user", content: prompt }],
    1000 // 600 se badhaya — complex/multi-query responses truncate ho
    // rahe the (live-testing mein "⚠️ JSON repair: sab attempts fail"
    // dikha, raw response mid-JSON cut off tha "...inten" jaisa —
    // ye 600-token cap se hi pura output nahi aa pa raha tha)
  );

  try {
    // safeParseLLMJson: markdown-fence-strip + trailing-comma-fix +
    // JSON-block-extraction + bracket-balance-repair, ek ke baad ek
    // try hota hai (gpt-oss-120b ki documented JSON-unreliability ke
    // against safety net — src/utils/jsonRepair.js mein reasoning hai)
    const result = safeParseLLMJson(response);
    if (!result) throw new Error("JSON repair failed — all attempts exhausted");

    // Normalize output
    return {
      query_type: result.query_type || "movie_query",
      is_multi_query: result.is_multi_query || false,
      queries: (result.queries || []).map(q => ({
        query_text: q.query_text || userQuery,
        intent: q.intent || "casual",
        is_complex: q.is_complex || false,
        tools: q.tools || [],
        topK: q.topK || 5,
        route: q.route || "hybrid",
        // Legacy support
        type: q.route || "hybrid",
        entities: extractEntitiesFromTools(q.tools || []),
        vectorFilter: {},
      })),
    };
  } catch {
    // Fallback
    return {
      query_type: "movie_query",
      is_multi_query: false,
      queries: [{
        query_text: userQuery,
        intent: "casual",
        is_complex: false,
        tools: [],
        topK: 5,
        route: "hybrid",
        type: "hybrid",
        entities: { directors: [], actors: [], genres: [], awards: [], years: [], movieTitles: [], language: [], country: [] },
        vectorFilter: {},
      }],
    };
  }
}

// ── Extract entities from tools for legacy graph search ──────
function extractEntitiesFromTools(tools) {
  const entities = {
    directors: [], actors: [], genres: [], awards: [],
    years: [], movieTitles: [], language: [], country: [],
  };

  for (const tool of tools) {
    const p = tool.params || {};
    if (p.directors) entities.directors.push(...p.directors);
    if (p.actors) entities.actors.push(...p.actors);
    if (p.actor) entities.actors.push(p.actor);
    if (p.actor1) entities.actors.push(p.actor1);
    if (p.actor2) entities.actors.push(p.actor2);
    if (p.genres) entities.genres.push(...p.genres);
    if (p.awards) entities.awards.push(...p.awards);
    if (p.titles) entities.movieTitles.push(...p.titles);
    if (p.movieTitles) entities.movieTitles.push(...p.movieTitles);
    if (p.languages) entities.language.push(...p.languages);
    if (p.countries) entities.country.push(...p.countries);
    if (p.director) entities.directors.push(p.director);
    if (p.keyword) entities.movieTitles.push(p.keyword);
  }

  return entities;
}