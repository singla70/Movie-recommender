// ============================================================
// src/ingestion/pdfParser.js
// ============================================================

import fs from "fs";
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import { chatCompletion } from "../utils/openrouterClient.js";
import { chunkArray, sleep } from "../utils/batchHelper.js";
import { MODELS, PDF_CHUNK_CHARS } from "../config/constants.js";

// Bug-fix: pehle yahan ek ALAG hardcoded constant tha
// (`const PARSE_MODEL = "openai/gpt-oss-120b:free"`), jo
// constants.js ke MODELS.LLM se completely independent tha —
// isliye jab hum MODELS.LLM ko naye model (llama-3.3-70b-instruct)
// pe switch kiya, PDF-parsing step ko wo update kabhi mila hi
// nahi (queryRouter.js/queryDecomposer.js already MODELS.LLM se
// derive karte the, sirf ye ek jagah miss ho gayi thi). Ab
// MODELS.LLM se hi derive hota hai — future mein model sirf
// constants.js mein change karne se HAR JAGAH apply hoga.
const PARSE_MODEL = MODELS.LLM;

export async function extractTextFromPDF(pdfPath) {
  console.log(`📄 Reading PDF: ${pdfPath}`);
  if (!fs.existsSync(pdfPath)) throw new Error(`❌ PDF not found: ${pdfPath}`);
  const dataBuffer = fs.readFileSync(pdfPath);
  const pdfData = await pdfParse(dataBuffer);
  console.log(`✅ Extracted ${pdfData.text.length} characters from PDF`);
  return pdfData.text;
}

function splitTextIntoMovieChunks(text, charsPerChunk = PDF_CHUNK_CHARS) {
  const chunks = [];
  const overlap = 200;
  let i = 0;
  while (i < text.length) {
    chunks.push(text.slice(i, i + charsPerChunk));
    i += charsPerChunk - overlap;
  }
  return chunks;
}

async function parseChunkWithLLM(textChunk, chunkIndex) {
  // directors: array hai ab (co-directed movies bhi correctly capture
  //   hongi — pehle single string tha, co-directors miss ho jaate the).
  // sourceExcerpt: movie ka ORIGINAL raw text jaisa PDF mein likha tha
  //   (LLM-summarized "plot" nahi) — is field ka use SIRF vector-DB
  //   embedding ke liye hoga, Graph DB structured fields se banta hai.
  //   Reasoning: templated "Title: X. Director: Y..." string embed
  //   karne se boilerplate tokens semantic signal dilute karte hain;
  //   raw natural-language text embedding quality ke liye behtar hai.
  const prompt = `Extract ALL movies from the text below. Return ONLY a valid JSON array, no explanation, no markdown.

Each movie:
{"title":string,"year":number|null,"directors":string[],"actors":string[],"genres":string[],"plot":string,"rating":number|null,"oscarWon":boolean,"oscarNominations":number,"awards":string[],"language":string|null,"country":string|null,"sourceExcerpt":string}

Rules:
- "directors": array — movie ke saare directors (agar co-directed hai toh sab include karo). Single director bhi array mein: ["Name"].
- "sourceExcerpt": is movie ke baare mein original text jaisa neeche diya hai, WAISA KA WAISA (word-for-word, apne se mat likho/summarize mat karo) — MAX 40 words. Agar original text isse lamba hai, sirf pehle ~40 words verbatim copy karo. Ye plot se alag hai — plot chhota summary hai, sourceExcerpt raw original text hai.
- Missing fields: null/false/0/[]/"". Short plot (1 sentence max, tumhara summary).
- Response CHHOTA aur TO-THE-POINT rakho — extra explanation ya formatting mat do, seedha JSON array.

Text:
---
${textChunk}
---`;

  let response;
  try {
    response = await chatCompletion(
      PARSE_MODEL,
      [{ role: "user", content: prompt }],
      4096
    );
  } catch (err) {
    // Bug-fix: pehle ye call try/catch ke BAHAR thi — agar chatCompletion
    // throw karta (timeout, network error, ya dono models — free aur
    // fallback dono — fail ho jaate), toh ye exception Promise.all ke
    // through poori parsePDFToMovies() ko crash kar deta, aur ab tak
    // parse hue saare chunks LOSE ho jaate (checkpoint sirf poori
    // parsing complete hone ke baad save hoti hai). Ab sirf is ek
    // chunk ko skip karte hain, baaki chunks process hote rehte hain.
    console.error(`⚠️  Chunk ${chunkIndex} LLM call failed: ${err.message.substring(0, 100)}`);
    return [];
  }

  try {
    let cleaned = response
      .replace(/```json\n?/gi, "")
      .replace(/```\n?/g, "")
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
      .trim();

    if (!cleaned.endsWith("]")) {
      const last = cleaned.lastIndexOf("}");
      if (last !== -1) cleaned = cleaned.substring(0, last + 1) + "]";
    }

    const movies = JSON.parse(cleaned);
    return movies.map((m, idx) => {
      // Backward-safe: agar LLM kabhi purana "director" (string) field
      // de de, usse bhi directors array mein normalize kar lo.
      let directors = [];
      if (Array.isArray(m.directors)) directors = m.directors.filter(Boolean);
      else if (m.director) directors = [m.director];

      return {
        id: `movie-${chunkIndex * 100 + idx}`,
        title: m.title || null,
        year: parseInt(m.year) || null,
        directors,
        actors: Array.isArray(m.actors) ? m.actors.slice(0, 8) : [],
        genres: Array.isArray(m.genres) ? m.genres : [],
        plot: m.plot || "",
        rating: parseFloat(m.rating) || null,
        oscarWon: Boolean(m.oscarWon),
        oscarNominations: parseInt(m.oscarNominations) || 0,
        awards: Array.isArray(m.awards) ? m.awards.filter(Boolean) : [],
        language: m.language || null,
        country: m.country || null,
        // Fallback: agar LLM sourceExcerpt na de (ya khaali de), plot
        // use karo taaki embedding text kabhi khaali na rahe.
        sourceExcerpt: (m.sourceExcerpt && m.sourceExcerpt.trim()) || m.plot || "",
      };
    });
  } catch (err) {
    console.error(`⚠️  Chunk ${chunkIndex} parse error: ${err.message.substring(0, 60)}`);
    return [];
  }
}

async function parseChunksParallel(chunks, concurrency = 3) {
  const allMovies = [];
  for (let i = 0; i < chunks.length; i += concurrency) {
    const batch = chunks.slice(i, i + concurrency);
    const nums = batch.map((_, j) => i + j + 1).join(", ");
    console.log(`  🔍 Parsing chunks ${nums}/${chunks.length} (parallel)...`);
    const results = await Promise.all(
      batch.map(async (chunk, j) => {
        const chunkNum = i + j + 1;
        const startedAt = Date.now();
        const movies = await parseChunkWithLLM(chunk, i + j);
        // Per-chunk completion log — pehle sirf poore group (3 chunks)
        // ke complete hone ke baad hi kuch dikhta tha (Promise.all ke
        // andar kya ho raha hai, kaunsa chunk atka hai — pata hi nahi
        // chalta tha). Ab har chunk ka apna completion-log hai.
        const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
        console.log(`    ✓ Chunk ${chunkNum}/${chunks.length} done in ${elapsed}s (${movies.length} movies)`);
        return movies;
      })
    );
    results.forEach(movies => allMovies.push(...movies));
    if (i + concurrency < chunks.length) await sleep(1000);
  }
  return allMovies;
}

export async function parsePDFToMovies(pdfPath) {
  const rawText = await extractTextFromPDF(pdfPath);
  const chunks = splitTextIntoMovieChunks(rawText, PDF_CHUNK_CHARS);
  console.log(`📦 Split into ${chunks.length} chunks (3 parallel)`);

  const allMovies = await parseChunksParallel(chunks, 3);

  const seen = new Set();
  const unique = allMovies.filter(movie => {
    if (!movie.title) return false;
    const key = `${movie.title.toLowerCase().trim()}-${movie.year}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`✅ Parsed ${unique.length} unique movies`);
  return unique;
}

// ── Vector-DB embedding text ──────────────────────────────────
// DECISION (locked): raw PDF excerpt use karte hain, templated
// "Title: X. Director: Y..." key-value string NAHI banate.
//
// Kyun: templated/key-value text mein boilerplate tokens
// ("Title:", "Director:") vector space mein noise add karte hain
// aur asli semantic content (movie ke baare mein natural-language
// description) dilute ho jata hai. Pure semantic queries jaisi
// "movies about friendship" ke liye raw prose text embedding
// quality ke liye kaafi behtar hota hai.
//
// Title har movie ke saath prefix kiya hai (chhota, zaroori
// disambiguation ke liye — warna do movies same excerpt jaisa
// dikh sakti hain agar title kahin excerpt mein na ho), baaki sab
// structured metadata (director/genre/rating/oscar) embedding text
// se HATA diya — woh sab already Pinecone metadata mein filter ke
// liye available hai (pineconeLoader.js), embedding text mein
// dobara daalne ki zaroorat nahi.
export function movieToEmbeddableText(movie) {
  const title = movie.title || "";
  const excerpt = movie.sourceExcerpt || movie.plot || "";
  return excerpt ? `${title}. ${excerpt}` : title;
}