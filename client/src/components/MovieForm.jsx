import { useState, useEffect } from "react";

const BLANK = {
  title: "", year: "", directors: "", actors: "", genres: "",
  plot: "", sourceExcerpt: "", rating: "", oscarWon: false,
  oscarNominations: "", awards: "", language: "", country: "",
};

// Neo4j/Pinecone dono mein arrays store hote hain (directors[],
// actors[], genres[], awards[]) — form mein simple comma-separated
// text input hai (typing ke liye zyada aasan), yahan array mein
// convert karte hain submit se pehle.
function toArray(str) {
  return str.split(",").map((s) => s.trim()).filter(Boolean);
}

// movie (from getMovieById) ki arrays ko wapas comma-separated string
// mein — edit form pre-fill karne ke liye.
function movieToFormState(movie) {
  if (!movie) return BLANK;
  return {
    title: movie.title || "",
    year: movie.year ?? "",
    directors: (movie.directors || []).join(", "),
    actors: (movie.actors || []).join(", "),
    genres: (movie.genres || []).join(", "),
    plot: movie.plot || "",
    sourceExcerpt: movie.sourceExcerpt || "",
    rating: movie.rating ?? "",
    oscarWon: Boolean(movie.oscarWon),
    oscarNominations: movie.oscarNominations ?? "",
    awards: (movie.awards || []).join(", "),
    language: movie.language || "",
    country: movie.country || "",
  };
}

const inputClass =
  "w-full rounded-md border border-theatre-border bg-theatre-bg px-3 py-2 text-sm text-theatre-text placeholder:text-theatre-faint focus:border-teal/50";

function Field({ label, children }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs text-theatre-muted">{label}</span>
      {children}
    </label>
  );
}

export default function MovieForm({ initial, onSubmit, submitLabel, busy }) {
  const [form, setForm] = useState(() => movieToFormState(initial));

  useEffect(() => setForm(movieToFormState(initial)), [initial]);

  function set(key, value) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function handleSubmit(e) {
    e.preventDefault();
    onSubmit({
      title: form.title,
      year: form.year || null,
      directors: toArray(form.directors),
      actors: toArray(form.actors),
      genres: toArray(form.genres),
      plot: form.plot,
      sourceExcerpt: form.sourceExcerpt,
      rating: form.rating || null,
      oscarWon: form.oscarWon,
      oscarNominations: form.oscarNominations || 0,
      awards: toArray(form.awards),
      language: form.language || null,
      country: form.country || null,
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Title *">
          <input required className={inputClass} value={form.title} onChange={(e) => set("title", e.target.value)} />
        </Field>
        <Field label="Year">
          <input type="number" className={inputClass} value={form.year} onChange={(e) => set("year", e.target.value)} />
        </Field>
        <Field label="Director(s) — comma-separated">
          <input className={inputClass} value={form.directors} onChange={(e) => set("directors", e.target.value)} placeholder="Christopher Nolan" />
        </Field>
        <Field label="Actors — comma-separated">
          <input className={inputClass} value={form.actors} onChange={(e) => set("actors", e.target.value)} placeholder="Cillian Murphy, Emily Blunt" />
        </Field>
        <Field label="Genres — comma-separated">
          <input className={inputClass} value={form.genres} onChange={(e) => set("genres", e.target.value)} placeholder="Drama, Biography" />
        </Field>
        <Field label="Rating (out of 10)">
          <input type="number" step="0.1" className={inputClass} value={form.rating} onChange={(e) => set("rating", e.target.value)} />
        </Field>
        <Field label="Language">
          <input className={inputClass} value={form.language} onChange={(e) => set("language", e.target.value)} />
        </Field>
        <Field label="Country">
          <input className={inputClass} value={form.country} onChange={(e) => set("country", e.target.value)} />
        </Field>
        <Field label="Oscar nominations">
          <input type="number" className={inputClass} value={form.oscarNominations} onChange={(e) => set("oscarNominations", e.target.value)} />
        </Field>
        <label className="flex items-center gap-2 pt-6 text-sm text-theatre-text">
          <input type="checkbox" checked={form.oscarWon} onChange={(e) => set("oscarWon", e.target.checked)} />
          Won an Oscar
        </label>
      </div>

      <Field label="Awards — comma-separated (specific names, e.g. 'Best Picture')">
        <input className={inputClass} value={form.awards} onChange={(e) => set("awards", e.target.value)} />
      </Field>

      <Field label="Plot (short summary)">
        <textarea rows={2} className={inputClass} value={form.plot} onChange={(e) => set("plot", e.target.value)} />
      </Field>

      <Field label="Source excerpt (used for semantic search — the richer this is, the better search matches will be)">
        <textarea rows={3} className={inputClass} value={form.sourceExcerpt} onChange={(e) => set("sourceExcerpt", e.target.value)} placeholder="Falls back to the plot above if left blank." />
      </Field>

      <button
        type="submit"
        disabled={busy}
        className="rounded-md bg-gold px-4 py-2 text-sm font-medium text-theatre-bg transition-colors hover:bg-gold-soft disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? "Working…" : submitLabel}
      </button>
    </form>
  );
}