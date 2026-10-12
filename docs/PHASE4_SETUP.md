# AI Asis Phase 4: review, verification and exports

Phase 4 turns extracted invoices into reviewed, exportable records. Nothing is verified automatically: a person checks the figures against the original, corrects what is wrong, and marks the invoice **Verified**. Warnings are only pointers. **No value is ever changed by a check.**

## 1. Setup

1. Run the new migrations (after the five earlier ones), in order: `006_review_export.sql`, then `007_export_redownload.sql`. No enum changes, each can run in one go.
2. No new environment variables. `SUPABASE_SERVICE_ROLE_KEY` (Phase 3) is used by the save and export routes.
3. `npm install && npm run typecheck && npm run lint && npm run build && npm test`
4. Scratch database only: `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/phase4_review_export.test.sql` (last row `PHASE 4 SQL TESTS PASSED`).
5. If the dashboard shows "counts could not be loaded", the migration has not been run.

## 2. What changed

| Area | What it does |
|---|---|
| Dashboard | Real counts from the database: invoices, needs review, verified, processing, failed, processed this month. AI usage panel (extractions vs monthly limit, tokens, estimated cost, exports), running jobs, recent failures. Recent activity now shows reviews and exports. |
| Invoice table | Server-side search (supplier, invoice no., GSTIN, file name), status tabs, warning filter, sortable columns, paging (25), polling every 5 s while anything is processing. Cards on phones, table from tablet width. |
| Statuses | **Processing** (uploaded, queued, processing), **Needs review** (needs_review, and completed = AI finished with no flags but nobody has verified it), **Verified**, **Failed**. |
| Review screen | Original invoice next to editable fields and line items (tabs on phones). Edit, add/remove items, save, mark verified, remove verification. Previous/next within the list. Duplicate candidates are listed and clickable. |
| Exports | CSV and XLSX, chosen and ordered columns, optional line items, verified-only option, date format, saved default columns, export history. |

## 3. Review rules

- Corrections go through `PUT /api/invoices/:id/review`. Browsers still cannot write `extracted_data` or `line_items`, or set `verified` (grants and trigger from Phase 3 are unchanged).
- Input is validated on the server: numbers are never rounded (more decimals than the column allows is rejected), dates must be real, HSN 4 to 8 digits. A wrong-looking GSTIN is accepted (it may be what the invoice shows) and flagged.
- The original AI output stays in `extracted_data.raw_extraction`. The first AI value of every corrected header field is kept in `corrected_fields` and shown next to the field. `review_events` records every edit, verification and un-verification with the changes.
- After each save all flags are recomputed from the current values (extraction-time flags described the old values) and duplicates are re-checked.
- Verifying while errors or warnings remain needs an explicit confirmation; the acknowledged warnings are stored in the event.
- Editing a verified invoice removes the verification.
- Two people editing at once: the save carries the `updated_at` the page loaded; a mismatch returns a conflict and writes nothing.

## 4. GST validation

All checks only add flags. Severity decides the status: error or warning keeps an invoice in **Needs review**; info does not.

| Check | Severity |
|---|---|
| Supplier and place of supply in the same state but IGST charged, or different states but CGST/SGST charged (state from the GSTIN prefix and the place-of-supply text/code; skipped for foreign country 96 and other territory 97) | warning |
| Supplier state or place of supply unknown while tax is charged | info |
| CGST and SGST amounts differ | warning |
| Tax charged but no supplier GSTIN | warning |
| Tax on a document marked bill of supply | warning |
| Tax invoice with no tax at all (exempt, nil-rated, zero-rated, composition are normal) | info |
| Item GST amount vs taxable value at the stated rate | warning |
| Invoice CGST+SGST+IGST vs items at their rates | warning |
| Rate not in the common list (0, 0.1, 0.25, 1, 1.5, 3, 5, 6, 7.5, 12, 18, 28, 40) or an overall effective rate that is not common | info |
| Invalid GSTIN format or check digit; implausible date; negative amounts (not on credit/debit notes) | warning |
| Existing Phase 3 checks: missing invoice number/date/total/supplier (error), missing supplier GSTIN (warning), taxable + taxes vs total, items vs subtotal, duplicates | as before |

The rate list is a hint, not law: GST rates change by notification, so an unlisted rate is info only. Edit `COMMON_GST_RATES` in `lib/review/gst.ts` when rates change.

**Not modelled** (they show up as arithmetic mismatches for a person to judge): reverse charge, TCS, round-off beyond the tolerance (`EXTRACTION_TOLERANCE_PAISE`, default INR 1), freight/packing lines without items, composition-scheme specifics, per-line CGST/SGST rates printed as 9 + 9 instead of 18, e-invoice/IRN checks, GSTIN existence on the GST portal (only format and check digit).

## 5. Exports

- `POST /api/exports` validates and records the export and returns an id; the browser then downloads the file from `GET /api/exports/:id/download` with a normal link (script-made blob downloads were blocked by some Android browsers after the first one). The file is rebuilt from the saved request, so it reflects the current invoice values. Up to 500 invoices per export, 10 exports per firm per minute. Only invoices of your firm with extracted data are included; others are counted as skipped. Unverified invoices are included unless "Verified only" is on, and are marked in the Review Status column.
- Order of rows: invoice date, invoice number (natural order), upload time.
- **CSV**: UTF-8 with BOM, CRLF, plain decimals (no thousands separators), dates as `2026-09-15` or `15/09/2026`, timestamps in IST. Text cells starting with `= + - @` get a leading apostrophe so a spreadsheet cannot run them as formulas.
- **XLSX** (built in `lib/export/xlsx.ts`, no dependency): real date cells, `#,##0.00` amounts, GSTIN/invoice number/HSN/ids as text (leading zeros kept), frozen styled header row, filters, line items on a second sheet "Line items". Text is stored as strings and never evaluated.
- Separate columns: Taxable Value, Discount, CGST, SGST/UTGST, IGST, Cess, Total Tax, Invoice Total. Optional: review flags, model confidence, source file, ids.
- Line items: XLSX second sheet (invoice reference columns repeat); CSV one row per item with invoice columns repeated.
- Column choice per user is saved in `export_preferences`. `export_history` stores who, when, format, count, skipped, columns and invoice ids; **the files themselves are not stored**, so a past export cannot be downloaded again, only repeated.

### Tally and other accounting formats

The structure is ready: `lib/export/profiles.ts` defines `ExportProfile`, and the column registry (`lib/export/columns.ts`) plus table builder (`lib/export/build.ts`) are separate from the file writers. A Tally-compatible profile is listed as **planned**. **No Tally XML, ledger mapping or import exists, and nothing has been tried in Tally.** Do not describe it as supported until a profile has been imported into Tally with real data.

## 6. Security

| Control | Where |
|---|---|
| Same-origin check on mutating routes, verified session, firm taken from the database (never from the browser) | `lib/api/guard.ts` |
| Reads through the user's session (RLS) plus an explicit `firm_id` filter; list/summary views are `security_invoker` | list, summary, export, extraction, file routes |
| Writes by the service role only after authorization, always with `firm_id`; the save function re-checks the invoice belongs to that firm | review and export routes, `save_invoice_review()`, `record_export()` |
| Browsers cannot insert export history, write extracted data, or call the server functions | grants and revokes in the migration |
| Search text, sort column, direction, status and warning filters are whitelisted; PostgREST special characters are stripped | `lib/review/query.ts` |
| Column keys are validated against the registry; unknown or repeated keys are rejected | `lib/export/columns.ts` |
| Original file is served only to firm members through `/api/invoices/:id/file`; the bucket stays private | file route |
| Request bodies are size-capped | review 256 KB, export 64 KB |

## 7. Tests and results

Run on 11 Oct 2026 in the build environment (Node 22, no network, no PostgreSQL):

| Check | Result |
|---|---|
| `npm test` (`node --test`) | **116 passed, 0 failed** (74 earlier + 42 new: review input/apply, GST and flag rules, list query, export CSV/XLSX/columns/profiles) |
| XLSX opened with openpyxl and LibreOffice (headless convert) | opens; dates, numbers, text cells, frozen header, filters and the second sheet read back correctly |
| Type check | the new pure modules (`lib/review`, `lib/export`) type-check with no errors. Components and routes were checked against stub declarations only (see below) |
| `supabase/tests/phase4_review_export.test.sql` | **written, not executed** |
| `npm run build`, `npm run lint` | **not run** (`npm install` is blocked without network) |

### Not verified (please run these first)

- **`next build`, lint and the real React/Next/Supabase/lucide types**: dependencies could not be installed. I type-checked the routes and components with stub module declarations, which catches undefined names, wrong imports and null-handling in my code but not mismatches with the real library types. Expect to fix small things on the first `npm run typecheck`.
- **SQL**: the migration and its test file were reviewed by hand, never run. Run them on a scratch Supabase project first. In particular check the `invoice_review_list` view (the `flag_keys` lateral unnest) and the `.overlaps()` filter used for warning filters.
- **Embedded selects** in `app/dashboard/page.tsx` (`processing_jobs` and `review_events` with `invoices(original_filename)`) rely on PostgREST resolving the composite foreign keys. If the jobs or activity panel is empty while data exists, that is the place to look.
- **PDF preview** inside the page depends on the browser. Desktop Chrome/Edge/Firefox use the built-in viewer; Android browsers cannot show a PDF in a page, so phones get an "Open original PDF" button (images show inline everywhere). The `next.config.mjs` header rules that allow this site to frame only `/api/invoices/:id/file` are untested in a real build.
- **Real devices**: layouts follow Tailwind breakpoints (cards below 768 px, stacked review tabs below 1024 px, 40 to 44 px touch targets, safe-area padding), but were not opened on an Android phone.
- **Excel itself** was not available; LibreOffice and openpyxl were.

## 8. Known limits

- Selecting "all matching" takes the first 500 matches (the export limit); the screen says so.
- Review is per firm member; any member can verify. Roles (maker/checker) are not part of this phase.
- Line-item edits replace all items of the invoice in one step; per-item history is only in the event summary (counts), the original is in `raw_extraction`.
- Bulk verify is not included; verification is one invoice at a time on purpose.
- Duplicate detection compares against other extracted invoices of the same firm.
- No paid subscriptions, billing or cloud sync were added.
