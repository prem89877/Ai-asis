// Offline evaluation dataset: each scenario has the GROUND TRUTH (what the page prints), what the scripted first reading returned (with
// injected errors), optional different answers of the other readings, and how the scripted source re-read behaves.
// These are SIMULATED model outputs written by hand. They exercise the pipeline's code; they say nothing about how often the real model errs.
import { invoice, set, BUYER_GSTIN_KA, BUYER_GSTIN_MH } from "./invoice-builder.mjs";
import { oracle } from "./oracle.mjs";
import { f, missing, unreadable } from "../helpers.mjs";

const R3 = [{ d: "Widget Pro", q: 2, p: 500, r: 18, hsn: "8471" }, { d: "Bolt M8", q: 10, p: 20, r: 18, hsn: "7318" }, { d: "Cable 2m", q: 5, p: 150, r: 18, hsn: "8544" }];
const intra = invoice(R3, { buyerGstin: BUYER_GSTIN_MH });
const inter = invoice(R3, { inter: true, buyerGstin: BUYER_GSTIN_KA, number: "INV-002" });
const MANY = Array.from({ length: 12 }, (_, i) => ({ d: `Part ${String.fromCharCode(65 + i)}`, q: i + 1, p: 100 + i * 10, r: i % 2 ? 12 : 18, hsn: String(8400 + i) }));
const multi = invoice(MANY, { number: "INV-MP-12" });
const dupLegit = invoice([{ d: "Bolt M8", q: 2, p: 500, r: 18 }, { d: "Bolt M8", q: 2, p: 500, r: 18 }, { d: "Nut M8", q: 4, p: 25, r: 18 }]);
const cessInv = invoice([{ d: "Aerated drink", q: 24, p: 40, r: 28 }, { d: "Water 1L", q: 50, p: 20, r: 0 }], { cess: 96, number: "DB/0931", date: "2025-08-20" }); // 28% + cess: only valid before GST 2.0 (22 Sep 2025), so the invoice is dated before it

const faithful = (t) => oracle(t);
const TOTAL = intra.grand_total.value; // 2301: used wherever a scenario needs the CORRECT total of the 3-row invoice
export const SCENARIOS = [
  // ---- clear invoices -----------------------------------------------------------------------------------------------------------
  { id: "clear-intra-state", category: "clear", truth: intra, reading: intra, source: faithful(intra) },
  { id: "clear-inter-state-igst", category: "clear", truth: inter, reading: inter, source: faithful(inter) },
  { id: "clear-cess-zero-rated", category: "clear", truth: cessInv, reading: cessInv, source: faithful(cessInv) },
  // ---- similar-looking digits / decimal errors repeated by every reading (the layers before cannot catch them) --------------------
  { id: "digits-total-misread", category: "digits", truth: intra, reading: set(intra, "grand_total", TOTAL + 60), source: faithful(intra) },
  { id: "digits-unit-price-500-600", category: "digits", truth: intra, reading: set(intra, "line_items.0.unit_price", 600), source: faithful(intra) },
  { id: "decimal-total-x10", category: "decimal", truth: intra, reading: set(intra, "grand_total", TOTAL * 10), source: faithful(intra) },
  { id: "decimal-unit-price-x10", category: "decimal", truth: intra, reading: set(intra, "line_items.0.unit_price", 5000), source: faithful(intra) },
  { id: "decimal-quantity-x10", category: "decimal", truth: intra, reading: set(intra, "line_items.1.quantity", 100), source: faithful(intra) },
  // ---- GSTIN ---------------------------------------------------------------------------------------------------------------------
  { id: "gstin-supplier-digit", category: "gstin", truth: intra, reading: set(intra, "supplier_gstin", "27AAPFU0939F1ZW"), source: faithful(intra) },
  { id: "gstin-buyer-digit", category: "gstin", truth: intra, reading: set(intra, "buyer_gstin", BUYER_GSTIN_MH.slice(0, 14) + (BUYER_GSTIN_MH[14] === "0" ? "1" : "0")), source: faithful(intra) },
  { id: "gstin-supplier-missing", category: "gstin", truth: intra, reading: set(intra, "supplier_gstin", missing()), source: faithful(intra) },
  { id: "gstin-wrong-reread-same", category: "gstin", truth: intra, reading: set(intra, "supplier_gstin", "27AAPFU0939F1ZW"), source: oracle(intra, { mode: "wrong", wrong: (t) => (t.find === "supplier GSTIN" ? "27AAPFU0939F1ZW" : null) }) },
  // ---- CGST / SGST versus IGST -----------------------------------------------------------------------------------------------------
  { id: "tax-cgst-misread", category: "tax", truth: intra, reading: set(intra, "cgst", intra.cgst.value + 72), source: faithful(intra) },
  { id: "tax-igst-misread", category: "tax", truth: inter, reading: set(inter, "igst", inter.igst.value - 90), source: faithful(inter) },
  // the document itself charges IGST on a same-state sale (supplier's mistake): the extraction must copy it and flag it, not "fix" it
  { id: "tax-igst-on-same-state-as-printed", category: "tax", truth: { ...intra, cgst: missing(), sgst: missing(), igst: f(351) }, reading: { ...intra, cgst: missing(), sgst: missing(), igst: f(351) }, source: faithful({ ...intra, cgst: missing(), sgst: missing(), igst: f(351) }) },
  // ---- taxable values and totals -----------------------------------------------------------------------------------------------------
  { id: "taxable-header-wrong", category: "totals", truth: intra, reading: set(intra, "taxable_value", intra.taxable_value.value + 100), source: faithful(intra) },
  { id: "total-wrong-all-layers", category: "totals", truth: intra, reading: set(intra, "grand_total", TOTAL - 45), source: faithful(intra) },
  { id: "total-wrong-first-only-others-right", category: "totals", truth: intra, reading: set(intra, "grand_total", TOTAL - 45), layers: { verify: intra, audit: intra }, source: faithful(intra) },
  // ---- multi-line / multi-page -------------------------------------------------------------------------------------------------------
  { id: "multipage-row-quantity", category: "multipage", truth: multi, reading: set(multi, "line_items.7.quantity", 80), pages: 3, source: faithful(multi) },
  { id: "multipage-clear", category: "multipage", truth: multi, reading: multi, pages: 3, source: faithful(multi) },
  // ---- duplicate versus legitimate repeated items ------------------------------------------------------------------------------------
  { id: "repeated-items-legit", category: "duplicates", truth: dupLegit, reading: dupLegit, source: faithful(dupLegit) },
  { id: "repeated-block-page-overlap", category: "duplicates", truth: intra, reading: { ...intra, line_items: [...intra.line_items, ...intra.line_items] }, pages: 2, source: faithful(intra) },
  // ---- blurry / missing / ambiguous -------------------------------------------------------------------------------------------------
  { id: "blurry-total-unreadable-reread-ok", category: "blurry", truth: intra, reading: set(intra, "grand_total", unreadable()), source: faithful(intra) },
  { id: "blurry-total-wrong-reread-unreadable", category: "blurry", truth: intra, reading: set(intra, "grand_total", TOTAL + 60), source: oracle(intra, { mode: "unreadable" }) },
  { id: "blurry-correct-values-low-confidence", category: "blurry", truth: intra, reading: set(set(intra, "grand_total", TOTAL, 0.45), "invoice_date", "2026-09-15", 0.5), source: faithful(intra) },
  { id: "missing-invoice-number", category: "missing", truth: intra, reading: set(intra, "invoice_number", missing()), source: faithful(intra) },
  { id: "ambiguous-reread", category: "ambiguous", truth: intra, reading: set(intra, "grand_total", TOTAL + 60), source: oracle(intra, { mode: "ambiguous" }) },
  // ---- the re-read itself is wrong (false-correction safety) -----------------------------------------------------------------------
  { id: "hallucinated-total-on-correct-doc", category: "safety", truth: intra, reading: set(intra, "grand_total", TOTAL, 0.5), source: oracle(intra, { mode: "wrong", wrong: (t) => (t.find === "grand total" ? TOTAL - 45 : null) }) },
  { id: "hallucinated-unit-price-on-correct-doc", category: "safety", truth: intra, reading: set(intra, "line_items.0.unit_price", 500, 0.5), source: oracle(intra, { mode: "wrong", wrong: (t) => (t.find === "unit price / rate" ? 5000 : null) }) },
  { id: "hallucinated-fix-on-wrong-total", category: "safety", truth: intra, reading: set(intra, "grand_total", TOTAL + 60), source: oracle(intra, { mode: "wrong", wrong: (t) => (t.find === "grand total" ? TOTAL - 9 : null) }) },
  // ---- malformed / failing re-read --------------------------------------------------------------------------------------------------
  { id: "source-reply-malformed", category: "failure", truth: intra, reading: set(intra, "grand_total", TOTAL + 60), source: () => ({ ok: true, text: "{\"results\": [", usage: { inputTokens: 10, outputTokens: 5 } }) },
  { id: "source-provider-error", category: "failure", truth: intra, reading: set(intra, "grand_total", TOTAL + 60), source: () => ({ ok: false, code: "provider_unavailable", retryable: true }) },
  { id: "photo-png-wrong-total", category: "photo", truth: intra, reading: set(intra, "grand_total", TOTAL + 60), file: "png", source: faithful(intra) },
];
