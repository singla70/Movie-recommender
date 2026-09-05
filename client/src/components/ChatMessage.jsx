import { useState } from "react";
import { Film, User, Sparkles, Network, Layers, ListTree, MessageCircle, Copy, Check, RefreshCcw } from "lucide-react";
import MovieRow from "./MovieRow.jsx";

// Tells the user which store(s) actually answered their question —
// not a raw internal string. "hybrid" reads as both databases,
// because that's what the pipeline does for that route.
const ROUTE_META = {
  vector: { icon: Sparkles, label: "Searched Pinecone — semantic match" },
  graph: { icon: Network, label: "Searched Neo4j — graph traversal" },
  hybrid: { icon: Layers, label: "Searched Pinecone + Neo4j" },
  multi_query: { icon: ListTree, label: "Answered as multiple sub-queries" },
  greeting: { icon: MessageCircle, label: "Just chatting — no catalogue search" },
  off_topic: { icon: MessageCircle, label: "Off-topic — no catalogue search" },
};

export default function ChatMessage({ role, text, movies, route, onRegenerate, regenerateDisabled }) {
  const isUser = role === "user";
  const routeMeta = route ? ROUTE_META[route] : null;
  const [copied, setCopied] = useState(false);

  async function copyText() {
    try {
      await navigator.clipboard.writeText(text || "");
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API can be blocked (permissions/insecure context) —
      // silently no-op rather than throw in the middle of a chat.
    }
  }

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

        {!isUser && routeMeta && (
          <div className="mt-1.5 flex items-center gap-1.5 text-[10px] tracking-wide text-theatre-faint">
            <routeMeta.icon size={11} strokeWidth={1.75} />
            {routeMeta.label}
          </div>
        )}

        {!isUser && (
          <div className="mt-1.5 flex items-center gap-3 text-[10px] text-theatre-faint">
            <button
              onClick={copyText}
              className="flex items-center gap-1 transition-colors hover:text-theatre-text"
            >
              {copied ? <Check size={11} strokeWidth={2} /> : <Copy size={11} strokeWidth={1.75} />}
              {copied ? "Copied" : "Copy"}
            </button>
            {onRegenerate && (
              <button
                onClick={onRegenerate}
                disabled={regenerateDisabled}
                className="flex items-center gap-1 transition-colors hover:text-theatre-text disabled:cursor-not-allowed disabled:opacity-40"
              >
                <RefreshCcw size={11} strokeWidth={1.75} />
                Regenerate
              </button>
            )}
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