import dotenv from "dotenv";
dotenv.config();
import { runQuery, closeNeo4jDriver } from "../src/utils/neo4jClient.js";

async function check() {
  const counts = await runQuery(`
    MATCH (m:Movie) WITH count(m) AS movies
    MATCH (a:Actor) WITH movies, count(a) AS actors
    MATCH (d:Director) WITH movies, actors, count(d) AS directors
    MATCH (g:Genre) WITH movies, actors, directors, count(g) AS genres
    RETURN movies, actors, directors, genres
  `);
  console.log("📊 DB Counts:", counts[0]);

  const sample = await runQuery(`MATCH (m:Movie) RETURN m.title LIMIT 5`);
  console.log("\n🎬 Sample movies:", sample.map(r => r["m.title"]));

  const gippy = await runQuery(`MATCH (a:Actor) WHERE toLower(a.name) CONTAINS 'gippy' RETURN a.name`);
  console.log("\n👤 Gippy search:", gippy);

  const comedy = await runQuery(`MATCH (g:Genre) WHERE toLower(g.name) CONTAINS 'comedy' RETURN g.name LIMIT 5`);
  console.log("\n🎭 Comedy genres:", comedy.map(r => r["g.name"]));

  const actorGenre = await runQuery(`
    MATCH (a:Actor)-[:ACTED_IN]->(m:Movie)-[:HAS_GENRE]->(g:Genre)
    WHERE toLower(g.name) CONTAINS 'comedy'
    RETURN a.name AS actor, m.title AS movie LIMIT 5
  `);
  console.log("\n🎭 Actors in comedy movies:", actorGenre);

  await closeNeo4jDriver();
}
check().catch(console.error);