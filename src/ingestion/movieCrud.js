// ============================================================
// src/ingestion/movieCrud.js
//
// Admin ke "add/edit/delete ek single movie" feature ke liye —
// bulk-PDF pipeline (ingestJob.js) se alag, kyunki yahan har baar
// EK movie hi involve hoti hai aur turant (synchronous-ish) result
// chahiye hota hai, background job-polling ki zaroorat nahi.
//
// CONSISTENCY GUARANTEE: har operation (add/update/delete) Neo4j
// AUR Pinecone dono ko ek saath touch karta hai — kabhi sirf ek
// jagah likh ke doosri chhod nahi deta. Agar beech mein koi step
// fail ho (embedding ya DB write), poori operation fail hoti hai
// aur caller ko pata chal jaata hai (koi silent partial-write nahi).
//
// EDIT — KNOWN LIMITATION (documented, jaan-boojh kar out-of-scope
// rakha hai): jab movie edit hoti hai, is movie ke SEEDHE relationships
// (DIRECTED_BY/ACTED_IN/HAS_GENRE/WON_AWARD/IN_LANGUAGE/FROM_COUNTRY)
// poori tarah replace hote hain (purane hat jaate hain, naye ban jaate
// hain) — matlab agar admin kisi actor ko cast se hata de, uska
// ACTED_IN edge bhi hat jaata hai. LEKIN aggregate cross-movie stats
// (Actor-Actor CO_STARRED_WITH, Actor-Genre WORKED_IN_GENRE.count) is
// movie ke purane data se already-incremented the — edit unhe wapas
// decrement nahi karta (sirf naya data ke liye future increments
// theek honge). Ye bulk-loader (neo4jLoader.js) mein bhi pehle se
// mojood limitation hai (dobara ingest karne se bhi double-count hota
// — isiliye resumable-cache pipeline already-processed movies ko
// SKIP karta hai, re-process nahi). Full correction ke liye poori
// graph rebuild chahiye hogi — is scope se bahar.
// ============================================================

import { randomUUID } from "crypto";
import { runQueryWithRetry } from "../utils/neo4jClient.js";
import { getPineconeIndex } from "../utils/pineconeClient.js";
import { PINECONE, MODELS } from "../config/constants.js";
import { loadMoviesToNeo4j } from "./neo4jLoader.js";
import { loadMoviesToPinecone } from "./pineconeLoader.js";
import { generateMovieEmbeddings } from "./embedder.js";

// Fields the admin form can set — same shape pdfParser.js already
// produces, so this movie is indistinguishable from a PDF-ingested
// one to every downstream consumer (search, display, etc).
const EDITABLE_FIELDS = [
  "title", "year", "directors", "actors", "genres", "plot",
  "rating", "oscarWon", "oscarNominations", "awards", "language",
  "country", "sourceExcerpt",
];

function normalizeMovieInput(input) {
  return {
    title: input.title?.trim() || "",
    year: input.year ? parseInt(input.year) : null,
    directors: Array.isArray(input.directors) ? input.directors.filter(Boolean) : [],
    actors: Array.isArray(input.actors) ? input.actors.filter(Boolean) : [],
    genres: Array.isArray(input.genres) ? input.genres.filter(Boolean) : [],
    plot: input.plot?.trim() || "",
    rating: input.rating ? parseFloat(input.rating) : null,
    oscarWon: Boolean(input.oscarWon),
    oscarNominations: input.oscarNominations ? parseInt(input.oscarNominations) : 0,
    awards: Array.isArray(input.awards) ? input.awards.filter(Boolean) : [],
    language: input.language?.trim() || null,
    country: input.country?.trim() || null,
    sourceExcerpt: input.sourceExcerpt?.trim() || "",
  };
}

// This movie's own direct relationships only — deliberately does NOT
// touch WORKED_IN_GENRE / CO_STARRED_WITH (those are aggregate edges
// between Actor/Genre/Actor nodes, not this movie's own edges — see
// file header).
async function clearOwnRelationships(movieId) {
  await runQueryWithRetry(
    `MATCH (m:Movie {id:$id})-[r:DIRECTED_BY|HAS_GENRE|WON_AWARD|IN_LANGUAGE|FROM_COUNTRY]->() DELETE r`,
    { id: movieId }
  );
  await runQueryWithRetry(`MATCH (:Actor)-[r:ACTED_IN]->(m:Movie {id:$id}) DELETE r`, { id: movieId });
}

// ── Add a brand-new movie, or update an existing one (pass existingId) ──
// log(line): optional — called with each step description, so a caller
// (the admin endpoint) can surface real progress instead of the request
// just going quiet for a few seconds while embedding/DB-writes happen.
export async function upsertMovie(input, existingId, log = () => {}) {
  const movie = normalizeMovieInput(input);
  if (!movie.title) throw new Error("Title is required.");

  const id = existingId || `movie-manual-${randomUUID().slice(0, 8)}`;
  const record = { ...movie, id };

  if (existingId) {
    log(`Clearing old relationships for "${movie.title}" before re-writing...`);
    await clearOwnRelationships(existingId);
  }

  log("Generating embedding...");
  const { embeddings } = await generateMovieEmbeddings([record]);
  if (embeddings.length === 0) {
    throw new Error("Embedding generation failed — the embedding provider may be unreachable. Nothing was written.");
  }

  log("Writing to Neo4j...");
  await loadMoviesToNeo4j([record]);

  log("Writing to Pinecone...");
  await loadMoviesToPinecone([record], embeddings);

  log(`Done — "${movie.title}" is ${existingId ? "updated" : "added"}.`);
  return record;
}

export async function deleteMovie(movieId, log = () => {}) {
  log("Removing from Neo4j...");
  const existing = await runQueryWithRetry(`MATCH (m:Movie {id:$id}) RETURN m.title AS title`, { id: movieId });
  if (existing.length === 0) throw new Error("Movie not found.");
  await runQueryWithRetry(`MATCH (m:Movie {id:$id}) DETACH DELETE m`, { id: movieId });

  log("Removing from Pinecone...");
  const index = await getPineconeIndex(PINECONE.INDEX_NAME, MODELS.EMBEDDING_DIMENSIONS);
  await index.deleteOne({ id: movieId });

  log(`Done — "${existing[0].title}" is deleted.`);
  return { title: existing[0].title };
}

export async function getMovieById(movieId) {
  // Scalars ko top-level RETURN keys ki tarah nikaalna zaroori hai —
  // raw node (`RETURN m`) return karte toh uske andar ke number fields
  // (year, rating, ...) Neo4j Integer object hi rehte (runQuery sirf
  // top-level record keys ko number mein convert karta hai, node
  // properties ke andar recurse nahi karta — neo4jClient.js dekho).
  const results = await runQueryWithRetry(
    `MATCH (m:Movie {id:$id})
     OPTIONAL MATCH (m)-[:DIRECTED_BY]->(d:Director)
     OPTIONAL MATCH (a:Actor)-[:ACTED_IN]->(m)
     OPTIONAL MATCH (m)-[:HAS_GENRE]->(g:Genre)
     OPTIONAL MATCH (m)-[:WON_AWARD]->(aw:Award)
     OPTIONAL MATCH (m)-[:IN_LANGUAGE]->(l:Language)
     OPTIONAL MATCH (m)-[:FROM_COUNTRY]->(c:Country)
     RETURN m.title AS title, m.year AS year, m.plot AS plot, m.rating AS rating,
            m.oscarWon AS oscarWon, m.oscarNominations AS oscarNominations,
            collect(DISTINCT d.name) AS directors,
            collect(DISTINCT a.name) AS actors,
            collect(DISTINCT g.name) AS genres,
            collect(DISTINCT aw.name) AS awards,
            head(collect(DISTINCT l.name)) AS language,
            head(collect(DISTINCT c.name)) AS country`,
    { id: movieId }
  );
  if (results.length === 0) return null;
  const row = results[0];
  return {
    id: movieId,
    title: row.title,
    year: row.year,
    plot: row.plot,
    rating: row.rating,
    oscarWon: row.oscarWon,
    oscarNominations: row.oscarNominations,
    directors: row.directors.filter(Boolean),
    actors: row.actors.filter(Boolean),
    genres: row.genres.filter(Boolean),
    awards: row.awards.filter(Boolean),
    language: row.language || null,
    country: row.country || null,
  };
}

// ── Browse/search movies — for the admin's "pick one to edit" list ──
export async function listMovies(search = "", limit = 30) {
  const cypher = search
    ? `MATCH (m:Movie) WHERE toLower(m.title) CONTAINS toLower($search)
       RETURN m.id AS id, m.title AS title, m.year AS year ORDER BY m.title LIMIT $limit`
    : `MATCH (m:Movie) RETURN m.id AS id, m.title AS title, m.year AS year ORDER BY m.title LIMIT $limit`;
  return runQueryWithRetry(cypher, { search, limit });
}