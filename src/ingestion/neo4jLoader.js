// ============================================================
// src/ingestion/neo4jLoader.js
//
// Movies ko Neo4j Graph DB mein insert karo.
//
// Graph Schema (poora — pehle kai relationships missing the):
//   (Movie)   -[:DIRECTED_BY]→     (Director)     [multi-director support]
//   (Actor)   -[:ACTED_IN]→        (Movie)
//   (Movie)   -[:HAS_GENRE]→       (Genre)
//   (Movie)   -[:WON_AWARD]→       (Award)         [real award names, not just generic]
//   (Movie)   -[:IN_LANGUAGE]→     (Language)      [NEW]
//   (Movie)   -[:FROM_COUNTRY]→    (Country)       [NEW]
//   (Actor)   -[:WORKED_IN_GENRE]→ (Genre)          [NEW, aggregate, has .count]
//   (Actor)   -[:CO_STARRED_WITH]- (Actor)          [NEW, undirected, pairwise]
//
// Optimization: UNWIND use karo — ek query mein N movies insert
//   hoti hain, N alag queries ki jagah.
//
// MERGE use karo (CREATE nahi) — duplicate nodes nahi banenge.
//   MERGE pehle check karta hai (label + key-property) match
//   exist karta hai ya nahi:
//     - exist karta hai  → wahi node reuse hota hai
//     - exist nahi karta → naya node create hota hai
//   Isliye "Christopher Nolan" (Director) sirf ek hi baar banega
//   chahe wo 50 movies mein director ho. Lekin agar koi Actor ka
//   naam bhi "Nolan" ho, wo ALAG node banega — kyunki label
//   (:Actor vs :Director) bhi match criteria ka part hai.
//
// Indexing: createIndexes() (neo4jClient.js) MERGE keys ke upar
//   index/constraint banata hai. Bina index MERGE ko poora label
//   scan karna padta — O(n). Index ke saath lookup O(log n) hai.
//
// Parallel batch insertion: batches ko limited-concurrency (3 ek
//   saath) parallel run karte hain, deadlock-retry ke saath. Full
//   unlimited parallelism nahi kiya kyunki dataset mein high-
//   collision entities hain (same director/actor baar-baar alag
//   movies mein) — zyada concurrency = zyada lock-contention/
//   deadlock chance. Detail README.md mein hai.
// ============================================================

import { runQueryWithRetry, createIndexes } from "../utils/neo4jClient.js";
import { BATCH_SIZES, NEO4J_CONCURRENCY } from "../config/constants.js";
import { chunkArray, sleep, runWithConcurrencyLimit } from "../utils/batchHelper.js";

// ── Movies ko Neo4j mein load karo ───────────────────────────
export async function loadMoviesToNeo4j(movies) {
  console.log(`\n🕸️  Loading ${movies.length} movies to Neo4j...`);

  // Pehle indexes + constraints banao — queries fast hongi
  await createIndexes();

  // Movies ko batches mein todo
  const batches = chunkArray(movies, BATCH_SIZES.NEO4J_INSERT);
  let totalInserted = 0;
  let totalFailed = 0;

  console.log(
    `  🔀 Running ${batches.length} batches with max ${NEO4J_CONCURRENCY.MAX_PARALLEL_BATCHES} in parallel...`
  );

  const outcomes = await runWithConcurrencyLimit(
    batches,
    NEO4J_CONCURRENCY.MAX_PARALLEL_BATCHES,
    async (batch, i) => {
      console.log(`  📊 Inserting Neo4j batch ${i + 1}/${batches.length} (${batch.length} movies)...`);
      try {
        await insertMovieBatch(batch);
        return { ok: true, count: batch.length };
      } catch (err) {
        console.error(`  ❌ Neo4j batch ${i + 1}/${batches.length} failed: ${err.message.substring(0, 100)}`);
        return { ok: false, count: batch.length, error: err.message };
      }
    }
  );

  for (const outcome of outcomes) {
    if (outcome.ok) totalInserted += outcome.count;
    else totalFailed += outcome.count;
  }

  if (totalFailed > 0) {
    console.warn(`⚠️  ${totalFailed} movies failed to insert into Neo4j (see errors above).`);
  }
  console.log(`✅ ${totalInserted} movies loaded to Neo4j`);
  return totalInserted;
}

// ── Ek batch movies insert karo (UNWIND pattern, deadlock-retry) ──
async function insertMovieBatch(movies) {
  // UNWIND: Neo4j ek hi query mein poori array loop karta hai
  // MERGE: Duplicate nodes nahi banenge
  const cypher = `
    UNWIND $movies AS movieData

    // Movie node banao ya existing update karo
    MERGE (m:Movie {id: movieData.id})
    SET m.title        = movieData.title,
        m.year         = movieData.year,
        m.plot         = movieData.plot,
        m.rating       = movieData.rating,
        m.oscarWon     = movieData.oscarWon,
        m.oscarNominations = movieData.oscarNominations,
        m.language     = movieData.language,
        m.country      = movieData.country

    // Director node(s) + relationship — MULTIPLE directors support
    // (co-directed movies ab correctly capture hoti hain)
    FOREACH (dirName IN movieData.directors |
      MERGE (d:Director {name: dirName})
      MERGE (m)-[:DIRECTED_BY]->(d)
    )

    // Actor nodes + relationships
    FOREACH (actorName IN movieData.actors |
      MERGE (a:Actor {name: actorName})
      MERGE (a)-[:ACTED_IN]->(m)
    )

    // Genre nodes + relationships
    FOREACH (genreName IN movieData.genres |
      MERGE (g:Genre {name: genreName})
      MERGE (m)-[:HAS_GENRE]->(g)
    )

    // Award nodes + relationships — REAL award names (movie.awards
    // array se), generic "Academy Award" sirf fallback hai agar
    // oscarWon=true lekin awards array khaali ho (LLM ne specific
    // naam extract nahi kiya).
    FOREACH (awardName IN movieData.awardNames |
      MERGE (aw:Award {name: awardName})
      MERGE (m)-[:WON_AWARD]->(aw)
    )

    // Language node + relationship [NEW]
    FOREACH (langName IN CASE WHEN movieData.language IS NOT NULL
                              THEN [movieData.language] ELSE [] END |
      MERGE (l:Language {name: langName})
      MERGE (m)-[:IN_LANGUAGE]->(l)
    )

    // Country node + relationship [NEW]
    FOREACH (countryName IN CASE WHEN movieData.country IS NOT NULL
                                 THEN [movieData.country] ELSE [] END |
      MERGE (c:Country {name: countryName})
      MERGE (m)-[:FROM_COUNTRY]->(c)
    )

    // Actor→Genre aggregate relationship [NEW] — "ye actor kitni
    // movies is genre mein kar chuka hai" (count property).
    // ON CREATE / ON MATCH se count sahi increment hota hai chahe
    // actor-genre pair pehle kabhi (kisi bhi purani movie mein)
    // bana ho ya nahi.
    FOREACH (actorName IN movieData.actors |
      FOREACH (genreName IN movieData.genres |
        MERGE (wa:Actor {name: actorName})
        MERGE (wg:Genre {name: genreName})
        MERGE (wa)-[wig:WORKED_IN_GENRE]->(wg)
        ON CREATE SET wig.count = 1
        ON MATCH SET wig.count = wig.count + 1
      )
    )

    // Actor↔Actor co-star relationship [NEW] — undirected, pairwise.
    // Pairs JS mein precompute kiye hain (movieData.actorPairs) —
    // Cypher FOREACH ke andar filtered-nested-loop likhna complex/
    // unsupported hai, isliye simpler + faster JS-side approach liya.
    FOREACH (pair IN movieData.actorPairs |
      MERGE (cp1:Actor {name: pair[0]})
      MERGE (cp2:Actor {name: pair[1]})
      MERGE (cp1)-[:CO_STARRED_WITH]-(cp2)
    )
  `;

  const cleanedMovies = movies.map((movie) => {
    const actors = Array.isArray(movie.actors) ? movie.actors : [];
    const directors = Array.isArray(movie.directors)
      ? movie.directors
      : movie.director
      ? [movie.director]
      : [];
    const awardNames =
      Array.isArray(movie.awards) && movie.awards.length > 0
        ? movie.awards
        : movie.oscarWon
        ? ["Academy Award"] // fallback — LLM ko specific award naam nahi mila
        : [];

    // Actor pairs precompute karo (i < j taaki koi pair/self-pair
    // duplicate na bane — CO_STARRED_WITH undirected relationship hai)
    const actorPairs = [];
    for (let i = 0; i < actors.length; i++) {
      for (let j = i + 1; j < actors.length; j++) {
        actorPairs.push([actors[i], actors[j]]);
      }
    }

    return {
      id: movie.id || `movie-${Date.now()}`,
      title: movie.title || "Unknown",
      year: movie.year || null,
      plot: movie.plot || "",
      rating: movie.rating || null,
      oscarWon: movie.oscarWon || false,
      oscarNominations: movie.oscarNominations || 0,
      language: movie.language || null,
      country: movie.country || null,
      directors,
      actors,
      genres: Array.isArray(movie.genres) ? movie.genres : [],
      awardNames,
      actorPairs,
    };
  });

  // Deadlock-aware retry — parallel batches lock-contention
  // (jaise "Christopher Nolan" node do batches se ek saath touch ho)
  // ki wajah se fail ho sakte hain; ye wrapper deadlock errors pe
  // hi retry karta hai (exponential backoff), baaki errors pe fail-fast.
  await runQueryWithRetry(cypher, { movies: cleanedMovies });
}

// ── Stats check karo ─────────────────────────────────────────
export async function getNeo4jStats() {
  const results = await runQueryWithRetry(`
    MATCH (m:Movie) WITH count(m) AS movies
    MATCH (a:Actor) WITH movies, count(a) AS actors
    MATCH (d:Director) WITH movies, actors, count(d) AS directors
    MATCH (g:Genre) WITH movies, actors, directors, count(g) AS genres
    RETURN movies, actors, directors, genres
  `);

  return results[0] || {};
}