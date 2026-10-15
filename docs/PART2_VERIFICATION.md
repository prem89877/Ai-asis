# Part 2: GSTIN checksum, verification layers, end-to-end consistency

Primary regression invoice: `GST Tax Invoice CGST SGST UTGST IGST.pdf` (taxable 350,000 | CGST 18,000 | SGST 9,000 | UTGST 9,000 | IGST 27,000 | cess 0 | total GST 63,000 | grand total 413,000 | TCS/TDS 0). Tests: `tests/part2-regression.test.mjs` (39 tests). `npm test`: 702 pass, 0 fail. `tsc`, `next lint`, `next build` were NOT run (no node_modules / network here).

## 1. GSTIN checksum: verdict
The algorithm is **correct**; nothing was changed in it. `gstinChecksumChar` (normalize.ts) gives the same character as an independent implementation of the published Modulo-36 algorithm written in the test file, on 6 numbers.
The two printed GSTINs really fail it: `27AAACN5544R1Z3` should end in `V`, `06AAACA9911A1Z2` should end in `8`. So the warning is right and the suggestions (`...ZV`, `...Z8`) are what the algorithm computes for those 14 characters. A printed number with a wrong check character is most likely a sample or print error. The system therefore:
- saves the printed value (`vendor_gstin`, `buyer_gstin`), keeps it in `field_status.*.rawValue`, never sets `gstin_auto_corrected`;
- shows the computed last character only as a suggestion (`proposed`, flag text), never writes it;
- treats a passing checksum as layout + check digit only. Registration / ownership is only checked by the portal lookup (`gst-portal.ts`);
- keeps the GSTIN warnings separate from the arithmetic: the engine raises nothing because of a GSTIN and a wrong total does not touch the GSTIN verdict.

## 2. The verification layers (what each does, honestly)
| Layer | Inputs | Method | Fields | Independent? | Output |
|---|---|---|---|---|---|
| Tax cross-check, `tripleCheckTax` (gst-engine.ts) | saved heads + lines | three derivations of the tax: heads printed on the invoice; sum of tax printed per line; taxable x rate per line (+ supplier state vs place of supply) | total GST | yes, three different derivations | `summary.verification` (level, methods, disagreeing) |
| Final gate layer 1, rules (final-audit.ts) | saved record, engine flags | GSTIN layout / check digit / state / PAN, dates, identifiers, **counts the engine's arithmetic verdict** | all header fields | **no for arithmetic**: it reuses the engine's result | `report.layers[0]` |
| Final gate layer 2, consensus | every full reading | strict majority of readings, or a proof (valid GSTIN, date, HSN, **arithmetic ties**) | all header + item cells | readings are independent AI passes; the arithmetic proof reuses the engine verdict | `report.layers[1]` |
| Final gate layer 3, evidence | blind parties reading, amount in words, key-figures reading | printed PAN / state / role, name, place of supply, grand total witnesses | GSTIN, names, place, grand total | yes (blind readings, the printed words); the arithmetic witness is again the engine | `report.layers[2]`, `total_consensus` |

Known limit: the arithmetic proof is one engine used in several places. The independent parts are the tax cross-check derivations, the blind AI readings and the printed amount in words. A model reporting 100% confidence is never used as a witness for the money fields (test: "model confidence of 100% with wrong financial data").

### Bug fixed
`summary.verification.level` only judged the **tax** cross-check, so an invoice with a wrong grand total (1,500 instead of 1,180) or a wrong tax head with a matching total could still show `level: "verified"`. Now (`validateInvoice`, gst-engine.ts) the level drops to `unverified` and `disagreeing` gets `grand_total` / `financial_checks` whenever the total check fails or an arithmetic / allocation / component / CGST-SGST flag is a warning or error. Values are never changed.

## 3. End to end (checked, no change needed)
Extraction normalize -> engine -> saved record (`complete_extraction_job` writes `utgst_amount`) -> review save (`app/api/invoices/[id]/review/route.ts` recomputes all flags on the **server** from the stored record; SQL writes `utgst_amount` only when the client sends it, so an old browser tab cannot wipe it) -> list view (`tax_total` = GST + cess) -> CSV / XLSX (own UTGST column) -> Tally (own UTGST ledger, voucher balances). Legacy rows (`utgst_amount` null, whole state tax in `sgst_amount`) are not double counted anywhere and no UTGST ledger entry is invented for them.

## 4. Small fixes
- `gst-portal.ts`: the composition-scheme check now also looks at UTGST.
- `InvoiceReviewTable.tsx`: the list column was called "GST" but shows GST + cess (`tax_total`); renamed "Tax (GST + cess)" so it cannot be read as the 63,000 total GST.

## 5. Not done / open
- Tally export skips an invoice that carries TCS (the voucher does not balance without a TCS ledger). It is skipped with a clear reason, never booked wrongly.
- No database migration is needed for Part 2.
