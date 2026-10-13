# AI Asis: Phase 6 Part 2 release-readiness report

Date of work: 12 Oct 2026. Environment of the author: Node 22, **no network, no `node_modules`, no PostgreSQL**. Anything not listed under "Tested" was **not verified**.

## 0. Read this first: the integration code was REBUILT in this delivery
The project zip (checked three times) did **not** contain `lib/integrations/` (9 files) or `app/api/exports/tally/route.ts`, and the owner has no copy of the Phase 6 Part 1 originals. Because the routes, the screens and the existing tests (`integrations-core`, `tally`) depend on them, and because the Vercel build failed with "Module not found: @/lib/integrations/...", these files were **written again from scratch** in Phase 6 Part 2:
`lib/integrations/crypto.ts, oauth.ts, http.ts, mapping.ts, sync.ts, google.ts, microsoft.ts, store.ts, route-helpers.ts` and `app/api/exports/tally/route.ts`.
They follow the contract that the old routes, screens and the 38 existing `integrations-core` tests and 12 `tally` tests define, and all of those tests pass. But this is **new, unreviewed code**: it has never talked to a real Google or Microsoft account, never been imported by Tally, and was not written by the original author. Treat it as a first version: review it, and do the end-to-end checks in `docs/PILOT_CHECKLIST.md` section G before any customer uses Sheets or Excel. If you find the original files, compare them with these.

## 1. Changed-file summary
**Updated (existing files)**
- `lib/api/debug.ts` (debug detail off in production)
- `lib/export/run.ts` (only the TEMP-DEBUG comment removed)
- `app/api/exports/route.ts` (fail closed when the rate-limit query fails; no TEMP-DEBUG marker)
- `app/api/exports/[id]/download/route.ts` (marker removed)
- `app/api/invoices/[id]/download/route.ts` (uses `guard`, explicit `firm_id` filter)
- `components/dashboard/ExportDialog.tsx` (no raw response or browser-error dumps)
- `supabase/migrations/*` (all 10 files renamed, contents unchanged except the two header comments in `004_` and `005_` that name the other file; they appear as NEW files in the zip)
- `supabase/tests/phase5_billing.test.sql` (migration names in its header)
- `docs/PHASE3_SETUP.md`, `PHASE4_SETUP.md`, `PHASE5_SETUP.md`, `PHASE6_PART1_SETUP.md`, `README.md`, `.env.example`, `.gitignore`
**New**
- Rebuilt code: `lib/integrations/*.ts` (9 files), `app/api/exports/tally/route.ts`
- Tests: `tests/integrations-server.test.mjs`, `tests/routes-tally.test.mjs`, `tests/routes-exports.test.mjs`, `routes-sync.test.mjs`, `routes-files.test.mjs`, `routes-upload-delete.test.mjs`, `routes-billing-quota.test.mjs`, `security-static.test.mjs`, `regression.test.mjs`
- Test support: `tests/helpers/alias-hooks.mjs`, `tests/helpers/route-harness.mjs`, `tests/stubs/*` (next-server, next-navigation, supabase-server, supabase-admin, supabase-js, integrations/*)
- SQL tests: `supabase/tests/phase2_isolation.test.sql`, `supabase/tests/phase6_integrations.test.sql`
- Docs: `docs/DEPLOYMENT.md`, `docs/PILOT_CHECKLIST.md`, `docs/OPERATIONS.md`, `docs/PHASE6_PART2_RELEASE.md`

Migration rename map: `20261010000001_schema` > `001_schema`; `20261010000002_rls` > `002_rls`; `20261010000003_storage` > `003_storage`; `20261011000001_extraction_enums` > `004_extraction_enums`; `20261011000002_extraction` > `005_extraction`; `20261012000001_review_export` > `006_review_export`; `20261012000002_export_redownload` > `007_export_redownload`; `20261013000001_phase5` > `008_billing`; `phase5_part2` > `009_billing_fixes`; `20261014000001_phase6_integrations` > `010_integrations`. The old `.sql` files must be **deleted** from your repo (the zip only adds the new names).

## 2. Findings and decisions
**Security audit (what was reviewed: every file in the uploaded zip except the missing ones above)**
| # | Finding | Status |
|---|---------|--------|
| 1 | `.gitignore` ignored only `.env*.local`; a plain `.env` could be committed | Fixed |
| 2 | TEMP-DEBUG detail (`DEBUG_ERRORS = true`) sent database error text to browsers | Fixed: off in all production builds; local `next dev` + `AI_ASIS_DEBUG_ERRORS=1` only |
| 3 | `POST /api/exports`: if the rate-limit query failed, the export ran with no limit (fail open) | Fixed (fail closed, 500) |
| 4 | `GET /api/invoices/[id]/download` had no explicit `firm_id` filter (RLS only) | Fixed |
| 5 | `ExportDialog` showed raw response text and browser exception text | Fixed |
| 6 | Secrets scan (Google, OpenAI-style, Supabase, JWT, private keys, GitHub, AWS patterns) over all text files | No real secret found; now a permanent test |
| 7 | All 23 route handlers (API and auth callback) authenticate; all mutating routes check Origin; GET routes read-only except OAuth callback | Verified by test and by reading; permanent test |
| 8 | Tenant queries without `firm_id` in routes | Only two reviewed exceptions (delete, extract) that compare the firm explicitly; permanent test |
| 9 | No `NEXT_PUBLIC_` variable holds a secret; no client component imports server code | Verified; permanent test |
| 10 | No sign-up/login IP rate limit or CAPTCHA | Open (see OPERATIONS) |
| 11 | `npm audit` | **Not run** (no network). Run: `npm ci && npm audit --omit=dev` then `npm audit` |
| 12 | Integration code (tokens, OAuth, crypto, sync) and Tally route | Rewritten in this delivery (see section 0); checked with unit and fake-service tests, **not** with real providers; needs your review |

**Tally exports: history and quota?** Recommendation: **record Tally exports in export history, but do not count them toward the invoice quota.** Reasons: (a) history is your audit trail of what left the system and who sent it; (b) the export rate limit reads `export_history`, so an unrecorded Tally route is unthrottled; (c) quota is metered on extraction (the costly step), exports are not metered anywhere and should stay free. **Not implemented in this delivery** (the Tally route was rebuilt without it, to keep the database unchanged). It needs three coordinated changes: a migration that lets `export_history.format` (currently `xlsx`/`csv`) and `record_export` accept `xml`/`json` with `profile = 'tally'`; the Tally route calling `record_export`; and `GET /api/exports/[id]/download` handling (or refusing) `tally` rows. Ask for it as a separate small change.

**Billing webhooks:** searched the whole codebase for Razorpay, Stripe, PayU, Cashfree, Paytm, checkout and webhook code: **none exists**. Webhooks are **incomplete / not started**; nothing was invented. `tests/routes-billing-quota.test.mjs` contains a guard test that fails if a payment/webhook route is added without tests being written.

**Pre-existing issues (not caused by this work)**
1. `phase5_part2.sql` broke the timestamp naming and could run out of order (fixed by the rename to `009_billing_fixes.sql`).
2. `lib/integrations/*` and `app/api/exports/tally/route.ts` missing from the zip (rebuilt, see section 0).
3. Account deletion leaves the firm, its invoices and files in place; firm deletion in SQL leaves files in storage (documented, pinned by SQL test).
4. `docs/PHASE6_PART1_SETUP.md` said a Phase 6 SQL test did not exist (updated).
5. Older phase docs describe the old migration file names (updated to the new names).
6. `.env.example` said Phase 2 does not use the service-role key (old comment, harmless; later sections correct it).
7. Preview deployments honour `BILLING_ALLOW_UNPAID_UPGRADES` (documented).

## 3. Regression map (bug fixed > test that guards it)
| Earlier bug / risk | Guard |
|--------------------|-------|
| PDF page objects in object streams read as "empty PDF" | `extraction-preflight.test.mjs` (existing) |
| Quota loophole and billing lock contention (009) | `phase5_billing.test.sql` sections for 009 (existing, not run) |
| Export file-name collisions in one minute | `regression.test.mjs` |
| Formula injection in CSV/XLSX | `regression.test.mjs`, `export.test.mjs` |
| Unpaid upgrades in production | `regression.test.mjs`, `billing.test.mjs`, `routes-billing-quota.test.mjs` |
| Debug detail in production | `regression.test.mjs`, `routes-exports.test.mjs` |
| Fail-open export rate limit | `routes-exports.test.mjs` |
| Missing firm filter (invoice download) | `routes-files.test.mjs`, `security-static.test.mjs` |
| Migration name/order problem | `regression.test.mjs` |
| `.env` not ignored | `security-static.test.mjs` |
The author could identify only bugs recorded in code comments and docs. If you fixed others in earlier chats, send the list and each gets a test.

## 4. Test-gap review (failure paths)
Already covered before this work (existing tests, not repeated): upload validation by content, PDF preflight and malformed PDFs, Gemini errors/timeouts/retries and deadline, schema-invalid model output, normalisation of invalid fields, duplicate invoice numbers inside the review flags, export columns/CSV/XLSX building, plan/quota helpers, Tally voucher building (needs missing file), integration core logic (needs missing files).
Added: route-level tests for exports (limits, firm scoping, errors), file access, upload/delete failure paths (malformed, oversized, spoofed, duplicate hash, storage outage, partial delete retry), quota and plan routes, cloud sync route failures with mocked services (revoked/expired token, 429, timeout, changed header, lost response, unexpected error), static security scan, regression suite, and SQL isolation tests.
Not covered: extraction route itself (`/api/invoices/[id]/extract`) at route level, review save route, OAuth start/callback, connection management routes, preferences route, the real Google/Microsoft HTTP behaviour, UI components (no browser tests).

## 5. Release readiness
### (a) Completed
- Migrations renamed to short numbered names, all references updated.
- Debug detail switched off for production, with a local-only opt-in.
- Fail-closed export limit; explicit firm filter on invoice download; cleaner export dialog errors; `.gitignore` fixed; `.env.example` updated.
- 7 new JS test files plus test harness (65+ route tests, 12 static checks, 10 regression tests) and 2 new SQL test files.
- Deployment guide, env-var checklist, migration order, OAuth callback URLs, pilot checklist, operations notes, this report.
### (b) Tested (and how)
- `npm test` (Node 22, `node --test`): **277 tests, 277 pass** (final run, after the last code change). This includes the previously failing `integrations-core` (38) and `tally` tests, which now load because the missing modules were rebuilt.
- New route tests exercise the real route files against in-memory fakes of Supabase; `integrations-server.test.mjs` runs the real `route-helpers` and `store` (token refresh, rotation, revoked grant, wrong-firm token, ledger calls) with a mocked `fetch`; `routes-tally.test.mjs` runs the real Tally route. `routes-sync.test.mjs` uses mocks of the provider modules.
- Mutation checks were done on the exports guards and on the static firm-filter and secret scans; the tests failed as intended.
- Partial TypeScript check (`tsc --strict`, only `lib/integrations`, `lib/tally`, `lib/api`, and the integration, export and invoice API routes, with stubbed `next` and Supabase types): no errors. This is **not** the real `tsc` of your project.
- Static scan of the whole project for secrets, route auth, Origin checks, firm filters, public env names, server-only imports.

### (c) Configured but untested
- `supabase/tests/phase2_isolation.test.sql` and `phase6_integrations.test.sql` (and the older phase 3 to 5 SQL tests): written, **never executed** (no PostgreSQL). Expect small first-run fixes.
- Migrations 001 to 010 on a real database in the new order.
- Vercel deployment, environment variables, OAuth callback URLs.
- Google Sheets, Microsoft Excel, Tally export (never run against real accounts or Tally).
- Gemini extraction against the live API (fixtures and mocks only).
- Supabase Auth settings, email confirmation, storage policies on a live project.
### (d) Incomplete or not started
- Billing webhooks and any payment gateway: **not started**.
- Tally exports in history: recommended, **not implemented** (route missing).
- Independent review of the rebuilt `lib/integrations/*`; tests against real Google and Microsoft accounts.
- `npm install`, the real `tsc`, lint, `next build`, `npm audit`: **not run** (no network). The Vercel log you sent shows the build failing only on the missing modules; other build errors, if any, are unknown until the build is run again.
- Account-deletion workflow, bucket backup job, monitoring/alerts, sign-up abuse protection: not built.
- Route tests for extraction, review-save, OAuth, connection routes; browser/UI tests.

## 6. Review these points in the rebuilt integration files
1. Server code reads `integration_connections` with the service-role client (`route-helpers`) or the safe column list (`PUBLIC_CONNECTION_COLUMNS`); `select *` through a user session is refused by the database. Done; keep it that way.
2. Tokens are encrypted with AES-GCM, never logged, never returned to the browser; callback verifies `state` and PKCE and that the user and firm match the stored state.
3. Only owners/admins can connect, disconnect, map and sync.
4. Provider error text is not shown to users or stored unfiltered.
5. Revocation clears tokens (SQL test `phase6_integrations` pins the table side).

## 7. Commands to run on your machine
```
npm ci
npm test
npm run typecheck
npm run lint
npm run build
npm audit --omit=dev
npm audit
psql "$SCRATCH_DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/phase2_isolation.test.sql
psql "$SCRATCH_DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/phase6_integrations.test.sql
```
(Apply migrations 001 to 010 to the scratch database first, in order; the older SQL tests are `phase3_extraction`, `phase4_review_export`, `phase5_billing`.)
TypeScript note: the new test helpers are plain `.mjs` and are not type-checked; the tests load route files through resolver hooks (`tests/helpers/alias-hooks.mjs`), which only exist for `node --test`.
