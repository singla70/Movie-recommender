# Movie Graph RAG — Hybrid AI Recommendation System

Neo4j (graph) + Pinecone (vector) + OpenRouter (LLM + embeddings) + LangChain hybrid RAG chatbot for movie recommendations.

This README documents **every decision made during the audit/optimization pass** on this project — what was already correct, what was broken, what was changed, and *why* (including options that were considered and rejected). The goal is that anyone (including future-you) can read this and understand the reasoning, not just the code.

---

## 1. Architecture overview

```
PDF (688 movies)
   │
   ▼
pdfParser.js  ──(OpenRouter LLM, openai/gpt-oss-120b:free)──▶  structured movie JSON
   │                                                              + raw sourceExcerpt per movie
   ▼
embedder.js  ──(OpenRouter embedding, qwen3-embedding-8b)──▶  4096-dim vectors (from raw excerpt)
   │
   ├──▶ pineconeLoader.js  ──▶  Pinecone (vector index)
   │                                    │  (parallel — Promise.all)
   └──▶ neo4jLoader.js     ──▶  Neo4j (graph DB, MERGE-based)
                                        │
Query time:
  queryRouter → queryDecomposer → (vectorSearch | graphSearch | both) → responseBuilder
```

---

## 2. Package / SDK audit

| Package | Was | Now | Notes |
|---|---|---|---|
| `neo4j-driver` | `^6.0.0` | unchanged | Already current major version. |
| `@pinecone-database/pinecone` | `^7.2.0` | unchanged | Already latest. |
| `pdf-parse` | `^1.1.1` (legacy API, deep-imports `pdf-parse/lib/pdf-parse.js`) | **unchanged — decision deferred** | v2.x exists with a breaking class-based API. We did **not** migrate: v1 still works, and rewriting the PDF-extraction call wasn't part of this pass's locked decisions. Flagged for a future pass if `pdf-parse` v1 is ever pulled from npm. |
| `dotenv` | `^16.4.5` | unchanged | v17 exists but is a non-breaking minor bump, not urgent. |
| `@langchain/core`, `@langchain/openai`, `langchain` | not present | **added** (`^1.5.10` / `^1.2.9`) | See §4. |

---

## 3. LangChain — why and how

**Decision: use it, but scoped.** We integrated LangChain's `ChatOpenAI` class (from `@langchain/openai`) to make all LLM chat-completion calls, replacing the raw `fetch()` call that was there before.

**Why only the chat side, not embeddings too:** OpenRouter's `/embeddings` endpoint via plain `fetch()` was already simple, reliable, and had no chaining/agent logic that would benefit from LangChain's abstractions. `ChatOpenAI` gives us a maintained, well-tested client (retries, message typing, streaming-ready) for the part of the codebase that actually has complexity (multi-step LLM calls in `queryRouter`, `queryDecomposer`, `responseBuilder`, `pdfParser`). Routing embeddings through `OpenAIEmbeddings` too would have added a second LangChain code path for no real benefit.

**How it was wired in:** `src/utils/openrouterClient.js`'s `chatCompletion(model, messages, maxTokens)` function keeps its **exact same signature and return type** (a string) — internally it now builds a `ChatOpenAI` instance pointed at OpenRouter's base URL (`baseURL: "https://openrouter.ai/api/v1"`, since OpenRouter is OpenAI-API-compatible) and calls `.invoke()`. Every consumer of `chatCompletion` (`queryRouter.js`, `queryDecomposer.js`, `responseBuilder.js`, `pdfParser.js`) needed **zero changes** — this was deliberate, to avoid a large-surface-area refactor.

`ChatOpenAI` instances are cached per `(model, maxTokens)` pair (`_chatModelCache`) to avoid rebuilding the client on every call.

**Not done in this pass (possible future work):** replacing `queryDecomposer.js`'s custom string-placeholder chaining (`PREV_TITLES`, `PREV_ACTORS`) with LangGraph's structured state graphs. That's a genuine improvement opportunity but is a bigger refactor than was in scope here.

---

## 4. Batch embedding retry logic

**Decision: retry-at-failure-time (immediate, exponential backoff), not retry-all-failed-batches-at-the-end.**

Two designs were considered:
- **End-of-run retry**: run all batches once, collect failures, retry them all after the full pass finishes.
- **At-failure retry** *(chosen)*: the moment a batch fails, retry it immediately with exponential backoff, up to `RETRY.MAX_ATTEMPTS` (3) times, before moving to the next batch.

**Why at-failure retry won:** most embedding failures are transient (a momentary network blip, a brief upstream hiccup) — retrying immediately resolves these without needing a second bookkeeping pass over "which batches failed." Exponential backoff (1s → 2s → 4s) also gives a failing request room to recover if the issue is a short rate-limit window. End-of-run retry would only be clearly better if failures were *correlated in time* (e.g., a sustained outage) — in that case immediate retry would also fail immediately, but our backoff (multiple seconds between attempts) already gives meaningful separation.

**What happens if a batch fails all 3 attempts:** it is **not silently dropped**. It's recorded in a `failedBatches` array (`{ batchIndex, movieIds }`) that:
1. Gets written into `ingestion-progress.json` at the `"embedded"` checkpoint stage, so the failure is visible and inspectable even if the process later crashes or is interrupted.
2. Gets summarized in the final console output at the end of `scripts/ingest.js` ("N embedding batch(es) failed permanently — M movies missing from Pinecone").

Same retry pattern (at-failure, exponential backoff, `RETRY.MAX_ATTEMPTS`) was applied to **Pinecone batch upserts** too (`pineconeLoader.js`), for consistency and because we found an actual bug there (see §8).

Config lives in `src/config/constants.js` under `RETRY`.

---

## 5. OpenRouter free-tier rate limits — research findings

Verified (as of Aug 2026): OpenRouter's free-tier cap for `:free`-suffixed models (like `openai/gpt-oss-120b:free`, which this project uses for all LLM/chat calls) is:
- **20 requests/minute** (hard cap, applies to all free models)
- **50 requests/day** if the account has never purchased credits
- **1000 requests/day** if the account has ever purchased ≥$10 of credit (lifetime, doesn't need to be spent)

**This does NOT apply to the embedding model** (`qwen/qwen3-embedding-8b`) — it's a paid model (~$0.01/1M tokens), so only the upstream provider's own limits apply, not OpenRouter's free-tier cap. This matters for §6 and §7 below.

**What we built:** `src/utils/rateLimiter.js` — a sliding-window token-bucket limiter that:
- Only activates for models whose name ends in `:free` (checked via `model.endsWith(":free")`) — paid models pass through with zero delay.
- Caps at **18 requests/minute** (not the full 20) — a deliberate safety buffer against timing drift, so we don't get 429'd right at the boundary.
- Is called automatically inside `chatCompletion()` in `openrouterClient.js`, so **every caller** (PDF parsing, query routing, decomposition, response building) is protected without needing to change those files.

**Why this matters in practice:** `pdfParser.js` already ran chunk-parsing with concurrency=3 using the free LLM — for a large PDF this could burst past 20RPM. And at query time, a single user question can trigger 2–3 LLM calls (route → decompose → build response). Without a limiter, a burst of user queries could hit 429s. With the limiter, calls now queue and wait instead of failing.

**Cost/quota note for the user:** with the free-tier daily cap (50/day without credit), a chatbot doing 2–3 LLM calls per query effectively supports only ~15–20 user queries/day. If real usage is expected, purchasing $10 of OpenRouter credit (raising the cap to 1000/day) is worth it — this is a business decision, not something the code can decide for you, so it's just flagged here.

---

## 6. Parallel batching within free-tier limits — verdict

**PDF-parsing side:** kept at concurrency=3 (unchanged) — now safe because the rate limiter (§5) throttles the underlying calls regardless of how many are fired concurrently.

**Embedding side:** sequential batches (unchanged design), because:
- The embedding model is paid, so free-tier RPM isn't the constraint — but we didn't have concrete evidence of what OpenRouter's *general* (non-free-tier) concurrent-request ceiling is for this specific model, and this project's dataset (688 movies, ~14 batches of 50) doesn't need parallel embedding to be fast — sequential batching already completes in a reasonable time. Not forcing unverified parallelism here, per the original ask ("this thing should not be forced, make sure no error occur").

**Neo4j insertion side:** *is* parallelized (limited concurrency=3) — see §9. This was the one place where parallelism had a clear, verifiable upside and a well-understood risk (deadlocks) that we could mitigate with retry logic.

---

## 7. Neo4j: CREATE vs MERGE

**Already correct — verified, not changed.** The entire ingestion codebase (`neo4jLoader.js`) uses `MERGE`, never `CREATE`, for every node type.

- `CREATE` always makes a new node, no matter what.
- `MERGE (label) {key: value}` first checks: does a node with this **label + key property** already exist?
  - **Yes** → reuse it (no duplicate).
  - **No** → create it.

Example: `MERGE (d:Director {name: "Christopher Nolan"})` — the first movie he directs creates the node; every subsequent movie he directs reuses the same node (adds a new `DIRECTED_BY` relationship to it, doesn't duplicate the node). If an *actor* were also named "Nolan", `MERGE (a:Actor {name: "Nolan"})` creates a **separate** node — because the label (`:Actor` vs `:Director`) is part of the match criteria, not just the name.

---

## 8. Neo4j: indexing (why it matters, what was missing)

**The principle (confirmed correct):** without an index on a MERGE key, Neo4j has to scan every node of that label to check for a match — O(n) per MERGE, which gets slow fast at scale. With an index, it's a lookup — O(log n).

**Bug found and fixed:** the Movie node is merged on `id` (`MERGE (m:Movie {id: movieData.id})`), but the old `createIndexes()` only indexed `title`, `year`, `oscarWon`, and `language` on Movie — **`id` was never indexed**. Every single Movie MERGE was doing a full label scan. Fixed by adding:

```cypher
CREATE CONSTRAINT movie_id_unique IF NOT EXISTS FOR (m:Movie) REQUIRE m.id IS UNIQUE
```

A `UNIQUE` constraint was used instead of a plain index — it creates a backing index (same lookup speedup) **and** additionally enforces uniqueness at the database level, as a second line of defense on top of the application-level MERGE logic.

Full MERGE-key → index/constraint table (all now correct):

| Node | MERGE key | Index/Constraint |
|---|---|---|
| Movie | `id` | `UNIQUE CONSTRAINT movie_id_unique` |
| Actor | `name` | `INDEX actor_name` |
| Director | `name` | `INDEX director_name` |
| Genre | `name` | `INDEX genre_name` |
| Award | `name` | `INDEX award_name` |
| Language | `name` | `INDEX lang_name` |
| Country | `name` | `INDEX country_name` |

---

## 9. Neo4j: relationships — completeness audit + fixes

### What was already correct
- `Movie -[:HAS_GENRE]-> Genre` — multiple genres per movie, handled via `FOREACH`.
- `Actor -[:ACTED_IN]-> Movie` — multiple actors per movie, handled via `FOREACH`.

### Bugs found and fixed
| Issue | Before | After |
|---|---|---|
| **Single director only** | `pdfParser.js` extracted `director: string` — co-directed movies lost all but one director. | LLM prompt now extracts `directors: string[]`. `neo4jLoader.js` creates one `Director` node + `DIRECTED_BY` relationship per director via `FOREACH`. |
| **Generic awards only** | Only ever created one `Award {name: "Academy Award"}` node, gated on `oscarWon` boolean — the actual `movie.awards` array from the PDF (real award names) was extracted but never used in the graph. | `neo4jLoader.js` now creates a real `Award` node per entry in `movie.awards`. The generic `"Academy Award"` node is now only a **fallback** — used only if `oscarWon` is true but the LLM didn't extract any specific award name. |
| **`IN_LANGUAGE` relationship missing** | 4 query tools (`searchByLanguage` etc.) queried `(Movie)-[:IN_LANGUAGE]->(Language)`, but ingestion never created it — silently returned empty results. | Now created: `MERGE (l:Language {name: ...}) MERGE (m)-[:IN_LANGUAGE]->(l)`. Also, `m.language` is now set as a **Movie property** too (query code in `enrichMoviesFromGraph` reads `m.language` directly as a property, separately from the relationship — both are now populated). |
| **`FROM_COUNTRY` relationship missing** | Same issue as above, for country. | Fixed the same way — relationship + `m.country` property both populated. |
| **`WORKED_IN_GENRE` (Actor→Genre aggregate) missing** | `searchActorsByGenre` queried `(Actor)-[:WORKED_IN_GENRE]->(Genre)` with a `.count` property, but this relationship was never created. | Now created for every (actor, genre) pair in every movie, with `ON CREATE SET count = 1` / `ON MATCH SET count = count + 1` — correctly accumulates "how many movies has this actor worked in this genre" across the whole dataset (not just per-batch). |
| **`CO_STARRED_WITH` (Actor↔Actor) missing** | `searchCoactors` queried this relationship; never created. | Created as an **undirected** relationship (`MERGE (a1)-[:CO_STARRED_WITH]-(a2)`) between every pair of actors in the same movie. Pairs are precomputed in JavaScript (`for i, for j=i+1`) rather than in Cypher — `FOREACH` in Cypher doesn't support a `WHERE`-filtered nested loop, so generating unique unordered pairs (`i < j`, no self-pairs, no duplicate reverse pairs) is much simpler done in JS before the query is sent. |

### Explicitly out of scope / needs clarification
- **"Theme"** — mentioned as a node type, but there's no `theme` field anywhere in the PDF extraction schema or the original design; it's unclear whether this means something distinct from `genres` or is meant to be folded into it. Not implemented — needs clarification before adding, to avoid guessing at a schema that doesn't match what's actually in the source data.
- **Query-side multi-director display** — `graphSearch.js` / `responseBuilder.js` currently return/display only one `director` field per movie in query *results* (via Cypher aliases like `d.name AS director`), even though the graph now correctly stores multiple `DIRECTED_BY` relationships when applicable. Fixing this would mean changing those Cypher queries to `collect(d.name)` and updating the result-shaping code downstream — this is query-side, not ingestion-side, and wasn't part of this pass's locked scope. Flagged for a future round.

---

## 10. Neo4j: parallel batch insertion

**Decision: moderate parallelism (max 3 concurrent batches) + deadlock-specific retry with exponential backoff — not full unlimited parallelism, and not a fully partitioned/collision-free scheme either.**

**How Neo4j writes actually behave:** every write transaction locks the nodes it touches. If two parallel transactions each need to write to the same node (e.g., both touch a "Christopher Nolan" `Director` node because two different batches both contain a Nolan movie), Neo4j can either make one wait, or — if the lock-acquisition order between two transactions crosses — detect a **deadlock** and roll one of them back with an error. Neo4j does **not** auto-retry a deadlocked transaction; that's the application's job.

**Why this dataset has real deadlock risk:** movie datasets have "hub" nodes — the same director/actor recurs across many movies. Running many batches fully in parallel raises the odds that two of them fight over the same hub node at the same time.

**Options considered:**
1. **Retry-on-deadlock only, moderate concurrency** *(chosen)* — catch the specific deadlock error, back off exponentially, retry (up to 4 attempts). Simple, and Neo4j's own recommendation for this class of problem.
2. **Partitioned/"mix and batch" parallelism** — pre-analyze all batches so that no two concurrently-running batches ever touch the same entity, guaranteeing zero deadlocks. Rejected for now: correct, but meaningfully more engineering complexity than this dataset's scale (688 movies) justifies.
3. **Neo4j-native `CALL {...} IN CONCURRENT TRANSACTIONS`** — a newer Cypher construct with built-in concurrency + retry. Not used here because we couldn't verify whether the specific Neo4j Aura Free tier configured in this project's `.env` supports it — worth revisiting if confirmed available.

**Implementation:**
- `src/utils/batchHelper.js` → `runWithConcurrencyLimit(items, limit, worker)` — a small worker-pool that runs at most `limit` items concurrently (not `Promise.all` on everything).
- `src/utils/neo4jClient.js` → `runQueryWithRetry(cypher, params, maxAttempts)` — inspects the error's Neo4j error code / message for deadlock signatures (`DeadlockDetected`, `LockClientStopped`) and retries only those, with exponential backoff (500ms → 1s → 2s → 4s). Non-deadlock errors fail immediately (retrying a genuine data/query error would just waste time and hide the real problem).
- `src/ingestion/neo4jLoader.js` now runs batches via `runWithConcurrencyLimit(batches, NEO4J_CONCURRENCY.MAX_PARALLEL_BATCHES, ...)`, `MAX_PARALLEL_BATCHES = 3` (`src/config/constants.js`).

---

## 11. Vector DB — what text gets embedded (and why raw excerpt, not structured JSON)

**Decision: embed the raw, original PDF text for each movie — not a templated key-value string built from the structured/extracted fields.**

**The problem with the old approach:** the old `movieToEmbeddableText()` built strings like `"Title: Inception. Director: Christopher Nolan. Actors: ... Genres: ... Plot: ..."`. This is *not* raw text and isn't pure JSON either — it's a templated, boilerplate-heavy string. Boilerplate tokens (`"Title:"`, `"Director:"`) add noise to the embedding vector and dilute the actual semantic signal (the natural-language description), hurting pure semantic queries like *"movies about friendship"*.

**The challenge:** the ingestion pipeline splits the PDF into arbitrary 8000-character chunks (for LLM context-size reasons) and asks the LLM to extract structured JSON from each chunk — the *original* per-movie text span was never preserved anywhere.

**Two options were considered:**
- **A) Have the LLM extraction step also return a `sourceExcerpt` field** — the original text for that movie, verbatim, alongside the structured fields *(chosen)*.
- **B) Embed only the `plot` field** — but `plot` is explicitly instructed to be a 1-sentence LLM-generated summary, not raw text either, so it doesn't actually solve the "raw text" requirement.

**Option A was implemented:**
- `pdfParser.js`'s extraction prompt now asks for `"sourceExcerpt": string` per movie, with an explicit instruction *not* to summarize it — copy the original text as-is.
- `movieToEmbeddableText()` now returns `"{title}. {sourceExcerpt}"` — just the title (for disambiguation) plus the raw excerpt. All the structured metadata (director, genres, rating, oscar status) was removed from the embedding text — it's still fully available for filtering via **Pinecone metadata** (`pineconeLoader.js` already attaches all of that as metadata on each vector), so nothing is lost, it's just no longer polluting the embedding itself.
- Fallback: if the LLM ever returns an empty `sourceExcerpt` (or omits it), we fall back to `plot`, so embedding text is never empty.

---

## 12. Embedding model — decision trail

Three options were discussed and researched during this session, in order:

1. **Pinecone's own "integrated inference"** (Pinecone auto-embeds raw text you send it, no external embedding call needed) — considered, then **rejected**. Reasoning: Pinecone's hosted embedding models (`llama-text-embed-v2` max 2048-dim, `multilingual-e5-large` 1024-dim) cap out lower than what we wanted for quality, and locking the Pinecone index to one specific hosted model removes flexibility. (It *would* have fit comfortably in Pinecone's free tier — 5M tokens/month vs. our ~100-200K token one-time ingestion need — so free-tier cost was never the blocker; model quality/dimension was.)
2. **OpenAI's `text-embedding-3-large`** — briefly proposed as "the best embedding model," researched (3072-dim, $0.13/1M tokens, strong MTEB scores) — then **explicitly reversed** by the user: the intent was "use whatever we were already using," not literally OpenAI's model.
3. **`qwen/qwen3-embedding-8b` via OpenRouter** *(final decision — unchanged from the original project)* — 4096 dimensions, ~$0.01/1M tokens, already validated and working in the original codebase. No model or dimension change was made. `MODELS.EMBEDDING_DIMENSIONS` stays `4096`, and the Pinecone index dimension stays `4096` to match.

**Net effect of this whole investigation:** the *embedding model* ended up unchanged from the original project. What *did* change, per §11, is *what text gets embedded* (raw excerpt vs. templated string) and *how it reaches Pinecone* (still an external embed-then-upsert call, not Pinecone's integrated inference).

---

## 13. Pinecone + Neo4j simultaneous upsert

**Already correct — verified, not changed.** `scripts/ingest.js` already runs both loads concurrently:

```js
const [pineconeCount, neo4jCount] = await Promise.all([
  loadMoviesToPinecone(movies, embeddings),
  loadMoviesToNeo4j(movies),
]);
```

Since Pinecone and Neo4j are two independent systems with no shared locks or dependencies between them, running them in parallel is safe and roughly halves total ingestion wall-clock time compared to sequential loading.

---

## 14. Bug found: Pinecone upsert was using the wrong API shape

**This was likely the actual cause of the ingestion pipeline getting stuck at the `"embedded"` stage in `ingestion-progress.json` (i.e., embeddings were generated, but the DB-load step silently never completed).**

The old code called:
```js
await index.upsert({ records: batches[i] });
```

`{ records: [...] }` is the request shape for Pinecone's **`upsertRecords`** method — which is specifically for **integrated-inference indexes** (where you send raw text and Pinecone embeds it server-side). This project's index is a **standard** index (external embeddings, fixed dimension set at creation) — for a standard index, the correct call is:

```js
await index.upsert(vectors); // vectors: [{ id, values, metadata }, ...]
```

Fixed in `pineconeLoader.js`, alongside the retry logic from §4.

---

## 15. Multi-director support — extraction schema change

Related to §9. `pdfParser.js`'s LLM extraction prompt changed from:
```json
{"director": string|null, ...}
```
to:
```json
{"directors": string[], ...}
```
with an explicit instruction to include *all* directors for co-directed movies. `neo4jLoader.js`, `pineconeLoader.js`, and the movie-cleaning logic all read `movie.directors` now, with a backward-compatible fallback to the old singular `movie.director` field in case it's ever encountered (e.g., from old cached/partial data).

---

## 16. Unified connection test

**Added:** `scripts/testAllConnections.js` (run via `npm run test:all`). Tests, in one run, with a clean pass/fail summary:
1. Neo4j (connectivity + a live query)
2. Pinecone (client init + list indexes)
3. OpenRouter LLM (a real chat completion, via the LangChain-backed `chatCompletion()`)
4. OpenRouter Embedding (a real embedding call, with a dimension-match sanity check against `MODELS.EMBEDDING_DIMENSIONS`)

The existing individual test files (`tests/testNeo4jConnection.js`, `tests/testPineconeConnection.js`, `tests/testEmbedding.js`, `tests/testOpenRouter.js`) were **kept as-is** — they're still useful for granular debugging of one service at a time. The new unified script is for a fast "is everything up?" check before running a full ingestion.

*(Note: this was validated for syntax/logic correctness, including a full trace through every new code path, but could not be validated against **live** Neo4j/Pinecone/OpenRouter credentials in the environment this was built in, due to network egress restrictions on that sandbox. Run `npm run test:all` yourself after downloading to confirm live connectivity.)*

---

## 17. Known follow-ups (not done in this pass — explicitly deferred, not forgotten)

- `pdf-parse` v1 → v2 migration decision (§2).
- Query-side multi-director display (§9).
- "Theme" node — needs clarification on what this means vs. `genres` (§9).
- `CALL {...} IN CONCURRENT TRANSACTIONS` — worth revisiting if confirmed supported on the Neo4j Aura tier in use (§10).
- LangGraph-based rewrite of `queryDecomposer.js`'s multi-step chaining logic (§3).

---

## 18. Setup

```bash
npm install
cp .env.example .env   # fill in your own credentials
npm run test:all       # verify all 4 connections before ingesting
node scripts/ingest.js ./scripts/movies.pdf
npm start               # or: node app.js
```

---

## 19. Query-phase improvements (this round)

Full research + risk-analysis was done before touching any code — see the reasoning trail below, since two of the "obvious" ideas discussed with the user were explicitly **rejected** after research.

### 19.1 Research finding that changed the plan
**`openai/gpt-oss-120b` (our LLM) has documented, cross-platform structured-output/JSON reliability problems** — confirmed via multiple independent GitHub issues (OpenClaw, Ollama, LM Studio, Groq community): it ignores `response_format: json_schema`, sometimes leaks tool-call JSON into the `content` field instead of a proper structured field, sometimes returns malformed JSON. This is an ongoing risk for **every** LLM call in this codebase that expects JSON back (`queryRouter`, `queryDecomposer`, `pdfParser`).

**Decision this drove:** an earlier idea — merging `queryRouter` and `queryDecomposer` into a single LLM call to cut call-count (and reduce free-tier rate-limit pressure) — was **rejected**. A bigger, more-nested JSON schema is exactly the kind of output this model is documented to fail on more often. Instead:
- Both calls stay separate (JSON schema per call stays small/simple).
- A new shared repair layer (`src/utils/jsonRepair.js`) was added and wired into every LLM-JSON-parsing site, as a defense against the documented unreliability instead of trying to avoid triggering it via fewer calls.

### 19.2 `jsonRepair.js` — shared JSON-repair layer
`safeParseLLMJson(rawText)` tries, in order: (1) parse as-is, (2) strip markdown fences/control chars/trailing commas then parse, (3) extract the largest balanced `{...}`/`[...]` block (handling the case where the model adds prose before/after the JSON, or leaves brackets unclosed — closes them by tracking bracket depth). Returns `null` if all three fail, which every caller already treats as "could not parse" and falls back gracefully (never throws uncaught).

Wired into: `queryRouter.js`, `queryDecomposer.js`. (`pdfParser.js` already had its own cleanup logic from an earlier round — left as-is, functionally equivalent.)

### 19.3 `queryDecomposer.js` — rewritten with LangGraph `StateGraph`
**Verified before writing any code**: installed `@langchain/langgraph@1.4.13`, confirmed its peer dependency (`@langchain/core: ^1.1.48`) is satisfied by our already-installed `@langchain/core@1.2.9`, and ran a live `StateGraph`/`Annotation`/`START`/`END` smoke test against the actual installed version before relying on it (docs snippets sometimes describe a different API version than what's installed — this was checked directly against the package, not assumed from search results).

**What changed:** the old version tracked chained step-results in two hardcoded plain-JS-object dictionaries (`stepTitles`, `stepActors`) and resolved `"PREV_TITLES"` / `"PREV_ACTORS"` string placeholders manually. This meant any query needing a third category (e.g., directors, genres) from a previous step would silently fail — there was no tracking for it. Now:
- State is a typed LangGraph `Annotation.Root` with `titles`, `actors`, `directors`, `genres` accumulator channels (each with a dedupe-concat reducer — a step's new data merges into, not overwrites, what came before).
- Placeholder resolution is generic — a `PLACEHOLDER_MAP` (`PREV_TITLES → titles`, `PREV_ACTORS → actors`, `PREV_DIRECTORS → directors`, `PREV_GENRES → genres`) — adding a new category is a one-line change, not a new tracking dict.
- Step execution is an explicit graph node (`executeStep`) with a conditional edge (`shouldContinue`) looping until all plan steps are done — replacing the old manual `for` loop.

**Note on scope:** this only changes the *execution engine's* robustness (state tracking, chaining). It does **not** change the *planning* LLM call itself (still one call, same prompt shape as before, now protected by `safeParseLLMJson`) — per the §19.1 decision not to touch call-merging.

**Tested before delivery:** since this sandbox has no live LLM/DB access, the full 3-step chain (`director+award → movie cast lookup → actor's other movies`, the exact scenario from the original prompt's own example) was simulated end-to-end with mocked tool responses, confirming `PREV_TITLES`/`PREV_ACTORS` correctly resolve through the typed state across all 3 steps. Live run against real data should still be verified via `npm run test:all` + a real complex query once deployed.

### 19.4 `graphSearch.js` — multi-director bug fix (partial, by design)
While auditing for the multi-director display gap flagged in §9/§17, found a **real correctness bug**: several Cypher queries did `OPTIONAL MATCH (m)-[:DIRECTED_BY]->(d:Director)` *before* the row-collapsing `WITH ... collect(...)` clause, without collecting `d` itself. For a movie with more than one director (now possible per §15), this causes Cypher to emit **one row per director** for that movie — silently duplicating movies in results, each row only showing one of the directors.

**Fixed in the 4 highest-traffic functions** (`searchByDirector`, `searchByActor`, `searchMovieDirectData`, `enrichMoviesFromGraph` — the last one is what every hybrid-mode query hits): changed the pattern to `collect(DISTINCT d.name) AS directors` in the same `WITH` clause as the other aggregations, and return a `directors` array instead of a singular `director` field.

**Why not all ~15 functions with this pattern:** rewriting all of them blind, in one pass, with no live Neo4j to verify against in this sandbox, was judged too risky — each function's `WITH` clause has slightly different existing aggregations, so a mechanical find-replace could introduce new row-duplication bugs elsewhere instead of just leaving the known display-limitation in place. The 4 fixed here cover the most-used query paths. The same mechanical pattern (move `d` into the row-collapsing `collect(DISTINCT d.name) AS directors`, before any other aggregation in that `WITH`) should be applied to the remaining functions (`searchOscarMovies`, `searchByGenre`, `searchByDirectorAndAward`, `searchByActorAndGenre`, `searchByLanguage`, `searchByCountry`, `searchByYearRange`, `searchTopRated`, `searchByRatingRange`, `searchFranchiseMovies`, `searchDirectorFilmography`) in a follow-up pass, with a live DB available to verify each one.

**Backward compatibility:** `formatResult()` (the shared result-formatter used by all graph functions) now accepts *either* a `directors` array (new pattern) or a `director` string (old pattern, still present in the ~11 not-yet-fixed functions) and always emits both `directors` (array) and `director` (first entry, string) on every result — so `responseBuilder.js` and `app.js`, which were also updated to prefer `directors` when present, don't break against results from either the fixed or not-yet-fixed functions.

### 19.5 `graphSearch.js` / `graphEnrichAndFilter` — refined hybrid re-ranking
This function already computed a combined score (`vectorScore * 0.7 + graphScore * 0.3`) — it was **not missing**, just cruder than it could be: `graphScore` was a flat `0.5` for any movie found in the graph at all, regardless of *how well* it matched the query's actual filters (director/actor/genre/award/language).

Changed `graphScore` to a **match-ratio**: count how many of the entity filters present in the query (e.g., director + genre = 2 criteria) actually matched this specific movie, divide by total criteria requested. A movie matching all requested criteria now clearly outranks one matching only one, instead of both getting the same flat graph-boost.

### 19.6 `app.js` — removed a wasteful re-fetch in the hybrid fallback path
When hybrid enrichment (`graphEnrichAndFilter`) returned zero results, the old fallback called `vectorSearch()` again — re-querying Pinecone with the same embedding, discarding the 50 candidates already fetched moments earlier by `getVectorCandidates()`. Now the already-fetched `candidates` are reused directly in the fallback; only the graph side gets an independent re-query.

### 19.7 `graphSearch.js` / `entitiesToTools` — removed a redundant tool call
When both an actor and a genre were present in a query's entities, two tools fired in parallel (`search_by_actor_and_genre` and `search_actor_in_multiple_genres`) with overlapping results that were merged/deduped downstream anyway — one extra Neo4j round-trip for no net-new information. Removed the redundant call; `search_by_actor_and_genre` alone already covers "this actor AND this genre."

### 19.8 Known follow-up (added to §17-style list)
- Apply the §19.4 multi-director Cypher fix to the remaining ~11 graph-search functions, with a live Neo4j instance to verify each one individually.

### 19.9 OpenRouter free-model unavailability — automatic fallback (found via live testing)
**Live `npm run test:all` run surfaced a real error**: `openai/gpt-oss-120b:free` returned `404 This model is unavailable for free. The paid version is available now - use this slug instead: openai/gpt-oss-120b`.

**Research confirmed this is a known, recurring OpenRouter pattern**, not a one-off bug: free-tier models on OpenRouter documentedly transition free→paid or go temporarily unavailable without warning when the upstream provider's free capacity is saturated — a real-world dev blog post logging their own production pipeline specifically caught this *exact* model (`openai/gpt-oss-120b:free`) 404ing the same way. Hardcoding a single `:free` model slug is inherently fragile against this.

**Fix — automatic fallback, no manual intervention needed:** `constants.js` had `MODELS.LLM_FALLBACK` (same model, paid slug) added. `openrouterClient.js`'s `chatCompletion()` catches this specific class of error (`isModelUnavailableError()` — matches "unavailable for free", "no longer available as a free model", "no allowed providers", "no endpoints found") and automatically retries once with the paid fallback slug.

### 19.10 Ingestion hang — 90s+ with 0% CPU, no error, no progress (found via live testing)
**Live ingestion run got stuck** for 5+ minutes with 0% CPU usage — no error, no log output, nothing. Two real, distinct bugs were found and fixed:

1. **LangChain `ChatOpenAI`'s own `timeout` config doesn't reliably fire.** We had set `timeout: 90000` when constructing the `ChatOpenAI` instance, expecting it to abort a stalled request after 90s — in live testing this did not happen; the process sat at 0% CPU indefinitely (a genuine network/connection stall that the internal timeout didn't catch). **Fix:** added an explicit `AbortController` + `setTimeout` wrapped around every `chatModel.invoke()` call in `chatCompletion()` — the same pattern the original pre-LangChain `fetch()`-based client used, which was reliable. This is now the actual enforcement mechanism; the constructor's `timeout` option is kept only for consistency, not relied upon.
2. **A single hung/failed chunk could crash the entire ingestion run.** In `pdfParser.js`, the `chatCompletion()` call inside `parseChunkWithLLM()` was **outside** its `try/catch` block — only the JSON-parsing step after it was wrapped. If `chatCompletion()` itself threw (which it now correctly does once the AbortController timeout fires), that exception would propagate up through `Promise.all()` in `parseChunksParallel()` and crash the whole `parsePDFToMovies()` call — losing every successfully-parsed chunk, since ingestion only checkpoints *after* all parsing finishes, not per-chunk. **Fix:** wrapped the `chatCompletion()` call in its own `try/catch` too — a failing/timed-out chunk is now skipped (logged, returns `[]`) and the rest of the PDF continues parsing normally.
3. **Visibility improvement:** `parseChunksParallel()` previously only logged once per *group* of 3 chunks (at the start) — inside a `Promise.all()`, there was no way to tell which of the 3 parallel chunks was actually stuck vs. still legitimately working. Now every individual chunk logs its own completion (`✓ Chunk N/23 done in Xs (Y movies)`) as soon as it finishes, regardless of its siblings in the same parallel group.

### 19.11 Root model swap — `gpt-oss-120b` → `llama-3.3-70b-instruct` (both free AND paid fallback timed out, back-to-back)
Even after the §19.9/§19.10 fixes, live testing showed **all 3 chunks in a parallel batch fail on both tiers** — the free `openai/gpt-oss-120b:free` was unavailable (as before), and the paid fallback `openai/gpt-oss-120b` *also* timed out after 45s, for all 3 chunks, consistently. This pointed to a deeper reliability problem with this specific model (both variants) rather than a one-off capacity blip.

**Researched alternatives and switched the primary model**: `meta-llama/llama-3.3-70b-instruct:free` — OpenRouter's most established, longest-running free model (live since December 2024), backed by 12 different provider endpoints (more redundancy than `gpt-oss-120b` had), well-suited for structured JSON extraction. `MODELS.LLM_FALLBACK` now points to the same model's paid slug (`meta-llama/llama-3.3-70b-instruct`, $0.10/1M input, $0.32/1M output — still cheap).

No other code changes were needed for this swap — the rate-limiter (`:free` suffix detection), the fallback logic, and the timeout/retry logic in `openrouterClient.js` are all generic and automatically applied to whichever model is configured in `constants.js`. Also reduced the per-attempt timeout from 90s to 45s (§19.10's `REQUEST_TIMEOUT_MS`), halving the worst-case wait (free attempt + paid fallback attempt) from ~180s down to ~90s per chunk when both tiers are having trouble.

### 19.12 Bug found via live testing: `pdfParser.js` had its own hardcoded model constant, bypassing `constants.js` entirely
After §19.11's model swap, live logs still showed `openai/gpt-oss-120b:free` being used for PDF parsing specifically (query-time calls correctly picked up the new model). Root cause: `pdfParser.js` defined `const PARSE_MODEL = "openai/gpt-oss-120b:free"` as its own **independent hardcoded constant** — never wired to `constants.js`'s `MODELS.LLM` at all. This predates this round's changes; it was simply never audited since earlier edits to this file focused on the extraction schema (directors/sourceExcerpt), not the model-selection line. Fixed: `PARSE_MODEL` is now `MODELS.LLM`, imported from `constants.js` like everywhere else. A full-codebase grep confirmed no other hardcoded model strings remain outside `constants.js`.

### 19.13 Root cause of the 45s timeouts: heavy per-chunk output, not a stall
Even after §19.11/§19.12's fixes, **every chunk still timed out at ~45s, consistently, across two completely different model families (both free and paid tiers)**. This consistency ruled out "this specific model is unreliable" as the explanation — the real cause was request *size*: each chunk was 8000 characters (~30 movies per chunk on this PDF), and the LLM was asked to generate up to 4096 tokens of structured JSON — including the `sourceExcerpt` field (§11), which asks for verbatim raw text per movie. Generating that much structured output for ~30 movies in a single completion is genuinely slow for a 70B-class model on shared/free-tier routing — this was never a hang or stall, just legitimately-needed generation time exceeding the timeout.

**Fix — three changes together:**
1. `PDF_CHUNK_CHARS` (new constant, `constants.js`) — chunk size reduced from a hardcoded `8000` to `4000` characters, roughly halving movies-per-chunk (and therefore output-per-call).
2. `REQUEST_TIMEOUT_MS` raised from 45s to 75s — giving genuinely-heavy generation realistic room, while still failing well before it would look "hung" to the user.
3. The extraction prompt now caps `sourceExcerpt` at ~40 words ("if the original text is longer, copy only the first ~40 words verbatim") — preventing runaway-long excerpts for movies with lengthy PDF descriptions from inflating output size unnecessarily.

### 19.14 CRITICAL bug found via live testing: §14's Pinecone "fix" was itself wrong
After the timeout/chunking issues were resolved, PDF parsing completed (307 movies, 47 chunks — down from an expected ~688 because OpenRouter's paid-tier credits ran out partway through, see §19.15) and embeddings generated successfully (307/307) — but the Pinecone DB-load step then failed **completely**: all 4 upsert batches errored with `Must pass in at least 1 record to upsert.`, ending in **0 vectors loaded**, despite `307 movies loaded to Neo4j` succeeding fine.

**Root cause: §14's earlier "bug fix" was itself incorrect.** That fix changed `index.upsert({ records: vectors })` to `index.upsert(vectors)` (a bare array), reasoning that `{records: ...}` was the shape for Pinecone's integrated-inference `upsertRecords()` method. This reasoning was wrong. Verified directly against the installed `@pinecone-database/pinecone` v7 SDK's actual TypeScript definitions and runtime source (`node_modules/.../dist/data/vectors/upsert.js`):

```js
validator = (options) => {
  if (!options.records || options.records.length === 0) {
    throw new PineconeArgumentError('Must pass in at least 1 record to upsert.');
  }
  ...
}
```

`Index.upsert()`'s real signature is `upsert(options: { records: Array<{id, values, metadata}>, namespace?: string })` — **`{records: [...]}` was the correct shape all along** for the standard (external-embedding) index this project uses. It is a *different* method (`index.upsertRecords()`, not `index.upsert()`) that's reserved for integrated-inference (raw-text, `chunk_text`-based) indexes — the shared word "records" in both APIs' option names was the source of the original misdiagnosis. Passing a bare array meant `options.records` was `undefined`, triggering exactly the validator error seen in the logs.

**Fixed** (reverted to the original shape): `index.upsert({ records: vectors })`. Verified by extracting the SDK's actual validator logic and running it directly against both call shapes — confirmed the bare-array shape throws the exact reported error, and the `{records: ...}` shape passes.

**Lesson applied going forward:** any future "bug fix" claims involving a third-party SDK's call shape should be checked against the installed package's actual source/type definitions before being treated as ground truth — this was checked correctly this time, but wasn't the first time around.

### 19.15 Data loss from OpenRouter credit exhaustion + a new safety net
The same live run also hit `402 This request would exceed your available credits` repeatedly once the account's OpenRouter balance ran out (after many free→paid fallbacks). Chunks failing this way return `0 movies` and are silently skipped (by the §19.12 fix — a single chunk failure doesn't crash the whole run) — but the cumulative effect was **307 movies parsed instead of the full ~688** in the PDF. This is a cost/capacity issue on the account, not a code bug — the practical fix is adding OpenRouter credit before the next full run (small chunk size means many chunks, so a run that repeatedly falls back to paid can add up).

**A related, more serious problem this exposed:** because of the §19.14 Pinecone bug, all 307 movies' worth of expensive parsing + embedding work (LLM calls, embedding API calls — real time and money) was **completely discarded** when the DB-load step failed — the only way to retry was re-running the entire pipeline from scratch, re-parsing the PDF and re-generating every embedding, burning through API calls (and credits) a second time for no reason.

**Fix — a cache-and-resume safety net:**
- `scripts/ingest.js` now writes `ingestion-cache.json` (parsed movies + embeddings) immediately after Step 2 (embedding) succeeds — before attempting the DB-load step.
- `scripts/loadFromCache.js` (new) reads this cache and runs **only** the Pinecone + Neo4j load step — no PDF parsing, no LLM calls, no embedding API calls. If the DB-load step ever fails again (for any reason), this lets you retry it directly without repeating the expensive/costly parts.
- The cache file is deleted automatically once a load fully succeeds (via `ingest.js`'s normal completion, or `loadFromCache.js`'s own success path).
- On ingestion failure, `ingest.js` now explicitly tells the user the cache exists and to use `loadFromCache.js` instead of re-running the full pipeline.

### 19.16 `scripts/wipeNeo4j.js` — new, mirrors `wipePinecone.js`
Given the live run above left Neo4j with a **partial** dataset (307 of ~688 movies) and Pinecone with **zero** vectors, a clean full re-ingestion would normally call for wiping both databases first — otherwise, re-parsing the PDF could return movies in a different order (LLM non-determinism), causing freshly-generated positional IDs to not align with the 307 partial IDs already in Neo4j, risking a handful of duplicate `Movie` nodes. `wipeNeo4j.js` batch-deletes all nodes/relationships (`DETACH DELETE`, capped at 5000/batch to avoid a single huge transaction on a large graph), gated behind an explicit `--confirm` flag like `wipePinecone.js`.

**Not used in the end** — see §19.17: the 307 movies already in Neo4j were judged "good enough for now," so instead of wiping and re-parsing, that data was rescued into Pinecone directly. `wipeNeo4j.js` stays in the codebase for whenever a genuinely clean full restart is wanted later (e.g., to eventually recover the missing ~381 movies via a fresh full PDF parse once more OpenRouter free-tier capacity or credit is available).

### 19.17 `scripts/rescueFromNeo4j.js` — recovering already-Neo4j'd data without re-parsing the PDFThe §19.15 cache-and-resume mechanism was added *after* the live run that hit the Pinecone bug — so that specific run's parsed movies + embeddings were never cached, and are gone (process exited, nothing persisted). Re-running the full pipeline would mean re-parsing the entire PDF and re-burning through OpenRouter's free-tier availability and paid-fallback credits — undesirable, especially with the account's credit constraint (§19.15) and a preference to stay within free-tier usage as much as possible.

**Key realization: the 307 movies' full structured data (title, year, plot, directors, actors, genres, oscar info, language, country) is already safely in Neo4j** — Neo4j load succeeded fully in that run; only the Pinecone step failed. There's no need to touch the PDF or the LLM at all to recover this — `scripts/rescueFromNeo4j.js` queries Neo4j directly (one Cypher read, aggregating each movie's relationships back into the same shape `pdfParser.js` would have produced), then runs only the embedding + Pinecone-upsert steps.

**One field is unavoidably different:** `sourceExcerpt` (the raw-PDF-text field used for higher-quality embeddings, §11) was never stored in Neo4j — it only ever existed transiently in memory during PDF parsing, and was intentionally never added to the Neo4j schema (it's Pinecone-embedding-specific, not a graph-relevant fact). `movieToEmbeddableText()` already falls back to `movie.plot` when `sourceExcerpt` is absent — no new code was needed for this, the existing fallback logic (§11) handles it automatically. This means vectors created via the rescue path are embedded from the shorter LLM-generated plot summary rather than the raw excerpt — a minor quality trade-off versus a full fresh ingestion, accepted here in exchange for zero additional LLM calls.

**Remaining cost:** the embedding step (`qwen/qwen3-embedding-8b`) is a paid-only model on OpenRouter (no free-tier variant exists for embeddings there) — cost for 307 movies is negligible (well under a cent), but it is *not zero*. If the account balance is exactly $0 and no credit can be added at all, even this trivial call will 402. In that specific case, the fallback would be switching this one step to Pinecone's own free-tier integrated-inference embedding (§12's rejected option) purely for this rescue path — not implemented here since it wasn't yet confirmed necessary, but the design doc (§12) already covers the trade-offs if it's needed later.

## 21. Groq added as primary LLM provider (3-tier chain)

**User request + research finding**: after repeated OpenRouter free-tier volatility (§19.9-§19.13), asked whether Groq could be used to cut cost/friction, since Groq offers a genuinely-free API. Researched Groq's actual free-tier limits and confirmed it's substantially better for this use case: **30 requests/minute and 14,400 requests/day** (vs. OpenRouter's 20RPM and only **50/day** without any credit — a ~288x difference in daily volume), served on Groq's own dedicated LPU hardware (300-800 tokens/sec) rather than OpenRouter's shared multi-backend-provider routing — the likely source of the "unavailable for free" volatility hit throughout this session. Groq hosts the same model family already in use (`llama-3.3-70b-versatile`, vs. OpenRouter's `meta-llama/llama-3.3-70b-instruct`).

**Implementation — `openrouterClient.js` restructured into a 3-tier provider chain:**
1. **Groq** (`llama-3.3-70b-versatile`, free, 30 RPM) — tried first
2. **OpenRouter free** (`meta-llama/llama-3.3-70b-instruct:free`, 20 RPM) — fallback if Groq fails/rate-limited
3. **OpenRouter paid** (`meta-llama/llama-3.3-70b-instruct`) — final fallback, cheap, used only if both free tiers fail

Any error at any tier (timeout, rate-limit, "unavailable", insufficient credits — anything) moves to the next tier automatically; only if all three fail does the call actually error out. `chatCompletion()`'s external signature is unchanged — every existing caller (`queryRouter.js`, `queryDecomposer.js`, `responseBuilder.js`, `pdfParser.js`) needed zero changes.

**`GROQ_API_KEY` is optional** — if not set in `.env`, the Groq tier is silently skipped and the chain starts directly at OpenRouter free, exactly matching pre-this-change behavior. This keeps the change backward-compatible with any existing `.env` that doesn't have a Groq key yet.

**`rateLimiter.js` generalized**: previously hardcoded to detect OpenRouter's `:free` suffix specifically (20RPM). Now takes an explicit `(key, limitPerMin)` pair per call, so each provider tier in the chain can have its own independently-tracked rate budget (Groq's 30RPM window is separate from OpenRouter's 20RPM window — they don't share or interfere with each other's budgets).

**Known limitation, not yet implemented**: Groq's free tier also enforces a **tokens-per-minute (TPM)** cap (~6,000 TPM on 70B models) in addition to the RPM cap — this project only rate-limits by request count (RPM), not by token volume. A burst of 3 parallel PDF-parsing chunks (each requesting up to 4096 output tokens) could plausibly exceed 6,000 TPM in a single minute and get a 429 from Groq specifically. This isn't a functional problem — the provider chain automatically falls to OpenRouter on any Groq error — but it does mean some Groq capacity may go underused during heavy parallel bursts. A token-aware limiter would be a reasonable future improvement if Groq TPM errors are observed in practice.

**Embeddings unchanged** — `qwen/qwen3-embedding-8b` via OpenRouter stays exactly as it was; Groq doesn't offer embedding models, and the existing embedding path was never the source of any of this session's problems.

### 21.1 Groq model name correction — `llama-3.3-70b-versatile` was deprecated
Live testing (`npm run test:all`) immediately after this change showed Groq returning `404 The model llama-3.3-70b-versatile does not exist or you do not have access`. Checked Groq's own deprecation docs directly: `llama-3.3-70b-versatile` was deprecated by Groq on **June 17, 2026**, with Groq's own recommended replacements being `openai/gpt-oss-120b` or `qwen/qwen3.6-27b`. Switched `MODELS.GROQ_LLM` to `openai/gpt-oss-120b`.

**Important distinction**: this is **Groq's own dedicated-infrastructure** `gpt-oss-120b` — a completely different reliability profile from the `openai/gpt-oss-120b` this project used earlier on **OpenRouter** (§19.11), which was volatile because OpenRouter routes that model across many different shared backend providers. Groq serves it on their own LPU hardware with generous published limits (250K TPM, 1000 RPM on the paid developer tier — free tier is lower but still well above OpenRouter's free-tier numbers). The provider-chain design (§21) means even if this choice also turns out to have issues, the system automatically falls through to OpenRouter free then paid — nothing breaks, worst case is just slower/costlier per-call until the chain is tuned further.

## 24. Bug found via live testing: pure-vector-route results crashed responseBuilder (`actors.slice(...).join is not a function`)

Live chatbot testing (`node app.js`, query "movies about friendship and loyalty" — a pure `VECTOR` route with no graph enrichment) crashed with `TypeError: m.actors.slice(...).join is not a function` inside `responseBuilder.js`.

**Root cause**: Pinecone metadata can't store arrays cleanly, so `pineconeLoader.js`'s upsert step joins `director`/`actors`/`genres` into comma-separated **strings** before storing them as metadata (e.g. `actors: "Cillian Murphy, Matt Damon, ..."`). `searchSimilarMovies()` (also in `pineconeLoader.js`) then read this metadata back via `...match.metadata` — a raw spread, with **no conversion back to arrays**. Every other part of the codebase (`responseBuilder.js`, `formatForDisplay()`, the hybrid-mode graph-enrichment path) assumes `actors`/`genres`/`directors` are **arrays** (calling `.slice()`, `.join()`, `.some()`, `.length` on them) — which is correct for graph-sourced results (Neo4j's `collect(DISTINCT ...)` genuinely returns arrays), but wrong for **pure-vector-route** results, since those never pass through the graph-enrichment step that would have overwritten these fields with real arrays. `"a, b, c".slice(0,6)` silently succeeds (strings have `.slice()` too, returns a **substring**, not an error) — but the following `.join(", ")` call on that substring throws, since strings don't have a `.join()` method. This is why the bug only surfaced for the `VECTOR` route specifically (`HYBRID` and `GRAPH` routes were never affected, since both go through Neo4j at some point and get real arrays).

**Fixed**: `searchSimilarMovies()` now normalizes `director`/`actors`/`genres` back into arrays right where Pinecone metadata is read (a small `splitToArray()` helper — comma-split, trim, filter empties; already-array or empty/missing values pass through safely). Both `directors` (array, new/consistent field) and `director` (string, backward-compat, from the raw metadata spread) are present on every vector-sourced result now, matching the shape graph-sourced results already had. Verified with a unit test reproducing the exact Pinecone metadata shape from a real movie (`Oppenheimer`) plus an empty-metadata edge case — both produce correctly-typed arrays, no crash.

## 22. Similarity queries now explain the connection ("why similar")

**User request**: for "movies similar to X" style queries, the response listed matching movies but never said *what* made them similar — director, genre, theme, etc. Fixed in `responseBuilder.js`'s `list`-intent prompt guide: for similarity-flavored queries specifically (the LLM detects this from the user's phrasing — "similar to", "like X", etc. — no new routing/classification code was needed, this is purely a prompt-instruction change), each listed movie now gets a short parenthetical (5-8 words) naming the specific shared trait, drawn only from the actual data already provided to the LLM (director/genre/actors/oscar — the same `moviesContext` block that was already being built) — e.g. `"Interstellar (2014) — same director, sci-fi themes"`. Plain listing queries with no reference movie/theme are explicitly told to skip this, so it doesn't clutter unrelated list answers.

## 25. Bugs found via live testing — genre queries + duplicate nodes + JSON truncation

Ran `scripts/debugGenres.js` (a new diagnostic, built specifically for this) to investigate why `search_by_genre({"genres":["Action","Romance"]})` returned zero results while `["Action"]` alone worked. The diagnostic surfaced a much bigger, more important bug than the one being investigated.

### 25.1 ROOT CAUSE: `Actor`/`Director`/`Genre`/`Award`/`Language`/`Country` were never actually protected against duplicates
The diagnostic's genre listing showed **triplicated** high-frequency genre nodes — `"Drama"` appearing 3 times (83/79/69 movies), `"Action"` 3 times (24/21/15), `"Romance"` 3 times (40/12/11), `"Comedy"` 3 times, `"Crime"` 3 times — while low-frequency genres (appearing in only 1-2 movies) had zero duplicates. This exact pattern (duplicates only on high-collision entities, count matching `MAX_PARALLEL_BATCHES = 3` precisely) is the signature of a **MERGE race condition**.

**The actual bug**: §8's `createIndexes()` documented "Unique CONSTRAINT ... duplicate insert ko DB-level pe bhi rok deta hai" but only ever *applied* a unique constraint to `Movie.id` — Actor/Director/Genre/Award/Language/Country were left as plain `INDEX`es, which speed up lookups but do **not** prevent duplicate creation. §10 (parallel Neo4j batch insertion, added specifically to speed up ingestion) made this a live problem: when two of the up-to-3 concurrent batch transactions both need to `MERGE` the *same not-yet-existing* node (e.g., both batches contain an "Action"-tagged movie, and neither transaction can see the other's uncommitted write), Neo4j lets both proceed and create separate nodes. Every genre appears in many movies across many batches, making `Genre` the single most exposed label to this race — matching exactly what was observed.

**Fixed**: `neo4jClient.js`'s `createIndexes()` now creates real `UNIQUE CONSTRAINT`s for all six labels (`actor_name_unique`, `director_name_unique`, `genre_name_unique`, `award_name_unique`, `lang_name_unique`, `country_name_unique`), not just plain indexes — matching what was already correctly done for `Movie.id`. A unique constraint makes Neo4j itself serialize/reject the racing duplicate creation, closing the gap regardless of concurrency level.

**Existing duplicates needed cleanup first** — a unique constraint cannot be created while violating data already exists. `scripts/mergeDuplicateNodes.js` (new) uses `apoc.refactor.mergeNodes` (APOC Core, included by default on Neo4j AuraDB free tier) to merge same-name duplicate nodes for all six labels — consolidating every relationship (any type, any direction) onto one surviving node and deleting the rest — then also merges duplicate `Movie` nodes by `(title, year)` (since Movie's unique key is `id`, not title — duplicate Movie nodes could arise across different ingestion attempts whose positional IDs didn't align), and finally re-runs `createIndexes()` so the new constraints apply cleanly against the now-deduplicated data.

### 25.2 `searchByGenre` and `searchOscarMovies` still had the old row-duplication pattern (§19.4's known follow-up, now fixed)
These two functions were flagged back in §19.4/§19.8 as not-yet-fixed (only 4 of ~15 functions were fixed in that round). `searchByGenre` in particular had a second issue beyond the plain `d.name AS director` pattern: `UNWIND $genres AS genreName` followed directly by `MATCH (m:Movie)-[:HAS_GENRE]->(g)` — with no row-collapsing `WITH` in between — meant a movie tagged with *both* queried genres (e.g., both "Action" and "Romance") would appear as **two separate rows**, one per matching genre, before any director-collecting even happened. Fixed both functions with the same `collect(DISTINCT d.name) AS directors` pattern as the earlier 4; `searchByGenre` additionally now groups movies first (`WITH m, collect(DISTINCT g.name) AS matchedGenres`) before the director lookup, so a movie matching multiple requested genres now correctly appears **once**, with all its matching genres listed, instead of duplicated once per genre.

**Note**: this fix improves correctness (no more duplicate rows, no more directors dropped for multi-director movies) but does not, by itself, fully explain the exact "zero results for `[\"Action\",\"Romance\"]`" the user saw live — the diagnostic script (running the equivalent raw Cypher directly) actually returned 10 non-empty results for that same query, all coincidentally ranked as "Action" matches by the `ORDER BY oscarWon DESC, rating DESC` sort (plausible if none of this dataset's Romance-tagged movies have `oscarWon=true` or a high rating). The most likely explanation for the live chatbot's *empty* result is the same duplicate-node fragmentation from §25.1 combined with the pre-fix row-duplication — both are now resolved; re-testing after running `mergeDuplicateNodes.js` is the way to confirm.

### 25.3 `search_movie_direct_data(["Oppenheimer"])` returning empty despite the movie definitely existing
Same live session showed `search_director_filmography` successfully listing "Oppenheimer (2023)" under Christopher Nolan, yet moments later `search_movie_direct_data({"titles":["Oppenheimer"]})` (used for "movies similar to Oppenheimer" — the hybrid-mode lookup step) returned empty. The most likely explanation, not yet independently confirmed, is duplicate `Movie` nodes for "Oppenheimer" itself (from separate ingestion attempts whose positional IDs never aligned — see §25.1's Movie-dedup pass) interacting with `ORDER BY m.year DESC LIMIT $limit` in a way that could drop or misorder results. `mergeDuplicateNodes.js`'s Movie-dedup pass (by `title`+`year`) directly addresses this; re-test this specific query after running it.

### 25.4 Routing LLM output getting truncated mid-JSON
Two live queries ("movies based or sports or western", "movie related to action fantasies") triggered `⚠️ JSON repair: sab attempts fail` — the raw response was visibly cut off mid-generation (e.g., ending in `"inten` for what should have been `"intent"`). `queryRouter.js`'s routing call was capped at `maxTokens: 600` — too tight for the full routing JSON schema (query classification + entity extraction + multi-query decomposition + tool suggestions) on some phrasings. Raised to `1000`. The system didn't crash either way (§20.2's `jsonRepair.js` safety net caught the malformed JSON and the query gracefully fell back to a casual/vector response rather than erroring) — but the routing intent was lost for these queries, so raising the token budget directly reduces how often that fallback path is needed.

## 23. Migrating already-inserted data to the new schema

If you already ran `ingest.js` before this update, your existing Neo4j/Pinecone data is on the **old schema** — missing the new relationships, multi-director support, real award names, and raw-excerpt embeddings. Two migration paths exist, depending on how much you need:

### Fast path — `npm run backfill:graph` (no PDF, no LLM calls)
Adds `WORKED_IN_GENRE` and `CO_STARRED_WITH` directly from data **already in Neo4j** (derived from existing `ACTED_IN` + `HAS_GENRE` relationships). Free, fast, safe to re-run anytime.

**Cannot** recover: multi-director, `IN_LANGUAGE`/`FROM_COUNTRY`, real award names, or raw-excerpt vector embeddings — that data was never persisted by the old ingestion run, so it isn't sitting in the database waiting to be derived. It only exists in the PDF.

### Full path — `npm run migrate <path-to-pdf>`
Re-parses the PDF (recovering `directors[]`, `sourceExcerpt`, real `awards[]`, `language`, `country`), then updates Pinecone (re-embeds + upserts) and Neo4j (MERGE-based update).

**Duplicate-safety:** a fresh PDF parse generates new positional movie IDs that won't reliably match the old ones (LLM extraction order isn't guaranteed identical run-to-run). `src/ingestion/idReconciler.js` looks up each freshly-parsed movie's **title + year** against what's already in Neo4j — if it matches an existing record, the *old* id is reused (so Pinecone/Neo4j update that same record instead of duplicating it); if no match is found, it's treated as a new movie and inserted fresh.

This script is idempotent — safe to run more than once.