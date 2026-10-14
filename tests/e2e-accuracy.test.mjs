// End-to-end verification of Parts 1-3 working together (dynamic prompt -> structured extraction -> suspicious-field detection ->
// source-grounded re-read -> evidence-backed correction -> saved record -> review form / table mapping -> export and Tally).
// The provider is a SCRIPTED stub (tests/helpers/pipeline-harness.mjs): these tests prove what the pipeline's CODE does with given
// readings. They do not prove how the real Gemini model behaves. Nothing here touches the network.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run, ok, BASE_CFG } from "./helpers/pipeline-harness.mjs";
import { invoice, set, BUYER_GSTIN_MH, BUYER_GSTIN_KA, SUPPLIER_GSTIN } from "./helpers/invoice-builder.mjs";
import { oracle } from "./helpers/oracle.mjs";
import { SCENARIOS } from "./helpers/eval-dataset.mjs";
import { SYSTEM_PROMPT } from "../lib/extraction/prompt.ts";
import { getCheckConfig, getFxConfig, getGeminiConfig } from "../lib/extraction/config.ts";
import { gstinIsValid } from "../lib/extraction/party-check.ts";
import { gstChecks } from "../lib/review/gst.ts";
import { HEADER_FIELDS, ITEM_FIELDS } from "../lib/review/fields.ts";
import { buildTables } from "../lib/export/build.ts";
import { toCsv } from "../lib/export/csv.ts";
import { toXlsx } from "../lib/export/xlsx.ts";
import { DEFAULT_COLUMNS, DEFAULT_ITEM_COLUMNS } from "../lib/export/columns.ts";
import { DEFAULT_TALLY_CONFIG, buildVouchers, toTallyXml, voucherBalance } from "../lib/tally/build.ts";
import { allowUnpaidUpgrades } from "../lib/billing/flags.ts";
import { f, missing } from "./helpers.mjs";
import { toExportRow } from "./helpers/pipeline-harness.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sc = (id) => SCENARIOS.find((s) => s.id === id);
const runScenario = (id, over = {}) => { const s = sc(id); return run({ reading: s.reading, answers: { verify: s.layers?.verify, audit: s.layers?.audit, source: s.source }, file: s.file, pages: s.pages ?? 1, ...over }); };
const itemsForExport = (items) => items.map((it, i) => ({ invoice_id: "11111111-1111-4111-8111-111111111111", position: i + 1, description: it.description, hsn_code: it.hsn_code, quantity: it.quantity, unit: it.unit, unit_price: it.unit_price, discount_amount: it.discount_amount, taxable_amount: it.taxable_amount, gst_rate: it.gst_rate, gst_amount: it.gst_amount, line_total: it.line_total }));
const exportRoundTrip = (r) => {
  const row = toExportRow(r.extracted);
  const tables = buildTables([row], new Map([[row.id, itemsForExport(r.items)]]), { format: "xlsx", columns: [...DEFAULT_COLUMNS], itemColumns: [...DEFAULT_ITEM_COLUMNS], includeItems: true });
  const csv = new TextDecoder().decode(toCsv(tables[0], "iso"));
  const xlsx = toXlsx(tables, "iso", new Date("2026-10-14T00:00:00Z"));
  return { row, tables, csv, xlsx };
};
const clean = (v) => JSON.parse(JSON.stringify(v));

// ---- 1. The whole workflow ------------------------------------------------------------------------------------------------------------

test("e2e: a clear GST invoice goes through every layer, costs no source call, saves exactly what is printed, and exports", async () => {
  const r = await runScenario("clear-intra-state");
  assert.equal(r.result.outcome, "completed");
  assert.deepEqual(r.state.calls.map((c) => c.role), ["first", "verify", "audit", "keyfigures", "parties"]); // no source call: nothing suspicious
  assert.equal(r.extracted.validation_summary.source_verification.status, "not_needed");
  const t = sc("clear-intra-state").truth;
  assert.equal(r.extracted.total_amount, t.grand_total.value);
  assert.equal(r.extracted.taxable_amount, t.taxable_value.value);
  assert.equal(r.extracted.vendor_gstin, SUPPLIER_GSTIN);
  assert.equal(r.items.length, 3);
  assert.deepEqual(r.items.map((i) => i.quantity), [2, 10, 5]);
  assert.equal(r.saved.outcome, "completed");
  // form / table mapping: every editable column the review form reads exists on the saved record, every item column on every item
  for (const h of HEADER_FIELDS) assert.ok(h.column in r.extracted, `saved invoice lacks column ${h.column}`);
  for (const i of ITEM_FIELDS) for (const it of r.items) assert.ok(i.key in it, `saved item lacks column ${i.key}`);
  for (const h of HEADER_FIELDS) if (h.statusKey !== "document_type") assert.ok(h.statusKey in r.extracted.field_status, `field_status lacks ${h.statusKey}`); // review/apply.ts keeps document_type out of field_status
  // export compatibility: CSV, XLSX (zip signature) and Tally
  const x = exportRoundTrip(r);
  assert.match(x.csv, /INV-001/);
  assert.ok(x.csv.includes(t.grand_total.value.toFixed(2)));
  assert.equal(x.tables[1].rows.length, 3);
  assert.deepEqual(Array.from(x.xlsx.subarray(0, 2)), [0x50, 0x4b]);
  const { vouchers, skipped } = buildVouchers([x.row], DEFAULT_TALLY_CONFIG);
  assert.equal(skipped.length, 0);
  assert.equal(voucherBalance(vouchers[0]), 0);
  assert.ok(toTallyXml(vouchers, DEFAULT_TALLY_CONFIG).includes("<DATE>20260915</DATE>"));
});

test("e2e: a wrong total repeated by every reading is re-read from the source, corrected with proof, the original kept, and the corrected value is what is exported", async () => {
  const r = await runScenario("total-wrong-all-layers");
  const t = sc("total-wrong-all-layers");
  assert.equal(r.result.outcome, "completed");
  assert.deepEqual(r.callsBy("source").length, 1);
  assert.equal(r.extracted.total_amount, t.truth.grand_total.value);
  assert.deepEqual(r.extracted.field_status.grand_total.autoCorrected, { from: String(t.reading.grand_total.value), to: String(t.truth.grand_total.value) });
  assert.equal(r.extracted.field_status.grand_total.source, "source_check");
  assert.equal(r.extracted.raw_extraction.grand_total.value, t.reading.grand_total.value); // the first reading is untouched
  assert.equal(r.extracted.review_flags.some((x) => x.code === "arithmetic_total_mismatch"), false);
  const entry = r.extracted.validation_summary.source_verification.entries.find((e) => e.field === "grand_total");
  assert.equal(entry.outcome, "corrected");
  assert.ok(entry.proof.length > 0 && entry.evidence.printed_text.length > 0 && entry.evidence.page === 1 && entry.evidence.confidence >= 0.9);
  const x = exportRoundTrip(r);
  assert.ok(x.csv.includes(t.truth.grand_total.value.toFixed(2)) && !x.csv.includes(t.reading.grand_total.value.toFixed(2)));
  const { vouchers, skipped } = buildVouchers([x.row], DEFAULT_TALLY_CONFIG);
  assert.equal(skipped.length, 0);
  assert.equal(voucherBalance(vouchers[0]), 0);
});

test("e2e: the source re-read is blind (saved value never sent), uses the original bytes at high resolution, and the dynamic prompt keeps the fixed prompt intact", async () => {
  const r = await runScenario("total-wrong-all-layers");
  const call = r.callsBy("source")[0].input;
  assert.equal(call.highResolution, true);
  assert.ok(!call.userPrompt.includes(String(sc("total-wrong-all-layers").reading.grand_total.value)));
  assert.deepEqual(Array.from(call.data), Array.from(r.bytes));
  const first = r.callsBy("first")[0].input.systemPrompt;
  assert.ok(first.startsWith(SYSTEM_PROMPT.replace(/\s*Return JSON only\.\s*$/, "")));
  assert.ok(first.endsWith("Return JSON only."));
});

// ---- 2. Test cases ----------------------------------------------------------------------------------------------------------------------

test("clear Indian GST invoices: intra-state, inter-state (IGST) and cess / zero-rated all complete with no corrections", async () => {
  for (const id of ["clear-intra-state", "clear-inter-state-igst", "clear-cess-zero-rated"]) {
    const r = await runScenario(id);
    assert.equal(r.result.outcome, "completed", id);
    assert.equal(r.callsBy("source").length, 0, id);
    assert.equal(r.extracted.review_flags.filter((x) => x.severity !== "info").length, 0, id);
    assert.equal(r.extracted.total_amount, sc(id).truth.grand_total.value, id);
  }
  const inter = await runScenario("clear-inter-state-igst");
  assert.equal(inter.extracted.igst_amount, sc("clear-inter-state-igst").truth.igst.value);
  assert.equal(inter.extracted.cgst_amount, null);
});

test("blurry or poorly scanned: a re-read that is unreadable, low-confidence or ambiguous changes nothing and sends the invoice to a person", async () => {
  const wrongTotal = sc("digits-total-misread").reading.grand_total.value;
  for (const mode of ["unreadable", "lowconf", "ambiguous", "none"]) {
    const r = await run({ reading: sc("digits-total-misread").reading, answers: { source: oracle(sc("digits-total-misread").truth, { mode }) } });
    assert.equal(r.extracted.total_amount, wrongTotal, mode);
    assert.equal(r.result.outcome, "needs_review", mode);
    assert.equal(r.extracted.field_status.grand_total.autoCorrected, undefined, mode);
  }
  // an unreadable total is never filled in from a single re-read
  const blurry = await runScenario("blurry-total-unreadable-reread-ok");
  assert.equal(blurry.extracted.total_amount, null);
  assert.ok(blurry.extracted.review_flags.some((x) => x.code === "source_verify_unresolved" && x.field === "grand_total"));
  assert.equal(blurry.result.outcome, "needs_review");
  // correct values that merely have low confidence are confirmed, not "corrected"
  const lowConf = await runScenario("blurry-correct-values-low-confidence");
  assert.equal(lowConf.extracted.total_amount, sc("blurry-correct-values-low-confidence").truth.grand_total.value);
  assert.equal(lowConf.extracted.review_flags.filter((x) => x.code === "source_verify_corrected").length, 0);
  // a phone photo (PNG) takes the same path
  const photo = await runScenario("photo-png-wrong-total");
  assert.equal(photo.callsBy("source")[0].input.mime, "image/png");
  assert.equal(photo.extracted.total_amount, sc("photo-png-wrong-total").truth.grand_total.value);
  assert.match(photo.callsBy("first")[0].input.systemPrompt, /image \(scan or phone photo\)/);
});

test("similar-looking digits and decimal errors that every reading repeated are corrected from the source, one field each", async () => {
  for (const id of ["digits-total-misread", "digits-unit-price-500-600", "decimal-total-x10", "decimal-unit-price-x10", "decimal-quantity-x10"]) {
    const s = sc(id);
    const r = await runScenario(id);
    assert.equal(r.result.outcome, "completed", id);
    const corrected = r.extracted.review_flags.filter((x) => x.code === "source_verify_corrected");
    assert.equal(corrected.length, 1, `${id}: exactly one correction`);
    assert.equal(r.extracted.total_amount, s.truth.grand_total.value, id);
    assert.deepEqual(r.items.map((i) => [i.quantity, i.unit_price, i.taxable_amount]), s.truth.line_items.map((i) => [i.quantity.value, i.unit_price.value, i.taxable_value.value]), id);
    assert.equal(r.extracted.raw_extraction.grand_total.value, s.reading.grand_total.value, id); // original reading preserved
  }
});

test("GSTIN: a wrong check digit is corrected only from a valid, grounded re-read; an invalid or identical re-read changes nothing; a missing GSTIN is never invented", async () => {
  const fixed = await runScenario("gstin-supplier-digit");
  assert.equal(fixed.extracted.vendor_gstin, SUPPLIER_GSTIN);
  assert.deepEqual(fixed.extracted.field_status.supplier_gstin.autoCorrected, { from: "27AAPFU0939F1ZW", to: SUPPLIER_GSTIN });
  assert.equal((await runScenario("gstin-buyer-digit")).extracted.buyer_gstin, BUYER_GSTIN_MH);
  // KNOWN BEHAVIOUR (documented): the earlier "check digit does not match" warning is not removed, so a corrected GSTIN still goes to review.
  assert.equal(fixed.result.outcome, "needs_review");
  assert.ok(fixed.extracted.review_flags.some((x) => x.code === "source_verify_corrected" && x.field === "supplier_gstin"));
  const same = await runScenario("gstin-wrong-reread-same");
  assert.equal(same.extracted.vendor_gstin, "27AAPFU0939F1ZW");
  assert.equal(same.result.outcome, "needs_review");
  const invalidReread = await run({ reading: sc("gstin-supplier-digit").reading, answers: { source: oracle(sc("gstin-supplier-digit").truth, { mode: "wrong", wrong: (t) => (t.find === "supplier GSTIN" ? "27AAPFU0939F1Z8" : null) }) } });
  assert.equal(invalidReread.extracted.vendor_gstin, "27AAPFU0939F1ZW");
  const missingG = await runScenario("gstin-supplier-missing");
  assert.equal(missingG.extracted.vendor_gstin, null);
  assert.equal(missingG.result.outcome, "needs_review");
  assert.ok(missingG.extracted.review_flags.some((x) => x.code === "missing_field" && x.field === "supplier_gstin" && x.severity === "warning"));
  // whatever happens, no saved GSTIN that passes through the source layer fails the check digit unless it was already there
  for (const id of ["gstin-supplier-digit", "gstin-buyer-digit"]) {
    const r = await runScenario(id);
    assert.ok(gstinIsValid(r.extracted.vendor_gstin) && gstinIsValid(r.extracted.buyer_gstin), id);
  }
});

test("CGST / SGST versus IGST: misread tax heads are corrected, and a tax type printed 'wrongly' on the document is copied as printed", async () => {
  const c = await runScenario("tax-cgst-misread");
  assert.equal(c.extracted.cgst_amount, sc("tax-cgst-misread").truth.cgst.value);
  const i = await runScenario("tax-igst-misread");
  assert.equal(i.extracted.igst_amount, sc("tax-igst-misread").truth.igst.value);
  assert.equal(i.extracted.cgst_amount, null);
  const printed = await runScenario("tax-igst-on-same-state-as-printed");
  assert.equal(printed.extracted.igst_amount, 351); // not "fixed" into CGST + SGST
  assert.equal(printed.extracted.cgst_amount, null);
  assert.equal(printed.callsBy("source").length, 0);
  // FINDING (not changed here, it predates Parts 1-3): the extraction pipeline does not run the review-time GST type rule, so this
  // invoice is saved as "completed". The rule exists and catches it as soon as the review code evaluates the saved record:
  const reviewFlags = gstChecks({ ...printed.extracted }, printed.items, { tolerancePaise: 100 });
  assert.ok(reviewFlags.some((x) => x.code === "gst_type_mismatch"));
  assert.equal(printed.extracted.review_flags.some((x) => x.code === "gst_type_mismatch"), false);
});

test("incorrect taxable value and grand total: corrected from the source; a total that the other readings out-vote needs no source call", async () => {
  const t = await runScenario("taxable-header-wrong");
  assert.equal(t.extracted.taxable_amount, sc("taxable-header-wrong").truth.taxable_value.value);
  const v = await runScenario("total-wrong-first-only-others-right");
  assert.equal(v.extracted.total_amount, sc("total-wrong-first-only-others-right").truth.grand_total.value);
  assert.equal(v.callsBy("source").length, 0);
  assert.equal(v.result.outcome, "completed");
});

test("multi-line and multi-page: a 3-page prompt, 12 rows kept in order, only the misread row is corrected", async () => {
  const clear = await runScenario("multipage-clear");
  assert.equal(clear.items.length, 12);
  assert.match(clear.callsBy("first")[0].input.systemPrompt, /This PDF has 3 pages\. Read every page/);
  assert.equal(clear.result.outcome, "completed");
  const r = await runScenario("multipage-row-quantity");
  const truth = sc("multipage-row-quantity").truth;
  assert.deepEqual(r.items.map((i) => i.quantity), truth.line_items.map((i) => i.quantity.value));
  assert.deepEqual(r.items.map((i) => i.description), truth.line_items.map((i) => i.description.value));
  assert.equal(r.extracted.review_flags.filter((x) => x.code === "source_verify_corrected").length, 1);
  assert.equal(r.items[7].field_status.quantity.source, "source_check");
  assert.equal(r.items.filter((i) => i.field_status.quantity.source === "source_check").length, 1);
  // the targeted re-read asks about that row only, not the whole table
  const targets = JSON.parse(/<targets>\n([\s\S]*)\n<\/targets>/.exec(r.callsBy("source")[0].input.userPrompt)[1]);
  assert.ok(targets.length <= 14 && targets.some((x) => /row 8 of the item table/.test(x.where)));
});

test("duplicate versus legitimate repeated items: identical rows that add up are kept; a block repeated by page overlap is removed and the raw reading kept", async () => {
  const legit = await runScenario("repeated-items-legit");
  assert.equal(legit.items.length, 3);
  assert.equal(legit.result.outcome, "completed");
  const overlap = await runScenario("repeated-block-page-overlap");
  assert.equal(overlap.items.length, 3);
  assert.equal(overlap.extracted.raw_extraction.line_items.length, 6);
  assert.ok(overlap.extracted.review_flags.some((x) => x.code === "duplicate_item_rows_removed"));
  assert.equal(overlap.extracted.total_amount, sc("repeated-block-page-overlap").truth.grand_total.value);
});

test("missing and ambiguous fields: a missing invoice number is only proposed; an ambiguous re-read leaves the value and raises a flag", async () => {
  const m = await runScenario("missing-invoice-number");
  assert.equal(m.extracted.invoice_number, null);
  const e = m.extracted.validation_summary.source_verification.entries.find((x) => x.field === "invoice_number");
  assert.equal(e.outcome, "unresolved");
  assert.equal(e.proposed, "INV-001");
  assert.equal(m.result.outcome, "needs_review");
  const a = await runScenario("ambiguous-reread");
  assert.equal(a.extracted.total_amount, sc("ambiguous-reread").reading.grand_total.value);
  assert.ok(a.extracted.review_flags.some((x) => x.code === "source_verify_unresolved"));
  assert.equal(a.result.outcome, "needs_review");
});

test("false-correction safety: a confident, self-quoted but wrong re-read never changes a value", async () => {
  for (const id of ["hallucinated-total-on-correct-doc", "hallucinated-unit-price-on-correct-doc", "hallucinated-fix-on-wrong-total"]) {
    const s = sc(id);
    const r = await runScenario(id);
    assert.equal(r.callsBy("source").length, 1, id);
    assert.equal(r.extracted.total_amount, s.reading.grand_total.value, id);
    assert.deepEqual(r.items.map((i) => i.unit_price), s.reading.line_items.map((i) => i.unit_price.value), id);
    assert.equal(r.extracted.review_flags.filter((x) => x.code === "source_verify_corrected").length, 0, id);
    assert.equal(r.result.outcome, "needs_review", id);
  }
});

// ---- 3. Malformed AI output and API failures -----------------------------------------------------------------------------------------

test("failures: malformed JSON on every attempt fails cleanly, saves nothing but the failure, and charges no invented data", async () => {
  const bad = ok("this is not json {");
  const r = await run({ reading: sc("clear-intra-state").reading, answers: { first: [bad, bad, bad] } });
  assert.equal(r.result.outcome, "failed");
  assert.equal(r.result.errorCode, "invalid_model_output");
  assert.equal(r.result.attempts, 3);
  assert.equal(r.saved.outcome, "failed");
  assert.equal(r.saved.extracted, null);
  assert.deepEqual(r.saved.items, []);
  assert.equal(r.callsBy("source").length + r.callsBy("verify").length, 0);
});

test("failures: a schema-invalid answer, then a good one, is retried (the retry prompt carries a schema reminder) and saved", async () => {
  const r = await run({ reading: sc("clear-intra-state").reading, answers: { first: [ok({ document_type: "tax_invoice" }), sc("clear-intra-state").reading] } });
  assert.equal(r.result.outcome, "completed");
  assert.equal(r.result.attempts, 2);
  const [a, b] = r.callsBy("first");
  assert.notEqual(a.input.systemPrompt, b.input.systemPrompt);
  assert.ok(b.input.systemPrompt.length > a.input.systemPrompt.length);
});

test("failures: 429 then success is retried with back-off; a permanent provider rejection is not retried; timeouts everywhere fail", async () => {
  const good = sc("clear-intra-state").reading;
  const retried = await run({ reading: good, answers: { first: [{ ok: false, code: "provider_rate_limited", retryable: true, httpStatus: 429, retryAfterMs: 1000 }, good] } });
  assert.equal(retried.result.outcome, "completed");
  assert.equal(retried.result.attempts, 2);
  const rejected = await run({ reading: good, answers: { first: [{ ok: false, code: "provider_rejected_input", retryable: false, httpStatus: 400 }] } });
  assert.equal(rejected.result.outcome, "failed");
  assert.equal(rejected.result.attempts, 1);
  const timeout = { ok: false, code: "provider_timeout", retryable: true };
  const t = await run({ reading: good, answers: { first: [timeout, timeout, timeout] } });
  assert.equal(t.result.outcome, "failed");
  assert.equal(t.result.errorCode, "provider_timeout");
  assert.equal(t.saved.extracted, null);
});

test("failures: when every extra layer fails or throws, the first reading is still saved, flagged, and nothing is lost", async () => {
  const s = sc("digits-total-misread");
  const boom = new Error("network down");
  const r = await run({ reading: s.reading, answers: { verify: boom, audit: ok("garbage"), keyfigures: { ok: false, code: "provider_unavailable", retryable: true }, parties: boom, source: boom } });
  assert.notEqual(r.result.outcome, "failed");
  assert.equal(r.extracted.total_amount, s.reading.grand_total.value);
  assert.equal(r.items.length, s.reading.line_items.length);
  const codes = r.extracted.review_flags.map((x) => x.code);
  for (const c of ["recheck_unavailable", "audit_unavailable", "keyfigures_unavailable", "parties_unavailable", "source_verify_unavailable"]) assert.ok(codes.includes(c), c);
  assert.equal(r.result.outcome, "needs_review");
});

test("failures: malformed or failing source re-read leaves every value exactly as the baseline would save it", async () => {
  for (const id of ["source-reply-malformed", "source-provider-error"]) {
    const s = sc(id);
    const withLayer = await runScenario(id);
    const baseline = await run({ reading: s.reading, config: { sourceVerify: false, dynamicPrompt: false } });
    assert.equal(withLayer.extracted.total_amount, baseline.extracted.total_amount, id);
    assert.deepEqual(withLayer.items.map((i) => [i.quantity, i.unit_price, i.taxable_amount]), baseline.items.map((i) => [i.quantity, i.unit_price, i.taxable_amount]), id);
    assert.ok(withLayer.extracted.review_flags.some((x) => x.code === "source_verify_unavailable" && x.severity === "info"), id);
    assert.equal(withLayer.result.outcome, "needs_review", id);
  }
});

test("failures: a throwing dynamic-prompt engine falls back to the unchanged fixed prompt and the run still completes", async () => {
  const s = sc("clear-intra-state");
  const h = await import("./helpers/pipeline-harness.mjs");
  const x = h.setup({ reading: s.reading });
  x.deps.promptBuilder = () => { throw new Error("engine bug"); };
  const { runExtraction } = await import("../lib/extraction/pipeline.ts");
  const result = await runExtraction(x.deps, x.ctx);
  assert.equal(result.outcome, "completed");
  const first = x.state.calls.find((c) => c.role === "first").input;
  assert.equal(first.systemPrompt, undefined); // no override: callGemini uses the fixed SYSTEM_PROMPT
  assert.ok(x.state.logs.some((l) => l.event === "extraction_dynamic_prompt_error"));
});

// ---- 4. Regression and production safety ------------------------------------------------------------------------------------------------

test("defaults: every layer is on by default, each has its own off switch, and source verification still needs the second reading", () => {
  const c = getGeminiConfig({ GEMINI_API_KEY: "k" });
  for (const k of ["verify", "audit", "totalCheck", "partiesCheck", "dynamicPrompt", "sourceVerify"]) assert.equal(c[k], true, k);
  assert.equal(c.partiesRetries, 1);
  assert.equal(c.model, "gemini-3.5-flash-lite");
  assert.equal(c.deadlineMs, 52_000);
  assert.equal(c.maxAttempts, 3);
  const off = getGeminiConfig({ GEMINI_API_KEY: "k", EXTRACTION_DYNAMIC_PROMPT: "off", EXTRACTION_SOURCE_VERIFY: "false", EXTRACTION_VERIFY: "0" });
  assert.deepEqual([off.dynamicPrompt, off.sourceVerify, off.verify], [false, false, false]);
  assert.equal(getGeminiConfig({}), null); // no key: the routes answer 503 before touching a job
  const chk = getCheckConfig({});
  assert.deepEqual([chk.lowConfidence, chk.tolerancePaise, chk.lineFix, chk.lineFixMaxConfidence, chk.dedupeRows, chk.forex], [0.8, 100, true, 0.95, true, true]);
  assert.deepEqual(getFxConfig({}), { enabled: true, timeoutMs: 2500 });
});

test("defaults: features that must be off by default are off, and the source layer is idle when its switch or the second reading is off", async () => {
  assert.equal(allowUnpaidUpgrades({}), false);
  assert.equal(allowUnpaidUpgrades({ BILLING_ALLOW_UNPAID_UPGRADES: "" }), false);
  const route = readFileSync(path.join(ROOT, "app/api/invoices/[id]/extract/route.ts"), "utf8");
  assert.match(route, /createGstPortalLookup/); // optional: the factory returns null without a key
  for (const cfg of [{ sourceVerify: false }, { verify: false }]) {
    const r = await runScenario("total-wrong-all-layers", { config: cfg });
    assert.equal(r.callsBy("source").length, 0);
    assert.equal(r.extracted.validation_summary.source_verification, undefined);
  }
  const off = await runScenario("total-wrong-all-layers", { config: { dynamicPrompt: false } });
  assert.equal(off.callsBy("first")[0].input.systemPrompt, undefined); // fixed prompt only
});

test("env: every variable read by lib/extraction/config.ts is documented in .env.example, and no new NEXT_PUBLIC_ variable exists", () => {
  const cfg = readFileSync(path.join(ROOT, "lib/extraction/config.ts"), "utf8");
  const example = readFileSync(path.join(ROOT, ".env.example"), "utf8");
  const names = new Set([...cfg.matchAll(/\b(?:env\.|(?:num|int)\(env, ")([A-Z][A-Z0-9_]+)/g)].map((m) => m[1]));
  assert.ok(names.size >= 20);
  const missingDocs = [...names].filter((n) => !new RegExp(`^#?\\s*${n}=`, "m").test(example));
  assert.deepEqual(missingDocs, []);
  assert.match(example, /^EXTRACTION_SOURCE_VERIFY=on/m);
  assert.match(example, /^EXTRACTION_DYNAMIC_PROMPT=on/m);
});

function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    if (["node_modules", ".next", ".git"].includes(n)) continue;
    const p = path.join(dir, n);
    statSync(p).isDirectory() ? walk(p, out) : out.push(p);
  }
  return out;
}

test("secrets: no client-side file reads server secrets or imports the extraction layers; the new modules never touch process.env", () => {
  const files = walk(ROOT).filter((p) => /\.(ts|tsx)$/.test(p));
  const clientFiles = files.filter((p) => /^["']use client["']/.test(readFileSync(p, "utf8").trimStart()));
  assert.ok(clientFiles.length > 10);
  for (const p of clientFiles) {
    const src = readFileSync(p, "utf8");
    const rel = path.relative(ROOT, p);
    assert.doesNotMatch(src, /GEMINI_API_KEY|SUPABASE_SERVICE_ROLE_KEY|INTEGRATION_ENCRYPTION_KEY|GST_PORTAL_API_KEY|process\.env\.(?!NEXT_PUBLIC_|NODE_ENV\b)/, `${rel} reads a server secret`);
    assert.doesNotMatch(src, /lib\/extraction\/(gemini|pipeline|source-verify|dynamic-prompt|config|store)/, `${rel} imports server-only extraction code`);
  }
  for (const m of ["source-verify.ts", "dynamic-prompt.ts", "pipeline.ts"]) assert.doesNotMatch(readFileSync(path.join(ROOT, "lib/extraction", m), "utf8"), /process\.env/, `${m} reads process.env directly`);
  // the only place the key travels is the request header of the provider client
  const gem = readFileSync(path.join(ROOT, "lib/extraction/gemini.ts"), "utf8");
  assert.match(gem, /x-goog-api-key/);
  assert.doesNotMatch(gem, /\?key=|&key=/);
});

test("secrets and privacy: logs and usage records of failing and corrected runs contain no API key, invoice number, GSTIN, supplier name or amount", async () => {
  const boom = new Error("secret: SECRET-KEY-123 INV-001");
  const runs = [
    await runScenario("total-wrong-all-layers"),
    await runScenario("gstin-supplier-digit"),
    await run({ reading: sc("digits-total-misread").reading, answers: { verify: boom, audit: ok("{bad"), source: boom } }),
    await run({ reading: sc("clear-intra-state").reading, answers: { first: [ok("{bad"), ok("{bad"), ok("{bad")] } }),
  ];
  for (const r of runs) {
    const dump = JSON.stringify([r.state.logs, r.state.usage]);
    for (const secret of ["SECRET-KEY-123", "INV-001", SUPPLIER_GSTIN, "27AAPFU0939F1ZW", "Acme Traders", "Beta Stores"]) assert.ok(!dump.includes(secret), `log/usage leaks ${secret}`);
    assert.doesNotMatch(dump, /"value"/);
  }
  // the API key only ever appears as the provider call's own input
  for (const r of runs) for (const c of r.state.calls) assert.ok(!c.input.userPrompt?.includes("SECRET-KEY-123") && !c.input.systemPrompt?.includes("SECRET-KEY-123"));
});

test("usage accounting: every provider call, including the source re-read, is recorded with its own outcome label", async () => {
  const r = await runScenario("total-wrong-all-layers");
  assert.equal(r.state.usage.length, r.state.calls.length);
  assert.deepEqual(r.state.usage.map((u) => u.outcome).sort(), ["audit_ok", "keyfigures_ok", "ok", "parties_ok", "source_verify_ok", "verify_ok"]);
  assert.ok(r.result.costUsd > 0);
});

test("the evaluation dataset itself is consistent: every truth invoice adds up, so a 'wrong' reading is really wrong", () => {
  for (const s of SCENARIOS) {
    const t = s.truth;
    const lines = t.line_items.reduce((a, i) => a + i.taxable_value.value, 0);
    assert.ok(Math.abs(lines - t.taxable_value.value) < 0.01, `${s.id}: lines ${lines} vs taxable ${t.taxable_value.value}`);
    const tax = ["cgst", "sgst", "igst", "cess"].reduce((a, k) => a + (t[k].value ?? 0), 0);
    assert.ok(Math.abs(t.taxable_value.value + tax - t.grand_total.value) < 0.01, `${s.id}: total does not add up`);
  }
});
