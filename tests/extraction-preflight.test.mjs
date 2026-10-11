import test from "node:test";
import assert from "node:assert/strict";
import { preflight } from "../lib/extraction/preflight.ts";
import { minimalPdf, png, jpeg } from "./helpers.mjs";

const pdfOpts = { expectedMime: "application/pdf", maxPdfPages: 5 };
const code = (r) => (r.ok ? "ok" : r.code);

test("valid PDF, PNG and JPEG pass", () => {
  assert.equal(code(preflight(minimalPdf(2), pdfOpts)), "ok");
  assert.equal(code(preflight(png(), { expectedMime: "image/png", maxPdfPages: 5 })), "ok");
  assert.equal(code(preflight(jpeg(), { expectedMime: "image/jpeg", maxPdfPages: 5 })), "ok");
});

test("empty, spoofed and mismatched files are rejected", () => {
  assert.equal(code(preflight(new Uint8Array(0), pdfOpts)), "empty_file");
  assert.equal(code(preflight(new TextEncoder().encode("hello"), pdfOpts)), "unsupported_type");
  assert.equal(code(preflight(png(), pdfOpts)), "unsupported_type"); // PNG bytes but DB says PDF
});

test("malformed PDFs", () => {
  const good = minimalPdf();
  assert.equal(code(preflight(good.subarray(0, good.length - 12), pdfOpts)), "malformed_pdf"); // truncated, no %%EOF
  assert.equal(code(preflight(new TextEncoder().encode("%PDF-1.4\n%%EOF\n"), pdfOpts)), "malformed_pdf"); // no objects
  const noPages = new TextEncoder().encode("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n%%EOF\n");
  assert.equal(code(preflight(noPages, pdfOpts)), "malformed_pdf");
});

test("page objects inside object streams are not mistaken for an empty PDF", () => {
  const stream = new TextEncoder().encode("%PDF-1.5\n1 0 obj\n<< /Type /ObjStm /N 3 >>\nendobj\ntrailer\n%%EOF\n");
  const r = preflight(stream, pdfOpts);
  assert.equal(r.ok, true);
  assert.equal(r.pages, null);
});

test("encrypted and over-long PDFs", () => {
  assert.equal(code(preflight(minimalPdf(1, "<< /Encrypt 9 0 R >>\n"), pdfOpts)), "password_protected");
  assert.equal(code(preflight(minimalPdf(6), pdfOpts)), "too_many_pages");
  assert.equal(code(preflight(minimalPdf(5), pdfOpts)), "ok");
});

test("damaged and tiny images", () => {
  const o = { expectedMime: "image/png", maxPdfPages: 5 };
  assert.equal(code(preflight(png(400, 400, { truncate: true }), o)), "unreadable_image");
  assert.equal(code(preflight(png(100, 100), o)), "image_too_small");
  const j = { expectedMime: "image/jpeg", maxPdfPages: 5 };
  assert.equal(code(preflight(jpeg(400, 400, { truncate: true }), j)), "unreadable_image");
  assert.equal(code(preflight(jpeg(400, 400, { noSof: true }), j)), "unreadable_image");
  assert.equal(code(preflight(jpeg(120, 800), j)), "image_too_small");
});
