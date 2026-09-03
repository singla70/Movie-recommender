import { Trophy } from "lucide-react";

// Film-strip inspired row — a numbered frame, not a rounded card.
// Keeps the sprocket motif meaningful (each row = one frame of film).
export default function MovieRow({ movie, index }) {
  const directors = movie.directors?.length ? movie.directors.join(", ") : movie.director;
  const genres = movie.genres?.slice(0, 3).join(" · ");

  return (
    <div className="flex gap-4 border-b border-theatre-border/70 py-3.5 last:border-b-0">
      <div className="w-6 shrink-0 pt-0.5 text-right font-mono text-xs text-theatre-faint">
        {String(index + 1).padStart(2, "0")}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-display text-base text-theatre-text">{movie.title}</span>
          {movie.year && <span className="font-mono text-xs text-theatre-muted">{movie.year}</span>}
          {movie.oscarWon && (
            <span className="inline-flex items-center gap-1 text-xs text-gold">
              <Trophy size={11} strokeWidth={2} /> Oscar
            </span>
          )}
        </div>
        <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-theatre-muted">
          {directors && <span>{directors}</span>}
          {genres && <span className="text-teal/80">{genres}</span>}
          {movie.rating ? <span>{movie.rating}/10</span> : null}
        </div>
        {movie.whySimilar && (
          <p className="mt-1.5 text-xs italic text-theatre-muted/80">{movie.whySimilar}</p>
        )}
      </div>
    </div>
  );
}
