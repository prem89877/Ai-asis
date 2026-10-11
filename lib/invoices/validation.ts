// Server-side upload validation. Never trust the browser-supplied MIME type or filename.

// Vercel Functions reject request bodies above 4.5 MB, so uploads through route handlers stay at 4 MB.
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
export const MAX_UPLOAD_MB = 4;

export type AllowedMime = "application/pdf" | "image/jpeg" | "image/png";

export interface DetectedFile {
  mime: AllowedMime;
  ext: "pdf" | "jpg" | "png";
}

export type UploadCheck =
  | { ok: true; file: DetectedFile }
  | { ok: false; status: number; message: string };

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  return signature.every((b, i) => bytes[i] === b);
}

// Detect the real type from magic bytes.
export function detectFileType(bytes: Uint8Array): DetectedFile | null {
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return { mime: "application/pdf", ext: "pdf" };
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return { mime: "image/jpeg", ext: "jpg" };
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { mime: "image/png", ext: "png" };
  return null;
}

export function validateUpload(bytes: Uint8Array): UploadCheck {
  if (bytes.length === 0) return { ok: false, status: 400, message: "The file is empty." };
  if (bytes.length > MAX_UPLOAD_BYTES) {
    return { ok: false, status: 413, message: `File is too large. The maximum is ${MAX_UPLOAD_MB} MB.` };
  }
  const file = detectFileType(bytes);
  if (!file) return { ok: false, status: 415, message: "Only PDF, JPG and PNG files are allowed." };
  return { ok: true, file };
}

// Produces a safe display name. It is never used to build a storage path.
export function sanitizeFilename(name: string, ext: string): string {
  const last = name.split(/[\\/]/).pop() ?? "";
  const base = last
    .replace(/\.[^.]*$/, "")
    .replace(/[^A-Za-z0-9 ._()-]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/^[. ]+/, "")
    .trim()
    .slice(0, 120);
  return `${base || "invoice"}.${ext}`;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
