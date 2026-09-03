// ============================================================
// src/config/constants.js
// Saari configuration values ek jagah.
// ============================================================

export const MODELS = {
  // ── PRIMARY: Groq (openai/gpt-oss-120b) ──────────────────────
  // DECISION (Sept 2026): Groq ko primary provider banaya — research
  // confirm karta hai ki Groq ka free tier OpenRouter se KAAFI better
  // hai: 30 RPM aur 14,400 requests/DAY (vs OpenRouter ka 20RPM/
  // sirf 50-per-day bina credit) — 288x zyada daily volume. Groq
  // apna dedicated LPU hardware use karta hai (300-800 tok/sec),
  // OpenRouter ki tarah multiple-backend-provider routing pe depend
  // nahi karta.
  //
  // NOTE: Groq ne `llama-3.3-70b-versatile` ko June 17, 2026 ko
  // deprecate kar diya (Groq ke official deprecation docs se confirm
  // kiya) — 404 "does not exist" error isi wajah se aaya live-testing
  // mein. Groq ka khud ka recommendation `openai/gpt-oss-120b` (ya
  // `qwen/qwen3.6-27b`) pe migrate karna tha — humne gpt-oss-120b
  // choose kiya (bada/zyada-capable model, structured JSON extraction
  // ke liye better). IMPORTANT: ye Groq ka apna dedicated-infra
  // gpt-oss-120b hai — OpenRouter waali gpt-oss-120b se ALAG hai
  // (jo humein pehle volatility deta tha, shared multi-provider
  // routing ki wajah se). Groq pe generous limits hain (250K TPM,
  // 1000 RPM developer-tier per Groq docs) — free-tier pe kam
  // honge but still OpenRouter se kaafi zyada.
  GROQ_LLM: "openai/gpt-oss-120b",
  GROQ_RPM: 28, // 30 RPM cap, thoda safety-buffer (28) rakha
  // NOTE: Groq ki TPM (tokens/min) cap bhi hai (~6000 TPM 70B models
  // pe) — abhi sirf RPM-based throttling hai, TPM tracking nahi hai.
  // Agar bade/parallel chunks se TPM cap hit ho, Groq 429 dega —
  // provider-chain automatically OpenRouter pe fallback kar dega
  // (neeche), isliye request fail nahi hogi, bas thoda slow ho sakti
  // hai us burst mein. README mein documented hai.

  // ── FALLBACK 1: OpenRouter free ──────────────────────────────
  // Groq fail/rate-limited ho toh yahan fallback hota hai.
  LLM: "meta-llama/llama-3.3-70b-instruct:free",

  // ── FALLBACK 2: OpenRouter paid (same model) ─────────────────
  // Dono free-tier options (Groq + OpenRouter free) fail ho jaayein
  // tabhi ye use hota hai. Cheap ($0.10/1M input, $0.32/1M output).
  LLM_FALLBACK: "meta-llama/llama-3.3-70b-instruct",

  // Embedding model via OpenRouter — koi change nahi, jo pehle se
  // kaam kar raha tha wahi retain kiya (koi free-tier embedding
  // OpenRouter/Groq pe available nahi hai, isliye ye paid rahega,
  // lekin cost negligible hai — ~$0.01/1M tokens).
  EMBEDDING: "qwen/qwen3-embedding-8b",

  // Must match Pinecone index dimension
  EMBEDDING_DIMENSIONS: 4096,
};

export const BATCH_SIZES = {
  EMBEDDING: 50,
  PINECONE_UPSERT: 100,
  NEO4J_INSERT: 100,
};

// ── PDF parsing chunk size ────────────────────────────────────
// DECISION (Sept 2026, live-testing finding): pehle 8000 chars/chunk
// tha — ek chunk mein ~30 movies aa jaate the (175K chars / 23
// chunks). LLM se har movie ke liye poora structured JSON +
// sourceExcerpt (raw verbatim text) generate karwana matlab ek
// hi completion mein bahut zyada output tokens (max 4096 tak) —
// 70B-class model (chahe free ho ya paid) ke liye ye genuinely
// slow hai, especially shared/free-tier routing pe. Ye "hang" nahi
// tha — genuinely itna time lagta hai itna bada output banane mein,
// aur 45s timeout usse pehle hi cut kar deta tha.
// Chunk size ghata ke kam movies/chunk kiya — kam output chahiye,
// faster response, safely timeout ke andar.
export const PDF_CHUNK_CHARS = 4000;

export const PINECONE = {
  INDEX_NAME: "movies-index",
  TOP_K: 10,
  CLOUD: "aws",
  REGION: "us-east-1",
};

export const OPENROUTER = {
  BASE_URL: "https://openrouter.ai/api/v1",
  MAX_TOKENS: 1024,
};

export const GROQ = {
  BASE_URL: "https://api.groq.com/openai/v1",
};

export const CONFIDENCE = {
  VECTOR_HIGH: 0.85,
  VECTOR_MEDIUM: 0.70,
  HOP_SCORE_BASE: 1.0,
  HOP_SCORE_DECAY: 0.2,
};

// ── OpenRouter free-tier rate limiting ───────────────────────
// openai/gpt-oss-120b:free ka OpenRouter free-tier cap (verified):
//   20 requests/minute (hard limit, sabhi free models pe common)
//   50 requests/day (agar account mein kabhi $10 credit nahi daala)
//   1000 requests/day (agar kabhi $10+ credit purchase kiya ho — lifetime)
// Embedding model (qwen3-embedding-8b) paid hai, isliye ye limits
// uspar apply NAHI hoti — sirf ":free" suffix wale models pe lagti hain.
export const RATE_LIMIT = {
  FREE_MODEL_RPM: 20,          // requests per minute — hard cap
  FREE_MODEL_RPM_SAFETY: 18,   // thoda buffer rakha (18/20) taaki edge-case
                                 // timing drift se 429 na aaye
  FREE_MODEL_DAILY_NO_CREDIT: 50,
  FREE_MODEL_DAILY_WITH_CREDIT: 1000,
};

// ── Retry config — batch failures, deadlocks, transient errors ──
export const RETRY = {
  MAX_ATTEMPTS: 3,          // embedding/pinecone batch retry cap
  BASE_DELAY_MS: 1000,      // 1s, phir 2s, phir 4s (exponential backoff)
  NEO4J_DEADLOCK_MAX_ATTEMPTS: 4,
  NEO4J_DEADLOCK_BASE_DELAY_MS: 500,
};

// ── Neo4j parallel batch insertion ───────────────────────────
// Kam concurrency isliye rakhi hai kyunki movies dataset mein
// high-collision entities hain (same director/actor baar baar
// alag movies mein aata hai) — zyada parallel batches = zyada
// lock-contention/deadlock chance. 3-4 ek accha balance hai.
export const NEO4J_CONCURRENCY = {
  MAX_PARALLEL_BATCHES: 3,
};