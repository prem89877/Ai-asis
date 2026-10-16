import test from "node:test";
import assert from "node:assert/strict";
import { setup } from "./helpers/route-harness.mjs";

setup(); // resolves the extensionless imports of lib/export/run.ts
const { generateExport } = await import("../lib/export/run.ts");

const row = (id, status = "verified") => ({ id, status, created_at: "2026-10-01", invoice_number: "SAME-1", invoice_date: "2026-09-15", original_filename: `${id}.pdf`, currency: "INR" });
// Fake PostgREST: returns the matching rows in REVERSED id order, like a database that ignores the order of the IN list.
function fakeSupabase(rows) {
  return {
    from: () => {
      const q = { ids: [] };
      const b = { select: () => b, eq: () => b, in: (_c, ids) => { q.ids = ids; return b; }, order: () => b, range: () => b, then: (res) => res({ data: rows.filter((r) => q.ids.includes(r.id)).reverse(), error: null }) };
      return b;
    },
  };
}
const A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222", C = "33333333-3333-4333-8333-333333333333";
const spec = (ids, over = {}) => ({ format: "csv", columns: ["id"], itemColumns: [], includeItems: false, verifiedOnly: false, dateFormat: "iso", invoiceIds: ids, ...over });

// The file is sorted by invoice date, then number, then upload time (build.ts, intended). Only rows that tie on all three used to come out
// in whatever order the database returned them; they now keep the order the person selected.
test("rows that tie on date, number and upload time follow the order the person selected, not the database order", async () => {
  const r = await generateExport(fakeSupabase([row(A), row(B), row(C)]), "firm", spec([C, A, B]));
  assert.equal(r.ok, true);
  assert.deepEqual(r.eligibleIds, [C, A, B]);
  const lines = new TextDecoder().decode(r.bytes).trim().split(/\r?\n/);
  assert.deepEqual(lines.slice(1).map((l) => l.replace(/^\uFEFF/, "")), [C, A, B]);
});
test("the same id listed twice is one invoice; the skipped count is not inflated or negative", async () => {
  const r = await generateExport(fakeSupabase([row(A), row(B, "processing")]), "firm", spec([A, A, B, B, B]));
  assert.equal(r.ok, true);
  assert.equal(r.count, 1);
  assert.equal(r.skipped, 1); // only B is skipped (still processing); not 4
  const same = await generateExport(fakeSupabase([row(A), row(B)]), "firm", spec([A, B, A]));
  assert.equal(same.skipped, 0);
  assert.deepEqual(same.eligibleIds, [A, B]);
});
