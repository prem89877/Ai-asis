# Accuracy evaluation and final integration check (Parts 1 to 3)

Scope: fixed reading prompt (Part 1), structured extraction (Part 2), source-grounded second verification (Part 3), working together in
`lib/extraction/pipeline.ts`. **No application code was changed.** This part adds tests, an evaluation script and this report.

## Read this first: what was and was not measured
| | Status |
|---|---|
| Pipeline logic end to end with a scripted provider (33 invoices, 622 tests) | **Run, results below** |
| Baseline vs updated on the same dataset, scripted provider | **Run, results below. Not real-world accuracy** |
| Real Gemini accuracy, latency and cost | **NOT measured** (no network / API key in the build environment). `npm run eval:pipeline -- --mode live` exists for it and was only smoke-tested without network |
| Effect of the reading prompt on real extraction quality | **NOT measured.** A scripted model cannot react to a prompt. Only the prompt text and its safety were tested |
| `tsc`, `next lint`, `next build`, Supabase SQL tests, Vercel deploy | **NOT run** (no `node_modules`, no network). Run them before deploying |

The "model" in the simulated evaluation is hand-written: I chose which values it misreads. The numbers show what the code does with such
readings (does it fix proven errors, does it refuse unproven ones, does it flag the rest). They do not say how often Gemini errs, so no
accuracy improvement for real invoices is claimed.

## Files
New: `tests/e2e-accuracy.test.mjs`, `tests/helpers/pipeline-harness.mjs`, `tests/helpers/invoice-builder.mjs`, `tests/helpers/oracle.mjs`,
`tests/helpers/eval-dataset.mjs`, `scripts/eval-pipeline.mjs`, `docs/ACCURACY_EVALUATION.md`.
Modified: `package.json` (script `eval:pipeline`), `README.md` (one section).

## Commands and actual results
```
npm test                    # 622 tests, 622 pass, 0 fail (baseline before this part: 596 pass; +26 new)
npm run eval:pipeline       # simulated, deterministic (two runs gave identical output)
GEMINI_API_KEY=... npm run eval:pipeline -- --mode live --runs 3     # real measurement, costs money. NOT run here
```

## Simulated baseline vs updated (33 invoices, scripted readings)
Same dataset for each column. `baseline` = all layers that existed before Part 1 and Part 3 (second / audit / key-figures / parties readings,
vote, line fix) with `EXTRACTION_SOURCE_VERIFY=off`. `updated` = current defaults.

| Measure | first reading only | baseline | updated |
|---|---|---|---|
| Field exact match | 1251/1274 | 1252/1274 | 1265/1274 |
| Critical financial fields (taxable, CGST, SGST, IGST, cess, grand total, line taxable) | 300/314 | 301/314 | 308/314 |
| Line-item values (qty, price, taxable, rate) | 460/464 | 460/464 | 464/464 |
| Line-item count correct | 33/33 | 33/33 | 33/33 |
| Fields changed to the truth by the layers | 0 | 1 | 14 |
| **False corrections** (changed and now wrong) | 0 | 0 | 0 |
| Invoices sent to review | 26/33 | 26/33 | 15/33 |
| **Silent errors** (a critical field wrong and not flagged) | 0 | 0 | 0 |
| Unresolved source-check flags | 0 | 0 | 13 |
| Provider calls per invoice | 1.00 | 5.00 | 5.73 |
| Code time per invoice (no network, NOT latency) | 1.6 ms | 2.6 ms | 4.7 ms |
| Cost per invoice | not measured | not measured | not measured |

Reading the table: 13 of the 33 scenarios were built with an error that every earlier layer repeats, so the improvement here is by
construction. The meaningful results are the zeros: no value was made wrong, and every one of the 9 fields still wrong in `updated` sits on an
invoice that was sent to review. The extra provider call happens only for invoices with suspicious values (0.73 extra calls per invoice on this
dataset, which is mostly suspicious by design; real clean invoices cost no extra call). Real latency and dollar cost need the live mode.

The 9 fields still wrong in `updated`, all flagged (measured before the later fixes: a missing supplier GSTIN and an unreadable total are now
re-read and filled when the proof holds): supplier GSTIN missing, invoice number missing (proposal only), unreadable
total, and six cases where the scripted re-read was unreadable / ambiguous / wrong / malformed / failed.

## What the tests cover (`tests/e2e-accuracy.test.mjs`)
Full workflow (upload bytes, fixed prompt, parse, validate, suspicious fields, source re-read, correction, saved record, review-form column
mapping, CSV / XLSX / Tally) for: clear intra-state, inter-state IGST and cess invoices; blurry / low-confidence / PNG photo; similar digits and
decimal errors (total, unit price, quantity); wrong, missing and re-read GSTINs; CGST/SGST vs IGST; wrong taxable value and total; 12-row
3-page invoice; legitimate repeated rows vs a block repeated by page overlap; missing and ambiguous fields; confident-but-wrong re-reads
(false-correction safety); malformed JSON, schema-invalid output, 429 retry, permanent rejection, timeouts, every extra layer failing or throwing,
a throwing prompt engine. Regression and safety: defaults and off-switches, `.env.example` covers every variable `config.ts` reads, no new
`NEXT_PUBLIC_` variable, no server secret in any `"use client"` file, no `process.env` in the new modules, logs and usage records contain no
key / invoice number / GSTIN / name / amount. The existing 596 tests (routes, auth guards, upload, billing, export, Tally, sync) still pass.

## Findings (items 1 to 5 were fixed in a later change; item 6 is still open)
1. **IGST on a same-state invoice (fixed).** The extraction pipeline now runs the `gst_type_mismatch` rule of `lib/review/gst.ts` (supplier state
   vs place of supply) after the source check. Such an invoice is saved as `needs_review` with a warning, not as `completed`. The value is kept
   as printed. Only this one rule was taken over; the other `gstChecks` rules still run at review time.
2. **A corrected GSTIN still went to review (fixed).** When the source re-read replaces a GSTIN with one that passes layout, check digit and
   state code, the old `invalid_gstin` / `gstin_checksum_note` flag of that field is removed. A confirmed (unchanged) invalid GSTIN keeps its flag,
   and the flag of the other party's GSTIN is never touched.
3. **A missing supplier GSTIN is now re-read (fixed).** Only when the document is a tax invoice or GST is charged (a bill of supply or an
   unregistered supplier costs no extra call). The re-read value is accepted only with the usual proof (valid GSTIN, grounded quote, confidence
   of 0.9 or more, no rival reading) and never when it equals the buyer's GSTIN. Otherwise the `missing_field` warning stays.
4. **A missing or unreadable grand total is now filled by the source re-read (fixed)**, but only when the re-read total ties to taxable value plus
   taxes (the engine's own total check passes with it). Otherwise it stays a proposal, and the note no longer says "arithmetic already ties".
5. **Tally default.** The route, `/api/integrations`, `.env.example`, `docs/PHASE6_PART1_SETUP.md` and `docs/DEPLOYMENT.md` all say the Tally export
   is **on by default** (off only with `TALLY_EXPORT_ENABLED=false`), and a test covers it. The comments in `lib/export/profiles.ts`,
   `lib/tally/build.ts` and `components/integrations/TallyPanel.tsx` were wrong and are corrected.
6. `mediaResolution: HIGH` for the source re-read is untested against live Gemini (Part 3 already noted this).

## Environment variables
No change. Existing optional switches: `EXTRACTION_HIGH_RES`, `EXTRACTION_SOURCE_VERIFY` (needs `EXTRACTION_VERIFY` on). Defaults unchanged (on).

## Safe deployment on Vercel
1. Locally with network: `npm ci && npm run typecheck && npm run lint && npm test && npm run build`.
2. Deploy to a **Preview** first. Confirm `GEMINI_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY` are server-only, `BILLING_ALLOW_UNPAID_UPGRADES` is unset.
3. Before Production, run `GEMINI_API_KEY=... npm run eval:pipeline -- --mode live --runs 3` and keep the output: it gives the first trustworthy
   baseline (6 synthetic fixtures; add real, anonymised invoices with `*.truth.json` for a better one). Check false corrections stay 0.
4. Check cost and time on that run: the route limit is `maxDuration = 60` s, `EXTRACTION_DEADLINE_MS` default 52000.
5. Rollback without code change: set `EXTRACTION_SOURCE_VERIFY=off` and/or `EXTRACTION_HIGH_RES=off` in Vercel, then redeploy (env changes
   apply to new deployments). No migration is needed for this part.
