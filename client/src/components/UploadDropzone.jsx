import { useCallback, useRef, useState } from "react";
import { UploadCloud, FileText } from "lucide-react";

export default function UploadDropzone({ onFile, disabled }) {
  const [isDragging, setIsDragging] = useState(false);
  const [fileName, setFileName] = useState(null);
  const inputRef = useRef(null);

  const handleFiles = useCallback(
    (fileList) => {
      if (disabled) return;
      const file = fileList?.[0];
      if (!file) return;
      if (file.type !== "application/pdf") return;
      setFileName(file.name);
      onFile?.(file);
    },
    [disabled, onFile]
  );

  return (
    <div
      onClick={() => !disabled && inputRef.current?.click()}
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setIsDragging(true);
      }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setIsDragging(false);
        handleFiles(e.dataTransfer.files);
      }}
      className={`flex cursor-pointer flex-col items-center justify-center gap-2.5 rounded-lg border border-dashed px-6 py-10 text-center transition-colors ${
        disabled
          ? "cursor-not-allowed border-theatre-border/60 opacity-50"
          : isDragging
          ? "border-teal/60 bg-teal/5"
          : "border-theatre-border hover:border-gold/40"
      }`}
    >
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf"
        className="hidden"
        disabled={disabled}
        onChange={(e) => handleFiles(e.target.files)}
      />

      {fileName ? (
        <FileText size={22} className="text-gold" strokeWidth={1.75} />
      ) : (
        <UploadCloud size={22} className="text-theatre-muted" strokeWidth={1.75} />
      )}

      <div>
        <p className="text-sm text-theatre-text">
          {fileName ? fileName : "Drop a PDF here, or click to browse"}
        </p>
        <p className="mt-1 text-xs text-theatre-muted">
          {disabled ? "Ingestion in progress…" : "PDF files only, up to 50MB"}
        </p>
      </div>
    </div>
  );
}
