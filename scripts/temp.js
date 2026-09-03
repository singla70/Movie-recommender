// ============================================================
// scripts/resumePinecone.js
//
// Sirf Pinecone mein data daalo — Neo4j skip karo
// Use karo jab Pinecone insert fail ho jaaye mid-way
//
// Run: node scripts/resumePinecone.js scripts/movies.pdf
// ============================================================

import { parsePDFToMovies } from "../src/ingestion/pdfParser.js";
import { generateMovieEmbeddings } from "../src/ingestion/embedder.js";
import { loadMoviesToPinecone } from "../src/ingestion/pineconeLoader.js";
import dotenv from "dotenv";
dotenv.config();

async function main() {
  const pdfPath = process.argv[2];
  if (!pdfPath) {
    console.error("Usage: node scripts/resumePinecone.js <pdf-path>");
    process.exit(1);
  }

  console.log("📌 Resuming — Pinecone insert only...\n");

  console.log("Step 1: Parsing PDF...");
  const movies = await parsePDFToMovies(pdfPath);
  console.log(`✅ ${movies.length} movies parsed`);

  console.log("\nStep 2: Generating embeddings...");
  const embeddings = await generateMovieEmbeddings(movies);
  console.log(`✅ ${embeddings.length} embeddings generated`);

  console.log("\nStep 3: Loading to Pinecone...");
  const count = await loadMoviesToPinecone(movies, embeddings);
  console.log(`\n✅ Done! ${count} vectors in Pinecone`);
  console.log('🚀 Now run: node app.js');
}

main().catch(err => {
  console.error("❌ Failed:", err.message);
  process.exit(1);
});