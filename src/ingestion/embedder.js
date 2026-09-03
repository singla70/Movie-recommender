// ============================================================
// src/ingestion/embedder.js
//
// Movies ke liye batch embeddings generate karo.
//
// Optimization: 1000 individual calls ki jagah batch calls
//   - 1000 movies, batch size 50 = sirf 20 API calls
//   - Time: ~10 seconds instead of ~500 seconds
//
// Model: qwen/qwen3-embedding-8b via OpenRouter
//   - 4096 dimensional vectors
//   - Strong semantic understanding
//   - $0.01 per 1M tokens
// ============================================================

import { createEmbeddings } from "../utils/openrouterClient.js";
import { MODELS, BATCH_SIZES, RETRY } from "../config/constants.js";
import { chunkArray, sleep } from "../utils/batchHelper.js";
import { movieToEmbeddableText } from "./pdfParser.js";

// ── Ek batch embed karo, transient failures pe retry ──────────
// DECISION (locked): retry-at-failure-time (immediate, exponential
// backoff), end-mein-saare-failed-retry-karo approach ki jagah.
// Reasoning: transient errors (network blip, momentary rate-limit)
// turant retry se resolve ho jaate hain — pipeline flow nahi
// tootta, aur alag se "failed batch IDs" track/resume karne ka
// extra bookkeeping bhi nahi chahiye is layer pe. Exponential
// backoff (1s → 2s → 4s) dono cases handle karta hai: transient
// blips aur short rate-limit windows.
async function embedBatchWithRetry(texts, batchNum, totalBatches) {
  let lastErr = null;
  for (let attempt = 1; attempt <= RETRY.MAX_ATTEMPTS; attempt++) {
    try {
      return await createEmbeddings(MODELS.EMBEDDING, texts);
    } catch (err) {
      lastErr = err;
      if (attempt < RETRY.MAX_ATTEMPTS) {
        const delay = RETRY.BASE_DELAY_MS * 2 ** (attempt - 1);
        console.warn(
          `  ⚠️  Batch ${batchNum}/${totalBatches} embedding failed (attempt ${attempt}/${RETRY.MAX_ATTEMPTS}): ${err.message.substring(0, 80)} — retrying in ${delay}ms...`
        );
        await sleep(delay);
      }
    }
  }
  console.error(
    `  ❌ Batch ${batchNum}/${totalBatches} embedding failed after ${RETRY.MAX_ATTEMPTS} attempts: ${lastErr.message.substring(0, 100)}`
  );
  return null; // signal to caller: is batch ko record as failed
}

// ── Movies ki batch embeddings generate karo ─────────────────
// movies: array of movie objects
// returns: array of {movieId, embedding} objects
export async function generateMovieEmbeddings(movies) {
  console.log(`\n🔢 Generating embeddings for ${movies.length} movies...`);
  console.log(
    `   Batch size: ${BATCH_SIZES.EMBEDDING} | Total batches: ${Math.ceil(movies.length / BATCH_SIZES.EMBEDDING)}`
  );

  // Step 1: Har movie ko embeddable text mein convert karo
  const movieTexts = movies.map((movie) => ({
    id: movie.id,
    text: movieToEmbeddableText(movie),
  }));

  // Step 2: Texts ko batches mein todo
  const batches = chunkArray(movieTexts, BATCH_SIZES.EMBEDDING);

  // Step 3: Har batch ke liye embeddings generate karo (with retry)
  const allEmbeddings = [];
  const failedBatches = []; // permanently-failed batches (MAX_ATTEMPTS ke baad bhi)

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    console.log(`  📡 Embedding batch ${i + 1}/${batches.length} (${batch.length} movies)...`);

    const texts = batch.map((item) => item.text);
    const embeddings = await embedBatchWithRetry(texts, i + 1, batches.length);

    if (embeddings === null) {
      // MAX_ATTEMPTS ke baad bhi fail — is batch ko record karo,
      // baaki batches ke saath aage badho (skip nahi rukte).
      failedBatches.push({ batchIndex: i, movieIds: batch.map((item) => item.id) });
    } else {
      batch.forEach((item, idx) => {
        allEmbeddings.push({ movieId: item.id, embedding: embeddings[idx] });
      });
    }

    // Rate limit se bachne ke liye thodi delay (embedding model paid hai,
    // isliye ye sirf politeness-delay hai, hard rate-limit nahi)
    if (i < batches.length - 1) {
      await sleep(500);
    }
  }

  console.log(`✅ Generated ${allEmbeddings.length}/${movies.length} embeddings`);
  if (failedBatches.length > 0) {
    const failedMovieCount = failedBatches.reduce((n, b) => n + b.movieIds.length, 0);
    console.warn(
      `⚠️  ${failedBatches.length} batch(es) permanently failed (${failedMovieCount} movies) after ${RETRY.MAX_ATTEMPTS} retry attempts each.`
    );
  }

  return { embeddings: allEmbeddings, failedBatches };
}

// ── Single query text ka embedding generate karo ─────────────
// Query time pe use hoga — single text embed karo
export async function generateQueryEmbedding(queryText) {
  const embeddings = await createEmbeddings(MODELS.EMBEDDING, [queryText]);
  return embeddings[0]; // Single text = single embedding
}