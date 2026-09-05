// ============================================================
// src/ingestion/idReconciler.js
//
// Problem jo isse solve hota hai:
//   Purani ingestion run mein movie IDs positionally bane the
//   (`movie-${chunkIndex*100+idx}`) — ye chunk-splitting aur LLM
//   ke extraction-order pe depend karte hain. Agar PDF ko dobara
//   parse karein (naye fields — directors[], sourceExcerpt, awards,
//   language, country — nikalne ke liye), toh fresh IDs shayad
//   OLD IDs se match na karein (LLM har baar exact same order mein
//   movies return kare, zaroori nahi).
//
//   Agar hum mismatched fresh IDs se seedha MERGE/upsert kar dein,
//   toh Neo4j mein DUPLICATE Movie nodes ban jayenge (naya id =
//   naya MERGE match), aur Pinecone mein bhi duplicate vectors
//   (naya id = naya upsert entry, purana wahi ka wahi reh jayega).
//
// Solution: fresh-parsed movies ko EXISTING Neo4j Movie nodes se
//   (title + year) ke through match karo — ye zyada stable/natural
//   key hai IDs se. Match milne pe purana id reuse karo (taaki
//   MERGE/upsert existing node/vector ko hi update kare). Match na
//   mile toh naya movie hai (fresh id rakho — naya insert).
// ============================================================

import { runQueryWithRetry } from "../utils/neo4jClient.js";

// ── Existing Neo4j movies ka (title+year) → id lookup map banao ──
async function buildExistingMovieIndex() {
  const results = await runQueryWithRetry(
    "MATCH (m:Movie) RETURN m.id AS id, m.title AS title, m.year AS year"
  );
  const index = new Map();
  for (const row of results) {
    if (!row.title) continue;
    const key = `${row.title.toLowerCase().trim()}|${row.year ?? "null"}`;
    index.set(key, row.id);
  }
  return index;
}

// ── Fresh-parsed movies ke IDs reconcile karo ─────────────────
// movies: freshly-parsed movie objects (naye positional IDs ke saath)
// returns: { movies (full array, ids reconciled — back-compat for
//   scripts/migrate.js), matched, newMovies (counts — same back-compat),
//   newMovieList, existingMovieList (NEW — actual arrays, so callers
//   that only care about genuinely-new movies, like server/ingestJob.js,
//   don't have to re-filter movies[] themselves) }
export async function reconcileMovieIds(movies) {
  console.log("  🔗 Matching freshly-parsed movies against existing Neo4j data (by title+year)...");
  const existingIndex = await buildExistingMovieIndex();

  let matched = 0;
  let newMovies = 0;
  const newMovieList = [];
  const existingMovieList = [];

  const reconciled = movies.map((movie) => {
    const key = `${(movie.title || "").toLowerCase().trim()}|${movie.year ?? "null"}`;
    const existingId = existingIndex.get(key);

    if (existingId) {
      matched++;
      const m = { ...movie, id: existingId }; // reuse existing id — UPDATE, not duplicate
      existingMovieList.push(m);
      return m;
    } else {
      newMovies++;
      newMovieList.push(movie); // naya movie — fresh id hi rehne do (nayi entry banegi)
      return movie;
    }
  });

  console.log(
    `  ✅ ${matched} movies matched to existing records (will UPDATE), ${newMovies} new movies (will INSERT)`
  );
  return { movies: reconciled, matched, newMovies, newMovieList, existingMovieList };
}