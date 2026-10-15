// Live check of what a person TYPES on the review screen, shown next to the box that was edited (separate from the
// extraction warnings, which describe what the AI read). Pure and client-safe: no network, no server code.
// Only boxes whose text differs from the saved value are checked. Nothing here changes a value.
//   "error"   = the server would refuse to save this (wrong number format, not 4-8 digit HSN, bad date ...)
//   "warning" = it is accepted, but it looks wrong and a person should look again
import { MAX_ABS_AMOUNT, MAX_ABS_QUANTITY, checkGstin, cleanText, normalizeHsn, normalizeIsoDate } from "../extraction/normalize.ts";
import { suggestGstinFixes, suggestionText } from "../extraction/gstin.ts";
import { ITEM_FIELDS } from "./fields.ts";
import type { HeaderColumn, ItemColumn } from "./fields.ts";
import { HEADER_FIELDS } from "./fields.ts";
import { parseAmount } from "./input.ts";

export interface DraftIssue {
  severity: "error" | "warning";
  message: string;
}

export type HeaderIssues = Partial<Record<HeaderColumn, DraftIssue[]>>;
export type ItemIssues = Partial<Record<ItemColumn, DraftIssue[]>>;
type HeaderDraft = Record<HeaderColumn, string>;
type ItemDraft = Record<ItemColumn, string>;

const GST_START = "2017-07-01";
const TAX_COLUMNS: HeaderColumn[] = ["cgst_amount", "sgst_amount", "utgst_amount", "igst_amount", "cess_amount"];
const TOTAL_COLUMNS: HeaderColumn[] = ["taxable_amount", "cgst_amount", "sgst_amount", "utgst_amount", "igst_amount", "cess_amount", "total_amount"];
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;

const inr = (n: number) => `₹${n.toFixed(2)}`;
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

function push<K extends string>(out: Partial<Record<K, DraftIssue[]>>, key: K, severity: DraftIssue["severity"], message: string) {
  const list = out[key] ?? [];
  if (!list.some((x) => x.message === message)) list.push({ severity, message });
  out[key] = list;
}

// A number typed in a box. null = blank or not a number (the amount check reports a non-number on its own).
function numberOf(raw: string): number | null {
  const t = raw.replace(/[,\s]/g, "");
  if (t === "" || !/^-?\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function amountMessage(raw: string, dp: number, max: number): string | null {
  const r = parseAmount(raw, "Amount", dp, max);
  return r.ok ? null : cap(r.message.replace(/^Amount: /, ""));
}

const isIndian = (currency: string) => currency.trim() === "" || currency.trim().toUpperCase() === "INR";

export function checkHeaderDraft(draft: HeaderDraft, base: HeaderDraft, now: Date = new Date()): HeaderIssues {
  const out: HeaderIssues = {};
  const changed = (c: HeaderColumn) => draft[c] !== base[c];
  const memo = draft.document_type === "credit_note" || draft.document_type === "debit_note";

  for (const def of HEADER_FIELDS) {
    const c = def.column;
    if (!changed(c) || def.kind === "doctype") continue;
    const raw = draft[c];
    const v = raw.trim();

    if (v === "") {
      if (base[c].trim() !== "") push(out, c, "warning", `You cleared this box. It was "${base[c].trim().slice(0, 40)}".`);
      continue;
    }

    switch (def.kind) {
      case "text": {
        if (CONTROL_CHARS.test(raw)) push(out, c, "error", "Contains characters that are not allowed.");
        else if (cleanText(raw).length > (def.maxLength ?? 200)) push(out, c, "error", `Too long. Use at most ${def.maxLength ?? 200} characters.`);
        if (c === "invoice_number" && !/^[A-Za-z0-9\-/._#\s]+$/.test(v)) push(out, c, "warning", "Unusual character. Invoice numbers normally use letters, digits, - / . and _ only.");
        break;
      }
      case "gstin": {
        const g = raw.replace(/\s+/g, "").toUpperCase();
        if (!/^[A-Z0-9]+$/.test(g)) {
          push(out, c, "error", "Use letters and digits only.");
        } else if (g.length !== 15) {
          push(out, c, "warning", `A GSTIN has 15 characters. You typed ${g.length}.`);
        } else {
          const chk = checkGstin(g);
          const hint = suggestionText(suggestGstinFixes(g));
          if (!chk.ok && chk.reason === "format") push(out, c, "warning", "Not a valid GSTIN pattern (2 digits, 5 letters, 4 digits, 1 letter, 1 digit or letter, Z, 1 check character)." + hint);
          else if (!chk.ok) push(out, c, "warning", "The check character does not match, so one character may be mistyped." + hint);
        }
        const other = c === "vendor_gstin" ? draft.buyer_gstin : c === "buyer_gstin" ? draft.vendor_gstin : "";
        if (other && other.replace(/\s+/g, "").toUpperCase() === g && g !== "") push(out, c, "warning", "Supplier and buyer GSTIN are the same.");
        break;
      }
      case "date": {
        const d = normalizeIsoDate(v);
        if (!d) push(out, c, "error", "Enter a valid date.");
        else if (d > now.toISOString().slice(0, 10)) push(out, c, "warning", "This date is in the future.");
        else if (d < GST_START) push(out, c, "warning", "This date is before GST started (1 July 2017).");
        break;
      }
      case "currency": {
        if (!/^[A-Za-z]{3}$/.test(v)) push(out, c, "error", "Use a 3-letter code such as INR.");
        break;
      }
      case "amount": {
        const msg = amountMessage(raw, 2, MAX_ABS_AMOUNT);
        if (msg) push(out, c, "error", msg);
        else if ((numberOf(raw) ?? 0) < 0 && !memo) push(out, c, "warning", "Negative amount. Only credit and debit notes normally have one.");
        break;
      }
      default:
        break;
    }
  }

  // Amounts that belong together. Only shown when one of them was edited.
  const n = (c: HeaderColumn) => (numberOf(draft[c]) ?? null);
  const cgst = n("cgst_amount");
  const sgst = n("sgst_amount");
  const utgst = n("utgst_amount");
  const igst = n("igst_amount");
  const stateTax = sgst === null && utgst === null ? null : (sgst ?? 0) + (utgst ?? 0); // SGST + UTGST, each its own amount
  const stateChanged = () => changed("sgst_amount") || changed("utgst_amount");
  if (cgst !== null && stateTax !== null && Math.abs(cgst - stateTax) > 1) {
    for (const c of ["cgst_amount", "sgst_amount", "utgst_amount"] as const) if ((n(c) !== null) && (changed("cgst_amount") || stateChanged())) push(out, c, "warning", `CGST and SGST + UTGST are normally equal (CGST ${inr(cgst)}, SGST + UTGST ${inr(stateTax)}).`);
  }
  if (igst !== null && igst !== 0 && ((cgst ?? 0) !== 0 || (sgst ?? 0) !== 0 || (utgst ?? 0) !== 0)) {
    // Allowed on a mixed invoice (some lines IGST, others CGST + SGST / UTGST), so this stays a soft note.
    for (const c of ["igst_amount", "cgst_amount", "sgst_amount", "utgst_amount"] as const) {
      if (changed("igst_amount") || changed("cgst_amount") || stateChanged()) if (n(c) !== null && n(c) !== 0) push(out, c, "warning", "IGST and CGST / SGST / UTGST are normally not charged on the same invoice, unless different lines carry different taxes.");
    }
  }
  if (isIndian(draft.currency) && TOTAL_COLUMNS.some(changed)) {
    const taxable = n("taxable_amount");
    const total = n("total_amount");
    if (taxable !== null && total !== null) {
      const tax = TAX_COLUMNS.reduce((s, c) => s + (n(c) ?? 0), 0);
      const expected = taxable + tax;
      if (Math.abs(expected - total) > 2) {
        push(out, "total_amount", "warning", `After your change, taxable value + taxes = ${inr(expected)} but the grand total is ${inr(total)} (difference ${inr(Math.abs(expected - total))}). Ignore this if TCS, round-off or other charges are printed on the invoice.`);
      }
    }
  }
  return out;
}

export function checkItemsDraft(items: ItemDraft[], base: ItemDraft[], currency: string): ItemIssues[] {
  return items.map((row, i) => {
    const out: ItemIssues = {};
    const b = base[i];
    const changed = (k: ItemColumn) => (b ? row[k] !== b[k] : row[k].trim() !== "");

    for (const def of ITEM_FIELDS) {
      const k = def.key;
      if (!changed(k)) continue;
      const raw = row[k];
      const v = raw.trim();
      if (v === "") {
        if (b && b[k].trim() !== "") push(out, k, "warning", `You cleared this box. It was "${b[k].trim().slice(0, 40)}".`);
        continue;
      }
      if (def.kind === "amount") {
        const max = k === "quantity" ? MAX_ABS_QUANTITY : MAX_ABS_AMOUNT;
        const msg = amountMessage(raw, def.dp ?? 2, max);
        const num = numberOf(raw);
        if (msg) push(out, k, "error", msg);
        else if (k === "gst_rate" && num !== null && (num < 0 || num > 100)) push(out, k, "error", "Enter a rate from 0 to 100.");
        else if (num !== null && num < 0) push(out, k, "warning", "Negative value. Only returns and rebates normally have one.");
      } else if (def.kind === "hsn") {
        const h = normalizeHsn(v);
        if (h === null) push(out, k, "error", "Use 4 to 8 digits.");
        else if (![4, 6, 8].includes(h.length)) push(out, k, "warning", "HSN/SAC codes normally have 4, 6 or 8 digits.");
      } else if (CONTROL_CHARS.test(raw)) {
        push(out, k, "error", "Contains characters that are not allowed.");
      } else if (cleanText(raw).length > (k === "description" ? 500 : 20)) {
        push(out, k, "error", `Too long. Use at most ${k === "description" ? 500 : 20} characters.`);
      }
    }

    // Line maths (Indian rupee invoices only: on a foreign currency invoice the unit price is in another currency).
    if (isIndian(currency)) {
      const q = numberOf(row.quantity);
      const p = numberOf(row.unit_price);
      const d = numberOf(row.discount_amount) ?? 0;
      const t = numberOf(row.taxable_amount);
      const r = numberOf(row.gst_rate);
      const g = numberOf(row.gst_amount);
      const lt = numberOf(row.line_total);
      if (q !== null && p !== null && t !== null && (["quantity", "unit_price", "discount_amount", "taxable_amount"] as const).some(changed)) {
        const expected = q * p - d;
        if (Math.abs(expected - t) > 1) push(out, "taxable_amount", "warning", `Qty × unit price − discount = ${inr(expected)}, but the taxable value is ${inr(t)}.`);
      }
      if (t !== null && r !== null && g !== null && (["taxable_amount", "gst_rate", "gst_amount"] as const).some(changed)) {
        const expected = (t * r) / 100;
        if (Math.abs(expected - g) > 1) push(out, "gst_amount", "warning", `${r}% of ${inr(t)} = ${inr(expected)}, but the GST amount is ${inr(g)}.`);
      }
      if (t !== null && g !== null && lt !== null && (["taxable_amount", "gst_amount", "line_total"] as const).some(changed)) {
        if (Math.abs(t + g - lt) > 1) push(out, "line_total", "warning", `Taxable + GST = ${inr(t + g)}, but the line total is ${inr(lt)}.`);
      }
    }
    return out;
  });
}

export function countIssues(header: HeaderIssues, items: ItemIssues[]): { errors: number; warnings: number } {
  let errors = 0;
  let warnings = 0;
  const all = [...Object.values(header), ...items.flatMap((r) => Object.values(r))];
  for (const list of all) for (const i of list ?? []) (i.severity === "error" ? errors++ : warnings++);
  return { errors, warnings };
}
