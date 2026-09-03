import { useState, useEffect, useRef } from "react";
import UploadDropzone from "../components/UploadDropzone.jsx";
import ProgressLog from "../components/ProgressLog.jsx";
import StatBar from "../components/StatBar.jsx";
import { api } from "../api.js";

export default function AdminMode() {
  const [stats, setStats] = useState(null);
  const [jobId, setJobId] = useState(null);
  const [stage, setStage] = useState(null);
  const [lines, setLines] = useState([]);
  const pollRef = useRef(null);

  useEffect(() => {
    refreshStats();
    return () => clearInterval(pollRef.current);
  }, []);

  async function refreshStats() {
    try {
      const data = await api.stats();
      setStats(data);
    } catch {
      // Stats endpoint may be unavailable before first ingestion — quiet fail.
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

  return (
    <div className="flex-1 overflow-y-auto px-8 py-8">
      <div className="mx-auto max-w-3xl">
        <h1 className="font-display text-lg text-theatre-text">Admin</h1>
        <p className="mt-1 text-xs text-theatre-muted">
          Upload a PDF of your film catalogue — it's parsed, embedded, and written into the graph and vector index.
        </p>

        <div className="mt-8">
          <UploadDropzone onFile={handleFile} disabled={busy} />
        </div>

        {(jobId || lines.length > 0) && (
          <div className="mt-6">
            <ProgressLog lines={lines} stage={stage} />
          </div>
        )}

        <div className="sprocket-rule my-10" />

        <div>
          <h2 className="font-display text-base text-theatre-text">Database</h2>
          <p className="mt-1 text-xs text-theatre-muted">Current state of the graph.</p>
          <div className="mt-4">
            <StatBar stats={stats} />
          </div>
        </div>
      </div>
    </div>
  );
}
