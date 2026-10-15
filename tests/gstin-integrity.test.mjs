// Regression tests: "AI Asis — GSTIN validation corruption bug".
// A GSTIN read from the invoice must reach the saved record, the review form and the export exactly as extracted.
// Validation may FLAG or PROPOSE; it may never silently replace a source-supported value with a guess.
import test from "node:test";
import assert from "node:assert/strict";
import { runExtraction } from "../lib/extraction/pipeline.ts";
import { normalizeExtraction } from "../lib/extraction/normalize.ts";
import { resolveParties, voteGstin } from "../lib/extraction/party-check.ts";
import { computeReviewFlags } from "../lib/review/flags.ts";
import { applyReview } from "../lib/review/apply.ts";
import { HEADER_COLUMNS } from "../lib/review/fields.ts";
import { buildTables } from "../lib/export/build.ts";
import { DEFAULT_COLUMNS, DEFAULT_ITEM_COLUMNS } from "../lib/export/columns.ts";
import { model, minimalPdf, sha, f, missing } from "./helpers.mjs";

const NOW = new Date("2026-10-11T00:00:00Z");
const OPTS = { lowConfidence: 0.8, tolerancePaise: 100 };
const pdf = minimalPdf();
const baseCfg = { apiKey: "k", model: "m", inputPricePerMTok: 0.3, outputPricePerMTok: 2.5, timeoutMs: 10_000, deadlineMs: 50_000, maxAttempts: 3, maxOutputTokens: 1000, verify: true };

const VALID = "27AAPFU0939F1ZV"; // passes layout + check digit
const PRINTED_BAD_CHECK = "27AAPFU0939F1ZW"; // layout ok, check digit fails: what an invoice with a misprinted / sample GSTIN shows

async function runPipeline(responses, config = {}) {
  const calls = { completes: [] };
  let t = Date.parse("2026-10-11T00:00:00Z"), n = 0;
  const deps = {
    geminiConfig: { ...baseCfg, ...config }, maxPdfPages: 10, now: () => t, sleep: async (ms) => { t += ms; }, random: () => 0, log: () => {},
    files: { download: async () => pdf },
    gemini: async () => { const r = responses[Math.min(n++, responses.length - 1)]; t += 1000; return { ok: true, text: JSON.stringify(r), usage: { inputTokens: 100, outputTokens: 50 } }; },
    store: { recordUsage: async () => {}, findDuplicateCandidates: async () => [], complete: async (a) => { calls.completes.push(a); return "ok"; } },
  };
  const ctx = { jobId: "j", invoiceId: "i", firmId: "f", userId: "u", storagePath: "p", mime: "application/pdf", sha256: sha(pdf) };
  const r = await runExtraction(deps, ctx);
  return { r, e: calls.completes[0].extracted };
}
const norm = (m, opts = {}) => normalizeExtraction(m, { model: "t", now: NOW, ...opts }).extracted;
const codes = (e, field) => e.review_flags.filter((x) => x.field === field).map((x) => x.code);

// ---- 1. A correctly extracted GSTIN stays unchanged ------------------------------------------------------------------------
test("1. correct GSTIN is saved unchanged, with the raw value recorded separately and no correction flag", async () => {
  const { r, e } = await runPipeline([model({ supplier_gstin: f(VALID, 0.98) })]);
  assert.equal(r.outcome, "completed");
  assert.equal(e.vendor_gstin, VALID);
  assert.equal(e.gstin_auto_corrected, false);
  assert.equal(e.field_status.supplier_gstin.rawValue, VALID);
  assert.equal(e.field_status.supplier_gstin.gstinCheck, "valid");
  assert.equal(e.field_status.supplier_gstin.autoCorrected, undefined);
  assert.deepEqual(codes(e, "supplier_gstin"), []);
});

// ---- 2. Invalid format: raw kept, flagged for review -------------------------------------------------------------------------
test("2. invalid-format GSTIN is kept as read and flagged for review", () => {
  for (const bad of ["27AAPFU0939F1", "27AAPFUO939F1ZV", "ABCDEFGHIJKLMNO"]) {
    const e = norm(model({ supplier_gstin: f(bad, 0.99) }), { agreed: new Set(["supplier_gstin"]) });
    assert.equal(e.vendor_gstin, bad);
    assert.equal(e.field_status.supplier_gstin.rawValue, bad);
    assert.equal(e.field_status.supplier_gstin.gstinCheck, "format_invalid");
    const fl = e.review_flags.find((x) => x.code === "invalid_gstin" && x.field === "supplier_gstin");
    assert.ok(fl, bad);
    assert.equal(fl.severity, "warning"); // needs review
    assert.equal(e.gstin_auto_corrected, false);
  }
});

// ---- 3. Missing GSTIN: nothing invented --------------------------------------------------------------------------------------
test("3. missing GSTIN stays empty: no value is invented, and the field is not marked valid", async () => {
  const e = norm(model({ supplier_gstin: missing() }));
  assert.equal(e.vendor_gstin, null);
  assert.equal(e.field_status.supplier_gstin.rawValue, undefined);
  assert.ok(!codes(e, "supplier_gstin").includes("gstin_auto_corrected"));
  const { e: saved } = await runPipeline([model({ supplier_gstin: missing() })]);
  assert.equal(saved.vendor_gstin, null);
});

// ---- 4. Ambiguous character ---------------------------------------------------------------------------------------------------
test("4. an ambiguous character in the first 14 characters is never swapped and never guessed; a wrong last character gets the one computed fix", () => {
  for (const printed of ["27AAPFUO939F1ZV", VALID.replace("1Z", "IZ")]) {
    const e = norm(model({ supplier_gstin: f(printed, 0.99) }), { agreed: new Set(["supplier_gstin"]) });
    assert.equal(e.vendor_gstin, printed);
    // Whatever is suggested keeps the first 14 characters exactly as read (only the last character may differ).
    for (const fl of e.review_flags.filter((x) => x.field === "supplier_gstin" && x.details?.suggestions)) for (const sg of fl.details.suggestions) assert.equal(sg.slice(0, 14), printed.slice(0, 14), printed);
    assert.ok(!e.review_flags.some((x) => x.code === "gstin_auto_corrected"));
  }
  const e = norm(model({ supplier_gstin: f("27AAPFU0939F1ZW", 0.99) }), { agreed: new Set(["supplier_gstin"]) });
  assert.equal(e.vendor_gstin, "27AAPFU0939F1ZW");
  assert.deepEqual(e.review_flags.find((x) => x.field === "supplier_gstin" && x.details?.suggestions).details.suggestions, [VALID]);
});

// ---- 5. A validator proposing another value without enough evidence ------------------------------------------------------------
test("5a. check digit fails and both readings agree (high confidence): the printed value is NOT overwritten by the computed check digit", async () => {
  const same = model({ supplier_gstin: f(PRINTED_BAD_CHECK, 0.97) });
  const { r, e } = await runPipeline([same, same]);
  assert.equal(r.outcome, "completed");
  assert.equal(e.vendor_gstin, PRINTED_BAD_CHECK);
  assert.ok(!codes(e, "supplier_gstin").includes("gstin_auto_corrected"));
  assert.equal(e.field_status.supplier_gstin.autoCorrected, undefined);
  const note = e.review_flags.find((x) => x.code === "gstin_checksum_note");
  assert.deepEqual(note.details.suggestions, [VALID]); // visible to the reviewer, not applied
});

test("5b. a GSTIN assembled character by character is only proposed (warning), the value that was read stays", () => {
  const sw = (g, i, c) => g.slice(0, i) + c + g.slice(i + 1);
  const a = model({ supplier_gstin: f(sw(VALID, 3, "B")) });
  const b = model({ supplier_gstin: f(sw(VALID, 8, "8")) });
  const p = { supplier_gstin: f(sw(VALID, 6, "V")), buyer_gstin: missing(), supplier_name: f("Acme"), buyer_name: f("Beta"), printed_gstins: [] };
  const res = resolveParties([a, b], [p], a);
  assert.equal(res.merged.supplier_gstin.value, sw(VALID, 3, "B"));
  assert.ok(!res.changed.includes("supplier_gstin"));
  assert.ok(res.flags.some((x) => x.code === "gstin_char_proposed" && x.severity === "warning" && x.details.proposed === VALID));
});

test("5c. one reading that passes the check digit does not outvote more readings that agree on another value", () => {
  const v = voteGstin([PRINTED_BAD_CHECK, PRINTED_BAD_CHECK, VALID]);
  assert.equal(v.value, null);
  assert.equal(v.status, "conflict");
  // a lone valid reading against a single different one is still decided by the check digit (a whole reading of the document)
  assert.equal(voteGstin([PRINTED_BAD_CHECK, VALID]).value, VALID);
});

test("5d. a format-valid GSTIN is not treated as authentic: the only authenticity check is the portal lookup", () => {
  const e = norm(model({ supplier_gstin: f(VALID, 0.99) }));
  assert.equal(e.field_status.supplier_gstin.gstinCheck, "valid");
  assert.ok(!e.review_flags.some((x) => /authentic|verified/.test(x.code) && x.field === "supplier_gstin")); // no "verified" claim from format alone
});

// ---- 6. Correct raw GSTIN reaches the form and the export unchanged ------------------------------------------------------------
test("6. a correct raw GSTIN reaches the review form and the CSV/XLSX export table unchanged", async () => {
  const { e } = await runPipeline([model({ supplier_gstin: f(VALID, 0.98) })]);
  // review form: header values are the saved columns; recomputing flags raises nothing about the GSTIN
  const header = { ...Object.fromEntries(HEADER_COLUMNS.map((c) => [c, null])), vendor_name: e.vendor_name, vendor_gstin: e.vendor_gstin, buyer_name: e.buyer_name, invoice_number: e.invoice_number, invoice_date: e.invoice_date, place_of_supply: e.place_of_supply, currency: e.currency, document_type: e.document_type, taxable_amount: e.taxable_amount, cgst_amount: e.cgst_amount, sgst_amount: e.sgst_amount, total_amount: e.total_amount };
  assert.equal(header.vendor_gstin, VALID);
  assert.deepEqual(computeReviewFlags(header, e.field_status, [], OPTS, NOW).filter((x) => x.field === "supplier_gstin"), []);
  // a save from the form without touching the GSTIN keeps it
  const applied = applyReview({ header, field_status: e.field_status, corrected_fields: {}, items: [] }, { header: { invoice_number: e.invoice_number } }, "u", "2026-10-13T00:00:00Z");
  assert.equal(applied.header.vendor_gstin, VALID);
  assert.equal(applied.fieldStatus.supplier_gstin.rawValue, VALID);
  // export
  const inv = { id: "11111111-1111-4111-8111-111111111111", original_filename: "a.pdf", status: "verified", created_at: "2026-10-11T04:30:00+00:00", ...e, confidence: 0.9, verified_at: null, review_flags: e.review_flags };
  const [table] = buildTables([inv], new Map(), { columns: DEFAULT_COLUMNS, itemColumns: DEFAULT_ITEM_COLUMNS, includeItems: false, format: "csv", dateFormat: "iso" });
  const col = table.headers.indexOf("Supplier GSTIN");
  assert.ok(col >= 0);
  assert.equal(table.rows[0][col], VALID);
});

test("6b. a raw GSTIN that fails its check digit also reaches the export exactly as printed", async () => {
  const same = model({ supplier_gstin: f(PRINTED_BAD_CHECK, 0.97) });
  const { e } = await runPipeline([same, same]);
  const inv = { id: "11111111-1111-4111-8111-111111111111", original_filename: "a.pdf", status: "verified", created_at: "2026-10-11T04:30:00+00:00", ...e, confidence: 0.9, verified_at: null, review_flags: e.review_flags };
  const [table] = buildTables([inv], new Map(), { columns: DEFAULT_COLUMNS, itemColumns: DEFAULT_ITEM_COLUMNS, includeItems: false, format: "csv", dateFormat: "iso" });
  assert.equal(table.rows[0][table.headers.indexOf("Supplier GSTIN")], PRINTED_BAD_CHECK);
});
