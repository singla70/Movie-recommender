import { useState, useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { ArrowUpRight, RefreshCw, WifiOff } from "lucide-react";
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
    setStage("uploading");
    try {
      const { jobId } = await api.uploadPdf(file);
      setJobId(jobId);
      pollRef.current = setInterval(() => pollJob(jobId), 1500);
    } catch (err) {
      setStage("error");
      setLines((prev) => [...prev, `Upload failed: ${err.message}`]);
    }
  }

  async function pollJob(id) {
    try {
      const job = await api.jobStatus(id);
      setStage(job.stage);
      setLines(job.log || []);
      if (job.stage === "done" || job.stage === "error") {
        clearInterval(pollRef.current);
        if (job.stage === "done") refreshStats();
      }
    } catch {
      clearInterval(pollRef.current);
    }
  }

  const busy = stage && stage !== "done" && stage !== "error";
  const justFinished = stage === "done";

  return (
    <div className="flex-1 overflow-y-auto px-5 py-8 md:px-8">
      <div className="mx-auto max-w-3xl">
        <h1 className="font-display text-lg text-theatre-text">Admin</h1>
        <p className="mt-1 text-xs text-theatre-muted">
          Upload a PDF of your film catalogue — it's parsed, embedded, and written into the graph and vector index.
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

        {justFinished && (
          <div className="mt-4 flex items-center justify-between gap-3 rounded-md border border-teal/30 bg-teal/10 px-4 py-3">
            <p className="text-xs text-theatre-text">Catalogue updated — new titles are searchable now.</p>
            <Link
              to="/query"
              className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-teal transition-colors hover:text-teal-soft"
            >
              Query it now <ArrowUpRight size={13} />
            </Link>
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