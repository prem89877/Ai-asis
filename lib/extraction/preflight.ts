// Cheap local checks before any money is spent on the AI provider.
// These are heuristics for obviously broken files. They are not a full PDF/image parser.
import { detectFileType } from "../invoices/validation.ts";
import type { ExtractionErrorCode } from "./errors.ts";

export interface PreflightOptions {
  expectedMime: string;
  maxPdfPages: number;
  minImageSide?: number; // pixels
  maxImageSide?: number;
}

export type PreflightResult =
  | { ok: true; kind: "pdf" | "image"; pages: number | null; width?: number; height?: number }
  | { ok: false; code: ExtractionErrorCode };

function latin1(bytes: Uint8Array, start: number, end: number): string {
  let out = "";
  for (let i = Math.max(0, start); i < Math.min(bytes.length, end); i++) out += String.fromCharCode(bytes[i]);
  return out;
}

function checkPdf(bytes: Uint8Array, opts: PreflightOptions): PreflightResult {
  const head = latin1(bytes, 0, 1024);
  const tail = latin1(bytes, bytes.length - 2048, bytes.length);
  if (!head.startsWith("%PDF-")) return { ok: false, code: "malformed_pdf" };
  // A complete PDF ends with %%EOF; truncated downloads and broken exports do not.
  if (!tail.includes("%%EOF")) return { ok: false, code: "malformed_pdf" };

  const body = latin1(bytes, 0, bytes.length);
  if (!/\bobj\b/.test(body) || !/\bendobj\b/.test(body)) return { ok: false, code: "malformed_pdf" };
  if (/\/Encrypt\b/.test(body)) return { ok: false, code: "password_protected" };

  const pageMatches = body.match(/\/Type\s*\/Page(?![A-Za-z])/g);
  const pages = pageMatches ? pageMatches.length : 0;
  const hasObjectStreams = /\/ObjStm\b/.test(body);
  if (pages === 0) {
    // Page objects may be hidden inside compressed object streams; only then is "no pages" not proof of damage.
    if (!hasObjectStreams) return { ok: false, code: "malformed_pdf" };
    return { ok: true, kind: "pdf", pages: null };
  }
  if (pages > opts.maxPdfPages) return { ok: false, code: "too_many_pages" };
  return { ok: true, kind: "pdf", pages };
}

function checkPng(bytes: Uint8Array, opts: PreflightOptions): PreflightResult {
  // signature (8) + IHDR length (4) + "IHDR" (4) + width (4) + height (4)
  if (bytes.length < 33) return { ok: false, code: "unreadable_image" };
  if (latin1(bytes, 12, 16) !== "IHDR") return { ok: false, code: "unreadable_image" };
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = dv.getUint32(16);
  const height = dv.getUint32(20);
  // A complete PNG ends with an IEND chunk (length 0, "IEND", CRC).
  if (latin1(bytes, bytes.length - 8, bytes.length - 4) !== "IEND") return { ok: false, code: "unreadable_image" };
  return checkDimensions("image", width, height, opts);
}

const JPEG_SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function checkJpeg(bytes: Uint8Array, opts: PreflightOptions): PreflightResult {
  let i = 2;
  let width = 0;
  let height = 0;
  while (i + 3 < bytes.length) {
    if (bytes[i] !== 0xff) return { ok: false, code: "unreadable_image" };
    const marker = bytes[i + 1];
    if (marker === 0xff) {
      i += 1; // fill byte
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    if (len < 2) return { ok: false, code: "unreadable_image" };
    if (JPEG_SOF.has(marker)) {
      if (i + 8 >= bytes.length) return { ok: false, code: "unreadable_image" };
      height = (bytes[i + 5] << 8) | bytes[i + 6];
      width = (bytes[i + 7] << 8) | bytes[i + 8];
      break;
    }
    if (marker === 0xda) break; // start of scan before any SOF: damaged
    i += 2 + len;
  }
  if (!width || !height) return { ok: false, code: "unreadable_image" };
  // A complete JPEG ends with the EOI marker (FF D9); allow a few trailing zero bytes.
  let end = bytes.length;
  while (end > 2 && bytes[end - 1] === 0 && bytes.length - end < 16) end--;
  if (!(bytes[end - 2] === 0xff && bytes[end - 1] === 0xd9)) return { ok: false, code: "unreadable_image" };
  return checkDimensions("image", width, height, opts);
}

function checkDimensions(kind: "image", width: number, height: number, opts: PreflightOptions): PreflightResult {
  const min = opts.minImageSide ?? 300;
  const max = opts.maxImageSide ?? 20000;
  if (!width || !height || width > max || height > max) return { ok: false, code: "unreadable_image" };
  if (Math.min(width, height) < min) return { ok: false, code: "image_too_small" };
  return { ok: true, kind, pages: null, width, height };
}

export function preflight(bytes: Uint8Array, opts: PreflightOptions): PreflightResult {
  if (bytes.length === 0) return { ok: false, code: "empty_file" };
  const detected = detectFileType(bytes);
  if (!detected || detected.mime !== opts.expectedMime) return { ok: false, code: "unsupported_type" };
  if (detected.mime === "application/pdf") return checkPdf(bytes, opts);
  if (detected.mime === "image/png") return checkPng(bytes, opts);
  return checkJpeg(bytes, opts);
}
