// A scripted "source re-read" (the targeted call of lib/extraction/source-verify.ts). It reads the target list from the prompt and
// answers from a ground-truth invoice, the way a faithful reader of the printed page would. `mode` makes it unfaithful on purpose so
// the safety rules (no change without proof) can be measured.
const inr = (n) => Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const ddmmyyyy = (iso) => iso.split("-").reverse().join("/");

function lookup(truth, find, where) {
  const row = /row (\d+) of the item table/.exec(where);
  if (row) {
    const it = truth.line_items[Number(row[1]) - 1];
    if (!it) return null;
    const m = { quantity: ["quantity", "amount"], "unit price / rate": ["unit_price", "amount"], "taxable value": ["taxable_value", "amount"], "GST rate %": ["gst_rate", "rate"] }[find];
    return m ? { value: it[m[0]].value, kind: m[1], label: find, desc: it.description.value } : null;
  }
  const h = { "invoice date": ["invoice_date", "date"], "invoice number": ["invoice_number", "text"], "supplier GSTIN": ["supplier_gstin", "gstin"], "buyer GSTIN": ["buyer_gstin", "gstin"], "grand total": ["grand_total", "amount"], "taxable value": ["taxable_value", "amount"], CGST: ["cgst", "amount"], SGST: ["sgst", "amount"], IGST: ["igst", "amount"], cess: ["cess", "amount"] }[find];
  if (!h) return null;
  const fld = truth[h[0]];
  if (!fld || fld.value === null || fld.value === undefined) return null;
  return { value: fld.value, kind: h[1], label: find };
}

function printed(hit) {
  if (hit.kind === "date") return `Date: ${ddmmyyyy(hit.value)}`;
  if (hit.kind === "gstin") return `GSTIN/UIN: ${hit.value}`;
  if (hit.kind === "text") return `Invoice No: ${hit.value}`;
  if (hit.kind === "rate") return `${hit.desc ? hit.desc + " " : ""}${hit.value}%`;
  return `${hit.desc ? hit.desc + " " : ""}${hit.label} ${inr(hit.value)}`;
}
const asString = (hit) => (hit.kind === "amount" ? Number(hit.value).toFixed(2) : String(hit.value));

// mode: faithful | unreadable | lowconf | ambiguous | wrong (confident, grounded in its own quote, but not the truth) | none (no answer for any target)
export function oracle(truth, { mode = "faithful", wrong = null, only = null } = {}) {
  return (input) => {
    const list = JSON.parse(/<targets>\n([\s\S]*)\n<\/targets>/.exec(input.userPrompt)[1]);
    const results = [];
    for (const t of list) {
      if (only && !only(t)) continue;
      const hit = lookup(truth, t.find, t.where);
      if (!hit) continue;
      const base = { id: t.id, status: "present", value: asString(hit), printed_text: printed(hit), page: 1, confidence: 0.97, other_readings: [] };
      if (mode === "unreadable") results.push({ ...base, status: "unreadable", value: "", printed_text: "", confidence: 0.2 });
      else if (mode === "lowconf") results.push({ ...base, confidence: 0.5 });
      else if (mode === "ambiguous") results.push({ ...base, other_readings: [asString({ ...hit, value: typeof hit.value === "number" ? hit.value + 10 : hit.value + "X" })] });
      else if (mode === "wrong") {
        const w = wrong ? wrong(t, hit) : null;
        if (w === null || w === undefined) results.push(base);
        else results.push({ ...base, value: asString({ ...hit, value: w }), printed_text: printed({ ...hit, value: w }) });
      } else results.push(base);
    }
    if (mode === "none") return { ok: true, text: JSON.stringify({ results: [] }), usage: { inputTokens: 100, outputTokens: 20 } };
    return { ok: true, text: JSON.stringify({ results }), usage: { inputTokens: 900, outputTokens: 300 } };
  };
}
