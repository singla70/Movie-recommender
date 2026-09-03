// ============================================================
// src/query/graphSearch.js
//
// All graph search functions — exported individually
// toolExecutor.js inhe call karta hai
//
// Functions:
//   Existing: searchByDirector, searchByActor, searchOscarMovies,
//             searchByGenre, searchMovieDirectData, searchMovieActorsOtherWork,
//             searchByDirectorAndAward, searchActorsByGenre,
//             searchByActorAndGenre, searchByLanguage, searchByCountry,
//             enrichMoviesFromGraph
//   New:      searchCoactors, searchActorInMultipleGenres,
//             searchByYearRange, searchTopRated, searchCommonMovies,
//             searchActorAggregates, searchDirectorAggregates,
//             searchGenreOscarStats, searchByRatingRange,
//             searchFranchiseMovies, searchDirectorFilmography
// ============================================================

import { runQuery } from "../utils/neo4jClient.js";
import { CONFIDENCE, MODELS } from "../config/constants.js";
import { chatCompletion } from "../utils/openrouterClient.js";

// ── Main graph search (called from app.js) ────────────────────
export async function graphSearch(entities, topK = 10) {
  console.log(`\n🕸️  Graph search with entities:`, JSON.stringify(entities));

  const { executeToolsParallel } = await import("./toolExecutor.js");

  const tools = entitiesToTools(entities, topK);
  if (tools.length === 0) return [];

  const results = await executeToolsParallel(tools);

  const yearFiltered = entities.years?.length > 0
    ? filterByYear(results, entities.years) : results;

  return deduplicateByTitle(yearFiltered).slice(0, topK);
}

// ── Convert entities to tool calls ───────────────────────────
function entitiesToTools(entities, topK) {
  const tools = [];
  const hasDirector = entities.directors?.length > 0;
  const hasActor    = entities.actors?.length > 0;
  const hasAward    = entities.awards?.length > 0 || hasOscarKeyword(entities);
  const hasGenre    = entities.genres?.length > 0;
  const hasTitle    = entities.movieTitles?.length > 0;
  const hasLanguage = entities.language?.length > 0;
  const hasCountry  = entities.country?.length > 0;

  if (hasDirector && hasAward) {
    tools.push({ name: "search_by_director_and_award", params: { directors: entities.directors, limit: topK } });
  } else if (hasDirector) {
    tools.push({ name: "search_by_director", params: { directors: entities.directors, limit: topK } });
  }

  if (hasActor && hasGenre) {
    // Pehle dono tools chalte the (search_by_actor_and_genre +
    // search_actor_in_multiple_genres) — overlapping results dete hain,
    // deduplicateByTitle se merge ho jaate the, lekin ek extra Neo4j
    // round-trip waste hota tha. search_by_actor_and_genre akela hi
    // "in actors" AND "in genres" cover kar deta hai — doosra tool
    // hataya.
    tools.push({ name: "search_by_actor_and_genre", params: { actors: entities.actors, genres: entities.genres, limit: topK } });
  } else if (hasActor) {
    tools.push({ name: "search_by_actor", params: { actors: entities.actors, limit: topK } });
  }

  if (!hasDirector && hasAward) {
    tools.push({ name: "search_oscar_movies", params: { limit: topK } });
  }

  if (hasGenre && !hasActor) {
    tools.push({ name: "search_by_genre", params: { genres: entities.genres, limit: topK } });
    tools.push({ name: "search_actors_by_genre", params: { genres: entities.genres, limit: topK } });
    tools.push({ name: "search_actor_in_multiple_genres", params: { genres: entities.genres, operator: "AND", limit: topK } });
  }

  if (hasTitle) {
    tools.push({ name: "search_movie_direct_data", params: { titles: entities.movieTitles, limit: topK } });
    tools.push({ name: "search_actor_other_movies", params: { movieTitles: entities.movieTitles, limit: topK } });
  }

  if (hasLanguage) {
    tools.push({ name: "search_by_language", params: { languages: entities.language, limit: topK } });
  }

  if (hasCountry) {
    tools.push({ name: "search_by_country", params: { countries: entities.country, limit: topK } });
  }

  return tools;
}

// ── Graph Enrich + Filter (Hybrid mode) ──────────────────────
export async function graphEnrichAndFilter(vectorCandidates, entities, topK = 10) {
  if (!vectorCandidates || vectorCandidates.length === 0) return [];

  const titles = vectorCandidates.map(c => c.title).filter(Boolean);
  if (titles.length === 0) return vectorCandidates.slice(0, topK);

  const graphData = await enrichMoviesFromGraph(titles);
  const graphMap = new Map(graphData.map(m => [m.title?.toLowerCase(), m]));

  let enriched = vectorCandidates.map(candidate => {
    const key = candidate.title?.toLowerCase();
    const graphInfo = graphMap.get(key);
    if (!graphInfo) return { ...candidate, graphScore: 0 };
    const directors = graphInfo.directors?.length ? graphInfo.directors : (candidate.directors || (candidate.director ? [candidate.director] : []));
    return {
      ...candidate,
      directors,
      director: directors[0] || null, // backward-compat singular field
      oscarWon: candidate.oscarWon || graphInfo.oscarWon,
      oscarNominations: candidate.oscarNominations || graphInfo.oscarNominations,
      genres: graphInfo.genres || [],
      actors: graphInfo.actors || [],
      language: graphInfo.language,
      country: graphInfo.country,
      graphScore: 0.5, // baseline — refined below (§ criteria-match ratio) is_complex entity filters ke baad
      source: "both",
    };
  });

  const hasAward    = entities.awards?.length > 0 || hasOscarKeyword(entities);
  const hasGenre    = entities.genres?.length > 0;
  const hasDirector = entities.directors?.length > 0;
  const hasActor    = entities.actors?.length > 0;
  const hasLang     = entities.language?.length > 0;

  // Kitne filter-criteria diye gaye the — is se pata chalega ki graphScore
  // ko kitne "matched criteria / total criteria" ke hisaab se scale karna hai.
  const totalCriteria = [hasAward, hasGenre, hasDirector, hasActor, hasLang].filter(Boolean).length;

  if (hasAward) { const f = enriched.filter(m => m.oscarWon); if (f.length > 0) enriched = f; }
  if (hasGenre) { const f = enriched.filter(m => m.genres?.some(g => entities.genres.some(eg => g.toLowerCase().includes(eg.toLowerCase())))); if (f.length > 0) enriched = f; }
  if (hasDirector) { const f = enriched.filter(m => m.directors?.some(d => entities.directors.some(ed => d.toLowerCase().includes(ed.toLowerCase())))); if (f.length > 0) enriched = f; }
  if (hasActor) { const f = enriched.filter(m => m.actors?.some(a => entities.actors.some(ea => a.toLowerCase().includes(ea.toLowerCase())))); if (f.length > 0) enriched = f; }
  if (hasLang) { const f = enriched.filter(m => entities.language.some(l => m.language?.toLowerCase().includes(l.toLowerCase()))); if (f.length > 0) enriched = f; }
  if (entities.years?.length > 0) { const f = filterByYear(enriched, entities.years); if (f.length > 0) enriched = f; }

  // ── Refined graphScore: kitne criteria ACTUALLY match karte hain ────
  // Pehle flat 0.5 tha (bas "graph mein mila ya nahi") — ab har entity-
  // type (director/actor/genre/award/language) ke against individually
  // check karke ek match-ratio banate hain. Isse hybrid ranking mein
  // genuinely-zyada-relevant movies upar aati hain, sirf "kisi bhi ek
  // cheez pe match hua" wale movies utni upar nahi aatin jitni "sab
  // criteria pe match" wali.
  enriched = enriched.map((m) => {
    if (totalCriteria === 0) return m; // koi graph-filter tha hi nahi — baseline 0.5 hi theek hai
    let matched = 0;
    if (hasAward && m.oscarWon) matched++;
    if (hasGenre && m.genres?.some(g => entities.genres.some(eg => g.toLowerCase().includes(eg.toLowerCase())))) matched++;
    if (hasDirector && m.directors?.some(d => entities.directors.some(ed => d.toLowerCase().includes(ed.toLowerCase())))) matched++;
    if (hasActor && m.actors?.some(a => entities.actors.some(ea => a.toLowerCase().includes(ea.toLowerCase())))) matched++;
    if (hasLang && entities.language.some(l => m.language?.toLowerCase().includes(l.toLowerCase()))) matched++;
    return { ...m, graphScore: matched / totalCriteria };
  });

  return enriched
    .map(m => ({ ...m, confidenceScore: (m.confidenceScore * 0.7) + ((m.graphScore || 0) * 0.3), confidenceLabel: getLabel(m.confidenceScore), confidenceExplanation: `${m.confidenceExplanation} | Graph enriched (${((m.graphScore||0)*100).toFixed(0)}% criteria match)` }))
    .sort((a, b) => b.confidenceScore - a.confidenceScore)
    .slice(0, topK);
}

// ════════════════════════════════════════════════════════════
// EXISTING TOOLS
// ════════════════════════════════════════════════════════════

export async function searchByDirector(directors, limit = 10) {
  const cypher = `
    UNWIND $directors AS dirName
    MATCH (d:Director) WHERE toLower(d.name) CONTAINS toLower(dirName)
    MATCH (m:Movie)-[:DIRECTED_BY]->(d)
    OPTIONAL MATCH (allDir:Director)<-[:DIRECTED_BY]-(m)
    OPTIONAL MATCH (a:Actor)-[:ACTED_IN]->(m)
    WITH m, collect(DISTINCT allDir.name) AS directors, collect(DISTINCT a.name)[0..5] AS actors
    RETURN m.id AS movieId, m.title AS title, m.year AS year,
           m.rating AS rating, m.oscarWon AS oscarWon,
           m.oscarNominations AS oscarNominations, m.plot AS plot,
           directors, actors,
           1 AS hops, 'Director: ' + directors[0] AS matchReason
    ORDER BY m.oscarWon DESC, m.year DESC LIMIT $limit
  `;
  return (await runQuery(cypher, { directors, limit: parseInt(limit) })).map(formatResult);
}

export async function searchByActor(actors, limit = 10) {
  const cypher = `
    UNWIND $actors AS actorName
    MATCH (a:Actor) WHERE toLower(a.name) CONTAINS toLower(actorName)
    MATCH (a)-[:ACTED_IN]->(m:Movie)
    OPTIONAL MATCH (d:Director)<-[:DIRECTED_BY]-(m)
    OPTIONAL MATCH (a2:Actor)-[:ACTED_IN]->(m)
    WITH m, a, collect(DISTINCT d.name) AS directors, collect(DISTINCT a2.name)[0..5] AS castList
    RETURN m.id AS movieId, m.title AS title, m.year AS year,
           m.rating AS rating, m.oscarWon AS oscarWon,
           m.oscarNominations AS oscarNominations, m.plot AS plot,
           directors, castList AS actors, a.name AS matchedActor,
           1 AS hops, 'Actor: ' + a.name AS matchReason
    ORDER BY m.oscarWon DESC, m.year DESC LIMIT $limit
  `;
  const records = await runQuery(cypher, { actors, limit: parseInt(limit) });
  return records.map(r => ({ ...formatResult(r), actors: r.actors || [] }));
}

export async function searchOscarMovies(limit = 10) {
  const cypher = `
    MATCH (m:Movie) WHERE m.oscarWon = true
    OPTIONAL MATCH (m)-[:DIRECTED_BY]->(d:Director)
    WITH m, collect(DISTINCT d.name) AS directors
    RETURN m.id AS movieId, m.title AS title, m.year AS year,
           m.rating AS rating, m.oscarWon AS oscarWon,
           m.oscarNominations AS oscarNominations, m.plot AS plot,
           directors, 1 AS hops, 'Oscar winner' AS matchReason
    ORDER BY m.year DESC LIMIT $limit
  `;
  return (await runQuery(cypher, { limit: parseInt(limit) })).map(formatResult);
}

export async function searchByGenre(genres, limit = 10) {
  const cypher = `
    UNWIND $genres AS genreName
    MATCH (g:Genre) WHERE toLower(g.name) CONTAINS toLower(genreName)
    MATCH (m:Movie)-[:HAS_GENRE]->(g)
    WITH m, collect(DISTINCT g.name) AS matchedGenres
    OPTIONAL MATCH (m)-[:DIRECTED_BY]->(d:Director)
    WITH m, matchedGenres, collect(DISTINCT d.name) AS directors
    RETURN m.id AS movieId, m.title AS title, m.year AS year,
           m.rating AS rating, m.oscarWon AS oscarWon,
           m.oscarNominations AS oscarNominations, m.plot AS plot,
           directors, matchedGenres,
           1 AS hops, 'Genre: ' + matchedGenres[0] AS matchReason
    ORDER BY m.oscarWon DESC, m.rating DESC LIMIT $limit
  `;
  return (await runQuery(cypher, { genres, limit: parseInt(limit) })).map(r => ({ ...formatResult(r), genres: r.matchedGenres || [] }));
}

export async function searchMovieDirectData(titles, limit = 10) {
  const cypher = `
    UNWIND $titles AS titleName
    MATCH (m:Movie) WHERE toLower(m.title) CONTAINS toLower(titleName)
    OPTIONAL MATCH (m)-[:DIRECTED_BY]->(d:Director)
    OPTIONAL MATCH (a:Actor)-[:ACTED_IN]->(m)
    OPTIONAL MATCH (m)-[:HAS_GENRE]->(g:Genre)
    WITH m, collect(DISTINCT d.name) AS directors, collect(DISTINCT a.name) AS actors, collect(DISTINCT g.name) AS genres
    RETURN m.id AS movieId, m.title AS title, m.year AS year,
           m.rating AS rating, m.oscarWon AS oscarWon,
           m.oscarNominations AS oscarNominations, m.plot AS plot,
           directors, actors, genres,
           1 AS hops, 'Direct match' AS matchReason
    ORDER BY m.year DESC LIMIT $limit
  `;
  const records = await runQuery(cypher, { titles, limit: parseInt(limit) });
  return records.map(r => ({ ...formatResult(r), actors: r.actors || [], genres: r.genres || [] }));
}

export async function searchMovieActorsOtherWork(movieTitles, limit = 10) {
  const cypher = `
    UNWIND $titles AS titleName
    MATCH (src:Movie) WHERE toLower(src.title) CONTAINS toLower(titleName)
    MATCH (a:Actor)-[:ACTED_IN]->(src)
    MATCH (a)-[:ACTED_IN]->(other:Movie)
    WHERE toLower(other.title) <> toLower(src.title)
    OPTIONAL MATCH (other)-[:DIRECTED_BY]->(d:Director)
    RETURN DISTINCT other.id AS movieId, other.title AS title, other.year AS year,
           other.rating AS rating, other.oscarWon AS oscarWon,
           other.oscarNominations AS oscarNominations, other.plot AS plot,
           d.name AS director, a.name AS connectingActor,
           2 AS hops, a.name + ' (from ' + src.title + ')' AS matchReason
    ORDER BY other.oscarWon DESC, other.year DESC LIMIT $limit
  `;
  return (await runQuery(cypher, { titles: movieTitles, limit: parseInt(limit) })).map(formatResult);
}

export async function searchByDirectorAndAward(directors, limit = 10) {
  const cypher = `
    UNWIND $directors AS dirName
    MATCH (d:Director) WHERE toLower(d.name) CONTAINS toLower(dirName)
    MATCH (m:Movie)-[:DIRECTED_BY]->(d) WHERE m.oscarWon = true
    RETURN m.id AS movieId, m.title AS title, m.year AS year,
           m.rating AS rating, m.oscarWon AS oscarWon,
           m.oscarNominations AS oscarNominations, m.plot AS plot,
           d.name AS director, 1 AS hops, 'Oscar by ' + d.name AS matchReason
    ORDER BY m.year DESC LIMIT $limit
  `;
  return (await runQuery(cypher, { directors, limit: parseInt(limit) })).map(formatResult);
}

export async function searchActorsByGenre(genres, limit = 10) {
  const cypher = `
    UNWIND $genres AS genreName
    MATCH (g:Genre) WHERE toLower(g.name) CONTAINS toLower(genreName)
    MATCH (a:Actor)-[r:WORKED_IN_GENRE]->(g)
    WITH a, g, r.count AS movieCount
    ORDER BY movieCount DESC
    MATCH (a)-[:ACTED_IN]->(m:Movie)-[:HAS_GENRE]->(g)
    WITH a, g, movieCount, collect(DISTINCT m.title)[0..3] AS sampleMovies
    RETURN a.name AS actorName, g.name AS genre, movieCount, sampleMovies
    LIMIT $limit
  `;
  const records = await runQuery(cypher, { genres, limit: parseInt(limit) });
  return records.map(r => ({
    movieId: `actor-${r.actorName?.replace(/\s+/g, "-")}`,
    title: r.actorName,
    year: null, rating: null, oscarWon: false, oscarNominations: 0,
    plot: `Worked in ${r.movieCount} ${r.genre} movies: ${r.sampleMovies?.join(", ")}`,
    director: null, actors: [], genres: [r.genre],
    source: "graph", confidenceScore: 0.95, confidenceLabel: "High",
    confidenceExplanation: `${r.movieCount} ${r.genre} movies`,
  }));
}

export async function searchByActorAndGenre(actors, genres, limit = 10) {
  const cypher = `
    UNWIND $actors AS actorName
    MATCH (a:Actor) WHERE toLower(a.name) CONTAINS toLower(actorName)
    UNWIND $genres AS genreName
    MATCH (g:Genre) WHERE toLower(g.name) CONTAINS toLower(genreName)
    MATCH (a)-[:ACTED_IN]->(m:Movie)-[:HAS_GENRE]->(g)
    OPTIONAL MATCH (m)-[:DIRECTED_BY]->(d:Director)
    RETURN m.id AS movieId, m.title AS title, m.year AS year,
           m.rating AS rating, m.oscarWon AS oscarWon,
           m.oscarNominations AS oscarNominations, m.plot AS plot,
           d.name AS director, a.name AS matchedActor,
           1 AS hops, a.name + ' in ' + g.name AS matchReason
    ORDER BY m.year DESC LIMIT $limit
  `;
  return (await runQuery(cypher, { actors, genres, limit: parseInt(limit) })).map(formatResult);
}

export async function searchByLanguage(languages, limit = 10) {
  const cypher = `
    UNWIND $languages AS langName
    MATCH (m:Movie)-[:IN_LANGUAGE]->(l:Language)
    WHERE toLower(l.name) CONTAINS toLower(langName)
    OPTIONAL MATCH (m)-[:DIRECTED_BY]->(d:Director)
    RETURN m.id AS movieId, m.title AS title, m.year AS year,
           m.rating AS rating, m.oscarWon AS oscarWon,
           m.oscarNominations AS oscarNominations, m.plot AS plot,
           d.name AS director, l.name AS language,
           1 AS hops, 'Language: ' + l.name AS matchReason
    ORDER BY m.oscarWon DESC, m.year DESC LIMIT $limit
  `;
  return (await runQuery(cypher, { languages, limit: parseInt(limit) })).map(formatResult);
}

export async function searchByCountry(countries, limit = 10) {
  const cypher = `
    UNWIND $countries AS countryName
    MATCH (m:Movie)-[:FROM_COUNTRY]->(c:Country)
    WHERE toLower(c.name) CONTAINS toLower(countryName)
    OPTIONAL MATCH (m)-[:DIRECTED_BY]->(d:Director)
    RETURN m.id AS movieId, m.title AS title, m.year AS year,
           m.rating AS rating, m.oscarWon AS oscarWon,
           m.oscarNominations AS oscarNominations, m.plot AS plot,
           d.name AS director, c.name AS country,
           1 AS hops, 'Country: ' + c.name AS matchReason
    ORDER BY m.oscarWon DESC, m.year DESC LIMIT $limit
  `;
  return (await runQuery(cypher, { countries, limit: parseInt(limit) })).map(formatResult);
}

export async function enrichMoviesFromGraph(titles) {
  const cypher = `
    UNWIND $titles AS titleName
    MATCH (m:Movie) WHERE toLower(m.title) = toLower(titleName)
    OPTIONAL MATCH (m)-[:DIRECTED_BY]->(d:Director)
    OPTIONAL MATCH (a:Actor)-[:ACTED_IN]->(m)
    OPTIONAL MATCH (m)-[:HAS_GENRE]->(g:Genre)
    WITH m, collect(DISTINCT d.name) AS directors, collect(DISTINCT a.name)[0..8] AS actors, collect(DISTINCT g.name) AS genres
    RETURN m.title AS title, m.oscarWon AS oscarWon,
           m.oscarNominations AS oscarNominations, m.rating AS rating,
           m.language AS language, m.country AS country,
           directors, actors, genres
  `;
  return await runQuery(cypher, { titles });
}

// ════════════════════════════════════════════════════════════
// NEW TOOLS
// ════════════════════════════════════════════════════════════

// ── Co-actors of an actor ─────────────────────────────────────
export async function searchCoactors(actor, limit = 10) {
  const cypher = `
    MATCH (a:Actor) WHERE toLower(a.name) CONTAINS toLower($actor)
    MATCH (a)-[:CO_STARRED_WITH]-(coActor:Actor)
    RETURN coActor.name AS title,
           coActor.name AS actorName,
           null AS movieId, null AS year, null AS rating,
           false AS oscarWon, 0 AS oscarNominations,
           null AS plot, null AS director,
           1 AS hops, 'Co-star of ' + a.name AS matchReason
    LIMIT $limit
  `;
  return (await runQuery(cypher, { actor, limit: parseInt(limit) })).map(r => ({
    ...formatResult(r),
    title: r.actorName || r.title,
    plot: `Co-starred with ${actor}`,
  }));
}

// ── Actor in MULTIPLE genres (AND/OR) ────────────────────────
export async function searchActorInMultipleGenres(genres, operator = "AND", limit = 10) {
  if (operator === "AND" && genres.length >= 2) {
    // Actor must have worked in ALL specified genres
    const cypher = `
      MATCH (a:Actor)
      WHERE ALL(genreName IN $genres WHERE
        EXISTS {
          MATCH (a)-[:ACTED_IN]->(m:Movie)-[:HAS_GENRE]->(g:Genre)
          WHERE toLower(g.name) CONTAINS toLower(genreName)
        }
      )
      WITH a
      MATCH (a)-[:ACTED_IN]->(m:Movie)
      OPTIONAL MATCH (m)-[:DIRECTED_BY]->(d:Director)
      OPTIONAL MATCH (m)-[:HAS_GENRE]->(g:Genre)
      WITH a, collect(DISTINCT m.title)[0..3] AS sampleMovies,
           collect(DISTINCT g.name) AS allGenres
      RETURN a.name AS title, a.name AS actorName,
             null AS movieId, null AS year, null AS rating,
             false AS oscarWon, 0 AS oscarNominations,
             'Works in: ' + apoc.text.join($genres, ' AND ') AS plot,
             null AS director, sampleMovies, allGenres,
             1 AS hops, 'Multi-genre actor' AS matchReason
      LIMIT $limit
    `;
    try {
      const records = await runQuery(cypher, { genres, limit: parseInt(limit) });
      if (records.length > 0) {
        return records.map(r => ({
          movieId: `actor-${r.actorName?.replace(/\s+/g, "-")}`,
          title: r.actorName,
          year: null, rating: null, oscarWon: false, oscarNominations: 0,
          plot: `Actor who worked in both ${genres.join(" and ")} movies. Films: ${r.sampleMovies?.join(", ")}`,
          director: null, actors: [], genres: r.allGenres || genres,
          source: "graph", confidenceScore: 0.95, confidenceLabel: "High",
          confidenceExplanation: `Multi-genre: ${genres.join(" AND ")}`,
        }));
      }
    } catch {
      // APOC not available — fallback
    }

    // Fallback without APOC — manual intersection
    const results = [];
    for (const genre of genres) {
      const actors = await searchActorsByGenre([genre], 50);
      results.push(new Set(actors.map(a => a.title)));
    }
    if (results.length === 0) return [];

    // Intersection
    const intersection = [...results[0]].filter(actor =>
      results.every(set => set.has(actor))
    );

    return intersection.slice(0, limit).map(actorName => ({
      movieId: `actor-${actorName.replace(/\s+/g, "-")}`,
      title: actorName,
      year: null, rating: null, oscarWon: false, oscarNominations: 0,
      plot: `Actor who worked in both ${genres.join(" and ")} movies`,
      director: null, actors: [], genres,
      source: "graph", confidenceScore: 0.9, confidenceLabel: "High",
      confidenceExplanation: `Multi-genre: ${genres.join(" AND ")}`,
    }));
  }

  // OR operator — union
  return searchActorsByGenre(genres, limit);
}

// ── Year range search ─────────────────────────────────────────
export async function searchByYearRange(startYear, endYear, filters = {}, limit = 10) {
  const conditions = ["m.year >= $startYear", "m.year <= $endYear"];
  if (filters.oscarWon) conditions.push("m.oscarWon = true");
  if (filters.minRating) conditions.push("m.rating >= $minRating");

  const cypher = `
    MATCH (m:Movie)
    WHERE ${conditions.join(" AND ")}
    ${filters.genre ? `MATCH (m)-[:HAS_GENRE]->(g:Genre) WHERE toLower(g.name) CONTAINS toLower($genre)` : ""}
    ${filters.language ? `MATCH (m)-[:IN_LANGUAGE]->(l:Language) WHERE toLower(l.name) CONTAINS toLower($language)` : ""}
    OPTIONAL MATCH (m)-[:DIRECTED_BY]->(d:Director)
    RETURN m.id AS movieId, m.title AS title, m.year AS year,
           m.rating AS rating, m.oscarWon AS oscarWon,
           m.oscarNominations AS oscarNominations, m.plot AS plot,
           d.name AS director,
           1 AS hops, toString(m.year) + ' release' AS matchReason
    ORDER BY m.rating DESC, m.year DESC LIMIT $limit
  `;
  const params = {
    startYear: parseInt(startYear), endYear: parseInt(endYear),
    limit: parseInt(limit), ...filters,
    minRating: filters.minRating ? parseFloat(filters.minRating) : undefined,
  };
  return (await runQuery(cypher, params)).map(formatResult);
}

// ── Top rated movies with optional filters ────────────────────
export async function searchTopRated(limit = 10, filters = {}) {
  const conditions = ["m.rating IS NOT NULL"];
  if (filters.oscarWon) conditions.push("m.oscarWon = true");
  if (filters.minRating) conditions.push("m.rating >= $minRating");

  const cypher = `
    MATCH (m:Movie) WHERE ${conditions.join(" AND ")}
    ${filters.genre ? `MATCH (m)-[:HAS_GENRE]->(g:Genre) WHERE toLower(g.name) CONTAINS toLower($genre)` : ""}
    ${filters.language ? `MATCH (m)-[:IN_LANGUAGE]->(l:Language) WHERE toLower(l.name) CONTAINS toLower($language)` : ""}
    OPTIONAL MATCH (m)-[:DIRECTED_BY]->(d:Director)
    RETURN m.id AS movieId, m.title AS title, m.year AS year,
           m.rating AS rating, m.oscarWon AS oscarWon,
           m.oscarNominations AS oscarNominations, m.plot AS plot,
           d.name AS director,
           1 AS hops, 'Rating: ' + toString(m.rating) AS matchReason
    ORDER BY m.rating DESC LIMIT $limit
  `;
  return (await runQuery(cypher, { limit: parseInt(limit), ...filters })).map(formatResult);
}

// ── Common movies between 2 actors ───────────────────────────
export async function searchCommonMovies(actor1, actor2, limit = 10) {
  const cypher = `
    MATCH (a1:Actor) WHERE toLower(a1.name) CONTAINS toLower($actor1)
    MATCH (a2:Actor) WHERE toLower(a2.name) CONTAINS toLower($actor2)
    MATCH (a1)-[:ACTED_IN]->(m:Movie)<-[:ACTED_IN]-(a2)
    OPTIONAL MATCH (m)-[:DIRECTED_BY]->(d:Director)
    RETURN m.id AS movieId, m.title AS title, m.year AS year,
           m.rating AS rating, m.oscarWon AS oscarWon,
           m.oscarNominations AS oscarNominations, m.plot AS plot,
           d.name AS director,
           1 AS hops, a1.name + ' & ' + a2.name + ' both' AS matchReason
    ORDER BY m.year DESC LIMIT $limit
  `;
  return (await runQuery(cypher, { actor1, actor2, limit: parseInt(limit) })).map(formatResult);
}

// ── Actor aggregates ──────────────────────────────────────────
export async function searchActorAggregates(sortBy = "movieCount", limit = 10) {
  const orderBy = sortBy === "oscarCount"
    ? "oscarMovies DESC, movieCount DESC"
    : "movieCount DESC";

  const cypher = `
    MATCH (a:Actor)-[:ACTED_IN]->(m:Movie)
    WITH a, count(m) AS movieCount,
         sum(CASE WHEN m.oscarWon THEN 1 ELSE 0 END) AS oscarMovies
    RETURN a.name AS title, a.name AS actorName,
           null AS movieId, null AS year, null AS rating,
           false AS oscarWon, 0 AS oscarNominations,
           'Movies: ' + toString(movieCount) + ', Oscar films: ' + toString(oscarMovies) AS plot,
           null AS director, movieCount, oscarMovies,
           1 AS hops, 'Actor aggregate' AS matchReason
    ORDER BY ${orderBy} LIMIT $limit
  `;
  return (await runQuery(cypher, { limit: parseInt(limit) })).map(r => ({
    movieId: `actor-agg-${r.actorName?.replace(/\s+/g, "-")}`,
    title: r.actorName,
    year: null, rating: null, oscarWon: false, oscarNominations: 0,
    plot: r.plot,
    director: null, actors: [], genres: [],
    source: "graph", confidenceScore: 0.9, confidenceLabel: "High",
    confidenceExplanation: `${r.movieCount} total movies`,
  }));
}

// ── Director aggregates ───────────────────────────────────────
export async function searchDirectorAggregates(sortBy = "movieCount", limit = 10) {
  const orderBy = sortBy === "oscarCount"
    ? "oscarMovies DESC, movieCount DESC"
    : "movieCount DESC";

  const cypher = `
    MATCH (d:Director)<-[:DIRECTED_BY]-(m:Movie)
    WITH d, count(m) AS movieCount,
         sum(CASE WHEN m.oscarWon THEN 1 ELSE 0 END) AS oscarMovies
    RETURN d.name AS title, d.name AS directorName,
           null AS movieId, null AS year, null AS rating,
           false AS oscarWon, toInteger(oscarMovies) AS oscarNominations,
           'Directed: ' + toString(movieCount) + ' movies, Oscar wins: ' + toString(oscarMovies) AS plot,
           d.name AS director, movieCount, oscarMovies,
           1 AS hops, 'Director aggregate' AS matchReason
    ORDER BY ${orderBy} LIMIT $limit
  `;
  return (await runQuery(cypher, { limit: parseInt(limit) })).map(r => ({
    movieId: `dir-agg-${r.directorName?.replace(/\s+/g, "-")}`,
    title: r.directorName,
    year: null, rating: null, oscarWon: false, oscarNominations: r.oscarNominations || 0,
    plot: r.plot,
    director: r.directorName, actors: [], genres: [],
    source: "graph", confidenceScore: 0.9, confidenceLabel: "High",
    confidenceExplanation: `${r.movieCount} total movies directed`,
  }));
}

// ── Genre Oscar stats ─────────────────────────────────────────
export async function searchGenreOscarStats(limit = 10) {
  const cypher = `
    MATCH (m:Movie)-[:HAS_GENRE]->(g:Genre)
    WITH g, count(m) AS totalMovies,
         sum(CASE WHEN m.oscarWon THEN 1 ELSE 0 END) AS oscarWins
    WHERE totalMovies > 2
    RETURN g.name AS title, g.name AS genre,
           null AS movieId, null AS year, null AS rating,
           false AS oscarWon, 0 AS oscarNominations,
           'Total: ' + toString(totalMovies) + ' movies, Oscar wins: ' + toString(oscarWins) AS plot,
           null AS director, totalMovies, oscarWins,
           1 AS hops, 'Genre stats' AS matchReason
    ORDER BY oscarWins DESC LIMIT $limit
  `;
  return (await runQuery(cypher, { limit: parseInt(limit) })).map(r => ({
    movieId: `genre-stat-${r.genre?.replace(/\s+/g, "-")}`,
    title: r.genre,
    year: null, rating: null, oscarWon: false, oscarNominations: 0,
    plot: r.plot,
    director: null, actors: [], genres: [r.genre],
    source: "graph", confidenceScore: 0.9, confidenceLabel: "High",
    confidenceExplanation: `${r.oscarWins} Oscar wins in this genre`,
  }));
}

// ── Rating range search ───────────────────────────────────────
export async function searchByRatingRange(minRating = 0, maxRating = 10, filters = {}, limit = 10) {
  const cypher = `
    MATCH (m:Movie)
    WHERE m.rating >= $minRating AND m.rating <= $maxRating
    ${filters.genre ? `MATCH (m)-[:HAS_GENRE]->(g:Genre) WHERE toLower(g.name) CONTAINS toLower($genre)` : ""}
    ${filters.language ? `MATCH (m)-[:IN_LANGUAGE]->(l:Language) WHERE toLower(l.name) CONTAINS toLower($language)` : ""}
    OPTIONAL MATCH (m)-[:DIRECTED_BY]->(d:Director)
    RETURN m.id AS movieId, m.title AS title, m.year AS year,
           m.rating AS rating, m.oscarWon AS oscarWon,
           m.oscarNominations AS oscarNominations, m.plot AS plot,
           d.name AS director,
           1 AS hops, 'Rating ' + toString(m.rating) AS matchReason
    ORDER BY m.rating DESC LIMIT $limit
  `;
  return (await runQuery(cypher, {
    minRating: parseFloat(minRating), maxRating: parseFloat(maxRating),
    limit: parseInt(limit), ...filters
  })).map(formatResult);
}

// ── Franchise/series search ───────────────────────────────────
export async function searchFranchiseMovies(keyword, limit = 10) {
  const cypher = `
    MATCH (m:Movie)
    WHERE toLower(m.title) CONTAINS toLower($keyword)
    OPTIONAL MATCH (m)-[:DIRECTED_BY]->(d:Director)
    OPTIONAL MATCH (a:Actor)-[:ACTED_IN]->(m)
    WITH m, d, collect(DISTINCT a.name)[0..5] AS actors
    RETURN m.id AS movieId, m.title AS title, m.year AS year,
           m.rating AS rating, m.oscarWon AS oscarWon,
           m.oscarNominations AS oscarNominations, m.plot AS plot,
           d.name AS director, actors,
           1 AS hops, 'Franchise: ' + $keyword AS matchReason
    ORDER BY m.year ASC LIMIT $limit
  `;
  return (await runQuery(cypher, { keyword, limit: parseInt(limit) })).map(r => ({
    ...formatResult(r), actors: r.actors || []
  }));
}

// ── Director full filmography ─────────────────────────────────
export async function searchDirectorFilmography(director, limit = 20) {
  const cypher = `
    MATCH (d:Director) WHERE toLower(d.name) CONTAINS toLower($director)
    MATCH (m:Movie)-[:DIRECTED_BY]->(d)
    OPTIONAL MATCH (a:Actor)-[:ACTED_IN]->(m)
    WITH m, d, collect(DISTINCT a.name)[0..5] AS actors
    RETURN m.id AS movieId, m.title AS title, m.year AS year,
           m.rating AS rating, m.oscarWon AS oscarWon,
           m.oscarNominations AS oscarNominations, m.plot AS plot,
           d.name AS director, actors,
           1 AS hops, 'Filmography: ' + d.name AS matchReason
    ORDER BY m.year ASC LIMIT $limit
  `;
  return (await runQuery(cypher, { director, limit: parseInt(limit) })).map(r => ({
    ...formatResult(r), actors: r.actors || []
  }));
}

// ════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════

function filterByYear(results, years) {
  return results.filter(r => {
    if (!r.year) return true;
    return years.some(y => {
      if (typeof y === "string" && y.includes("-")) {
        const [s, e] = y.split("-").map(Number);
        return r.year >= s && r.year <= e;
      }
      return r.year === parseInt(y);
    });
  });
}

function deduplicateByTitle(results) {
  const seen = new Set();
  return results.filter(r => {
    const key = r.title?.toLowerCase().trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function formatResult(record) {
  const hops = record.hops || 1;
  const score = CONFIDENCE.HOP_SCORE_BASE - (hops - 1) * CONFIDENCE.HOP_SCORE_DECAY;
  // Multi-director support: Cypher ab `collect(DISTINCT d.name) AS directors`
  // return karta hai (jahan fix apply hui hai) — purane query-functions
  // (jo abhi tak nahi chhuye) singular `d.name AS director` bhej sakte hain,
  // dono cases handle karte hain taaki koi consumer break na ho.
  const directors = Array.isArray(record.directors)
    ? record.directors.filter(Boolean)
    : record.director
    ? [record.director]
    : [];
  return {
    movieId: record.movieId,
    title: record.title,
    year: record.year,
    rating: record.rating,
    oscarWon: record.oscarWon,
    oscarNominations: record.oscarNominations,
    plot: record.plot,
    directors,                              // [NEW] full list
    director: directors[0] || null,         // backward-compat — pehla director
    actors: record.actors || [],
    genres: record.genres || [],
    source: "graph",
    confidenceScore: Math.max(score, 0.4),
    confidenceLabel: score >= 0.8 ? "High" : score >= 0.6 ? "Medium" : "Low",
    confidenceExplanation: `Graph: ${hops} hop(s) — ${record.matchReason || ""}`,
  };
}

function getLabel(score) {
  if (score >= CONFIDENCE.VECTOR_HIGH) return "High";
  if (score >= CONFIDENCE.VECTOR_MEDIUM) return "Medium";
  return "Low";
}

function hasOscarKeyword(entities) {
  return entities.awards?.some(a =>
    a.toLowerCase().includes("oscar") || a.toLowerCase().includes("academy")
  ) || false;
}