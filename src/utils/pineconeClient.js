// ============================================================
// src/utils/pineconeClient.js
//
// Pinecone v7 SDK — correct syntax confirmed from GitHub releases
// v7: pc.index({ name: 'my-index' }) → recommended
//     pc.index('my-index') → deprecated but works
// Bug fix: _index cache hata diya — race condition fix
// ============================================================

import { Pinecone } from "@pinecone-database/pinecone";
import dotenv from "dotenv";
dotenv.config();

const PINECONE_API_KEY = process.env.PINECONE_API_KEY;

if (!PINECONE_API_KEY) {
  throw new Error("❌ PINECONE_API_KEY missing in .env file.");
}

let _client = null;
// Confirmed-existing index names — set once we've verified an index
// is there, never invalidated. Avoids an extra listIndexes() control-
// plane round-trip on EVERY query/embedding call forever after the
// first — the index is created once at ingestion time and never
// renamed/deleted while the app is running, so re-checking every
// single request was pure wasted latency (~100-300ms) with no benefit.
const _confirmedIndexes = new Set();

export function getPineconeClient() {
  if (!_client) {
    _client = new Pinecone({ apiKey: PINECONE_API_KEY });
  }
  return _client;
}

// ── Index lao — existence check sirf ek baar hoti hai per index name ──
export async function getPineconeIndex(indexName, dimension) {
  const client = getPineconeClient();

  if (!_confirmedIndexes.has(indexName)) {
    const existingIndexes = await client.listIndexes();
    const indexNames = existingIndexes.indexes?.map((i) => i.name) || [];

    if (!indexNames.includes(indexName)) {
      console.log(`📦 Creating new Pinecone index: "${indexName}"...`);
      await client.createIndex({
        name: indexName,
        dimension,
        metric: "cosine",
        spec: { serverless: { cloud: "aws", region: "us-east-1" } },
      });
      console.log("⏳ Waiting for index to be ready...");
      await waitForIndexReady(client, indexName);
    } else {
      console.log(`✅ Pinecone index "${indexName}" already exists.`);
    }
    _confirmedIndexes.add(indexName);
  }

  // v7 recommended: object syntax with name
  return client.index({ name: indexName });
}

async function waitForIndexReady(client, indexName, maxWaitMs = 60000) {
  const startTime = Date.now();
  while (Date.now() - startTime < maxWaitMs) {
    const desc = await client.describeIndex(indexName);
    if (desc.status?.ready === true) {
      console.log("✅ Pinecone index is ready!");
      return;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`❌ Index "${indexName}" not ready within ${maxWaitMs}ms`);
}