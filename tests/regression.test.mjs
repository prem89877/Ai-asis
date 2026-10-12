// Regression tests: core flows from Phase 1 to 6 plus every earlier bug that can be checked in plain Node.
// Bugs covered here are the ones recorded in the code or docs (see docs/PHASE6_PART2_RELEASE.md, "Regression map").
// SQL-level fixes (quota loophole, advisory-lock contention) are in supabase/tests/phase5_billing.test.sql.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { validateUpload, sanitizeFilename } from "../lib/invoices/validation.ts";
import { normalizeExtraction } from "../lib/extraction/normalize.ts";
import { reviewState, hasExtractedData } from "../lib/review/status.ts";
import { buildTables } from "../lib/export/build.ts";
import { toCsv } from "../lib/export/csv.ts";
import { toXlsx } from "../lib/export/xlsx.ts";
import { DEFAULT_COLUMNS } from "../lib/export/columns.ts";
import { allowUnpaidUpgrades } from "../lib/billing/flags.ts";
import { model, f, minimalPdf } from "./helpers.mjs";
import { setup } from "./helpers/route-harness.mjs";

setup(); // lets run.ts (extensionless imports) load under plain node --test
const { istStamp } = await import("../lib/export/run.ts");

const root = new URL("..", import.meta.url);
const NOW = new Date("2026-10-11T00:00:00Z");

// -------------------------------------------------------------- core flow: upload -> extract -> review -> export
test("core flow: PDF accepted -> normalised extraction -> clean review state -> exact amounts in the exported CSV", () => {
  assert.equal(validateUpload(minimalPdf()).ok, true);
  const { extracted, items } = normalizeExtraction(model({ invoice_number: f("0012") }), { model: "test", now: NOW });
  assert.equal(extracted.invoice_number, "0012", "leading zeros survive normalisation");
  const inv = { id: "i1", original_filename: "a.pdf", status: "completed", created_at: "2026-10-11T04:30:00+00:00", ...extracted, tax_total: 180, review_flags: [], verified_at: null };
  assert.equal(hasExtractedData(inv.status), true);
  assert.equal(reviewState(inv.status), "needs_review", "'completed' is not 'verified'");
  const csv = new TextDecoder().decode(toCsv(buildTables([inv], new Map([["i1", items]]), { format: "csv", columns: DEFAULT_COLUMNS, itemColumns: [], includeItems: false })[0], "iso"));
  assert.match(csv, /0012/);
  assert.match(csv, /1180\.00|1180/);
  assert.ok(!/1,180/.test(csv), "no thousands separators in numbers");
});

test("core flow: every sample invoice in tests/fixtures is a valid upload and has a truth file with the key fields", () => {
  const dir = new URL("tests/fixtures/", root);
  const pdfs = readdirSync(dir).filter((n) => n.endsWith(".pdf"));
  assert.ok(pdfs.length >= 4);
  for (const n of pdfs) {
    assert.equal(validateUpload(new Uint8Array(readFileSync(new URL(n, dir)))).ok, true, `${n} must pass upload validation`);
    const truth = JSON.parse(readFileSync(new URL(n.replace(/\.pdf$/, ".truth.json"), dir), "utf8"));
    assert.ok("invoice_number" in truth, `${n}: truth.invoice_number`);
  }
});

// -------------------------------------------------------------- regressions
test("regression: TEMP-DEBUG error detail is off by default and can never be switched on in a production build", async () => {
  const saved = { NODE_ENV: process.env.NODE_ENV, F: process.env.AI_ASIS_DEBUG_ERRORS };
  try {
    delete process.env.AI_ASIS_DEBUG_ERRORS; process.env.NODE_ENV = "development";
    assert.equal((await import("../lib/api/debug.ts?a")).DEBUG_ERRORS, false, "off by default, even in development");
    process.env.AI_ASIS_DEBUG_ERRORS = "1"; process.env.NODE_ENV = "production";
    assert.equal((await import("../lib/api/debug.ts?b")).DEBUG_ERRORS, false, "ignored in production");
    process.env.NODE_ENV = "development";
    assert.equal((await import("../lib/api/debug.ts?c")).DEBUG_ERRORS, true, "only with next dev AND the flag");
  } finally {
    process.env.NODE_ENV = saved.NODE_ENV; if (saved.F === undefined) delete process.env.AI_ASIS_DEBUG_ERRORS; else process.env.AI_ASIS_DEBUG_ERRORS = saved.F;
  }
});

test("regression: no TEMP-DEBUG markers or raw browser error dumps remain in source", () => {
  const dialog = readFileSync(new URL("components/dashboard/ExportDialog.tsx", root), "utf8");
  assert.ok(!dialog.includes("TEMP-DEBUG"));
  assert.ok(!dialog.includes("RAW:"), "raw response bodies are not shown to users");
  assert.ok(!/Browser error:/.test(dialog));
});

test("regression: export file names include seconds, so two exports in one minute never collide", () => {
  const a = istStamp(new Date("2026-10-11T04:30:05Z")), b = istStamp(new Date("2026-10-11T04:30:06Z"));
  assert.match(a, /^\d{8}-\d{6}$/);
  assert.notEqual(a, b);
  assert.equal(a, "20261011-100005", "India time (UTC+5:30)");
});

test("regression: spreadsheet formula injection is neutralised in CSV and stored as text in XLSX", () => {
  const inv = { id: "i1", original_filename: "a.pdf", status: "verified", created_at: "2026-10-11T04:30:00+00:00", vendor_name: "=HYPERLINK(\"http://evil\")", vendor_gstin: "27AAPFU0939F1ZV", buyer_name: "+cmd|' /C calc'!A0", buyer_gstin: null, invoice_number: "@SUM(1)", invoice_date: "2026-09-15", place_of_supply: null, currency: "INR", document_type: "tax_invoice", taxable_amount: 1, discount_amount: null, cgst_amount: null, sgst_amount: null, igst_amount: null, cess_amount: null, tax_total: null, total_amount: 1, confidence: 1, review_flags: [], verified_at: null };
  const cols = ["vendor_name", "buyer_name", "invoice_number"];
  const t = buildTables([inv], new Map(), { format: "csv", columns: cols, itemColumns: [], includeItems: false });
  const csv = new TextDecoder().decode(toCsv(t[0], "iso"));
  for (const line of csv.split("\r\n").slice(1)) assert.ok(!/^["]?[=+@-]/.test(line), line);
  assert.ok(toXlsx(t, "iso").length > 100);
});

test("regression: an unpaid plan upgrade can never be applied in production, on Vercel or elsewhere", () => {
  const on = { BILLING_ALLOW_UNPAID_UPGRADES: "true" };
  assert.equal(allowUnpaidUpgrades({ ...on, VERCEL_ENV: "production" }), false);
  assert.equal(allowUnpaidUpgrades({ ...on, NODE_ENV: "production" }), false);
  assert.equal(allowUnpaidUpgrades({ ...on, NODE_ENV: "development" }), true);
});

test("regression: file names cannot escape the firm folder and uploads are judged by content", () => {
  assert.equal(sanitizeFilename("../../../etc/passwd", "pdf"), "passwd.pdf");
  assert.equal(validateUpload(new TextEncoder().encode("<?php system($_GET[1]); ?>")).ok, false);
});

test("regression: Supabase migration files use short, ordered names 001_ ... with no gaps or duplicates (phase5_part2.sql problem)", () => {
  const files = readdirSync(new URL("supabase/migrations/", root)).filter((n) => !n.startsWith("."));
  assert.ok(files.length >= 10);
  for (const n of files) assert.match(n, /^\d{3}_[a-z0-9_]+\.sql$/, `migration name: ${n}`);
  const nums = files.map((n) => Number(n.slice(0, 3))).sort((a, b) => a - b);
  nums.forEach((n, i) => assert.equal(n, i + 1, `migration numbers must be 001..${nums.length} without gaps or duplicates`));
  // The enum migration must run (and commit) before the file that uses its values.
  assert.ok(files.indexOf(files.find((n) => n.includes("extraction_enums"))) < files.indexOf(files.find((n) => /_extraction\.sql$/.test(n))));
});

test("regression: every phase has its setup document and the SQL test files named in the docs exist", () => {
  for (const d of ["PHASE2_SETUP", "PHASE3_SETUP", "PHASE4_SETUP", "PHASE5_SETUP", "PHASE6_PART1_SETUP"]) assert.ok(existsSync(new URL(`docs/${d}.md`, root)), d);
  for (const t of ["phase2_isolation", "phase3_extraction", "phase4_review_export", "phase5_billing", "phase6_integrations"]) assert.ok(existsSync(new URL(`supabase/tests/${t}.test.sql`, root)), t);
});
