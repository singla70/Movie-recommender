import { Film, User } from "lucide-react";
import MovieRow from "./MovieRow.jsx";

export default function ChatMessage({ role, text, movies, route }) {
  const isUser = role === "user";

  return (
    <div className={`flex gap-3 ${isUser ? "flex-row-reverse" : ""}`}>
      <div
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${
          isUser ? "bg-theatre-surface2" : "bg-gold/15"
        }`}
      >
        {isUser ? (
          <User size={14} className="text-theatre-muted" strokeWidth={1.75} />
        ) : (
          <Film size={14} className="text-gold" strokeWidth={1.75} />
        )}
      </div>

      <div className={`max-w-2xl ${isUser ? "text-right" : ""}`}>
        <div
          className={`inline-block rounded-lg px-4 py-2.5 text-sm leading-relaxed ${
            isUser
              ? "bg-theatre-surface2 text-theatre-text"
              : "bg-theatre-surface text-theatre-text"
          }`}
        >
          <p className="whitespace-pre-wrap text-left">{text}</p>
        </div>

        {!isUser && route && (
          <div className="mt-1.5 font-mono text-[10px] tracking-wide text-theatre-faint">
            {route}
          </div>
        )}

        {!isUser && movies?.length > 0 && (
          <div className="mt-3 rounded-lg border border-theatre-border bg-theatre-surface/50 px-4">
            {movies.map((m, i) => (
              <MovieRow key={m.movieId || m.id || i} movie={m} index={i} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
