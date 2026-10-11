# AI Asis Phase 3: AI invoice extraction

Phase 3 adds a working extraction pipeline: upload PDF/JPG/PNG invoices (single or batch), queue them, send each to Google Gemini from the server, validate the answer against a strict schema, flag anything doubtful, and save the result for human review.

**AI output is never treated as verified accounting data.** Extracted invoices end as `completed` (no flags) or `needs_review`. Only a later human-review step may set `verified`, and the database blocks browsers from setting it.

## 1. What changed in setup

| Item | Phase 2 | Phase 3 |
|---|---|---|
| Service-role key | not used | **required, server only** (`SUPABASE_SERVICE_ROLE_KEY`) |
| Gemini key | none | **required, server only** (`GEMINI_API_KEY`) |
| Migrations | 3 files | +2 files (run each separately, in order) |
| Vercel function time | default | extract route sets `maxDuration = 60` |

## 2. Model choice (checked 11 Oct 2026)

- `gemini-1.5-flash` and `gemini-2.0-flash` are shut down. Google's deprecation page lists `gemini-2.5-flash` for retirement on 16 Oct 2026 in one version of the page and "no shutdown date" in another, and says new projects should use 3.5 Flash-Lite or 3.8 Flash.
- Default: **`gemini-3.5-flash-lite`**, GA since 21 Jul 2026. List price quoted by price trackers citing Google: **$0.30 / 1M input tokens, $2.50 / 1M output tokens**.
- Higher-accuracy option: `gemini-3.8-flash` (about $0.75 / $3.75, introductory rate until 31 Dec 2026, per trackers).
- I could not open Google's own pricing page from the build environment, so the prices are configurable (`GEMINI_INPUT_PRICE_PER_MTOK`, `GEMINI_OUTPUT_PRICE_PER_MTOK`) and **must be re-checked before launch**. Cost records are approximate: thinking tokens are billed as output and are included; context caching, batch discounts and taxes are not.
- Switching models is an env change only (`GEMINI_MODEL`). Run `npm run eval:extraction` on the fixtures before switching in production.

## 3. Setup

1. **Migrations** (Supabase SQL Editor or `supabase db push`). Run the new files **one at a time**, in this order, after the three Phase 2 files:
   1. `20261011000001_extraction_enums.sql` (adds enum values; must be committed before the next file uses them)
   2. `20261011000002_extraction.sql`
2. **Environment variables**: copy the new block of `.env.example` into `.env.local` and into Vercel (Production and Preview). All Phase 3 variables are server-only.
3. `npm install && npm run typecheck && npm run lint && npm run build && npm test`
4. **Database tests** (scratch/local database only): `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/phase3_extraction.test.sql`. The last row must read `PHASE 3 SQL TESTS PASSED`. Everything runs in a transaction that is rolled back.
5. Dashboard: upload up to `EXTRACTION_BATCH_MAX_FILES` files. They are uploaded, queued and processed two at a time.

## 4. Flow

```
Browser                         Server (Next.js routes)                      Database / Gemini
-------                         -----------------------                      -----------------
POST /api/invoices/batches  ->  checks limit, creates batch (file_count N)
POST /api/invoices/upload   ->  existing secure upload + batch_id            trigger refuses file N+1
  (per file)
POST /api/invoices/enqueue  ->  enqueue_extraction_jobs()                    quota, per-minute, runs/invoice
                                invoice -> queued, job -> queued
POST /api/invoices/:id/extract  claim_extraction_job()                       concurrency limit, stale cleanup
                                download file, verify SHA-256, preflight
                                Gemini call (timeout, retries, backoff)  ->  Gemini (key only on server)
                                strict validation, normalize, checks,
                                duplicate lookup
                                complete_extraction_job()                    one transaction: data + items +
                                                                             job + invoice status
GET  /api/invoices/:id/extraction  reads through RLS for the review panel
```

Statuses: job `queued -> processing -> needs_review | completed | failed`. The invoice mirrors the job. A job stuck in `processing` for longer than `EXTRACTION_STALE_SECONDS` is failed as `stale_timeout` at the next claim, so the invoice can be retried.

## 5. Missing vs unreadable vs zero (and no invention)

Every field comes back as `{status, value, confidence}`:

- `present` + value `0` = a genuine zero printed on the document (stored as `0`).
- `missing` = not on the document (stored as `NULL`).
- `unreadable` = on the document but not reliably legible (stored as `NULL`).

The validator rejects output that carries a value with `missing`/`unreadable`, numeric strings, unknown keys, bad enums or out-of-range confidence. Rejected output is retried (up to `EXTRACTION_MAX_ATTEMPTS`) and, if it never validates, **nothing is saved** and the job fails as `invalid_model_output`. Currency is never defaulted to INR (the column is now nullable). Amounts are never rounded, recomputed or "fixed" to make totals agree: a mismatch becomes a review flag and the extracted figures are stored as read. `field_status` (per field) and the validated raw model output (`raw_extraction`) are stored with each invoice. The original file is never modified or deleted by extraction.

## 6. Review flags

Severity `error` / `warning` => `needs_review`; only `info` flags or none => `completed`.

- Missing/unreadable required fields (supplier name, invoice number, date, grand total): error. Supplier GSTIN, buyer name, taxable value: warning. Buyer GSTIN, place of supply: info.
- Invalid GSTIN format or check digit, invalid or implausible date, invalid currency, out-of-range amount, negative amount, extra decimals, invalid HSN, GST rate outside 0 to 100.
- Low confidence (below `EXTRACTION_LOW_CONFIDENCE`), item values unreadable.
- Arithmetic (tolerance `EXTRACTION_TOLERANCE_PAISE`): quantity x price vs item taxable value; item taxable values vs invoice taxable value (with or without bill-level discount); taxable + CGST + SGST + IGST + cess vs grand total (with or without discount); tax fields that were not found are listed in the flag instead of being treated as zero; IGST together with CGST/SGST.
- Possible duplicate: same normalized invoice number and compatible supplier, or same supplier GSTIN + date + total, in the same firm. (Identical files are already blocked by the existing SHA-256 unique index.)

## 7. Limits and abuse protection (all server-side)

| Control | Where |
|---|---|
| Same-origin check, session required, firm taken from the database | every route |
| File type by magic bytes, 4 MB, filename sanitising | existing upload route |
| Files per batch (`EXTRACTION_BATCH_MAX_FILES`, hard max 100) | batch route + trigger on `invoices` |
| Uploads per firm per 24 h | upload route |
| Monthly extraction quota, per-minute queue rate, runs per invoice | `enqueue_extraction_jobs()` under a per-firm advisory lock |
| Concurrent jobs per firm | `claim_extraction_job()` |
| Provider failures (rate limit, outage, timeout, auth, missing model) do not use monthly quota | `enqueue_extraction_jobs()` |
| Request bodies capped (16 KB) | `lib/api/body.ts` |
| Browsers cannot write extraction data, jobs or usage; cannot set invoice status except `pending_deletion` | grants, RLS, trigger |
| Server functions callable by `service_role` only | `revoke ... from public, anon, authenticated` |

Failure handling: malformed/truncated/encrypted PDFs, damaged or tiny images, wrong type, oversized files and file/hash mismatch fail **before** any provider call (no cost). Provider 429/5xx/timeouts are retried with backoff and `Retry-After`; auth, model-not-found, blocked and truncated responses fail immediately with a clear code. Every failure closes the job and updates the invoice status. Users see a safe message per error code, never provider details.

Recommended on top (not built here): a platform rate limit such as Vercel WAF on `/api/invoices/*`, and a Google Cloud budget alert on the Gemini key.

## 8. Usage and cost

Each Gemini call writes one `usage_records` row (`kind = extraction`) with model, input/output tokens, estimated USD cost and outcome (including invalid-output retries, which are billed by Google). The view `extraction_usage_monthly` gives each firm its calls, invoices, tokens and approximate cost per UTC month. Calls that time out before a response have no token count and are recorded with `NULL` cost; they may still be billed by Google.

## 9. Tests and results

Run on 11 Oct 2026 in the build environment (Node 22, no network):

| Check | Result |
|---|---|
| `npm test` (unit, `node --test`) | **74 passed, 0 failed** (6 existing Phase 2 tests + 68 new) |
| Type check of all new/changed files | no errors in the new code. See "Not verified" below |
| SQL syntax lint (balanced quotes, parentheses, `$$` bodies, BEGIN/END, IF/END IF) | clean |
| `supabase/tests/phase3_extraction.test.sql` (132 assertions) | **written, not executed** (no PostgreSQL available) |
| `npm run build`, `npm run lint` | **not run** (`npm install` is blocked without network) |
| Live Gemini calls | **not run** (no network, no API key) |

New unit tests cover: strict schema validation; GSTIN checksum; date/HSN/number normalisers; missing vs unreadable vs zero; arithmetic and rounding tolerance; flags; PDF/PNG/JPEG preflight (truncated, encrypted, too many pages, tiny, damaged); the Gemini client with a mocked `fetch` (header-only API key, status mapping, `Retry-After`, timeout, blocked/truncated/empty, thought parts, token cost); and the pipeline with fakes (retry/backoff, deadline, invalid output never saved, not-an-invoice, file integrity, duplicates, stale job, usage failure, unexpected exception).

### Field-level accuracy

**Not measured yet.** The build environment has no network or API key, so no real model output exists. Any accuracy percentage written here would be unsupported, so none is claimed.

What is ready: six synthetic fixtures with ground truth in `tests/fixtures` (fake parties, valid-format GSTINs): intra-state CGST/SGST grid layout, inter-state IGST with bill-level discount, bill of supply (no GST, many absent fields), zero-rated item plus cess, a skewed blurred PNG scan, a dim rotated JPEG phone photo. Run:

```bash
GEMINI_API_KEY=... npm run eval:extraction -- --runs 3
```

It prints, per field, counts of `correct`, `wrong`, `abstained` (model said missing/unreadable though the value exists), `invented` (value given for something absent) and `ok-missing`, plus flags per invoice and the API cost. It deliberately prints no single headline number. Six clean synthetic files are an optimistic test: before relying on the pipeline, add 30+ real, anonymised invoices from your own customers (including bad scans and regional layouts) with ground truth and run the same command.

### Not verified

- **Build / lint / Next-specific types**: could not install dependencies. New modules import each other with explicit `.ts` extensions (needed so `node --test` can run them); `tsconfig.json` now has `allowImportingTsExtensions`. If `next build` rejects this, tell me and I will switch to extensionless imports plus a small test loader.
- **SQL**: the migrations and the test file were reviewed by hand and linted, never run. Expect to fix small things on first run. Run migrations and tests on a scratch Supabase project first.
- **Gemini request shape** (`responseSchema` with upper-case types, `inlineData`): written from the REST docs, not exercised against the live API. Output validation is independent of it.

## 10. Known limits

- One invoice per extract request (about 60 s). A 10-file batch takes a few minutes. The browser must stay open: closing it leaves remaining invoices `queued`; the Extract button resumes them. A background queue is a later improvement.
- 4 MB per file and up to 10 PDF pages by default.
- Encrypted PDFs are rejected (the check cannot tell owner-password-only files from open-password files).
- Duplicate detection only compares against already-extracted invoices of the same firm.
- Human editing/verification, export, billing and Google/Microsoft sync are not part of this phase.
