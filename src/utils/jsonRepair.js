// ============================================================
// src/utils/jsonRepair.js
//
// RESEARCH FINDING (documented, multiple independent sources —
// OpenClaw, Ollama, LM Studio, Groq community GitHub issues):
// `openai/gpt-oss-120b` (jo humara LLM hai) ki structured-output/
// JSON reliability KHARAAB hai — `response_format: json_schema`
// ignore kar deta hai, kabhi tool-call JSON `content` field mein
// leak ho jata hai instead of proper structure, kabhi malformed
// JSON (trailing garbage, unclosed brackets) return karta hai.
//
// Isliye humne jaanbujh kar (a) response_format/strict schema pe
// depend nahi kiya — sirf prompt mein JSON maanga hai aur text
// parse karte hain, aur (b) ye shared repair-layer banayi hai jo
// sabhi LLM-JSON-parsing jagah (queryRouter, queryDecomposer,
// pdfParser) use karti hai, taaki ek jagah fix karne se sab jagah
// benefit mile.
//
// DECISION (locked, is round mein): queryRouter + queryDecomposer
// ko EK LLM call mein merge NAHI kiya — bada/zyada-nested JSON
// schema is model ke liye zyada fail-prone hota, jitna document
// hua hai research mein. Iski jagah har call ka JSON chhota rakha
// hai aur ye repair-layer add ki hai — safer trade-off.
// ============================================================

// ── Markdown fences, control chars, trailing commas clean karo ──
function basicClean(text) {
  return text
    .replace(/```json\n?/gi, "")
    .replace(/```\n?/g, "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "") // control chars
    .replace(/,(\s*[\]}])/g, "$1") // trailing commas — "a,]" -> "a]"
    .trim();
}

// ── Sabse bada valid {...} ya [...] block extract karo ────────
// gpt-oss kabhi JSON se pehle/baad extra text/reasoning chhod deta
// hai ("Here's the JSON: {...}" jaisa) — isse sirf JSON part nikal
// aate hain.
function extractJsonBlock(text) {
  const firstBrace = text.search(/[[{]/);
  if (firstBrace === -1) return text;

  const openChar = text[firstBrace];
  const closeChar = openChar === "{" ? "}" : "]";

  let depth = 0;
  let inString = false;
  let escapeNext = false;

  for (let i = firstBrace; i < text.length; i++) {
    const ch = text[i];
    if (escapeNext) { escapeNext = false; continue; }
    if (ch === "\\") { escapeNext = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;

    if (ch === openChar) depth++;
    else if (ch === closeChar) {
      depth--;
      if (depth === 0) return text.substring(firstBrace, i + 1);
    }
  }
  // Unclosed — bracket balance khud se close karne ki koshish karo
  if (depth > 0) {
    return text.substring(firstBrace) + closeChar.repeat(depth);
  }
  return text.substring(firstBrace);
}

// ── Main entry point — LLM response se safely JSON nikaalo ────
// Returns parsed object/array, ya null agar sab attempts fail ho jayein
// (caller already null-safe fallback rakhta hai — router/decomposer
// dono mein).
export function safeParseLLMJson(rawText) {
  if (!rawText || typeof rawText !== "string") return null;

  const attempts = [
    (t) => JSON.parse(t),                          // 1. seedha parse
    (t) => JSON.parse(basicClean(t)),               // 2. cleanup ke baad
    (t) => JSON.parse(extractJsonBlock(basicClean(t))), // 3. JSON-block extract + bracket-balance repair
  ];

  for (const attempt of attempts) {
    try {
      return attempt(rawText);
    } catch {
      continue;
    }
  }

  console.warn("  ⚠️  JSON repair: sab attempts fail — raw response (first 150 chars):", rawText.substring(0, 150));
  return null;
}