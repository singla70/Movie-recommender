import { useEffect, useRef } from "react";

export default function ProgressLog({ lines, stage }) {
  const ref = useRef(null);

  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [lines]);

  const stageLabel = {
    parsing: "Parsing PDF",
    embedding: "Generating embeddings",
    loading: "Writing to Pinecone + Neo4j",
    done: "Complete",
    error: "Failed",
  }[stage] || "Starting";

  return (
    <div className="rounded-lg border border-theatre-border bg-theatre-surface">
      <div className="flex items-center justify-between border-b border-theatre-border px-4 py-2.5">
        <span className="text-xs text-theatre-muted">{stageLabel}</span>
        {stage && stage !== "done" && stage !== "error" && (
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-teal" />
        )}
      </div>
      <div ref={ref} className="max-h-64 overflow-y-auto px-4 py-3 font-mono text-xs leading-relaxed text-theatre-muted">
        {lines.length === 0 ? (
          <span className="text-theatre-faint">Log output will appear here…</span>
        ) : (
          lines.map((line, i) => <div key={i}>{line}</div>)
        )}
      </div>
    </div>
  );
}
