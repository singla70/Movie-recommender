// ============================================================
// scripts/wipePinecone.js
//
// Purpose: jab Neo4j fresh/khaali ho (naya instance) lekin Pinecone
// mein PURANA (stale, old-schema) data ho — is case mein migrate.js
// use karna SAFE nahi hai, kyunki idReconciler.js sirf Neo4j ke
// against match karta hai. Neo4j khaali hone ki wajah se har movie
// "naya" treat hogi, fresh positional IDs generate hongi jo purane
// Pinecone vector-IDs se match nahi karengi — result: Pinecone mein
// DUPLICATE vectors (purane + naye, dono alag IDs ke saath).
//
// Fix: Pinecone ka stale data pehle wipe karo, phir dono DBs khaali
// state se `node scripts/ingest.js <pdf>` se fresh consistent ban
// jayenge — koi duplicate/mismatch risk nahi.
//
// DESTRUCTIVE — isliye explicit --confirm flag zaroori hai, taaki
// galti se accidentally chal na jaye.
//
// Run: node scripts/wipePinecone.js --confirm
// ============================================================

import { getPineconeIndex } from "../src/utils/pineconeClient.js";
import { PINECONE, MODELS } from "../src/config/constants.js";

async function main() {
  const confirmed = process.argv.includes("--confirm");

  if (!confirmed) {
    console.log(`⚠️  Ye script Pinecone index "${PINECONE.INDEX_NAME}" ke SAARE vectors permanently delete kar dega.`);
    console.log(`   Confirm karne ke liye dobara chalao: node scripts/wipePinecone.js --confirm`);
    process.exit(0);
  }

  console.log(`🗑️  Wiping all vectors from Pinecone index "${PINECONE.INDEX_NAME}"...`);

  try {
    const index = await getPineconeIndex(PINECONE.INDEX_NAME, MODELS.EMBEDDING_DIMENSIONS);

    // deleteAll() — default namespace ke saare vectors delete karta hai.
    // Index khud delete nahi hota (structure/dimension config reh jaati
    // hai), sirf data — isliye fresh ingest.js dobara isi index mein
    // seedha upsert kar sakta hai, index-recreation ka wait nahi karna
    // padta.
    await index.deleteAll();

    console.log("✅ Pinecone index wiped clean.");
    console.log("\n🚀 Ab chalao: node scripts/ingest.js <path-to-pdf>");
  } catch (err) {
    console.error("❌ Wipe failed:", err.message);
    process.exit(1);
  }
}

main();