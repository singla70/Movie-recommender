import { useState, useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { ArrowUpRight, RefreshCw, WifiOff, RotateCcw, Plus, Search, Trash2, X } from "lucide-react";
import UploadDropzone from "../components/UploadDropzone.jsx";
import ProgressLog from "../components/ProgressLog.jsx";
import StatBar from "../components/StatBar.jsx";
import MovieForm from "../components/MovieForm.jsx";
import { api } from "../api.js";

export default function AdminMode({ connected }) {
  const [stats, setStats] = useState(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [jobId, setJobId] = useState(null);
  const [stage, setStage] = useState(null);
  const [lines, setLines] = useState([]);
  const [result, setResult] = useState(null);
  const [retrying, setRetrying] = useState(false);
  const pollRef = useRef(null);

  useEffect(() => {
    refreshStats();
    return () => clearInterval(pollRef.current);
  }, []);

  async function refreshStats() {
    setStatsLoading(true);
    try {
      setStats(await api.stats());
    } catch {
      // Stats endpoint may be unavailable before first ingestion — quiet fail.
    } finally {
      setStatsLoading(false);
    }
  }

  async function handleFile(file) {
    setLines([`Uploading ${file.name}…`]);
    setResult(null);
    setStage("uploading");
    try {
      const { jobId } = await api.uploadPdf(file);
      startPolling(jobId);
    } catch (err) {
      setStage("error");
      setLines((prev) => [...prev, `Upload failed: ${err.message}`]);
    }
  }

  function startPolling(id) {
    setJobId(id);
    clearInterval(pollRef.current);
    pollRef.current = setInterval(() => pollJob(id), 1500);
  }

  async function pollJob(id) {
    try {
      const job = await api.jobStatus(id);
      setStage(job.stage);
      setLines(job.log || []);
      if (job.stage === "done" || job.stage === "error") {
        clearInterval(pollRef.current);
        if (job.stage === "done") {
          setResult(job.result);
          refreshStats();
        }
      }
    } catch {
      clearInterval(pollRef.current);
    }
  }

  async function retry() {
    if (!jobId) return;
    setRetrying(true);
    try {
      const { jobId: newJobId } = await api.retryUpload(jobId);
      setStage("queued");
      setLines((prev) => [...prev, "Retrying — resuming from whatever already completed…"]);
      startPolling(newJobId);
    } catch (err) {
      setLines((prev) => [...prev, `Retry failed: ${err.message}`]);
    } finally {
      setRetrying(false);
    }
  }

  const busy = stage && !["done", "error"].includes(stage);
  const justFinished = stage === "done";
  const failed = stage === "error";

  return (
    <div className="flex-1 overflow-y-auto px-5 py-8 md:px-8">
      <div className="mx-auto max-w-3xl">
        <h1 className="font-display text-lg text-theatre-text">Admin</h1>
        <p className="mt-1 text-xs text-theatre-muted">
          Upload a PDF of your film catalogue — it's parsed, embedded, and written into the graph and vector index.
          Movies already in the database are skipped here (no re-embedding); edit them individually below instead.
        </p>

        {connected === false && (
          <div className="mt-4 flex items-center gap-2 rounded-md border border-gold/30 bg-gold/10 px-4 py-2.5 text-xs text-gold">
            <WifiOff size={13} strokeWidth={2} />
            Can't reach the backend right now, so nothing below will go through. Check the connection status in the sidebar.
          </div>
        )}

        <div className="mt-8">
          <UploadDropzone onFile={handleFile} disabled={busy || connected === false} />
        </div>

        {(jobId || lines.length > 0) && (
          <div className="mt-6">
            <ProgressLog lines={lines} stage={stage} />
          </div>
        )}

        {failed && (
          <div className="mt-4 flex items-center justify-between gap-3 rounded-md border border-gold/30 bg-gold/10 px-4 py-3">
            <p className="text-xs text-theatre-text">
              Ingestion failed. Whatever already completed is cached — retrying resumes instead of starting over.
            </p>
            <button
              onClick={retry}
              disabled={retrying || connected === false}
              className="flex shrink-0 items-center gap-1.5 rounded-md border border-gold/40 px-3 py-1.5 text-xs font-medium text-gold transition-colors hover:bg-gold/10 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <RotateCcw size={13} strokeWidth={1.75} className={retrying ? "animate-spin" : ""} />
              Retry
            </button>
          </div>
        )}

        {justFinished && (
          <div className="mt-4 rounded-md border border-teal/30 bg-teal/10 px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-theatre-text">
                {result ? (
                  <>
                    {result.added > 0 && `${result.added} new movie${result.added === 1 ? "" : "s"} added`}
                    {result.added > 0 && result.matched > 0 && ", "}
                    {result.matched > 0 && `${result.matched} already existed (skipped)`}
                    {!result.added && !result.matched && "Nothing to add"} — searchable now.
                  </>
                ) : (
                  "Catalogue updated."
                )}
              </p>
              <Link
                to="/query"
                className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-teal transition-colors hover:text-teal-soft"
              >
                Query it now <ArrowUpRight size={13} />
              </Link>
            </div>
            {result?.failedMovies?.length > 0 && (
              <div className="mt-2 border-t border-teal/20 pt-2 text-xs text-gold">
                {result.failedMovies.length} movie(s) failed to embed and were skipped: {result.failedMovies.join(", ")}.
                Re-uploading the same PDF will retry just these (everything else is cached).
              </div>
            )}
          </div>
        )}

        <div className="sprocket-rule my-10" />

        <ManageMovies connected={connected} onChanged={refreshStats} />

        <div className="sprocket-rule my-10" />

        <div>
          <div className="flex items-center justify-between">
            <div>
              <h2 className="font-display text-base text-theatre-text">Database</h2>
              <p className="mt-1 text-xs text-theatre-muted">Current state of the graph.</p>
            </div>
            <button
              onClick={refreshStats}
              disabled={statsLoading}
              className="flex shrink-0 items-center gap-1.5 rounded-md border border-theatre-border px-3 py-1.5 text-xs text-theatre-muted transition-colors hover:border-gold/40 hover:text-theatre-text disabled:cursor-not-allowed disabled:opacity-50"
            >
              <RefreshCw size={13} strokeWidth={1.75} className={statsLoading ? "animate-spin" : ""} />
              Refresh
            </button>
          </div>
          <div className="mt-4">
            <StatBar stats={stats} />
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Add / edit / delete a single movie ─────────────────────────
function ManageMovies({ connected, onChanged }) {
  const [mode, setMode] = useState(null); // null | 'add' | 'edit'
  const [resetKey, setResetKey] = useState(0);
  const [search, setSearch] = useState("");
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState(null);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState([]);
  const [notice, setNotice] = useState(null); // { type: 'success'|'error', text }

  async function runSearch(q) {
    setSearch(q);
    setSelected(null);
    if (!q.trim()) return setResults([]);
    setSearching(true);
    try {
      const { movies } = await api.listMovies(q);
      setResults(movies);
    } catch {
      setResults([]);
    } finally {
      setSearching(false);
    }
  }

  async function pickMovie(id) {
    setBusy(true);
    try {
      setSelected(await api.getMovie(id));
    } catch (err) {
      setNotice({ type: "error", text: err.message });
    } finally {
      setBusy(false);
    }
  }

  async function handleAdd(movie) {
    setBusy(true);
    setLog([]);
    setNotice(null);
    try {
      const { log } = await api.addMovie(movie);
      setLog(log || []);
      setNotice({ type: "success", text: `"${movie.title}" added.` });
      onChanged();
    } catch (err) {
      setNotice({ type: "error", text: err.message });
    } finally {
      setBusy(false);
    }
  }

  async function handleUpdate(movie) {
    setBusy(true);
    setLog([]);
    setNotice(null);
    try {
      const { log } = await api.updateMovie(selected.id, movie);
      setLog(log || []);
      setNotice({ type: "success", text: `"${movie.title}" updated.` });
      onChanged();
    } catch (err) {
      setNotice({ type: "error", text: err.message });
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    if (!selected) return;
    if (!confirm(`Delete "${selected.title}" permanently? This removes it from both Neo4j and Pinecone.`)) return;
    setBusy(true);
    setLog([]);
    setNotice(null);
    try {
      const { log } = await api.deleteMovie(selected.id);
      setLog(log || []);
      setNotice({ type: "success", text: `"${selected.title}" deleted.` });
      setSelected(null);
      setResults((prev) => prev.filter((m) => m.id !== selected.id));
      onChanged();
    } catch (err) {
      setNotice({ type: "error", text: err.message });
    } finally {
      setBusy(false);
    }
  }

  function close() {
    setMode(null);
    setSelected(null);
    setSearch("");
    setResults([]);
    setLog([]);
    setNotice(null);
  }

  return (
    <div>
      <h2 className="font-display text-base text-theatre-text">Manage individual movies</h2>
      <p className="mt-1 text-xs text-theatre-muted">
        Add a movie by hand, or edit/delete one already in the database — changes apply to Neo4j and Pinecone together.
      </p>

      {!mode && (
        <div className="mt-4 flex gap-2">
          <button
            onClick={() => { setMode("add"); setNotice(null); setLog([]); }}
            disabled={connected === false}
            className="flex items-center gap-1.5 rounded-md border border-theatre-border px-3.5 py-2 text-xs text-theatre-text transition-colors hover:border-gold/40 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Plus size={13} strokeWidth={2} /> Add new movie
          </button>
          <button
            onClick={() => { setMode("edit"); setNotice(null); setLog([]); }}
            disabled={connected === false}
            className="flex items-center gap-1.5 rounded-md border border-theatre-border px-3.5 py-2 text-xs text-theatre-text transition-colors hover:border-gold/40 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Search size={13} strokeWidth={2} /> Edit or delete existing movie
          </button>
        </div>
      )}

      {mode === "add" && (
        <div className="mt-4 rounded-lg border border-theatre-border p-5">
          <div className="mb-4 flex items-center justify-between">
            <span className="text-xs font-medium text-theatre-text">Add new movie</span>
            <button onClick={close} className="text-theatre-faint hover:text-theatre-text"><X size={14} /></button>
          </div>
          <MovieForm key={`add-${resetKey}`} initial={null} onSubmit={handleAdd} submitLabel="Add movie" busy={busy} />
          {notice && (
            <div className={`mt-4 rounded-md border px-3 py-2 text-xs ${notice.type === "success" ? "border-teal/30 bg-teal/10 text-theatre-text" : "border-gold/30 bg-gold/10 text-gold"}`}>
              {notice.text}
            </div>
          )}
          {log.length > 0 && <div className="mt-3"><ProgressLog lines={log} stage="done" /></div>}
          {notice?.type === "success" && (
            <button
              onClick={() => { setResetKey((k) => k + 1); setNotice(null); setLog([]); }}
              className="mt-3 flex items-center gap-1.5 text-xs font-medium text-teal transition-colors hover:text-teal-soft"
            >
              <Plus size={13} strokeWidth={2} /> Add another movie
            </button>
          )}
        </div>
      )}

      {mode === "edit" && (
        <div className="mt-4 rounded-lg border border-theatre-border p-5">
          <div className="mb-4 flex items-center justify-between">
            <span className="text-xs font-medium text-theatre-text">Edit or delete existing movie</span>
            <button onClick={close} className="text-theatre-faint hover:text-theatre-text"><X size={14} /></button>
          </div>

          {!selected && (
            <>
              <input
                autoFocus
                value={search}
                onChange={(e) => runSearch(e.target.value)}
                placeholder="Search by title…"
                className="w-full rounded-md border border-theatre-border bg-theatre-bg px-3 py-2 text-sm text-theatre-text placeholder:text-theatre-faint focus:border-teal/50"
              />
              <div className="mt-2 max-h-56 overflow-y-auto">
                {searching && <p className="px-1 py-2 text-xs text-theatre-faint">Searching…</p>}
                {!searching && search.trim() && results.length === 0 && (
                  <p className="px-1 py-2 text-xs text-theatre-faint">No matches.</p>
                )}
                {results.map((m) => (
                  <button
                    key={m.id}
                    onClick={() => pickMovie(m.id)}
                    className="flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm text-theatre-text transition-colors hover:bg-theatre-surface2/60"
                  >
                    <span>{m.title}</span>
                    <span className="text-xs text-theatre-faint">{m.year}</span>
                  </button>
                ))}
              </div>
            </>
          )}

          {selected && (
            <>
              <div className="mb-4 flex items-center justify-between">
                <button onClick={() => setSelected(null)} className="text-xs text-theatre-muted hover:text-theatre-text">← Back to search</button>
                <button
                  onClick={handleDelete}
                  disabled={busy}
                  className="flex items-center gap-1.5 rounded-md border border-gold/40 px-3 py-1.5 text-xs text-gold transition-colors hover:bg-gold/10 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Trash2 size={12} strokeWidth={2} /> Delete
                </button>
              </div>
              <MovieForm initial={selected} onSubmit={handleUpdate} submitLabel="Save changes" busy={busy} />
            </>
          )}

          {notice && (
            <div className={`mt-4 rounded-md border px-3 py-2 text-xs ${notice.type === "success" ? "border-teal/30 bg-teal/10 text-theatre-text" : "border-gold/30 bg-gold/10 text-gold"}`}>
              {notice.text}
            </div>
          )}
          {log.length > 0 && <div className="mt-3"><ProgressLog lines={log} stage="done" /></div>}
        </div>
      )}
    </div>
  );
}