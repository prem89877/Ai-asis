# GST validation engine (migration 011)

Entry point: `validateInvoice({ extracted, items }, { tolerancePaise })` in `lib/extraction/gst-engine.ts`.
It only returns flags, a summary and (for round-off) a derived value. It never rewrites an extracted figure.

## Algorithms (each figure is checked by more than one method)
| Function | What it checks |
|---|---|
| `validateLineItem()` | qty x price, less discount (PERCENT or FLAT), x exchange rate, vs printed taxable value. Soft tolerance INR 1.00. Negative lines (returns, rebates) accepted. |
| `validateTaxAllocation()` | Mixed IGST + CGST/SGST. Lines labelled `applied_tax_type`: sum of line IGST / CGST / SGST must equal the invoice. Lines not labelled: the split that reproduces the totals is searched (up to 16 lines). |
| `validateInvoiceTotals()` | Taxable + CGST + SGST + IGST + Cess + TCS - TDS +/- round-off = grand total. Pre-tax charges accepted as a line or only in the taxable base. Difference <= INR 2.00 -> `round_off_amount` set, total PASSES. |
| `tripleCheckTax()` | Printed invoice tax vs printed line tax vs rate x taxable vs state rule (supplier state / place of supply). "verified" only when every available method agrees. |
| `validateEInvoiceMetadata()` | IRN (64 hex), ack no (9-15 digits), e-way bill (12 digits): info notes only, never in a calculation. The note says what is wrong (for example "only 63 characters instead of 64"). Cleaning and the reading vote are in `identifiers.ts` / `verify.ts`. |
| `validateNegativeLines()` | Negative lines (returns, rebates, discounts) are judged ONCE per invoice, not line by line. Signs agree and the items add up to the invoice: silent. Mixed signs on a line, or the invoice adds up only with the line positive: warning `negative_line_suspect`. Cannot be tied to anything: ONE info note `negative_line_items` listing the item numbers. Credit / debit notes: nothing. |
| `resolveGrandTotal()` (total-check.ts) | Grand total witnesses: every AI reading, the printed amount in words (turned into a number in code) and this engine's arithmetic. See docs/EXTRACTION_LAYERS.md. |
| `validateAndRepairGSTIN()` (gstin.ts) | Modulo-36 check digit. Only the 15th character is repaired automatically, and only when two readings agree with confidence above 95%. |

## Decisions you may want to change
- `currency` stays NULL when it is not printed (never guessed). The engine treats NULL as INR; `exchange_rate` is stored as 1.0 for INR invoices and NULL for a foreign currency without a printed rate.
- The old blanket `tax_type_conflict` warning is no longer raised. Mixed tax is judged line by line.
- Round-off window is `ROUND_OFF_MAX_PAISE` (200) in `gst-engine.ts`.

## Not covered
HSN-to-rate lookup tables (rates change by notification), reverse charge, composition scheme, QR-code decoding. Review screen has no edit boxes for the new fields yet; they are kept and used in re-checks.
