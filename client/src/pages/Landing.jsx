import { Link } from "react-router-dom";
import { Film, ArrowUpRight, Network, MessagesSquare, Database } from "lucide-react";
import GraphHero from "../components/GraphHero.jsx";

const notes = [
  {
    icon: Network,
    title: "Two databases, one answer",
    body: "Vector search finds films by feel — mood, theme, plot. The graph finds them by fact — director, cast, awards. Every query picks the right one, or both.",
  },
  {
    icon: MessagesSquare,
    title: "Conversational, not just a search box",
    body: "Ask a follow-up, refine a list, compare two films — the assistant keeps the thread and explains why a result matches.",
  },
  {
    icon: Database,
    title: "Bring your own catalogue",
    body: "Upload a PDF of your film library and the pipeline extracts structure — cast, genre, awards — into a queryable graph.",
  },
];

export default function Landing() {
  return (
    <div className="min-h-screen bg-theatre-bg">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-6">
        <div className="flex items-center gap-2.5">
          <Film size={20} className="text-gold" strokeWidth={1.75} />
          <span className="font-display text-lg tracking-tight">Cinegraph</span>
        </div>
        <Link
          to="/query"
          className="rounded-md border border-theatre-border px-4 py-2 text-sm text-theatre-text transition-colors hover:border-gold/50 hover:text-gold"
        >
          Enter app
        </Link>
      </header>

      <main className="mx-auto max-w-6xl px-6 pb-24 pt-12 md:pt-20">
        <div className="grid items-center gap-12 md:grid-cols-2">
          <div>
            <h1 className="font-display text-5xl leading-[1.08] tracking-tight text-theatre-text md:text-6xl">
              Every film,
              <br />
              connected.
            </h1>
            <p className="mt-6 max-w-md text-base leading-relaxed text-theatre-muted">
              Cinegraph pairs a movie knowledge graph with semantic search, so you can ask
              for a film the way you'd describe it to a friend, or trace it through the
              people and awards that made it.
            </p>
            <div className="mt-9 flex flex-wrap items-center gap-4">
              <Link
                to="/query"
                className="inline-flex items-center gap-1.5 rounded-md bg-gold px-5 py-2.5 text-sm font-medium text-theatre-bg transition-colors hover:bg-gold-soft"
              >
                Start a query
              </Link>
              <Link
                to="/admin"
                className="inline-flex items-center gap-1 text-sm text-theatre-muted transition-colors hover:text-theatre-text"
              >
                Upload a catalogue <ArrowUpRight size={14} />
              </Link>
            </div>
          </div>

          <div className="h-72 md:h-80">
            <GraphHero />
          </div>
        </div>

        <div className="sprocket-rule mt-20 mb-12" />

        <div className="grid gap-10 md:grid-cols-3">
          {notes.map(({ icon: Icon, title, body }) => (
            <div key={title}>
              <Icon size={18} className="text-teal" strokeWidth={1.75} />
              <h3 className="mt-3 font-display text-lg text-theatre-text">{title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-theatre-muted">{body}</p>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
