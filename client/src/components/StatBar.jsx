// Inline stat row, sprocket-divided — deliberately not a grid of
// identical rounded cards; these are counts along one strip of film.
export default function StatBar({ stats }) {
  const items = [
    { label: "Movies", value: stats?.movies },
    { label: "Actors", value: stats?.actors },
    { label: "Directors", value: stats?.directors },
    { label: "Genres", value: stats?.genres },
    { label: "Pinecone vectors", value: stats?.pineconeVectors },
  ];

  // Neo4j and Pinecone are separate stores kept in sync only by the
  // ingestion pipeline — if they drift apart (a partial upload
  // failure, for instance), semantic/vector-search results silently
  // only cover whatever's actually in Pinecone even though Neo4j
  // (and graph-routed queries like genre/actor/director filters)
  // looks completely fine. Surfacing this mismatch directly is more
  // useful than a bare count ever was on its own.
  const mismatch =
    typeof stats?.movies === "number" &&
    typeof stats?.pineconeVectors === "number" &&
    stats.movies !== stats.pineconeVectors;

  return (
    <div>
      <div className="flex divide-x divide-theatre-border rounded-lg border border-theatre-border">
        {items.map(({ label, value }) => (
          <div key={label} className="flex-1 px-5 py-4">
            <div className="font-mono text-2xl text-theatre-text">
              {value ?? "—"}
            </div>
            <div className="mt-0.5 text-xs text-theatre-muted">{label}</div>
          </div>
        ))}
      </div>
      {mismatch && (
        <p className="mt-2 text-xs text-gold">
          Movies ({stats.movies}) and Pinecone vectors ({stats.pineconeVectors}) don't match — semantic/mood-based
          search only covers what's actually in Pinecone, even though genre/actor/director search (Neo4j) is unaffected.
        </p>
      )}
    </div>
  );
}