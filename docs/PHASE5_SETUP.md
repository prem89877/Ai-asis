# AI Asis Phase 5: plans, quota and billing screens

Phase 5 Part 1 added the database side (plans, subscriptions, quota ledger, plan changes). **Part 2 (this document) adds the screens, the dashboard integration, tests and docs. Online payment is NOT part of Phase 5**: nothing here charges money, and paid upgrades do not apply until a payment phase confirms them.

## 1. Setup

1. Run the new migration after the earlier ones (SQL editor, in this order):
   `008_billing.sql` (Part 1, already applied) then **`009_billing_fixes.sql`** (new, two small fixes, safe to run once).
2. New environment variable (optional, testing only): `BILLING_ALLOW_UNPAID_UPGRADES`. Leave it unset or `false`. See section 7.
3. `SUPABASE_SERVICE_ROLE_KEY` (Phase 3) is used by the plan-change and enqueue routes. Nothing else is needed.
4. `npm install && npm run typecheck && npm run lint && npm run build && npm test`
5. Scratch database only: `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/phase5_billing.test.sql` (last row `PHASE 5 SQL TESTS PASSED`).
6. If the dashboard shows "Your plan and invoice quota are not available", the Phase 5 migrations have not been run.

## 2. Screens and routes

| Route | Who | What |
|---|---|---|
| `/pricing` | public | Plan cards from the `plans` table. Logged out: "Start free". Logged in: current plan and an upgrade or downgrade button (owner and admin only). |
| `/dashboard/billing` | signed in | Current plan and price, status badge (Active, Trial, Payment overdue, Suspended), billing period, invoices used and remaining with a progress bar, files per upload, pending change with **Cancel change**, plan options. Members see the same information read-only. |
| `/dashboard` | signed in | Quota and batch limit come from `billing_overview`. Warning at 80% and 100% with an Upgrade link; a banner when the subscription is not active. Clear messages for `quota_exceeded`, `batch_limit`, `subscription_inactive`, and for invoices skipped because of quota (they stay "Uploaded"). |
| `GET /api/review/summary` | signed in | Now returns `{ summary, billing }`. `monthlyLimit` is gone. |
| `GET /api/billing/overview`, `POST /api/billing/change-plan` | signed in | Part 1, unchanged. The browser sends only a plan code. |

The landing page pricing section uses the same plan data (refreshed at most every 5 minutes). Navbar and footer link to `/pricing`; the other links are `/#features` etc. so they work from any page.

The browser never decides plan, status or quota. Every number on screen is read from the server, and every limit is enforced in the database (`enqueue_metered_jobs`, the `batches` trigger, RLS and grants). A modified page can only send a plan code, which the server authorizes.

## 3. Plans (proposed, not final)

| Code | Name | Price / month | Invoices / month | Files / upload |
|---|---|---|---|---|
| `pilot` | Pilot | Free | 25 | 5 |
| `solo` | Solo | ₹799 | 300 | 20 |
| `ca_firm` | CA Firm | ₹1,499 to ₹2,999 | 1,500 | 50 |

The invoice and file numbers are placeholders chosen for testing; decide them after you know your real AI cost per invoice (see section 9).

### Change prices and limits (plain SQL, no deploy)

Prices are in **paise** (79900 = ₹799).

```sql
-- price
update public.plans set price_paise = 99900 where code = 'solo';
-- price range (CA Firm); set price_max_paise = null for a single price
update public.plans set price_paise = 199900, price_max_paise = 349900 where code = 'ca_firm';
-- limits (take effect on the next enqueue; invoices already counted stay counted)
update public.plans set monthly_invoice_limit = 400, batch_max_files = 25 where code = 'solo';
-- text shown on the cards
update public.plans set tagline = 'For a single CA', features = '["AI extraction with GST checks","Review, verify and export (CSV and Excel)","Email support"]'::jsonb where code = 'solo';
-- once prices are final, hide the "Proposed pricing" note
update public.plans set is_proposed = false;
-- order (also decides what counts as an upgrade or a downgrade)
update public.plans set sort_order = 25 where code = 'solo';
-- stop offering a plan (firms already on it keep it); add a new plan with an insert
update public.plans set is_public = false where code = 'solo';
```

Notes: a feature line that only repeats a number ("300 invoices per month", "Up to 20 files per upload") is hidden by the UI, because those numbers are always shown from `monthly_invoice_limit` and `batch_max_files`. Pricing page and billing page show changes immediately; the landing page within 5 minutes. `FALLBACK_PLANS` in `lib/billing/plans.ts` is only used when the table cannot be read.

## 4. How quota works

- One quota unit = one invoice per billing period (`usage_ledger`, one row per firm, invoice and period).
- Queuing an invoice **reserves** a unit. When the AI work is done the unit is **consumed**. A free failure **releases** it.
- The period comes from the subscription (`current_period_start` to `current_period_end`), not the calendar month. New firms start on the day they sign up; firms that existed before Phase 5 start on the 1st of the month.
- The check happens in `enqueue_metered_jobs` under a per-firm lock, so two browser tabs cannot both take the last unit. If only some invoices fit, those are queued and the rest are returned as `quota_exceeded`; they stay **Uploaded** and can be processed after an upgrade or when the period renews.
- The "AI processing, calendar month" box on the dashboard (succeeded, failed, tokens, cost, exports) still counts the calendar month; it is a statistic, not the quota.

### Free failures and the retry rule

- A failure that is not the invoice's fault does not use quota: `provider_unavailable`, `provider_timeout`, `provider_rate_limited`, `provider_auth`, `provider_model_unavailable`, `stale_timeout`, `internal_error`, `invoice_removed`, and cancelled jobs. The unit is released.
- A failure caused by the invoice (unreadable file, `invalid_model_output`, not an invoice, and so on) consumes the unit.
- **A retry of the same invoice in the same period never uses a second unit.** If the first run did billable work the unit stays consumed and the retry is free; if the first run released its unit, the retry takes one again.
- Deleting an invoice does not return quota (the ledger has no link to the invoice). Exception: an invoice deleted while its job was still `queued` (the AI never started) releases its unit. After `009_billing_fixes.sql`, an invoice deleted while its job was `processing` stays consumed.
- Runs per invoice are still limited by `EXTRACTION_MAX_RUNS_PER_INVOICE`.

## 5. Upgrade and downgrade rules

- Only the firm **owner or admin** can change the plan (checked in the database). Members see read-only information.
- **Downgrade** (lower `sort_order`): scheduled for the end of the billing period; the current plan stays active until then. Choosing Pilot is how a paid plan is cancelled. A scheduled change can be cancelled with **Cancel change** (the same call with the current plan code).
- **Upgrade**: recorded as `upgrade_awaiting_payment` and the plan does **not** change until payment is confirmed. The screen says "payment not available yet". Only with `BILLING_ALLOW_UNPAID_UPGRADES=true` (section 7) does an upgrade apply at once.
- A firm whose subscription is `past_due` or `suspended` cannot upload for processing or queue new invoices (HTTP 402, `subscription_inactive`). Existing invoices, review and export keep working. Nothing sets these statuses yet: that is the payment phase.
- Extra limits that still come from environment variables: per-minute queue rate, concurrent jobs, runs per invoice, uploads per day. `EXTRACTION_MONTHLY_LIMIT` and `EXTRACTION_BATCH_MAX_FILES` are **no longer used**.

## 6. Review of Part 1: what was fixed

| # | Problem found | Fix |
|---|---|---|
| 1 | `roll_subscription_period` took the firm-wide advisory lock on every call. `billing_overview` calls it on every dashboard load and every 5-second poll, so the dashboard queued behind extraction claims. | `009_billing_fixes.sql`: return early, without a lock, while the period is still running. Rollover logic unchanged. |
| 2 | Deleting an invoice while its job was `processing` released the quota unit although the AI call had started and may be billed. | `009_billing_fixes.sql`: only a `queued` job releases; a `processing` job is settled as consumed. |
| 3 | `allowUnpaidUpgrades` ignored the flag only when `VERCEL_ENV=production`. A self-hosted production build (no `VERCEL_ENV`) would have honoured it. | `lib/billing/flags.ts`: also ignored when `NODE_ENV=production` and `VERCEL_ENV` is unset. It now works only with `next dev` and on Vercel Preview. Moved to its own file so it can be unit tested. |
| 4 | The dashboard quota panel counted every job of the calendar month (`month_jobs`: retries and free failures included), so it disagreed with the real quota. The summary route and dashboard page still used `EXTRACTION_MONTHLY_LIMIT` and `EXTRACTION_BATCH_MAX_FILES`. | Quota and batch limit now come from `billing_overview` in `app/dashboard/page.tsx`, `/api/review/summary`, `DashboardLive` and `UsagePanel`. |
| 5 | `formatPlanPrice` ignored the plan's `currency` column. | Non-INR plans are formatted in their own currency. |

Known, not changed: a job marked `stale_timeout` releases its unit even if the provider call actually ran. This favours the customer and is rare; revisit when real cost data exists.

## 7. BILLING_ALLOW_UNPAID_UPGRADES

> **Warning.** When `true`, any owner or admin can upgrade to any plan **for free**. It exists only so you can test the upgrade screens before payment exists. It is ignored on Vercel Production and on any production build outside Vercel. **It is still honoured on Vercel Preview deployments, which can be public: never set it there with real customer data.** Leave it unset everywhere else.

## 8. What Phase 6 (payment) must do

1. Pick the gateway and add its credentials server-side only (no `NEXT_PUBLIC_`). Do not simulate payments.
2. Create the gateway customer and subscription or order from a server route, using the **plan from the database** and the **firm from the session**; never an amount or plan sent by the browser.
3. Never trust the browser's "payment done" redirect. Only a verified server webhook may change the plan (verify the signature on the raw body, reject old timestamps, store each event id with a unique constraint so a repeated webhook does nothing).
4. On a confirmed payment: set `plan_code` from the pending upgrade, `current_period_start/end` from the gateway, `provider`, `provider_customer_id`, `provider_subscription_id`, and clear the pending fields. While `provider_subscription_id` is set, `roll_subscription_period` already leaves the dates to the gateway.
5. Handle success, pending, failed and refunded payments, renewals, cancellation and expiry. Map them to `active`, `past_due` (grace period, then `suspended`) and a return to Pilot. Write every step to `billing_events`.
6. Pilot downgrades and cancellations at period end must also cancel the gateway subscription.
7. Add a billing-events history to the Billing page and a way to download invoices or receipts.
8. Add tests for webhook signature, replay and out-of-order events.

## 9. Tests and results

Run on 12 Oct 2026 in the build environment (Node 22, no network, no PostgreSQL):

| Check | Result |
|---|---|
| `npm test` | **128 passed, 0 failed** (116 existing + 12 new in `tests/billing.test.mjs`: price formatting, `changeKind`, `usagePercent`, `usageLevel`, feature filtering, `allowUnpaidUpgrades` incl. `VERCEL_ENV=production`, enqueue messages) |
| Type check | `npm install` is blocked here, so the real Next and React types were not available. All project files were checked with `tsc` against loose stand-in declarations for `react`, `next` and `@supabase/*`: **no errors in new or changed files** other than artefacts of those stand-ins. Please run `npm run typecheck`. |
| `npm run build`, `npm run lint` | **not run** (no dependencies) |
| `supabase/tests/phase5_billing.test.sql` | **written, not executed** (no PostgreSQL). Covers quota limit, retry costs no unit, provider failure releases the unit, deleting an invoice keeps quota, batch limit trigger, member cannot change plan, upgrade/downgrade/cancel, period rollover, tenant isolation, and that browsers cannot write plans, subscriptions, usage or billing events. Expect small fixes on the first run. |
| UI in a browser | **not run** |

## 10. Known limits

- No payment: paid upgrades stay "awaiting payment" and nothing sets `past_due` or `suspended` yet.
- Quota is counted per invoice per period, not per page or per token. Real cost per invoice is in `usage_records` (tokens and estimated USD): compare it with the price before fixing limits.
- The browser must stay open while a batch is processed (Phase 3 limit).
- The firm is the first membership of the user (Phase 2 behaviour); users in several firms are not switchable yet.
