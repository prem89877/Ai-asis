// Regression: "IGST: expected INR 212000.00, found INR 182000.00. The 3 IGST line(s) add up to INR 212000.00 of IGST."
// Cause: the IGST lines print IGST + cess, but the cess was not read at invoice level (null / 0 / misread). The cess was then never
// re-read from the original file because a missing cess is normal on most invoices and tax-breakdown findings started no re-read.
// Now the cess (and the tax heads) are re-read when the tax heads do not match the lines, and a re-read cess is accepted only when
// that makes the tax checks pass. The figures below are TEST DATA; production code never contains them.
import test from "node:test";
import assert from "node:assert/strict";
import { run } from "./helpers/pipeline-harness.mjs";
import { f, missing, item, model } from "./helpers.mjs";
import { getGeminiConfig } from "../lib/extraction/config.ts";

const ln = (t, pct, type, rate) => item({ description: f("Line"), quantity: f(1), unit_price: f(t), taxable_value: f(t), gst_rate: f(rate),
  tax_amount: f(Math.round(t * pct) / 100), line_total: f(Math.round(t * (100 + pct)) / 100), applied_tax_type: f(type) });
const inv = (over = {}) => model({ taxable_value: f(1100000), cgst: f(9000), sgst: f(9000), igst: f(182000), cess: f(30000), grand_total: f(1330000), tcs_amount: f(0), tds_amount: f(0),
  line_items: [ln(600000, 21.2, "IGST", 18.2), ln(300000, 21.2, "IGST", 18.2), ln(100000, 21.2, "IGST", 18.2), ln(100000, 18, "CGST+SGST", 18)], ...over });

// What a faithful second reader returns: every figure as printed; the cess as `cessOnDocument` (null = no cess printed).
const reread = (cessOnDocument) => (input) => {
  const targets = JSON.parse(input.userPrompt.match(/<targets>\n([\s\S]*?)\n<\/targets>/)[1]);
  const rows = [18.2, 18.2, 18.2, 18];
  const results = targets.map((t) => {
    if (t.find === "cess") {
      return cessOnDocument === null
        ? { id: t.id, status: "missing", value: "", printed_text: "", page: 1, confidence: 0.95, other_readings: [] }
        : { id: t.id, status: "present", value: String(cessOnDocument), printed_text: `Compensation Cess ${cessOnDocument}.00`, page: 1, confidence: 0.97, other_readings: [] };
    }
    const row = /row (\d+)/.exec(t.where);
    const v = { "taxable value": 1100000, CGST: 9000, SGST: 9000, IGST: 182000, "grand total": 1330000 }[t.find] ?? (row ? rows[+row[1] - 1] : 0);
    return { id: t.id, status: "present", value: String(v), printed_text: `${t.find} ${v}`, page: 1, confidence: 0.97, other_readings: [] };
  });
  return { ok: true, text: JSON.stringify({ results }), usage: { inputTokens: 100, outputTokens: 20 } };
};
const open = (r) => r.extracted.review_flags.filter((x) => x.severity !== "info").map((x) => x.code);

for (const [name, cess] of [["not read (null)", missing()], ["read as 0", f(0)], ["misread (3000 instead of 30000)", f(3000)]]) {
  test(`cess ${name}: it is re-read from the original, the IGST check passes and nothing else changes`, async () => {
    const r = await run({ reading: inv({ cess }), answers: { source: reread(30000) } });
    assert.equal(r.result.outcome, "completed");
    assert.deepEqual(open(r), []);
    assert.equal(r.extracted.cess_amount, 30000);
    assert.equal(r.extracted.igst_amount, 182000); // the head was right and stays untouched
    assert.equal(r.extracted.total_amount, 1330000);
    assert.equal(r.items.length, 4);
    assert.equal(r.extracted.validation_summary.source_verification.corrected, 1);
    const entry = r.extracted.validation_summary.source_verification.entries.find((x) => x.field === "cess");
    assert.equal(entry.outcome, "corrected");
    assert.ok(r.extracted.review_flags.some((x) => x.code === "source_verify_corrected" && x.field === "cess"), "the change is flagged for audit");
  });
}

test("no cess printed on the document: nothing is invented, the mismatch stays visible", async () => {
  const r = await run({ reading: inv({ cess: missing(), grand_total: f(1300000) }), answers: { source: reread(null) } });
  assert.equal(r.extracted.cess_amount, null);
  assert.ok(open(r).includes("tax_allocation_mismatch"));
  assert.notEqual(r.result.outcome, "completed");
});

test("a re-read cess that does not make the tax checks pass is not applied", async () => {
  const r = await run({ reading: inv({ cess: missing() }), answers: { source: reread(1234) } });
  assert.equal(r.extracted.cess_amount, null);
  assert.ok(open(r).includes("tax_allocation_mismatch"));
});

test("an invoice whose tax already ties costs no extra re-read for the cess", async () => {
  const r = await run({ reading: inv(), answers: { source: reread(30000) } });
  assert.equal(r.result.outcome, "completed");
  assert.equal(r.extracted.validation_summary.source_verification.entries.some((x) => x.field === "cess"), false);
});

test("the run budget leaves room for the extra re-read (default 150 s, always below the stale limit)", () => {
  const c = getGeminiConfig({ GEMINI_API_KEY: "k" });
  assert.equal(c.deadlineMs, 150_000);
});
