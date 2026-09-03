import neo4j from "neo4j-driver";
import dotenv from "dotenv";
import { RETRY } from "../config/constants.js";
dotenv.config();

const NEO4J_URI = process.env.NEO4J_URI;
const NEO4J_USERNAME = process.env.NEO4J_USERNAME || "neo4j";
const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD;

if (!NEO4J_URI || !NEO4J_PASSWORD) throw new Error("❌ NEO4J_URI or NEO4J_PASSWORD missing");

let _driver = null;

export function getNeo4jDriver() {
  if (!_driver) {
    _driver = neo4j.driver(
      NEO4J_URI,
      neo4j.auth.basic(NEO4J_USERNAME, NEO4J_PASSWORD),
      { maxConnectionPoolSize: 10, connectionTimeoutMs: 30000 }
    );
  }
  return _driver;
}

function toNeo4jSafe(value) {
  if (typeof value === "number" && Number.isFinite(value)) return neo4j.int(Math.floor(value));
  if (Array.isArray(value)) return value.map(toNeo4jSafe);
  return value;
}

function convertParams(params) {
  const safe = {};
  for (const [key, val] of Object.entries(params)) safe[key] = toNeo4jSafe(val);
  return safe;
}

export async function runQuery(cypher, params = {}) {
  const driver = getNeo4jDriver();
  const session = driver.session();
  try {
    const result = await session.run(cypher, convertParams(params));
    return result.records.map(record => {
      const obj = {};
      record.keys.forEach(key => {
        const value = record.get(key);
        obj[key] = neo4j.isInt(value) ? value.toNumber() : value;
      });
      return obj;
    });
  } finally {
    await session.close();
  }
}

export async function closeNeo4jDriver() {
  if (_driver) { await _driver.close(); _driver = null; console.log("✅ Neo4j driver closed."); }
}

// ── Indexes + Unique Constraints ─────────────────────────────
// Har node type ka MERGE key yahan indexed/constrained hona
// ZAROORI hai — warna MERGE poore label ko scan karta hai (slow).
//
// CRITICAL BUG-FIX (found via live testing): pehle sirf Movie.id
// UNIQUE CONSTRAINT thi — Actor/Director/Genre/Award/Language/
// Country sirf plain INDEX the (constraint nahi). Plain INDEX
// lookup fast karta hai, lekin duplicate-creation ko ROKTA NAHI —
// agar do parallel transactions (§10 ki parallel-batch insertion,
// MAX_PARALLEL_BATCHES=3) EK HI NAYE naam (jaise "Action" Genre,
// jo abhi tak exist nahi karta) ko SAME TIME pe MERGE karne ki
// koshish karein, dono transactions "exist nahi karta" dekh sakte
// hain (ek dusre ka not-yet-committed write nahi dikhta) aur DONO
// apna-apna alag node bana sakte hain — result: duplicate "Action"
// Genre nodes. High-collision entities (Genre, jinke sirf ~30
// unique names hain 307+ movies ke against) is race-condition ke
// liye sabse zyada vulnerable hain — exactly wahi observed hua
// (live data mein "Drama"/"Action"/"Romance"/"Comedy" jaise
// high-frequency genres 3x duplicate the — 3 EXACTLY match karta
// hai MAX_PARALLEL_BATCHES=3 se).
//
// UNIQUE CONSTRAINT is race ko DB-level pe rokta hai — Neo4j
// dusri transaction ko wait/fail karwa deta hai agar koi aur
// transaction same unique-value create kar rahi ho, chahe kitni
// bhi parallel ho.
//
//   Node       | MERGE key    | Constraint
//   -----------|--------------|-----------------------------
//   Movie      | id           | UNIQUE CONSTRAINT (movie_id_unique)
//   Actor      | name         | UNIQUE CONSTRAINT (actor_name_unique)
//   Director   | name         | UNIQUE CONSTRAINT (director_name_unique)
//   Genre      | name         | UNIQUE CONSTRAINT (genre_name_unique)
//   Award      | name         | UNIQUE CONSTRAINT (award_name_unique)
//   Language   | name         | UNIQUE CONSTRAINT (lang_name_unique)
//   Country    | name         | UNIQUE CONSTRAINT (country_name_unique)
export async function createIndexes() {
  // Purane plain INDEXes (jo pehle in exact property names pe bane the)
  // pehle drop karo — Neo4j ek property pe plain INDEX aur UNIQUE
  // CONSTRAINT dono ek saath nahi rehne deta (constraint create karne
  // se pehle conflicting index drop karna zaroori hai). Ye sirf
  // pehli baar hi kuch drop karega (agar purana index tha) — agla
  // baar "IF EXISTS" ki wajah se safely no-op ho jayega.
  const dropOldIndexes = [
    "DROP INDEX actor_name IF EXISTS",
    "DROP INDEX director_name IF EXISTS",
    "DROP INDEX genre_name IF EXISTS",
    "DROP INDEX award_name IF EXISTS",
    "DROP INDEX lang_name IF EXISTS",
    "DROP INDEX country_name IF EXISTS",
  ];
  for (const q of dropOldIndexes) await runQuery(q);

  const queries = [
    "CREATE CONSTRAINT movie_id_unique     IF NOT EXISTS FOR (m:Movie)    REQUIRE m.id IS UNIQUE",
    "CREATE CONSTRAINT actor_name_unique    IF NOT EXISTS FOR (a:Actor)    REQUIRE a.name IS UNIQUE",
    "CREATE CONSTRAINT director_name_unique IF NOT EXISTS FOR (d:Director) REQUIRE d.name IS UNIQUE",
    "CREATE CONSTRAINT genre_name_unique    IF NOT EXISTS FOR (g:Genre)    REQUIRE g.name IS UNIQUE",
    "CREATE CONSTRAINT award_name_unique    IF NOT EXISTS FOR (a:Award)    REQUIRE a.name IS UNIQUE",
    "CREATE CONSTRAINT lang_name_unique     IF NOT EXISTS FOR (l:Language) REQUIRE l.name IS UNIQUE",
    "CREATE CONSTRAINT country_name_unique  IF NOT EXISTS FOR (c:Country)  REQUIRE c.name IS UNIQUE",

    // Baaki secondary indexes — filtering/sorting queries fast karne ke liye
    // (ye MERGE keys nahi hain, isliye plain index theek hai)
    "CREATE INDEX movie_title    IF NOT EXISTS FOR (m:Movie)    ON (m.title)",
    "CREATE INDEX movie_year     IF NOT EXISTS FOR (m:Movie)    ON (m.year)",
    "CREATE INDEX movie_oscar    IF NOT EXISTS FOR (m:Movie)    ON (m.oscarWon)",
    "CREATE INDEX movie_lang     IF NOT EXISTS FOR (m:Movie)    ON (m.language)",
    "CREATE INDEX year_value     IF NOT EXISTS FOR (y:Year)     ON (y.value)",
  ];
  for (const q of queries) await runQuery(q);
  console.log("✅ Neo4j indexes + constraints created/verified.");
}

// ── Deadlock-aware retry wrapper ──────────────────────────────
// Parallel batch writes ke time do transactions ek hi node
// (jaise "Christopher Nolan") ko touch kar sakti hain — Neo4j
// deadlock detect karke transaction rollback + error throw karta
// hai (khud retry NAHI karta). Ye wrapper sirf deadlock errors pe
// exponential backoff ke saath retry karta hai; baaki errors pe
// fail-fast rehta hai (galat data ko silently retry karna galat hai).
function isDeadlockError(err) {
  const code = err?.code || "";
  return (
    code.includes("DeadlockDetected") ||
    code.includes("LockClientStopped") ||
    /deadlock/i.test(err?.message || "")
  );
}

export async function runQueryWithRetry(cypher, params = {}, maxAttempts = RETRY.NEO4J_DEADLOCK_MAX_ATTEMPTS) {
  let attempt = 0;
  while (true) {
    attempt++;
    try {
      return await runQuery(cypher, params);
    } catch (err) {
      if (!isDeadlockError(err) || attempt >= maxAttempts) throw err;
      const delay = RETRY.NEO4J_DEADLOCK_BASE_DELAY_MS * 2 ** (attempt - 1);
      console.warn(
        `  ⚠️  Neo4j deadlock detected (attempt ${attempt}/${maxAttempts}) — retrying in ${delay}ms...`
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}