// ============================================================
// src/utils/batchHelper.js
//
// Array ko chhote chunks mein todne ki utility.
//
// Kyun zaruri hai?
//   - 1000 movies ke liye 1000 API calls = slow + expensive
//   - 10 batches of 100 = 10 API calls = fast + cheap
//
// Example:
//   chunkArray([1,2,3,4,5], 2) → [[1,2], [3,4], [5]]
// ============================================================

// ── Array ko fixed-size chunks mein todo ─────────────────────
// array: any[]
// chunkSize: number
// returns: any[][] (array of arrays)
export function chunkArray(array, chunkSize) {
  const chunks = [];

  for (let i = 0; i < array.length; i += chunkSize) {
    // slice end index array length se zyada ho toh JS
    // automatically array end tak hi lega — no error
    chunks.push(array.slice(i, i + chunkSize));
  }

  return chunks;
}

// ── Batches ko parallel ya sequential run karo ───────────────
// Ingestion mein sequential use karein (rate limit se bachne ke liye)
// Query time mein parallel use kar sakte ho (speed ke liye)

// Sequential — ek ke baad ek (rate limit friendly)
export async function processBatchesSequentially(batches, processFn) {
  const results = [];

  for (let i = 0; i < batches.length; i++) {
    console.log(`  Processing batch ${i + 1}/${batches.length}...`);
    const result = await processFn(batches[i], i);
    results.push(...result);
  }

  return results;
}

// Parallel — sab ek saath (speed ke liye, lekin rate limit ka risk)
export async function processBatchesParallel(batches, processFn) {
  const promises = batches.map((batch, i) => processFn(batch, i));
  const results = await Promise.all(promises);
  // Flatten nested arrays
  return results.flat();
}

// ── Delay utility — rate limit se bachne ke liye ─────────────
// ms: milliseconds to wait
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Limited-concurrency parallel runner ──────────────────────
// Poora Promise.all() (sab ek saath) risky hota hai jab items
// mein resource-contention ho sakta ho (jaise Neo4j writes jahan
// high-collision entities — same director/actor — deadlock cause
// kar sakte hain agar bahut zyada parallel chale). Ye helper
// ek time pe max `limit` items hi process karta hai — baaki queue
// mein wait karte hain, jaise hi ek slot free hota hai agla start
// hota hai.
//
// items: any[]
// limit: max concurrent workers
// worker: async (item, index) => result
// returns: results[] (same order as items)
export async function runWithConcurrencyLimit(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runNext() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex++;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => runNext());
  await Promise.all(workers);
  return results;
}