// ============================================================
// src/utils/openrouterClient.js
//
// LLM chat completions ab ek 3-TIER PROVIDER CHAIN se jaate hain:
//   1. Groq (llama-3.3-70b-versatile)       — free, 30RPM, 14,400/day
//   2. OpenRouter free (llama-3.3-70b:free)  — free, 20RPM, 50/day (bina credit)
//   3. OpenRouter paid (llama-3.3-70b)       — paid, cheap, unlimited-ish
//
// DECISION (Sept 2026, research-driven): Groq ka free tier
// OpenRouter se kaafi zyada generous hai (288x zyada daily requests
// — 14,400 vs 50), aur Groq apna dedicated LPU hardware use karta
// hai (OpenRouter ki tarah multiple shared-backend routing pe
// depend nahi karta) — isliye "unavailable for free" wali volatility
// kam hone ki sambhavna hai jo humein OpenRouter pe baar-baar mili.
// Groq ko primary banaya, OpenRouter dono tier (free+paid) safety-
// net ke roop mein rakhe — agar Groq kabhi apni TPM/RPM cap hit
// kare ya down ho, seamlessly OpenRouter pe gir jaata hai, poori
// request fail nahi hoti.
//
// GROQ_API_KEY optional hai — agar .env mein nahi hai, Groq tier
// silently skip ho jaata hai, seedha OpenRouter se shuru hota hai
// (backward-compatible — purana .env bhi kaam karega).
//
// Interface (chatCompletion signature) bilkul same rakha hai —
// consumer files (queryRouter, queryDecomposer, responseBuilder,
// pdfParser) mein koi change nahi karna pada.
//
//   Embeddings LangChain se route nahi kiye — OpenRouter ka
//   /embeddings endpoint seedha fetch se already simple/reliable
//   hai. Koi change nahi — same embedding model/provider jo pehle
//   kaam kar raha tha.
// ============================================================

import dotenv from "dotenv";
import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { waitForRateLimit } from "./rateLimiter.js";
import { MODELS, OPENROUTER, GROQ, RATE_LIMIT } from "../config/constants.js";
dotenv.config();

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY; // optional

if (!OPENROUTER_API_KEY) {
  throw new Error("❌ OPENROUTER_API_KEY missing in .env file.");
}

const headers = {
  Authorization: `Bearer ${OPENROUTER_API_KEY}`,
  "Content-Type": "application/json",
  "HTTP-Referer": "https://movie-graph-rag.local",
  "X-Title": "Movie Graph RAG",
};

// ── Fetch with timeout (embeddings ke liye — LangChain se nahi jaate) ──
async function fetchWithTimeout(url, options, timeoutMs = 60000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return response;
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`Request timed out after ${timeoutMs / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ── Provider chain — order matters (Groq pehle try hota hai) ──
function buildProviderChain() {
  const chain = [];
  if (GROQ_API_KEY) {
    chain.push({
      name: "groq",
      apiKey: GROQ_API_KEY,
      baseURL: GROQ.BASE_URL,
      model: MODELS.GROQ_LLM,
      rateLimitKey: `groq:${MODELS.GROQ_LLM}`,
      rpm: MODELS.GROQ_RPM,
    });
  }
  chain.push({
    name: "openrouter-free",
    apiKey: OPENROUTER_API_KEY,
    baseURL: OPENROUTER.BASE_URL,
    model: MODELS.LLM,
    rateLimitKey: `openrouter:${MODELS.LLM}`,
    rpm: RATE_LIMIT.FREE_MODEL_RPM_SAFETY,
  });
  chain.push({
    name: "openrouter-paid",
    apiKey: OPENROUTER_API_KEY,
    baseURL: OPENROUTER.BASE_URL,
    model: MODELS.LLM_FALLBACK,
    rateLimitKey: null, // paid, no RPM throttle needed
    rpm: null,
  });
  return chain;
}
const PROVIDER_CHAIN = buildProviderChain();

// ── ChatOpenAI instances cache karo per provider+maxTokens ────
const _chatModelCache = new Map();

function getChatModel(provider, maxTokens) {
  const cacheKey = `${provider.name}::${provider.model}::${maxTokens}`;
  if (!_chatModelCache.has(cacheKey)) {
    _chatModelCache.set(
      cacheKey,
      new ChatOpenAI({
        model: provider.model,
        maxTokens,
        apiKey: provider.apiKey,
        configuration: {
          baseURL: provider.baseURL,
          defaultHeaders:
            provider.name === "groq"
              ? {}
              : { "HTTP-Referer": "https://movie-graph-rag.local", "X-Title": "Movie Graph RAG" },
        },
        timeout: 45000, // internal LangChain timeout — unreliable per live-testing,
        // asli enforcement neeche explicit AbortController se hota hai
      })
    );
  }
  return _chatModelCache.get(cacheKey);
}

function toLangChainMessages(messages) {
  return messages.map((m) =>
    m.role === "system" ? new SystemMessage(m.content) : new HumanMessage(m.content)
  );
}

const REQUEST_TIMEOUT_MS = 75000; // heavy structured-JSON-generation (bade
// chunks, many movies) ke liye realistic time — live-testing se pata chala
// ki 45s bahut tight tha genuine generation ke liye.

// ── Ek provider try karo (single attempt, no chain-fallback yahan) ──
async function tryProvider(provider, messages, maxTokens) {
  await waitForRateLimit(provider.rateLimitKey, provider.rpm);

  const chatModel = getChatModel(provider, maxTokens);
  const lcMessages = toLangChainMessages(messages);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await chatModel.invoke(lcMessages, { signal: controller.signal });
    return typeof response.content === "string" ? response.content : String(response.content);
  } finally {
    clearTimeout(timeoutId);
  }
}

// ── LLM Chat Completion — poori provider-chain walk karta hai ─
// `model` param backward-compat ke liye rakha hai (purane call-sites
// isse pass karte hain) lekin ab ignore hota hai — chain khud
// decide karti hai kaunsa provider/model use karna hai, kis order
// mein. Koi bhi tier fail ho (timeout, rate-limit, unavailable,
// insufficient credits — koi bhi error) toh agli tier try hoti hai.
// Sab tiers fail ho jaayein tabhi error throw hota hai.
//
// onRetry(info): optional — jab bhi ek provider fail hoke agle pe
// fallback hota hai, turant call hota hai (before the next attempt
// starts, not after). Callers (queryRouter etc) isse UI tak stream
// kar sakte hain, taaki 75s+ ki chup wait ke bajaye "Groq slow hai,
// OpenRouter try kar rahe hain..." jaisa real status dikhe.
export async function chatCompletion(model, messages, maxTokens = 1024, onRetry) {
  let lastErr = null;

  for (let i = 0; i < PROVIDER_CHAIN.length; i++) {
    const provider = PROVIDER_CHAIN[i];
    try {
      return await tryProvider(provider, messages, maxTokens);
    } catch (err) {
      lastErr = err;
      const isTimeout = err.name === "AbortError" || /abort|timeout/i.test(err.message || "");
      const reason = isTimeout
        ? `timed out (${REQUEST_TIMEOUT_MS / 1000}s)`
        : `failed (${err.message.substring(0, 80)})`;

      if (i < PROVIDER_CHAIN.length - 1) {
        const next = PROVIDER_CHAIN[i + 1];
        console.warn(
          `  ⚠️  "${provider.name}" (${provider.model}) ${reason} — falling back to "${next.name}" (${next.model})...`
        );
        onRetry?.({ from: provider.name, to: next.name, reason });
      }
    }
  }

  throw new Error(`All LLM providers in chain failed. Last error: ${lastErr?.message}`);
}

// ── Embeddings — koi change nahi, jo pehle se kaam kar raha tha ──
export async function createEmbeddings(model, inputs) {
  if (!inputs || inputs.length === 0) {
    throw new Error("createEmbeddings: inputs array is empty");
  }

  const response = await fetchWithTimeout(
    `${OPENROUTER.BASE_URL}/embeddings`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ model, input: inputs }),
    },
    60000
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenRouter Embedding error ${response.status}: ${error}`);
  }

  const data = await response.json();

  if (!data.data || data.data.length === 0) {
    throw new Error(`OpenRouter returned empty embeddings.`);
  }

  const embeddingMap = new Map();
  for (const item of data.data) {
    embeddingMap.set(item.index, item.embedding);
  }

  return inputs.map((_, i) => {
    const embedding = embeddingMap.get(i);
    if (!embedding) throw new Error(`Missing embedding for index ${i}`);
    return embedding;
  });
}