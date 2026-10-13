// e-invoice / e-way bill identifiers: IRN (64 hex characters), acknowledgement number (digits), e-way bill number (12 digits).
// They are text only and never enter a calculation, but they are copied from long, tiny-print blocks and QR captions,
// so they are the values most often misread. Rules in this file:
//  - cleaning removes only things that can never be part of the value (labels, spaces, line breaks, dashes, quotes);
//  - the ONLY character repair is O/o/Q -> 0 and I/l/| -> 1 inside an IRN, because letters outside a-f can never be
//    part of a hexadecimal IRN and those are the digits they are mistaken for. It is used only when the repaired value
//    is then exactly 64 hexadecimal characters, and it is always reported;
//  - a value that is still wrong after cleaning is kept as read and flagged. Nothing is ever invented.

export type IdentifierKind = "irn" | "ack_no" | "eway_bill_no";

const INVISIBLE = /[\u200B-\u200D\u2060\uFEFF\u00AD]/g;
const SEPARATORS = /[\s\-\u2010-\u2015_.:;,|'"`()[\]{}<>]+/g;
const IRN_LABEL = /^\s*(?:e[\s-]*invoice\s*)?irn(?:\s*(?:no\.?|number|#|hash))?\s*[:=\-\u2013\u2014]?\s*/i;
const ACK_LABEL = /^\s*ack(?:nowledge?ment)?\.?\s*(?:no\.?|number|#)?\s*[:=\-\u2013\u2014]?\s*/i;
const EWAY_LABEL = /^\s*e[\s-]*way\s*bill\s*(?:no\.?|number|#)?\s*[:=\-\u2013\u2014]?\s*/i;

const IRN_RE = /^[0-9a-f]{64}$/;
const ACK_RE = /^[0-9]{9,15}$/;
const EWAY_RE = /^[0-9]{12}$/;

export function isValidIrn(v: string | null | undefined): boolean {
  return typeof v === "string" && IRN_RE.test(v);
}
export function isValidAckNo(v: string | null | undefined): boolean {
  return typeof v === "string" && ACK_RE.test(v);
}
export function isValidEwayBill(v: string | null | undefined): boolean {
  return typeof v === "string" && EWAY_RE.test(v);
}

export function isValidIdentifier(kind: IdentifierKind, v: string | null | undefined): boolean {
  return kind === "irn" ? isValidIrn(v) : kind === "ack_no" ? isValidAckNo(v) : isValidEwayBill(v);
}

export interface CleanedIdentifier {
  value: string; // cleaned text (lower-case for a valid IRN)
  valid: boolean;
  // Set only when look-alike characters had to be replaced to reach a valid IRN.
  repaired?: { from: string; to: string };
}

function stripLabel(kind: IdentifierKind, raw: string): string {
  const re = kind === "irn" ? IRN_LABEL : kind === "ack_no" ? ACK_LABEL : EWAY_LABEL;
  return raw.replace(INVISIBLE, "").replace(re, "");
}

// Characters that cannot occur in a hexadecimal IRN, and the digit each one is almost always a misreading of.
const HEX_LOOKALIKE: Record<string, string> = { O: "0", o: "0", Q: "0", I: "1", l: "1", "|": "1" };

export function cleanIdentifier(kind: IdentifierKind, raw: string): CleanedIdentifier {
  // "|" is a separator for ack/e-way, but inside an IRN it is a misread "1", so it is removed after the repair step.
  const base = stripLabel(kind, raw).replace(/[\s\u00A0]+/g, "");
  if (kind === "irn") {
    const plain = base.replace(SEPARATORS, "");
    const lower = plain.toLowerCase();
    if (IRN_RE.test(lower)) return { value: lower, valid: true };
    const fixed = base.replace(/[\-\u2010-\u2015_.:;,'"`()[\]{}<>]+/g, "").replace(/[OoQIl|]/g, (c) => HEX_LOOKALIKE[c]).toLowerCase();
    if (IRN_RE.test(fixed) && !IRN_RE.test(lower)) return { value: fixed, valid: true, repaired: { from: plain, to: fixed } };
    return { value: plain, valid: false };
  }
  const value = base.replace(SEPARATORS, "");
  return { value, valid: isValidIdentifier(kind, value) };
}

// Same-value test used when two readings of an identifier are compared.
export function identifierForm(kind: IdentifierKind, raw: string): string {
  return cleanIdentifier(kind, raw).value;
}

// Why a value is wrong, in words a reviewer can act on. Returns null when the value is fine.
export function describeIdentifierProblem(kind: IdentifierKind, value: string): string | null {
  if (isValidIdentifier(kind, value)) return null;
  const n = value.length;
  if (kind === "irn") {
    const bad = value.replace(/[0-9a-f]/gi, "");
    if (bad.length > 0) return `The IRN read from the invoice has ${n} characters and contains characters that cannot be in an IRN. An IRN is exactly 64 characters, 0-9 and a-f only. Check the QR code or the original.`;
    return n < 64
      ? `The IRN read from the invoice has only ${n} characters instead of 64, so ${64 - n} character(s) were probably missed. Check the QR code or the original.`
      : `The IRN read from the invoice has ${n} characters instead of 64, so extra characters were probably picked up. Check the QR code or the original.`;
  }
  if (kind === "ack_no") return `The acknowledgement number has ${n} characters; it should be 9 to 15 digits. Check the original.`;
  return `The e-way bill number has ${n} characters; it should be exactly 12 digits. Check the original.`;
}
