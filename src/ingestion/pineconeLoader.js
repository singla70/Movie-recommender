// ============================================================
// src/ingestion/pineconeLoader.js
// Movie vectors ko Pinecone mein batch upsert karo
// ============================================================

import { getPineconeIndex } from "../utils/pineconeClient.js";
import { PINECONE, BATCH_SIZES, MODELS, RETRY } from "../config/constants.js";
import { chunkArray, sleep } from "../utils/batchHelper.js";

// ── Ek batch upsert karo, transient failures pe retry ─────────
// Same retry-at-failure-time + exponential-backoff pattern jo
// embedder.js mein use kiya hai — consistency ke liye (README mein
// dono jagah reasoning ek hi hai: transient errors turant retry se
// resolve ho jaate hain, alag "failed batch" bookkeeping layer
// nahi chahiye is scale pe).
async function upsertBatchWithRetry(index, vectors, batchNum, totalBatches) {
  let lastErr = null;
  for (let attempt = 1; attempt <= RETRY.MAX_ATTEMPTS; attempt++) {
    try {
      // CORRECTED (checked actual @pinecone-database/pinecone v7 SDK
      // TypeScript definitions directly — dist/data/index.d.ts):
      // `Index.upsert()` ka real signature hai
      //   upsert(options: { records: Array<{id, values, metadata}>, namespace?: string })
      // Matlab `{ records: vectors }` hi SAHI shape hai standard
      // (external-embedding) index ke liye — pehle is response ko
      // maine galti se Pinecone ke "integrated inference" wale
      // `upsertRecords()` (ALAG method — chunk_text-based, raw-text
      // auto-embed) se confuse kar diya tha aur bare array
      // (`index.upsert(vectors)`) mein badal diya tha — jo galat hai:
      // SDK options.records ko undefined paata hai aur "Must pass in
      // at least 1 record to upsert" throw karta hai. Ab wapas sahi
      // `{ records: vectors }` shape use ho raha hai.
      await index.upsert({ records: vectors });
      return true;
    } catch (err) {
      lastErr = err;
      if (attempt < RETRY.MAX_ATTEMPTS) {
        const delay = RETRY.BASE_DELAY_MS * 2 ** (attempt - 1);
        console.warn(
          `  ⚠️  Pinecone batch ${batchNum}/${totalBatches} upsert failed (attempt ${attempt}/${RETRY.MAX_ATTEMPTS}): ${err.message.substring(0, 80)} — retrying in ${delay}ms...`
        );
        await sleep(delay);
      }
    }
  }
  console.error(
    `  ❌ Pinecone batch ${batchNum}/${totalBatches} upsert failed after ${RETRY.MAX_ATTEMPTS} attempts: ${lastErr.message.substring(0, 100)}`
  );
  console.error(
    `     Affected movies: ${vectors.map((v) => `${v.metadata?.title || v.id} (${v.id})`).join(", ")}`
  );
  return false;
}

export async function loadMoviesToPinecone(movies, embeddings) {
  console.log(`\n📌 Loading ${movies.length} movies to Pinecone...`);

  // Movie ID → movie object lookup map
  const movieMap = new Map(movies.map((m) => [m.id, m]));

  // Validate inputs before mapping
  console.log(`  🔍 Movie IDs: ${[...movieMap.keys()].slice(0, 3).join(", ")}...`);
  console.log(`  🔍 Embedding IDs: ${embeddings.slice(0, 3).map(e => e.movieId).join(", ")}...`);
  console.log(`  🔍 First embedding length: ${embeddings[0]?.embedding?.length}`);

  // Build vectors array with full validation
  const vectors = [];
  for (const { movieId, embedding } of embeddings) {
    if (!movieId) {
      console.warn("  ⚠️  Skipping: missing movieId");
      continue;
    }
    const movie = movieMap.get(movieId);
    if (!movie) {
      console.warn(`  ⚠️  Skipping: no movie found for ID "${movieId}"`);
      continue;
    }
    if (!embedding || !Array.isArray(embedding) || embedding.length === 0) {
      console.warn(`  ⚠️  Skipping: invalid embedding for "${movieId}"`);
      continue;
    }

    // Bug-fix: pehle `movie.director` (singular) read hota tha, lekin
    // pdfParser.js ab `movie.directors` (array) deta hai — multi-director
    // support ke liye. Backward-safe fallback bhi rakha hai.
    const directorList = Array.isArray(movie.directors)
      ? movie.directors
      : movie.director
      ? [movie.director]
      : [];

    vectors.push({
      id: movieId,
      values: embedding,
      metadata: {
        title: movie.title || "",
        year: movie.year || 0,
        director: directorList.join(", "),
        actors: movie.actors?.slice(0, 5).join(", ") || "",
        genres: movie.genres?.join(", ") || "",
        oscarWon: movie.oscarWon || false,
        oscarNominations: movie.oscarNominations || 0,
        rating: movie.rating || 0,
        plot: movie.plot?.substring(0, 200) || "",
      },
    });
  }

  console.log(`  ✅ Built ${vectors.length} valid vectors`);

  if (vectors.length === 0) {
    throw new Error(
      `No valid vectors to upsert. Movies: ${movies.length}, Embeddings: ${embeddings.length}. Check embedding generation.`
    );
  }

  const index = await getPineconeIndex(PINECONE.INDEX_NAME, MODELS.EMBEDDING_DIMENSIONS);

  const batches = chunkArray(vectors, BATCH_SIZES.PINECONE_UPSERT);
  let totalUpserted = 0;
  let totalFailed = 0;

  for (let i = 0; i < batches.length; i++) {
    console.log(`  📤 Upserting batch ${i + 1}/${batches.length} (${batches[i].length} vectors)...`);
    const ok = await upsertBatchWithRetry(index, batches[i], i + 1, batches.length);
    if (ok) totalUpserted += batches[i].length;
    else totalFailed += batches[i].length;
    if (i < batches.length - 1) await sleep(200);
  }

  console.log(`✅ ${totalUpserted} vectors loaded to Pinecone`);
  if (totalFailed > 0) {
    console.warn(`⚠️  ${totalFailed} vectors permanently failed to upsert after ${RETRY.MAX_ATTEMPTS} attempts each.`);
  }
  return totalUpserted;
}

export async function searchSimilarMovies(queryEmbedding, topK = 10, filter = {}) {
  const index = await getPineconeIndex(PINECONE.INDEX_NAME, MODELS.EMBEDDING_DIMENSIONS);

  const queryOptions = {
    vector: queryEmbedding,
    topK,
    includeMetadata: true,
  };

  if (Object.keys(filter).length > 0) {
    queryOptions.filter = filter;
  }

  const results = await index.query(queryOptions);

  // Bug-fix: Pinecone metadata mein `director`/`actors`/`genres` sab
  // comma-joined STRINGS ke roop mein store hote hain (buildVectors()
  // mein — Pinecone metadata arrays achhe se support nahi karta,
  // isliye upsert ke time .join(", ") kiya jaata hai). Lekin
  // responseBuilder.js aur baaki poora codebase in fields ko
  // ARRAY maan ke .slice()/.join()/.some() use karta hai — jo
  // Graph-sourced results ke liye sahi hai (Neo4j se collect() se
  // asli array aata hai), lekin pure-vector-route results (jahan
  // koi graph-enrichment nahi hoti) ke liye string hi reh jaata tha
  // → ".join is not a function" jaisa crash.
  // Yahan wapas string → array normalize kar rahe hain, taaki
  // vector-only results bhi graph-sourced results jaisa hi consistent
  // shape dein.
  return results.matches.map((match) => {
    const meta = match.metadata || {};
    return {
      movieId: match.id,
      score: match.score,
      ...meta,
      directors: splitToArray(meta.director),
      actors: splitToArray(meta.actors),
      genres: splitToArray(meta.genres),
    };
  });
}

// ── "A, B, C" → ["A", "B", "C"] — khaali/missing ho toh [] ────
function splitToArray(value) {
  if (Array.isArray(value)) return value; // already array hai toh as-is
  if (typeof value !== "string" || value.trim() === "") return [];
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}