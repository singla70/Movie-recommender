// ============================================================
// src/query/vectorSearch.js
//
// Two modes:
//   1. getCandidates(query, 50) — Graph fusion ke liye top 50
//   2. vectorSearch(query, topK) — Direct results ke liye
//
// Confidence:
//   >= 0.85 → High
//   >= 0.70 → Medium
//   <  0.70 → Low
// ============================================================

import { generateQueryEmbedding } from "../ingestion/embedder.js";
import { searchSimilarMovies } from "../ingestion/pineconeLoader.js";
import { CONFIDENCE } from "../config/constants.js";

// ── Top 50 candidates — graph fusion ke liye ─────────────────
export async function getVectorCandidates(userQuery, filter = {}) {
  const queryEmbedding = await generateQueryEmbedding(userQuery);
  const results = await searchSimilarMovies(queryEmbedding, 50, filter);
  console.log(`  📊 getVectorCandidates: Pinecone returned ${results.length} candidate(s) for "${userQuery}"${Object.keys(filter).length ? ` (filter: ${JSON.stringify(filter)})` : ""}`);
  return results.map(r => ({
    ...r,
    source: "vector",
    confidenceScore: r.score,
    confidenceLabel: getLabel(r.score),
    confidenceExplanation: `Vector similarity: ${(r.score * 100).toFixed(1)}%`,
  }));
}

// ── Direct vector search — no graph fusion ───────────────────
export async function vectorSearch(userQuery, topK = 10, filter = {}) {
  console.log(`\n🔍 Vector search: "${userQuery}"`);
  const queryEmbedding = await generateQueryEmbedding(userQuery);
  const results = await searchSimilarMovies(queryEmbedding, topK, filter);
  return results.map(r => ({
    ...r,
    source: "vector",
    confidenceScore: r.score,
    confidenceLabel: getLabel(r.score),
    confidenceExplanation: `Vector similarity: ${(r.score * 100).toFixed(1)}%`,
  }));
}

function getLabel(score) {
  if (score >= CONFIDENCE.VECTOR_HIGH) return "High";
  if (score >= CONFIDENCE.VECTOR_MEDIUM) return "Medium";
  return "Low";
}