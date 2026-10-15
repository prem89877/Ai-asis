import test from "node:test";
import assert from "node:assert/strict";
import { parseModelJson } from "../lib/extraction/parse-json.ts";
import { dedupeItemRows, findRepeatedRows } from "../lib/extraction/item-rows.ts";
import { normalizeExtraction } from "../lib/extraction/normalize.ts";
import { runExtraction } from "../lib/extraction/pipeline.ts";
import { getCheckConfig } from "../lib/extraction/config.ts";
import { buildTables } from "../lib/export/build.ts";
import { INVOICE_COLUMNS, ITEM_COLUMNS } from "../lib/export/columns.ts";
import { f, missing, unreadable, item, model, minimalPdf, png, sha } from "./helpers.mjs";

// ---- JSON parsing --------------------------------------------------------------------------------------------------------------

test("parser: plain JSON, BOM, code fence and a JSON object inside plain words are accepted", () => {
  const body = JSON.stringify({ a: 1 });
  for (const text of [body, "\uFEFF" + body, "```json\n" + body + "\n```", "Here you go:\n" + body + "\nDone.", "text ```\n" + body + "\n``` more"]) {
    const r = parseModelJson(text);
    assert.equal(r.ok, true, text);
    assert.deepEqual(r.value, { a: 1 });
  }
  assert.equal(parseModelJson(body).extracted, false);
  assert.equal(parseModelJson("Result: " + body).extracted, true);
});

test("parser: braces and quotes inside strings do not confuse it", () => {
  const r = parseModelJson('note {x}\n{"d":"a } b \\" { c","n":2} trailing');
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { d: 'a } b " { c', n: 2 });
});

test("parser: a cut-off answer is 'truncated' and is never completed", () => {
  const full = JSON.stringify(model());
  const r = parseModelJson(full.slice(0, Math.floor(full.length / 2)));
  assert.deepEqual(r, { ok: false, reason: "truncated" });
});

test("parser: no repair of broken JSON, arrays, scalars, empty or non-text input", () => {
  assert.equal(parseModelJson('{"a":1,}').ok, false); // trailing comma is not repaired
  assert.equal(parseModelJson("{'a':1}").ok, false);
  assert.deepEqual(parseModelJson("[1,2]"), { ok: false, reason: "not_object" });
  assert.deepEqual(parseModelJson("42"), { ok: false, reason: "not_object" });
  assert.deepEqual(parseModelJson("   "), { ok: false, reason: "empty" });
  assert.deepEqual(parseModelJson(undefined), { ok: false, reason: "empty" });
  assert.deepEqual(parseModelJson("no json here"), { ok: false, reason: "not_json" });
});

// ---- Pipeline harness ----------------------------------------------------------------------------------------------------------

function setup({ responses, bytes = minimalPdf(1), mime = "application/pdf", config = {}, check } = {}) {
  const saved = { completes: [] };
  let i = 0, t = Date.parse("2026-10-14T00:00:00Z");
  const deps = {
    geminiConfig: { apiKey: "k", model: "m", inputPricePerMTok: 0.3, outputPricePerMTok: 2.5, timeoutMs: 10_000, deadlineMs: 50_000, maxAttempts: 3, maxOutputTokens: 1000, ...config },
    checkConfig: check, maxPdfPages: 10, now: () => t, sleep: async (ms) => { t += ms; }, random: () => 0, log: () => {},
    files: { download: async () => bytes },
    gemini: async () => { const r = responses[Math.min(i, responses.length - 1)]; i += 1; t += 500; return r; },
    store: { recordUsage: async () => {}, findDuplicateCandidates: async () => [], complete: async (a) => { saved.completes.push(a); return "ok"; } },
  };
  return { deps, saved, ctx: { jobId: "j", invoiceId: "i", firmId: "f", userId: "u", storagePath: "f/i", mime, sha256: sha(bytes) }, calls: () => i };
}
const ok = (m) => ({ ok: true, text: typeof m === "string" ? m : JSON.stringify(m), usage: { inputTokens: 1, outputTokens: 1 } });

test("pipeline: a valid answer wrapped in words or a code fence is accepted", async () => {
  for (const text of ["```json\n" + JSON.stringify(model()) + "\n```", "Here is the JSON: " + JSON.stringify(model())]) {
    const { deps, ctx, saved } = setup({ responses: [ok(text)] });
    const r = await runExtraction(deps, ctx);
    assert.equal(r.outcome, "completed");
    assert.equal(saved.completes[0].extracted.total_amount, 1180);
  }
});

test("pipeline: truncated or malformed answers are retried, then fail safely with nothing saved", async () => {
  const cut = JSON.stringify(model()).slice(0, 200);
  const { deps, ctx, saved, calls } = setup({ responses: [ok(cut)] });
  const r = await runExtraction(deps, ctx);
  assert.equal(r.outcome, "failed");
  assert.equal(r.errorCode, "invalid_model_output");
  assert.equal(calls(), 3);
  assert.equal(saved.completes.length, 1);
  assert.equal(saved.completes[0].extracted, null);
  assert.deepEqual(saved.completes[0].items, []);
});

test("pipeline: a schema-invalid answer (extra key, string number, value on a missing field) is rejected, a later good answer is used", async () => {
  const bad = [
    { ...model(), surprise: 1 },
    model({ grand_total: { status: "present", value: "1180", confidence: 1 } }),
    model({ buyer_gstin: { status: "missing", value: "29ABCDE1234F1Z5", confidence: 1 } }),
  ];
  for (const b of bad) {
    const { deps, ctx, saved } = setup({ responses: [ok(b), ok(model())] });
    const r = await runExtraction(deps, ctx);
    assert.equal(r.outcome, "completed");
    assert.equal(r.attempts, 2);
    assert.equal(saved.completes[0].extracted.total_amount, 1180);
  }
});

test("pipeline: provider failures end the run with a code and save no invoice data", async () => {
  for (const [code, retryable, expectedCalls] of [["provider_auth", false, 1], ["provider_blocked", false, 1], ["output_truncated", false, 1], ["provider_unavailable", true, 3]]) {
    const { deps, ctx, saved, calls } = setup({ responses: [{ ok: false, code, retryable }] });
    const r = await runExtraction(deps, ctx);
    assert.equal(r.outcome, "failed");
    assert.equal(r.errorCode, code);
    assert.equal(calls(), expectedCalls);
    assert.equal(saved.completes[0].extracted, null);
  }
});

// ---- Field mapping: model -> stored invoice and items -> export --------------------------------------------------------------------

const RICH = model({
  supplier_name: f("Acme Traders Pvt Ltd"), supplier_gstin: f("27AAPFU0939F1ZV"), buyer_name: f("Beta Stores"), buyer_gstin: missing(),
  invoice_number: f("INV/2026/0042"), invoice_date: f("2026-09-15"), place_of_supply: f("Maharashtra (27)"),
  taxable_value: f(2750.5), discount_total: f(49.5), cgst: f(247.55), sgst: f(247.55), igst: missing(), cess: f(0),
  pre_tax_charges: f(100), round_off_amount: f(-0.1), grand_total: f(3245.6),
  line_items: [
    item({ description: f("Steel bolt M8"), hsn_sac: f("7318"), unit: f("Kg"), quantity: f(10.5), unit_price: f(120.3333), discount: f(10), taxable_value: f(1250.5), gst_rate: f(18), tax_amount: f(225.09), line_total: f(1475.59) }),
    item({ description: f("Hex nut M8"), hsn_sac: f("7318"), unit: f("Nos"), quantity: f(300), unit_price: f(4.5), discount: missing(), taxable_value: f(1350), gst_rate: f(18), tax_amount: f(243), line_total: f(1593) }),
    item({ description: f("Packing"), hsn_sac: unreadable(), unit: missing(), quantity: missing(), unit_price: missing(), discount: missing(), taxable_value: f(150), gst_rate: f(0), tax_amount: f(0), line_total: f(150) }),
  ],
});

test("mapping: every supported invoice field reaches its stored column", () => {
  const { extracted: e, items } = normalizeExtraction(RICH, { model: "t" });
  assert.equal(e.vendor_name, "Acme Traders Pvt Ltd");
  assert.equal(e.vendor_gstin, "27AAPFU0939F1ZV");
  assert.equal(e.buyer_name, "Beta Stores");
  assert.equal(e.invoice_number, "INV/2026/0042");
  assert.equal(e.invoice_date, "2026-09-15");
  assert.equal(e.place_of_supply, "Maharashtra (27)");
  assert.equal(e.currency, "INR");
  assert.equal(e.taxable_amount, 2750.5);
  assert.equal(e.discount_amount, 49.5);
  assert.equal(e.cgst_amount, 247.55);
  assert.equal(e.sgst_amount, 247.55);
  assert.equal(e.cess_amount, 0);
  assert.equal(e.pre_tax_charges, 100);
  assert.equal(e.round_off_amount, -0.1);
  assert.equal(e.total_amount, 3245.6);
  assert.equal(e.document_type, "tax_invoice");
  assert.equal(items.length, 3);
  const a = items[0];
  assert.deepEqual([a.description, a.hsn_code, a.unit, a.quantity, a.unit_price, a.discount_amount, a.taxable_amount, a.gst_rate, a.gst_amount, a.line_total],
    ["Steel bolt M8", "7318", "Kg", 10.5, 120.3333, 10, 1250.5, 18, 225.09, 1475.59]);
});

test("missing values are told apart from genuine zeros and unreadable values", () => {
  const { extracted: e, items } = normalizeExtraction(RICH, { model: "t" });
  assert.equal(e.cess_amount, 0);
  assert.equal(e.field_status.cess.state, "zero");
  assert.equal(e.igst_amount, null);
  assert.equal(e.field_status.igst.state, "missing");
  assert.equal(e.buyer_gstin, null);
  assert.equal(e.field_status.buyer_gstin.state, "missing");
  const pack = items[2];
  assert.equal(pack.gst_amount, 0);
  assert.equal(pack.field_status.tax_amount.state, "zero");
  assert.equal(pack.quantity, null);
  assert.equal(pack.field_status.quantity.state, "missing");
  assert.equal(pack.hsn_code, null);
  assert.equal(pack.field_status.hsn_sac.state, "unreadable");
  const u = normalizeExtraction(model({ supplier_gstin: unreadable() }), { model: "t" }).extracted;
  assert.equal(u.vendor_gstin, null);
  assert.equal(u.field_status.supplier_gstin.state, "unreadable");
});

test("numeric precision: values are stored as read, never rounded or recomputed; the original reading is kept", () => {
  const m = model({ taxable_value: f(1234567890.12), grand_total: f(1234567890.12), cgst: missing(), sgst: missing(), line_items: [item({ unit_price: f(33.3333), quantity: f(2.5), taxable_value: f(83.33), tax_amount: f(15), line_total: f(98.33) })] });
  const { extracted: e, items } = normalizeExtraction(m, { model: "t" });
  assert.equal(e.taxable_amount, 1234567890.12);
  assert.equal(items[0].unit_price, 33.3333);
  assert.equal(items[0].quantity, 2.5);
  assert.deepEqual(e.raw_extraction, m);
  const extra = normalizeExtraction(model({ cess: f(100.005) }), { model: "t" });
  assert.ok(extra.extracted.review_flags.some((x) => x.code === "amount_precision" && x.field === "cess"), "extra decimals are flagged");
  assert.equal(extra.extracted.raw_extraction.cess.value, 100.005, "the original figure is still in the raw reading");
});

test("out-of-range amounts are not stored", () => {
  const { extracted: e } = normalizeExtraction(model({ grand_total: f(5e15) }), { model: "t" });
  assert.equal(e.total_amount, null);
  assert.ok(e.review_flags.some((x) => x.code === "amount_out_of_range"));
});

test("multi-item invoice through the pipeline: all rows, in order, nothing merged; then into the export tables", async () => {
  const { deps, ctx, saved } = setup({ responses: [ok(RICH)], bytes: minimalPdf(3) });
  const r = await runExtraction(deps, ctx);
  assert.notEqual(r.outcome, "failed");
  const { extracted, items } = saved.completes[0];
  assert.deepEqual(items.map((x) => x.description), ["Steel bolt M8", "Hex nut M8", "Packing"]);

  const inv = { id: "11111111-1111-4111-8111-111111111111", original_filename: "a.pdf", status: "needs_review", created_at: "2026-10-14T00:00:00+00:00", ...extracted, tax_total: 495.1, verified_at: null };
  const rows = items.map((x, idx) => ({ invoice_id: inv.id, position: idx + 1, ...x }));
  const [t1, t2] = buildTables([inv], new Map([[inv.id, rows]]), { format: "xlsx", columns: INVOICE_COLUMNS.map((c) => c.key), itemColumns: ITEM_COLUMNS.map((c) => c.key), includeItems: true });
  const cell = (t, label, row = 0) => t.rows[row][t.headers.indexOf(label)];
  const header = (key) => INVOICE_COLUMNS.find((c) => c.key === key).label;
  assert.equal(t1.rows.length, 1);
  assert.equal(cell(t1, header("vendor_name")), "Acme Traders Pvt Ltd");
  assert.equal(cell(t1, header("total_amount")), 3245.6);
  assert.equal(t2.rows.length, 3);
  assert.equal(cell(t2, ITEM_COLUMNS.find((c) => c.key === "description").label, 1), "Hex nut M8");
  assert.equal(cell(t2, ITEM_COLUMNS.find((c) => c.key === "unit_price").label, 0), 120.3333);
});

test("multi-page PDF and image uploads both complete", async () => {
  for (const [bytes, mime] of [[minimalPdf(4), "application/pdf"], [png(800, 1000), "image/png"]]) {
    const { deps, ctx, saved } = setup({ responses: [ok(model())], bytes, mime });
    const r = await runExtraction(deps, ctx);
    assert.equal(r.outcome, "completed");
    assert.equal(saved.completes[0].items.length, 1);
  }
});

// ---- Duplicate item rows -------------------------------------------------------------------------------------------------------

const A = () => item({ description: f("Widget A"), taxable_value: f(1000), tax_amount: f(180), line_total: f(1180) });
const B = () => item({ description: f("Widget B"), taxable_value: f(500), tax_amount: f(90), line_total: f(590) });
const tol = { tolerancePaise: 100 };

test("rows read twice are removed only when the invoice taxable total proves it", () => {
  const m = model({ taxable_value: f(1500), line_items: [A(), B(), A(), B()] });
  const r = dedupeItemRows(m, tol);
  assert.deepEqual(r.removed, [3, 4]);
  assert.equal(r.model.line_items.length, 2);
  assert.equal(m.line_items.length, 4, "the reading as received is untouched");
  assert.equal(r.flags[0].code, "duplicate_item_rows_removed");
  assert.equal(r.flags[0].severity, "info");
});

test("genuinely repeated items are never removed", () => {
  const m = model({ taxable_value: f(2000), line_items: [A(), A()] });
  const r = dedupeItemRows(m, tol);
  assert.equal(r.model, m);
  assert.deepEqual(r.flags, []);
  const m3 = model({ taxable_value: f(3500), line_items: [A(), A(), B(), A(), A(), B()] });
  assert.equal(dedupeItemRows(m3, tol).model.line_items.length, 6);
});

test("when the total cannot settle it, rows are kept and a warning is raised", () => {
  const neither = dedupeItemRows(model({ taxable_value: f(1700), line_items: [A(), A()] }), tol);
  assert.equal(neither.model.line_items.length, 2);
  assert.equal(neither.flags[0].code, "possible_duplicate_item_rows");
  assert.equal(neither.flags[0].severity, "warning");
  assert.equal(neither.flags[0].itemPosition, 2);
  const noTotal = dedupeItemRows(model({ taxable_value: missing(), line_items: [A(), A()] }), tol);
  assert.equal(noTotal.model.line_items.length, 2);
  assert.equal(noTotal.flags[0].details.total_check, "not_available");
  const noRowTaxable = dedupeItemRows(model({ taxable_value: f(1000), line_items: [A(), item({ ...A(), taxable_value: f(1000) }), item({ description: f("X"), taxable_value: missing(), line_total: f(5) })] }), tol);
  assert.ok(noRowTaxable.model.line_items.length >= 2);
});

test("a run of three identical rows keeps one when one row matches the total; rows with too little data are not compared", () => {
  assert.deepEqual(dedupeItemRows(model({ taxable_value: f(1000), line_items: [A(), A(), A()] }), tol).removed, [2, 3]);
  const blank = () => item({ description: missing(), taxable_value: missing(), line_total: missing() });
  assert.deepEqual(findRepeatedRows([blank(), blank()]), []);
  assert.deepEqual(findRepeatedRows([A(), B()]), []);
});

test("pipeline: a page read twice is cleaned, the original reading and a note are saved", async () => {
  const dup = model({ taxable_value: f(1500), cgst: f(135), sgst: f(135), grand_total: f(1770), line_items: [A(), B(), A(), B()] });
  const { deps, ctx, saved } = setup({ responses: [ok(dup)], bytes: minimalPdf(2) });
  await runExtraction(deps, ctx);
  const s = saved.completes[0];
  assert.equal(s.items.length, 2);
  assert.equal(s.extracted.raw_extraction.line_items.length, 4);
  assert.ok(s.extracted.review_flags.some((x) => x.code === "duplicate_item_rows_removed"));
});

test("pipeline: genuine repeated items survive, and EXTRACTION_DEDUPE_ROWS=off disables the check", async () => {
  const legit = model({ taxable_value: f(2000), cgst: f(180), sgst: f(180), grand_total: f(2360), line_items: [A(), A()] });
  const a = setup({ responses: [ok(legit)] });
  await runExtraction(a.deps, a.ctx);
  assert.equal(a.saved.completes[0].items.length, 2);
  assert.ok(!a.saved.completes[0].extracted.review_flags.some((x) => x.code.includes("duplicate_item")));

  const dup = model({ taxable_value: f(1000), cgst: f(90), sgst: f(90), grand_total: f(1180), line_items: [A(), A()] });
  const off = setup({ responses: [ok(dup)], check: { ...getCheckConfig({ EXTRACTION_DEDUPE_ROWS: "off" }) } });
  await runExtraction(off.deps, off.ctx);
  assert.equal(off.saved.completes[0].items.length, 2);
  const on = setup({ responses: [ok(dup)] });
  await runExtraction(on.deps, on.ctx);
  assert.equal(on.saved.completes[0].items.length, 1);
});
