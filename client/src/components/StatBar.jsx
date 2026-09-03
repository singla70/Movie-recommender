// Inline stat row, sprocket-divided — deliberately not a grid of
// identical rounded cards; these are counts along one strip of film.
export default function StatBar({ stats }) {
  const items = [
    { label: "Movies", value: stats?.movies },
    { label: "Actors", value: stats?.actors },
    { label: "Directors", value: stats?.directors },
    { label: "Genres", value: stats?.genres },
  ];

  return (
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
  );
}
