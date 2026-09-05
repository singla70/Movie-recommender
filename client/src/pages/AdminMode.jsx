import { useState, useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { ArrowUpRight, RefreshCw, WifiOff, RotateCcw } from "lucide-react";
import UploadDropzone from "../components/UploadDropzone.jsx";
import ProgressLog from "../components/ProgressLog.jsx";
import StatBar from "../components/StatBar.jsx";
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
      const data = await api.stats();
      setStats(data);
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
          Movies already in the database are updated, not duplicated.
        </p>

        {connected === false && (
          <div className="mt-4 flex items-center gap-2 rounded-md border border-gold/30 bg-gold/10 px-4 py-2.5 text-xs text-gold">
            <WifiOff size={13} strokeWidth={2} />
            Can't reach the backend right now, so uploads won't go through. Check the connection status in the sidebar.
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
                    {result.newMovies > 0 && `${result.newMovies} new movie${result.newMovies === 1 ? "" : "s"} added`}
                    {result.newMovies > 0 && result.matched > 0 && ", "}
                    {result.matched > 0 && `${result.matched} existing movie${result.matched === 1 ? "" : "s"} updated`}
                    {!result.newMovies && !result.matched && "Catalogue updated"} — searchable now.
                  </>
                ) : (
                  "Catalogue updated — new titles are searchable now."
                )}
              </p>
              <Link
                to="/query"
                className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-teal transition-colors hover:text-teal-soft"
              >
                Query it now <ArrowUpRight size={13} />
              </Link>
            </div>
          </div>
        )}

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