// ============================================================
// src/query/toolExecutor.js
//
// Central tool executor — har tool ka ek entry point
// queryRouter se tool name + params aata hai
// ye sahi graph function call karta hai
// ============================================================

import {
  searchByDirector,
  searchByActor,
  searchOscarMovies,
  searchByGenre,
  searchMovieDirectData,
  searchMovieActorsOtherWork,
  searchByDirectorAndAward,
  searchActorsByGenre,
  searchByActorAndGenre,
  searchByLanguage,
  searchByCountry,
  searchCoactors,
  searchActorInMultipleGenres,
  searchByYearRange,
  searchTopRated,
  searchCommonMovies,
  searchActorAggregates,
  searchDirectorAggregates,
  searchGenreOscarStats,
  searchByRatingRange,
  searchFranchiseMovies,
  searchDirectorFilmography,
} from "./graphSearch.js";

// ── Execute a tool by name ────────────────────────────────────
export async function executeTool(toolName, params = {}) {
  const topK = params.limit || params.topK || 10;

  switch (toolName) {
    case "search_by_director":
      return searchByDirector(params.directors || [], topK);

    case "search_by_actor":
      return searchByActor(params.actors || [], topK);

    case "search_oscar_movies":
      return searchOscarMovies(topK);

    case "search_by_genre":
      return searchByGenre(params.genres || [], topK);

    case "search_movie_direct_data":
      return searchMovieDirectData(params.titles || params.movieTitles || [], topK);

    case "search_actor_other_movies":
      return searchMovieActorsOtherWork(params.movieTitles || params.titles || [], topK);

    case "search_by_director_and_award":
      return searchByDirectorAndAward(params.directors || [], topK);

    case "search_actors_by_genre":
      return searchActorsByGenre(params.genres || [], topK);

    case "search_by_actor_and_genre":
      return searchByActorAndGenre(params.actors || [], params.genres || [], topK);

    case "search_by_language":
      return searchByLanguage(params.languages || [], topK);

    case "search_by_country":
      return searchByCountry(params.countries || [], topK);

    case "search_coactors":
      return searchCoactors(params.actor || "", topK);

    case "search_actor_in_multiple_genres":
      return searchActorInMultipleGenres(params.genres || [], params.operator || "AND", topK);

    case "search_by_year_range":
      return searchByYearRange(params.startYear, params.endYear, params.filters || {}, topK);

    case "search_top_rated":
      return searchTopRated(topK, params.filters || {});

    case "search_common_movies":
      return searchCommonMovies(params.actor1 || "", params.actor2 || "", topK);

    case "search_actor_aggregates":
      return searchActorAggregates(params.sortBy || "movieCount", topK);

    case "search_director_aggregates":
      return searchDirectorAggregates(params.sortBy || "movieCount", topK);

    case "search_genre_oscar_stats":
      return searchGenreOscarStats(topK);

    case "search_by_rating_range":
      return searchByRatingRange(params.minRating || 0, params.maxRating || 10, params.filters || {}, topK);

    case "search_franchise_movies":
      return searchFranchiseMovies(params.keyword || "", topK);

    case "search_director_filmography":
      return searchDirectorFilmography(params.director || "", topK);

    default:
      console.warn(`⚠️  Unknown tool: ${toolName}`);
      return [];
  }
}

// ── Execute multiple tools in parallel ───────────────────────
export async function executeToolsParallel(tools = []) {
  if (tools.length === 0) return [];

  console.log(`\n🔧 Executing ${tools.length} tools in parallel...`);

  const promises = tools.map(tool => {
    console.log(`  ▶ ${tool.name}(${JSON.stringify(tool.params)})`);
    return executeTool(tool.name, tool.params || {})
      .catch(err => {
        console.error(`  ❌ Tool ${tool.name} failed: ${err.message}`);
        return [];
      });
  });

  const results = await Promise.all(promises);

  // Flatten + deduplicate by title
  const merged = results.flat();
  const seen = new Set();
  return merged.filter(r => {
    const key = r.title?.toLowerCase().trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}