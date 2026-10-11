"use client";

import { useRef } from "react";
import { UploadCloud } from "lucide-react";
import { Button } from "@/components/ui/Button";

interface UploadDropzoneProps {
  onFilesSelected?: (files: File[]) => void;
  /** Helper text under the title. */
  hint?: string;
  busy?: boolean;
}

export function UploadDropzone({
  onFilesSelected,
  hint = "PDF, JPG or PNG. Upload is not connected in this preview.",
  busy = false,
}: UploadDropzoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="flex flex-col items-center rounded-xl border-2 border-dashed border-slate-300 bg-white px-6 py-8 text-center">
      <UploadCloud className="h-8 w-8 text-brand" aria-hidden />
      <p className="mt-3 text-sm font-semibold">Upload invoices</p>
      <p className="mt-1 text-xs text-ink-muted">{hint}</p>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept=".pdf,image/png,image/jpeg"
        className="sr-only"
        aria-label="Choose invoice files"
        onChange={(e) => {
          onFilesSelected?.(Array.from(e.target.files ?? []));
          e.target.value = "";
        }}
      />
      <Button variant="secondary" className="mt-4" loading={busy} onClick={() => inputRef.current?.click()}>
        {busy ? "Uploading" : "Choose files"}
      </Button>
    </div>
  );
}
