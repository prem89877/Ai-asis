# AI Asis (Phase 1)

AI invoice extraction platform for Indian CAs, tax consultants, wholesalers and small businesses.

**Phase 1 is the interface only.** There is no backend: authentication, upload, extraction and export are not connected. All dashboard data is labelled sample data.

## Stack
Next.js 14 (App Router), TypeScript, Tailwind CSS, Inter font (`next/font`), lucide-react icons.

## Setup
```bash
npm install
npm run dev        # http://localhost:3000
npm run typecheck  # tsc --noEmit
npm run lint
npm run build
```
Note: `next/font/google` downloads Inter at build time, so the first build needs internet.

## Routes
`/` landing · `/login` · `/register` · `/dashboard` (sample-data preview)

## Where to integrate later
- `lib/auth.ts`: replace `submitAuth` with real auth.
- `components/dashboard/UploadDropzone.tsx`: `onFilesSelected` prop for uploads.
- `lib/sample-data.ts`: swap for API data; table/stat/activity components already take props plus `loading` and empty states.

## Brand
Primary `#2563EB` · Background `#F8FAFC` · Text `#1E293B` · Accent `#10B981` (Tailwind tokens: `brand`, `canvas`, `ink`, `success`).
Accent green is used for icons and fills; success text uses a darker green for readable contrast.

## Phase 2: auth, database, storage
Supabase Auth (email/password, optional Google), PostgreSQL with RLS, private storage for invoice files. Setup, security notes and limits: see `docs/PHASE2_SETUP.md`. Copy `.env.example` to `.env.local` first.

## Phase 3: AI extraction
Gemini-based invoice extraction with batches, job statuses, validation, review flags, quotas and cost tracking. Setup, environment variables, limits, test results and the accuracy-evaluation method: see `docs/PHASE3_SETUP.md`. Extra server-only secrets are required (`SUPABASE_SERVICE_ROLE_KEY`, `GEMINI_API_KEY`).

## Phase 4: review, verification, exports
Invoice table with search/sort/filter, side-by-side original and editable fields, GST-aware warnings, verification, and CSV/XLSX export with configurable columns. Migration, setup, test results and limits: see `docs/PHASE4_SETUP.md`. No new environment variables.

## Phase 5: plans, quota and billing screens
Plans and prices live in the `plans` table (change them with SQL). Pricing page (`/pricing`), Billing page (`/dashboard/billing`), plan-based invoice quota and batch limit on the dashboard, upgrade and downgrade rules. **Online payment is not connected yet**: paid upgrades wait for a payment phase. Migrations (`008_billing.sql`, then `009_billing_fixes.sql`), setup, plan table, quota rules, tests and the Phase 6 checklist: see `docs/PHASE5_SETUP.md`. New optional variable: `BILLING_ALLOW_UNPAID_UPGRADES` (testing only, never in production).

## Phase 6 Part 2: production readiness
Release report, deployment guide, pilot checklist and operations notes: `docs/PHASE6_PART2_RELEASE.md`, `docs/DEPLOYMENT.md`, `docs/PILOT_CHECKLIST.md`, `docs/OPERATIONS.md`. Migrations are numbered `001_` to `012_` in `supabase/migrations/`. Run `npm test` for the automated tests and the SQL files in `supabase/tests/` on a scratch database.

## GST validation engine
Unified GST checks (mixed IGST + CGST/SGST, TCS/TDS, pre-tax charges, round-off, multi-slab, negative lines, e-invoice metadata): `lib/extraction/gst-engine.ts`, migrations `011_gst_engine.sql` and `012_net_payable.sql`, notes in `docs/GST_ENGINE.md`.

## Source-grounded second verification
Suspicious values only are re-read from the original file, judged in code, corrected only with proof, audited in `validation_summary.source_verification`. See `docs/SOURCE_VERIFICATION.md`. New optional variable: `EXTRACTION_SOURCE_VERIFY` (default on).

## Accuracy evaluation and final integration check
End-to-end tests of the dynamic prompt, structured extraction and source verification working together, an offline baseline-vs-updated evaluation (`npm run eval:pipeline`) and a live mode for measuring real accuracy, latency and cost. Results, limits and Vercel deployment steps: `docs/ACCURACY_EVALUATION.md`. No new environment variables.
