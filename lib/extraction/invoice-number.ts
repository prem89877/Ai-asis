// One definition of "the same invoice number", shared by the database duplicate check (extracted_data.invoice_number_norm),
// the review duplicate flag, the sync ledger key and the Tally exporter. No imports on purpose: it is also used in the browser.
//
// Case, spaces and punctuation differences do not matter ("INV-001", "inv/001" and "INV 001" are one number), but the PLACE of a
// separator does: every run of non-alphanumeric characters becomes ONE "-". So "12/3" -> "12-3" and "1/23" -> "1-23" stay different.
// (Stripping all punctuation turned both into "123" and reported them as duplicates.)
export function normalizeInvoiceNumber(raw: string): string | null {
  const n = raw.toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return n === "" ? null : n;
}
