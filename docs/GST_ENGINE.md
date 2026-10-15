# GST validation engine (migration 011)

Entry point: `validateInvoice({ extracted, items }, { tolerancePaise })` in `lib/extraction/gst-engine.ts`.
It only returns flags, a summary and (for round-off) a derived value. It never rewrites an extracted figure.

## Algorithms (each figure is checked by more than one method)
| Function | What it checks |
|---|---|
| `validateLineItem()` | qty x price, less discount (PERCENT or FLAT), x exchange rate, vs printed taxable value. Soft tolerance INR 1.00. Negative lines (returns, rebates) accepted. |
| `validateTaxAllocation()` | Mixed IGST + CGST/SGST. Lines labelled `applied_tax_type`: sum of line IGST / CGST / SGST must equal the invoice. Lines not labelled: the split that reproduces the totals is searched (up to 16 lines). |
| `validateInvoiceTotals()` | **Two-tier total check.** Tier 1 Grand Total = Taxable + CGST + SGST + IGST + Cess + TCS. Tier 2 Net Payable = Tier 1 - TDS. The printed `grand_total` passes if it reproduces EITHER tier, within INR 2.00. Pre-tax charges accepted as a line or only in the taxable base. Difference <= INR 2.00 -> `round_off_amount` set, total PASSES. A printed `net_payable_amount` is cross-checked against the total (see below). |
| `tripleCheckTax()` | Printed invoice tax vs printed line tax vs rate x taxable vs state rule (supplier state / place of supply). "verified" only when every available method agrees. |
| `validateEInvoiceMetadata()` | IRN (64 hex), ack no (9-15 digits), e-way bill (12 digits): info notes only, never in a calculation. The note says what is wrong (for example "only 63 characters instead of 64"). Cleaning and the reading vote are in `identifiers.ts` / `verify.ts`. |
| `validateNegativeLines()` | Negative lines (returns, rebates, discounts) are judged ONCE per invoice, not line by line. Signs agree and the items add up to the invoice: silent. Mixed signs on a line, or the invoice adds up only with the line positive: warning `negative_line_suspect`. Cannot be tied to anything: ONE info note `negative_line_items` listing the item numbers. Credit / debit notes: nothing. |
| `resolveGrandTotal()` (total-check.ts) | Grand total witnesses: every AI reading, the printed amount in words (turned into a number in code) and this engine's arithmetic. See docs/EXTRACTION_LAYERS.md. |
| `validateGstin()` (gstin.ts) | Layout + Modulo-36 check digit. It only REPORTS: the saved GSTIN is always the raw extracted value, and a possible correction is returned as `proposed` (and shown in the flag), never applied. A passing check is not proof that the GSTIN exists; only the GST portal lookup says that. |

## Bottom-line summary fields and the two-tier total (migration 012)
The invoice bottom summary is read as four explicit fields (all optional, `missing` when not printed, never turned into 0). They are read by every AI reading, including the audit and key-figures readings, and voted like any other field.

| Field | Meaning | In the grand total? |
|---|---|---|
| `tcs_amount` | Tax Collected at Source, Sec 206C | Yes, added after tax |
| `tds_amount` | Tax Deducted at Source / withholding, Sec 194Q | No, deducted from the payment |
| `round_off_amount` | Printed round-off, positive or negative | Explains a small difference |
| `net_payable_amount` | Amount payable after TDS | Only when printed as its own figure |

How the printed total is judged (`validateInvoiceTotals()` in `gst-engine.ts`):
1. Tier 1 `taxable + taxes + TCS` and, when TDS > 0, Tier 2 `taxable + taxes + TCS - TDS` are both calculated. Discount, pre-tax charges, a foreign-currency total and a credit-note sign are tried on both tiers.
2. The closest tier to the printed `grand_total` wins (Tier 1 on a tie). It passes when the difference is <= INR 2.00 (or is explained by a printed round-off).
3. A difference up to INR 2.00 is absorbed: `round_off_amount` is saved with source `computed` (only when the invoice printed no round-off; a printed one is never replaced). Above INR 1.00 an info note `round_off_absorbed` is added.
4. TCS and TDS are used as magnitudes: TCS always adds, TDS always reduces, whatever sign the invoice printed.
5. If `net_payable_amount` is printed, it must equal `printed total - TDS` (Tier 1 match) or the printed total itself (Tier 2 match), within INR 2.00. Otherwise `net_payable_mismatch` (warning). If it is lower than the grand total and no TDS was read, `net_payable_tds_not_found` (info) shows the implied deduction.
6. Only when neither tier matches: `arithmetic_total_mismatch` (error). Its details carry both expected figures (`expected`, `expectedNetPayable`).

`validation_summary` also has `total_tier` (`grand_total` or `net_payable`), `expected_grand_total` and `expected_net_payable`.
`resolveGrandTotal()` uses this check as its "arithmetic" witness, so a printed total that reproduces either tier gets that witness.
The old strict `checkTotals()` (Taxable + GST = Total) in `arithmetic.ts` was unused and has been removed.

## Decisions you may want to change
- `currency` stays NULL when it is not printed (never guessed). The engine treats NULL as INR; `exchange_rate` is stored as 1.0 for INR invoices and NULL for a foreign currency without a printed rate.
- The old blanket `tax_type_conflict` warning is no longer raised. Mixed tax is judged line by line.
- Round-off window is `ROUND_OFF_MAX_PAISE` (200) in `gst-engine.ts`.

## Not covered
HSN-to-rate lookup tables (rates change by notification), reverse charge, composition scheme, QR-code decoding. Review screen has no edit boxes for the new fields (TCS, TDS, round-off, net payable) yet; they are kept and used in re-checks.

## Tax-head second layer (`lib/extraction/tax-math.ts`)
Runs inside `validateInvoice()` next to the main checks. It never changes an extracted figure; it only adds flags, `summary.tax_regime` and diagnosis hints.

| Check | Flag | Severity |
|---|---|---|
| CGST and SGST / UTGST differ by more than the tolerance (they are always equal) | `cgst_sgst_unequal` | warning |
| Only one of CGST / SGST read, no IGST | `cgst_sgst_one_sided` | warning |
| Line tax is neither taxable x rate nor half of it | `line_tax_rate_mismatch` | warning |
| Cess more than 5x the taxable value | `cess_implausible` | warning |
| TCS or TDS more than 20% of the taxable value, or TDS >= grand total | `tcs_implausible` / `tds_implausible` | warning |
| Printed total does not reproduce | `arithmetic_total_mismatch` now carries `details.likelyCauses` (TDS already deducted, TCS / cess / CGST / SGST / IGST left out or counted twice, discount twice, pre-tax charges) and the best one in the message | error |

**UTGST.** There is no separate UTGST field: UTGST is saved in `sgst_amount` (labelled "SGST / UTGST" on the review screen and in exports). `summary.tax_regime` tells which head to expect from the supplier GSTIN state and the place of supply: same state = CGST+SGST (CGST+UTGST for UT codes 04, 26, 31, 35, 38), different state = IGST. Delhi, Puducherry and J&K charge SGST.
`normalizeAppliedTaxType()` now accepts any label that names CGST together with SGST or UTGST.

## UTGST is its own tax head (migration 014)

- Stored fields: `cgst_amount`, `sgst_amount`, `utgst_amount`, `igst_amount`, `cess_amount`. UTGST is never merged into SGST.
- `lib/extraction/tax-components.ts` is the single place that adds the heads (integer paise): total GST = CGST + SGST + UTGST + IGST,
  cess is added separately. Verification layers, review checks, exports and Tally all use it.
- CGST is compared with the state-level SUM (SGST + UTGST), never with SGST alone, so mixed invoices
  (IGST lines + CGST/SGST lines + CGST/UTGST lines) reconcile. Line types: `IGST`, `CGST_SGST`, `CGST_UTGST`, `NONE`.
- Legacy rows: `utgst_amount` NULL means "not printed"; `sgst_amount` keeps its old "SGST / UTGST" meaning and is simply
  added, so nothing is lost or double counted. An optional, commented backfill is at the end of migration 014.
- Tolerance: INR 2.00 round-off window (`ROUND_OFF_MAX_PAISE`) plus one paisa per line. Nothing silently changes an extracted
  amount, and the printed grand total is never edited to make a reconciliation pass.
- Discrepancies are specific: `tax_allocation_mismatch` lists the mismatched heads with invoice / lines / difference per head;
  `arithmetic_total_mismatch` lists likely causes (for example `utgst_not_read`).

## Component-specific tax validation (lib/extraction/tax-reconcile.ts)

Every GST head is rebuilt from the item lines on its own and compared with the invoice-level figure. A matching grand total can no longer hide a wrong breakdown.

| Head | Compared with |
| --- | --- |
| IGST | lines charged IGST |
| CGST | half of every CGST+SGST line **and** every CGST+UTGST line (the aggregate of both) |
| SGST | half of the CGST+SGST lines only |
| UTGST | half of the CGST+UTGST lines only |
| Cess | the cess the item totals imply (only when the lines carry a total that includes it) |
| Total GST | CGST + SGST + UTGST + IGST (each head once) against the tax of all lines |
| Grand total | the full invoice arithmetic (`validateInvoiceTotals`) |

CGST is never compared with SGST alone: with SGST lines and UTGST lines, CGST = SGST + UTGST.

Where the lines carry no tax label, a non-mixed invoice is still split by supply type (IGST only, or CGST + state tax). Mixed unlabelled invoices keep the existing split inference. Invoices with pre-tax charges that are not item rows skip the unlabelled fallback, because those charges carry tax the lines do not show.

Every finding states the field, the expected value, the observed value and the reason (`details.components[]`):

* `tax_allocation_mismatch` (labelled lines) and `tax_component_mismatch` (everything else) list each failed head.
* Diagnoses: `utgst_missing`, `utgst_merged_into_sgst`, `utgst_without_utgst_lines`, `igst_mismatch`, `cgst_mismatch`, `sgst_mismatch`, `state_tax_mismatch`, `cess_mismatch`, `total_gst_mismatch`.
* `arithmetic_total_mismatch` now also carries `details.field`, `observed`, `difference`, `reason` and the `components` used.
* When a head disagrees with the lines, `summary.verification.level` is `unverified` even if the grand total matches.

`validation_summary.tax_components` and `validation_summary.adjustments` (TCS, TDS, discount, discount treatment, round-off, printed net payable) record what was compared.

## TCS, TDS and discounts

* TCS is added after tax and is inside the grand total. TDS is withheld from the payment and is not inside the grand total. A commercial discount only reduces the invoice value. They are kept in separate fields and never converted into each other.
* An invoice that states TCS / TDS is not applied gets no adjustment (`adjustments.tcs_tds_applied = false`).
* A printed net payable that is lower than the grand total by exactly the printed commercial discount is explained by the discount. It is no longer reported as a missing TDS (`net_payable_tds_not_found`).
* A TCS or TDS figure identical to the printed discount raises `tcs_matches_discount` / `tds_matches_discount`; both values stay as read.
* Tally: a gap between taxable + taxes and the printed total that equals the printed discount is booked to the `discountLedger` ("Discount Received", credit) instead of skipping the invoice. TCS is still not booked (the export view does not carry `tcs_amount`), so such an invoice is skipped with the usual "does not add up" reason.
