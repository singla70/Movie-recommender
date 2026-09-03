import { useState, useRef, useEffect } from "react";
import { Send } from "lucide-react";
import ChatMessage from "../components/ChatMessage.jsx";
import { api } from "../api.js";

const STARTERS = [
  "Movies directed by Christopher Nolan",
  "Something about friendship and loyalty",
  "Movies similar to Oppenheimer",
  "Which Nolan movies won an Oscar?",
];

export default function QueryMode() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, loading]);

  async function send(text) {
    const query_text = (text ?? input).trim();
    if (!query_text || loading) return;

    const history = messages.map((m) => ({ role: m.role, content: m.text }));
    setMessages((prev) => [...prev, { role: "user", text: query_text }]);
    setInput("");
    setLoading(true);

    try {
      const data = await api.query(query_text, history);
      setMessages((prev) => [
        ...prev,
        { role: "assistant", text: data.answer, movies: data.movies, route: data.route },
      ]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", text: `Something went wrong: ${err.message}` },
      ]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex h-screen flex-1 flex-col">
      <div className="flex items-center justify-between border-b border-theatre-border px-8 py-4">
        <div>
          <h1 className="font-display text-lg text-theatre-text">Query mode</h1>
          <p className="text-xs text-theatre-muted">Ask about the catalogue — mood, cast, awards, or a film to compare against.</p>
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-8 py-6">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <p className="font-display text-2xl text-theatre-muted">What are you looking for?</p>
            <div className="mt-6 grid max-w-lg grid-cols-1 gap-2 sm:grid-cols-2">
              {STARTERS.map((s) => (
                <button
                  key={s}
                  onClick={() => send(s)}
                  className="rounded-md border border-theatre-border px-3.5 py-2.5 text-left text-xs text-theatre-muted transition-colors hover:border-teal/40 hover:text-theatre-text"
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
              <div className="flex items-center gap-2 pl-10 text-xs text-theatre-muted">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-gold" />
                Searching the graph…
              </div>
            )}
          </div>
        )}
      </div>

      <div className="border-t border-theatre-border px-8 py-4">
        <div className="mx-auto flex max-w-3xl items-center gap-3">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && send()}
            placeholder="Ask about a film, director, mood, or genre…"
            className="flex-1 rounded-md border border-theatre-border bg-theatre-surface px-4 py-2.5 text-sm text-theatre-text placeholder:text-theatre-faint focus:border-teal/50"
          />
          <button
            onClick={() => send()}
            disabled={loading || !input.trim()}
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
