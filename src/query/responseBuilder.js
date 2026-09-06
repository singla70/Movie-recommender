// ============================================================
// src/query/responseBuilder.js
//
// Fixes:
//   1. Hallucination completely band — sirf DB data
//   2. Multi-query — alag alag sections mein output
//   3. Title-based deduplication
//   4. English only
// ============================================================

import { chatCompletion } from "../utils/openrouterClient.js";
import { MODELS } from "../config/constants.js";

// ── Single query response ─────────────────────────────────────
export async function buildResponse(
  userQuery,
  vectorResults = [],
  graphResults = [],
  routingInfo = {},
  conversationHistory = [],
  lastMovies = []
) {
  let merged = mergeAndDeduplicateResults(vectorResults, graphResults);

  // Followup detection
  const isFollowup = lastMovies.length > 0 && isFollowupQuery(userQuery, conversationHistory);
  if (isFollowup) {
    const filtered = filterLastMovies(lastMovies, merged, routingInfo);
    if (filtered.length > 0) merged = filtered;
  }

  const sorted = merged.sort((a, b) => b.confidenceScore - a.confidenceScore);

  if (sorted.length === 0) {
    return {
      answer: "I couldn't find any results for this query in my database. Try using a full name or different keywords!",
      movies: [],
      sources: { vector: 0, graph: 0, total: 0 },
    };
  }

  const answer = await generateAnswer(userQuery, sorted, routingInfo.intent || "casual", conversationHistory, isFollowup);

  return {
    answer,
    movies: sorted.map(formatForDisplay),
    sources: { vector: vectorResults.length, graph: graphResults.length, total: sorted.length },
  };
}

// ── Multi-query response — alag sections ─────────────────────
export async function buildMultiQueryResponse(subQueries, conversationHistory = []) {
  const sections = [];

  for (const sq of subQueries) {
    if (!sq.results || sq.results.length === 0) {
      sections.push({
        query: sq.queryText,
        answer: `No results found for: "${sq.queryText}"`,
        movies: [],
      });
      continue;
    }

    const sorted = sq.results.sort((a, b) => b.confidenceScore - a.confidenceScore);
    const answer = await generateAnswer(sq.queryText, sorted, sq.intent || "list", conversationHistory, false);

    sections.push({
      query: sq.queryText,
      answer,
      movies: sorted.map(formatForDisplay),
    });
  }

  return sections;
}

// ── Answer generator — strictly DB data only ─────────────────
async function generateAnswer(userQuery, movies, intent, conversationHistory, isFollowup) {
  const recentHistory = conversationHistory.slice(-4)
    .map(m => `${m.role === "user" ? "User" : "You"}: ${m.content.substring(0, 150)}`)
    .join("\n");

  // Strict DB context — only these movies exist
  const moviesContext = movies.slice(0, 10).map((m, i) => {
    const actors = m.actors?.length > 0 ? `Cast: ${m.actors.slice(0, 6).join(", ")}` : "Cast: not available";
    const genres = m.genres?.length > 0 ? `Genre: ${m.genres.join(", ")}` : "";
    // Multi-director support — directors array ho toh sab list karo,
    // warna purana singular `director` field (backward-compat) use karo.
    const directorText = m.directors?.length ? m.directors.join(", ") : (m.director || "?");
    return `${i+1}. "${m.title}" (${m.year||"?"}) | Director: ${directorText} | Rating: ${m.rating||"?"}/10 | Oscar: ${m.oscarWon ? "Won" : "No"} | ${actors} | ${genres}`.trim();
  }).join("\n");

  const intentGuide = {
    yes_no: "Answer in 1-2 lines (yes/no + brief reason from data). Ask one follow-up. No lists.",
    list: `Match output EXACTLY to what was asked:
- Names/titles only → numbered list of names (+ year). Nothing else.
- Names + specific detail → name + that detail only.
- Full details asked → complete info.
- SIMILARITY QUERIES ONLY (user asked for movies "similar to X" / "like X"): after each title,
  add a short parenthetical (5-8 words max) naming the SPECIFIC common link to X — shared
  director, shared genre, shared theme/setting, or shared lead actor. Pick from the actual
  data given, don't guess. Example: "2. Interstellar (2014) — same director, sci-fi themes".
  Skip this for plain listing queries with no reference movie/theme to compare against.`,
    detail: "Detailed info about the top matching movie/person — from the data provided only.",
    comparison: "Compare top matches on what user asked about.",
    casual: "2-3 suggestions with one-line reason each. End with a follow-up question.",
  };

  const followupNote = isFollowup ? "NOTE: This is a followup — answer strictly from database results below." : "";

  const prompt = `You are a movie recommendation assistant.

CRITICAL RULES:
1. ONLY use information from "DATABASE RESULTS" below. NEVER add info from your own knowledge.
2. If a specific FIELD for a movie is missing (e.g. no rating, no language listed), say "not available in database" for that field — do NOT make it up.
3. NEVER invent placeholder or filler movie entries to reach a count the user asked for (e.g. if asked for "3 movies" but DATABASE RESULTS below only has 1, list only that 1 — do not add "2. not available in database" or similar fake rows). List exactly as many real movies as are given below, never more.
4. ENGLISH ONLY always.
5. Match output format EXACTLY to what user asked — names only → give only names.
6. Do NOT show confidence scores or technical terms to user.
${followupNote}

${recentHistory ? `Recent conversation:\n${recentHistory}\n` : ""}
User asked: "${userQuery}"
Intent: ${intent}

DATABASE RESULTS (use ONLY these — there are exactly ${movies.slice(0, 10).length} movie(s) below, no more, no less):
${moviesContext}

Format for "${intent}" intent:
${intentGuide[intent] || intentGuide.casual}`;

  return await chatCompletion(MODELS.LLM, [{ role: "user", content: prompt }], 500);
}

// ── Followup detection ────────────────────────────────────────
function isFollowupQuery(query, history) {
  if (history.length === 0) return false;
  const q = query.toLowerCase();
  const signals = ["these", "those", "them", "in these", "from these", "among these",
    "of these", "which one", "which of", "any of", "from the above", "inme", "inme se",
    "in se", "unme", "among them", "from that list", "tell me more", "more about",
    "details of", "detail about"];
  return signals.some(s => q.includes(s));
}

function filterLastMovies(lastMovies, freshResults, routingInfo) {
  const freshTitles = new Set(freshResults.map(r => r.title?.toLowerCase().trim()));
  const hasOscarFilter = routingInfo.entities?.awards?.length > 0
    || routingInfo.vectorFilter?.oscarWon === true;

  return lastMovies.filter(movie => {
    const titleMatch = freshTitles.has(movie.title?.toLowerCase().trim());
    return hasOscarFilter ? titleMatch && movie.oscarWon : titleMatch;
  }).map(movie => ({
    ...movie,
    source: "filtered-from-previous",
    confidenceScore: movie.confidence?.score ? movie.confidence.score / 100 : 0.9,
    confidenceLabel: "High",
    confidenceExplanation: "From your previous search results",
  }));
}

// ── Merge + deduplicate by title ──────────────────────────────
function mergeAndDeduplicateResults(vectorResults, graphResults) {
  const movieMap = new Map();
  const getKey = r => r.title ? r.title.toLowerCase().trim() : r.movieId;

  for (const r of vectorResults) {
    const key = getKey(r);
    if (key) movieMap.set(key, { ...r });
  }

  for (const r of graphResults) {
    const key = getKey(r);
    if (!key) continue;
    if (movieMap.has(key)) {
      const existing = movieMap.get(key);
      movieMap.set(key, {
        ...existing,
        ...(r.confidenceScore > existing.confidenceScore ? r : {}),
        source: "both",
        confidenceScore: Math.max(r.confidenceScore, existing.confidenceScore),
        confidenceExplanation: `${existing.confidenceExplanation||""} | ${r.confidenceExplanation||""}`.trim(),
      });
    } else {
      movieMap.set(key, { ...r });
    }
  }

  return Array.from(movieMap.values());
}

function formatForDisplay(movie) {
  return {
    title: movie.title || "Unknown",
    year: movie.year || null,
    directors: movie.directors?.length ? movie.directors : (movie.director ? [movie.director] : []),
    director: movie.directors?.[0] || movie.director || null, // backward-compat singular
    rating: movie.rating ? parseFloat(Number(movie.rating).toFixed(1)) : null,
    oscarWon: movie.oscarWon || false,
    oscarNominations: movie.oscarNominations || 0,
    plot: movie.plot?.substring(0, 150) || "",
    actors: movie.actors || [],
    genres: movie.genres || [],
    source: movie.source || "unknown",
    confidence: {
      score: parseFloat((movie.confidenceScore * 100).toFixed(1)),
      label: movie.confidenceLabel || "Unknown",
      stars: movie.confidenceLabel === "High" ? "★★★" : movie.confidenceLabel === "Medium" ? "★★☆" : "★☆☆",
    },
  };
}