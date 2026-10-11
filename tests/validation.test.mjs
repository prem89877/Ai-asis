import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_UPLOAD_BYTES,
  detectFileType,
  sanitizeFilename,
  validateUpload,
  UUID_RE,
} from "../lib/invoices/validation.ts";
import { safeNextPath } from "../lib/security/redirect.ts";

const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0]);

test("detects allowed types by content, not by name", () => {
  assert.equal(detectFileType(pdf)?.mime, "application/pdf");
  assert.equal(detectFileType(png)?.mime, "image/png");
  assert.equal(detectFileType(jpg)?.mime, "image/jpeg");
});

test("rejects scripts, executables and spoofed files", () => {
  assert.equal(validateUpload(new TextEncoder().encode("<script>alert(1)</script>")).ok, false);
  assert.equal(validateUpload(new Uint8Array([0x4d, 0x5a, 0x90, 0x00])).ok, false); // Windows .exe
  assert.equal(validateUpload(new Uint8Array(0)).ok, false);
});

test("enforces the size limit", () => {
  const big = new Uint8Array(MAX_UPLOAD_BYTES + 1);
  big.set(pdf);
  const result = validateUpload(big);
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.status, 413);
  const exact = new Uint8Array(MAX_UPLOAD_BYTES);
  exact.set(pdf);
  assert.equal(validateUpload(exact).ok, true);
});

test("sanitizes filenames and blocks path traversal", () => {
  assert.equal(sanitizeFilename("../../etc/passwd", "pdf"), "passwd.pdf");
  assert.equal(sanitizeFilename("C:\\temp\\inv<1>.exe", "pdf"), "inv_1_.pdf");
  assert.equal(sanitizeFilename("   ", "png"), "invoice.png");
  assert.ok(sanitizeFilename("a".repeat(500), "pdf").length <= 124);
});

test("only same-site relative redirects are allowed", () => {
  assert.equal(safeNextPath("/dashboard"), "/dashboard");
  assert.equal(safeNextPath("//evil.com"), "/dashboard");
  assert.equal(safeNextPath("https://evil.com"), "/dashboard");
  assert.equal(safeNextPath("/\\evil.com"), "/dashboard");
  assert.equal(safeNextPath(null), "/dashboard");
});

test("UUID validation", () => {
  assert.ok(UUID_RE.test("123e4567-e89b-12d3-a456-426614174000"));
  assert.equal(UUID_RE.test("../../x"), false);
});
