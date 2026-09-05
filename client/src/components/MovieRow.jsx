import { useState } from "react";
import { Trophy, ChevronDown } from "lucide-react";

// Film-strip inspired row — a numbered frame, not a rounded card.
// Keeps the sprocket motif meaningful (each row = one frame of film).
// Click to expand: shows the fields formatForDisplay() (server/
// src/query/responseBuilder.js) already sends but the collapsed row
// has no room for — full cast list, confidence rating, Oscar nod
// count, plot. Nothing here is invented; it's all already in `movie`.
export default function MovieRow({ movie, index }) {
  const [expanded, setExpanded] = useState(false);
  const directors = movie.directors?.length ? movie.directors.join(", ") : movie.director;
  const genres = movie.genres?.slice(0, 3).join(" · ");
  const hasDetail = Boolean(
    movie.plot || movie.actors?.length || movie.genres?.length > 3 || movie.confidence
  );

  return (
    <div className="border-b border-theatre-border/70 py-3.5 last:border-b-0">
      <button
        onClick={() => hasDetail && setExpanded((e) => !e)}
        className={`flex w-full gap-4 text-left ${hasDetail ? "cursor-pointer" : "cursor-default"}`}
      >
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
            {hasDetail && (
              <ChevronDown
                size={13}
                strokeWidth={2}
                className={`ml-auto shrink-0 text-theatre-faint transition-transform ${expanded ? "rotate-180" : ""}`}
              />
            )}
          </div>
          <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-theatre-muted">
            {directors && <span>{directors}</span>}
            {genres && <span className="text-teal/80">{genres}</span>}
            {movie.rating ? <span>{movie.rating}/10</span> : null}
          </div>
        </div>
      </button>

      {expanded && (
        <div className="ml-10 mt-2.5 space-y-2 border-l border-theatre-border pl-4 text-xs text-theatre-muted">
          {movie.plot && <p className="italic text-theatre-muted/90">{movie.plot}</p>}
          {movie.actors?.length > 0 && (
            <p>
              <span className="text-theatre-faint">Cast: </span>
              {movie.actors.join(", ")}
            </p>
          )}
          {movie.genres?.length > 0 && (
            <p>
              <span className="text-theatre-faint">Genres: </span>
              {movie.genres.join(", ")}
            </p>
          )}
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {movie.oscarNominations > 0 && (
              <span>{movie.oscarNominations} Oscar nomination{movie.oscarNominations > 1 ? "s" : ""}</span>
            )}
            {movie.confidence?.label && (
              <span>
                Match confidence: {movie.confidence.stars || movie.confidence.label}
                {typeof movie.confidence.score === "number" ? ` (${movie.confidence.score}%)` : ""}
              </span>
            )}
            {movie.source && movie.source !== "unknown" && <span className="capitalize">Source: {movie.source}</span>}
          </div>
        </div>
      )}
    </div>
  );
}