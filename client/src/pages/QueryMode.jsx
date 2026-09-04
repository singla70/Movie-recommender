import { useState, useRef, useEffect } from "react";
import { Send, X, RotateCcw, WifiOff } from "lucide-react";
import ChatMessage from "../components/ChatMessage.jsx";
import { api } from "../api.js";

const STARTERS = [
  "Movies directed by Christopher Nolan",
  "Something about friendship and loyalty",
  "Movies similar to Oppenheimer",
  "Which Nolan movies won an Oscar?",
];

// Turns a real pipeline stage (from api.queryStream) into copy the
// user can actually act on — reflects what the backend is doing at
// that instant, not a generic spinner label.
function stageLabel(stage) {
  if (!stage) return "Thinking…";
  const { stage: name, route } = stage;
  if (name === "understanding") return "Reading your question…";
  if (name === "responding") return route === "greeting" ? "Saying hello…" : "Redirecting to movies…";
  if (name === "searching") {
    if (route === "vector") return "Searching Pinecone — semantic match…";
    if (route === "graph") return "Searching Neo4j — graph traversal…";
    if (route === "hybrid") return "Searching Pinecone + Neo4j…";
    if (route === "multi_query") return "Breaking this into sub-queries…";
    return "Searching the catalogue…";
  }
  if (name === "composing") return "Composing the answer…";
  return "Thinking…";
}

export default function QueryMode({ connected }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [stage, setStage] = useState(null);
  const scrollRef = useRef(null);
  const abortRef = useRef(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, loading, stage]);

  useEffect(() => () => abortRef.current?.abort(), []); // cancel any in-flight request on unmount

  async function send(text) {
    const query_text = (text ?? input).trim();
    if (!query_text || loading || connected === false) return;

    const history = messages.map((m) => ({ role: m.role, content: m.text }));
    setMessages((prev) => [...prev, { role: "user", text: query_text }]);
    setInput("");
    setLoading(true);
    setStage(null);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const data = await api.queryStream(query_text, history, setStage, controller.signal);
      setMessages((prev) => [
        ...prev,
        { role: "assistant", text: data.answer, movies: data.movies, route: data.route },
      ]);
    } catch (err) {
      if (err.name === "AbortError") {
        setMessages((prev) => [...prev, { role: "assistant", text: "Cancelled.", route: null }]);
      } else {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", text: `Something went wrong: ${err.message}` },
        ]);
      }
    } finally {
      setLoading(false);
      setStage(null);
      abortRef.current = null;
    }
  }

  function cancel() {
    abortRef.current?.abort();
  }

  function newChat() {
    if (loading) cancel();
    setMessages([]);
    setInput("");
  }

  const disabled = loading || connected === false;

  return (
    <div className="flex h-full flex-1 flex-col overflow-hidden">
      <div className="flex items-center justify-between gap-4 border-b border-theatre-border px-5 py-4 md:px-8">
        <div className="min-w-0">
          <h1 className="font-display text-lg text-theatre-text">Query mode</h1>
          <p className="text-xs text-theatre-muted">Ask about the catalogue — mood, cast, awards, or a film to compare against.</p>
        </div>
        {messages.length > 0 && (
          <button
            onClick={newChat}
            className="flex shrink-0 items-center gap-1.5 rounded-md border border-theatre-border px-3 py-1.5 text-xs text-theatre-muted transition-colors hover:border-gold/40 hover:text-theatre-text"
          >
            <RotateCcw size={13} strokeWidth={1.75} />
            New chat
          </button>
        )}
      </div>

      {connected === false && (
        <div className="flex items-center gap-2 border-b border-gold/30 bg-gold/10 px-5 py-2.5 text-xs text-gold md:px-8">
          <WifiOff size={13} strokeWidth={2} />
          Can't reach the backend right now, so queries won't go through. Check the connection status in the sidebar.
        </div>
      )}

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-6 md:px-8">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <p className="font-display text-2xl text-theatre-muted">What are you looking for?</p>
            <div className="mt-6 grid max-w-lg grid-cols-1 gap-2 sm:grid-cols-2">
              {STARTERS.map((s) => (
                <button
                  key={s}
                  onClick={() => send(s)}
                  disabled={disabled}
                  className="rounded-md border border-theatre-border px-3.5 py-2.5 text-left text-xs text-theatre-muted transition-colors hover:border-teal/40 hover:text-theatre-text disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-6">
            {messages.map((m, i) => (
              <ChatMessage key={i} {...m} />
            ))}
            {loading && (
              <div className="flex items-center gap-3 pl-10 text-xs text-theatre-muted">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-gold" />
                {stageLabel(stage)}
                <button
                  onClick={cancel}
                  className="ml-1 flex items-center gap-1 text-theatre-faint transition-colors hover:text-theatre-text"
                >
                  <X size={12} strokeWidth={2} />
                  Cancel
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="border-t border-theatre-border px-5 py-4 md:px-8">
        <div className="mx-auto flex max-w-3xl items-center gap-3">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && send()}
            disabled={disabled}
            placeholder={
              connected === false
                ? "Backend unreachable — check the connection status…"
                : "Ask about a film, director, mood, or genre…"
            }
            className="flex-1 rounded-md border border-theatre-border bg-theatre-surface px-4 py-2.5 text-sm text-theatre-text placeholder:text-theatre-faint focus:border-teal/50 disabled:cursor-not-allowed disabled:opacity-60"
          />
          <button
            onClick={() => send()}
            disabled={disabled || !input.trim()}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-gold text-theatre-bg transition-colors hover:bg-gold-soft disabled:cursor-not-allowed disabled:opacity-40"
            aria-label="Send"
          >
            <Send size={16} strokeWidth={2} />
          </button>
        </div>
      </div>
    </div>
  );
}