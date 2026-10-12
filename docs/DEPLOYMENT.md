# AI Asis: final deployment guide (Vercel + Supabase)

One guide for everything: accounts, database, environment variables, OAuth, deploy, first checks. Status of every step is in `docs/PHASE6_PART2_RELEASE.md`. **Nothing in this guide has been executed by the person who wrote it** (no network, no Vercel or Supabase access was available); follow it on a test project first.

## 0. Before you start
You need: a Supabase project, a Vercel account, a Google AI Studio API key (Gemini), a GitHub repository, Node 22 or newer on your computer. Optional: a Google Cloud project (Sheets), a Microsoft Entra app (Excel), a custom domain.

On your computer, once, from the project folder:
```
npm ci
npm test
npm run typecheck
npm run lint
npm run build
npm audit --omit=dev
```
Fix anything that fails before deploying. `npm audit` needs internet; review each finding rather than running `npm audit fix --force`.

## 1. Supabase
1. Create a project (choose a region close to India, for example Mumbai). Use **Pro** for real customer data: the Free plan has no automatic backups (see `docs/OPERATIONS.md`).
2. Authentication > URL Configuration: **Site URL** = your production URL. **Redirect URLs**: `https://YOUR-DOMAIN/auth/callback`, `http://localhost:3000/auth/callback`, and for previews `https://*-YOUR-TEAM.vercel.app/auth/callback`.
3. Authentication > Providers: Email on. Google only if you set `NEXT_PUBLIC_GOOGLE_AUTH_ENABLED=true` (needs a Google OAuth client whose redirect URI is `https://PROJECT-REF.supabase.co/auth/v1/callback`).
4. Project Settings > API: copy the Project URL, the anon key and the service_role key.

## 2. Database migrations
Run in this order. Each file once. Use the SQL Editor (paste, Run) or `supabase db push`.

| # | File | Adds |
|---|------|------|
| 1 | `001_schema.sql` | firms, members, clients, invoices, extracted data, jobs, usage, signup trigger |
| 2 | `002_rls.sql` | Row Level Security, grants, policies |
| 3 | `003_storage.sql` | private `invoices` bucket and storage policies |
| 4 | `004_extraction_enums.sql` | new status values. **Run alone and let it finish before 005** |
| 5 | `005_extraction.sql` | batches, extraction functions, quotas, status guard |
| 6 | `006_review_export.sql` | review, verification, export history, review list view |
| 7 | `007_export_redownload.sql` | re-download of past exports |
| 8 | `008_billing.sql` | plans, subscriptions, quota ledger |
| 9 | `009_billing_fixes.sql` | lock and quota fixes for 008 (formerly `phase5_part2.sql`) |
| 10 | `010_integrations.sql` | Google/Microsoft connections, sync records, OAuth states |

**Renamed files.** The migrations used to have timestamp names (`20261010000001_schema.sql` ... and `phase5_part2.sql`). They now have short numbers. If you already applied the old files, the database is fine and you do not need to run anything again. If you use the Supabase CLI and it complains about history, either keep using the SQL Editor, or align the history table with `supabase migration repair` (mark the old versions reverted and the new ones applied) on a copy first. On a brand-new project nothing special is needed.

After migrating, run the SQL tests on a **scratch** project (never production data), see section 8.

## 3. Environment variables
Set them in Vercel > Project > Settings > Environment Variables (Production, and Preview if you use previews). Copy names exactly. **Server-only** means: no `NEXT_PUBLIC_` prefix, never shown in the browser.

| Name | Where to get it | Required | Notes |
|------|-----------------|----------|-------|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase > Settings > API | Yes | public |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | same | Yes | public; safe only because RLS is on |
| `NEXT_PUBLIC_SITE_URL` | your production URL | Yes | no trailing slash. Used in OAuth callbacks and emails |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase > Settings > API | Yes | server-only; bypasses RLS; rotate if leaked |
| `GEMINI_API_KEY` | Google AI Studio | Yes | server-only; without it extraction answers 503 |
| `GEMINI_MODEL` | default `gemini-3.5-flash-lite` | No | change only after re-testing accuracy |
| `GEMINI_INPUT_PRICE_PER_MTOK`, `GEMINI_OUTPUT_PRICE_PER_MTOK` | Google AI pricing page | No | only for the cost estimate shown to you |
| `GEMINI_TIMEOUT_MS`, `EXTRACTION_DEADLINE_MS`, `EXTRACTION_MAX_ATTEMPTS`, `GEMINI_MAX_OUTPUT_TOKENS` | defaults in `.env.example` | No | keep `EXTRACTION_DEADLINE_MS` below the 60 s route limit |
| `EXTRACTION_PER_MINUTE_LIMIT`, `EXTRACTION_MAX_CONCURRENT`, `EXTRACTION_MAX_RUNS_PER_INVOICE`, `EXTRACTION_UPLOADS_PER_DAY`, `EXTRACTION_STALE_SECONDS`, `EXTRACTION_MAX_PDF_PAGES` | defaults in `.env.example` | No | abuse and cost limits |
| `EXTRACTION_LOW_CONFIDENCE`, `EXTRACTION_TOLERANCE_PAISE` | defaults | No | review-flag thresholds |
| `NEXT_PUBLIC_GOOGLE_AUTH_ENABLED` | `true` after enabling Google sign-in | No | default `false` |
| `BILLING_ALLOW_UNPAID_UPGRADES` | leave `false` | No | testing only; ignored on Production but **honoured on Preview** |
| `INTEGRATION_ENCRYPTION_KEY` | `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` | Only for Sheets/Excel | server-only. Losing it = every user must reconnect. Back it up in a password manager |
| `INTEGRATION_ENCRYPTION_KEY_PREVIOUS` | old key while rotating | No | decrypt-only |
| `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` | Google Cloud Console > Credentials | Only for Google Sheets | enable Google Sheets API |
| `MICROSOFT_OAUTH_CLIENT_ID`, `MICROSOFT_OAUTH_CLIENT_SECRET`, `MICROSOFT_OAUTH_TENANT` | Microsoft Entra > App registrations | Only for Excel | tenant `common` or your tenant id. Secret **Value**, not Secret ID |
| `TALLY_EXPORT_ENABLED` | leave `false` | No | experimental; never import-tested |
| `AI_ASIS_DEBUG_ERRORS` | **do not set** | No | local `next dev` only; ignored in production builds |

Never set: anything starting with `NEXT_PUBLIC_` that holds a secret. The automated test `tests/security-static.test.mjs` fails if a new `NEXT_PUBLIC_` name appears or a key-like string is committed.

## 4. OAuth callback URLs (exact)
Replace `YOUR-DOMAIN` with the value of `NEXT_PUBLIC_SITE_URL` (same scheme and host, no trailing slash).

* Supabase sign-in (Google): `https://PROJECT-REF.supabase.co/auth/v1/callback` (in the Google client used for sign-in).
* App auth landing (Supabase redirect list): `https://YOUR-DOMAIN/auth/callback`.
* Google Sheets: `https://YOUR-DOMAIN/api/integrations/oauth/google_sheets/callback`
* Microsoft Excel: `https://YOUR-DOMAIN/api/integrations/oauth/microsoft_excel/callback`

Google: use exactly the consent-screen scopes listed in `docs/PHASE6_PART1_SETUP.md` (step 3). While the app is in "Testing" only listed test users can connect and refresh tokens expire after 7 days. Production use needs Google's verification for sensitive scopes. Microsoft: Web platform, delegated permissions `Files.ReadWrite`, `offline_access`, `openid`, `profile`, `email`. Local development uses the same paths with `http://localhost:3000`.

## 5. Vercel
1. Push the code to GitHub (check `git status`: no `.env` file).
2. Vercel > Add New > Project > import the repo. Framework: Next.js (auto). Build command `next build`, output default.
3. Add the environment variables from section 3, then Deploy.
4. Settings > Domains: add your domain; set `NEXT_PUBLIC_SITE_URL` to it; redeploy; update the Supabase and OAuth URLs from section 4.
5. Region: set the function region near your Supabase region (Project > Settings > Functions).
6. Function time: extraction, export and sync routes declare `maxDuration` 60 s (30 s for connection pages). Check that your Vercel plan allows it.
7. Use the Vercel plan that permits commercial use for a paid product (check Vercel's current terms; the free Hobby plan is for personal, non-commercial use).

## 6. First checks after deploy (10 minutes)
1. Sign up with a new email; confirm the email; you land on the dashboard.
2. Upload one sample PDF (`tests/fixtures/01-intra-state-grid.pdf`), press extract, review, verify.
3. Export CSV and XLSX; open both in Excel; check GSTIN, invoice number and amounts.
4. Sign up a second user in a second browser; confirm they cannot see the first firm's invoice (also try the first invoice's URL).
5. Billing page shows the Pilot plan and the quota.
6. Wrong-origin test: from another site `fetch("https://YOUR-DOMAIN/api/exports",{method:"POST"})` is refused (403).
7. Check `view-source` or the Network tab: no `SUPABASE_SERVICE_ROLE_KEY`, `GEMINI_API_KEY` or token text anywhere.
8. Trigger an error (export with no invoices selected): the message is plain, with no database text.
9. If using Sheets/Excel: connect a test account, map columns, sync one verified invoice, press Sync again (must not add a second row), revoke access in the Google/Microsoft account and sync again (must say "reconnect").

## 7. Rollback
Vercel > Deployments > previous deployment > Promote to Production. Database changes are not rolled back by Vercel: take a backup before each migration, and write down the reverse SQL for any new migration.

## 8. Tests and where they run
| Command / file | What it covers | Needs |
|----------------|----------------|-------|
| `npm test` | all JS tests (extraction, review, export, billing, routes, security scan, regression) | Node 22+, no database |
| `supabase/tests/phase2_isolation.test.sql` | RLS, tenant isolation, private files, deletion, structural sweep of all tables | scratch database, all migrations |
| `supabase/tests/phase3_extraction.test.sql`, `phase4_review_export.test.sql`, `phase5_billing.test.sql` | earlier phases | same |
| `supabase/tests/phase6_integrations.test.sql` | connections, sync records, OAuth states, token columns, duplicate prevention | same |

Run one SQL file: `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/phase2_isolation.test.sql`. Each file rolls back everything it creates; the last row says PASSED. Use the direct connection string of a scratch project, never production.
