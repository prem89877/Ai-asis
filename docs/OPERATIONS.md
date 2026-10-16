# AI Asis: operations notes

Honest list of limits, costs, backups, retention and risks as of Phase 6 Part 2. Figures marked *check* change; confirm them on the provider's pricing page before quoting them to a customer.

## 1. Known limitations
**Product**
- Extraction is AI output and can be wrong. Every invoice needs human review; only verified invoices should be exported.
- Files: PDF, JPEG, PNG up to 4 MB, at most `EXTRACTION_MAX_PDF_PAGES` pages. One invoice per file is expected. Handwritten, blurred or heavily stamped invoices are less reliable.
- INR invoices only for the Tally export. Credit and debit notes, reverse-charge, imports and non-INR currency are not specially handled.
- Tally export is experimental and was never test-imported into Tally. There is no direct posting to Tally or any accounting system.
- Google Sheets / Excel sync: header row and column mapping must stay unchanged; line items are not synced; retries are manual ("press Sync again"); Google needs app verification for real customers (the `spreadsheets` scope is sensitive).
- **No payment gateway exists.** Plans can be shown and recorded, but paying, invoices for subscriptions, failed-payment handling and billing webhooks are **not built**. Paid upgrades are blocked in production by design.
- A person belongs to one primary firm in the UI (the earliest membership). Multi-firm switching is not built.
- No email notifications, no audit export, no admin console. The only scheduled job is the extraction worker (section 6); it must be scheduled, otherwise queued invoices run only while a browser tab is open.
**Technical**
- Extraction runs inside a request (limit 60 s). Large PDFs or provider slowness end as a failed job that the user retries.
- Rate limits are counted in the database per firm; there is no IP-level limit or CAPTCHA in front of sign-up and login (rely on Supabase Auth limits and consider Vercel's firewall).
- SQL tests and cloud integrations have not been run against real services by the author (see the release report).

## 2. Running costs (estimate the way you will be billed)
**Gemini (Google AI)**: charged per token. The app records an estimate per extraction in `usage_records.estimated_cost_usd` using the prices in `GEMINI_INPUT_PRICE_PER_MTOK` / `GEMINI_OUTPUT_PRICE_PER_MTOK` (defaults 0.30 and 2.50 USD per million tokens, checked 11 Oct 2026; *check*). Formula: `input_tokens x input_price/1,000,000 + output_tokens x output_price/1,000,000`. **Illustration only, not measured**: if one invoice page used 1,500 input and 1,200 output tokens the cost would be about 0.0035 USD. Measure your own average in the pilot:
```sql
select date_trunc('month', recorded_at) as month, count(*) filter (where kind = 'extraction') as extractions,
       sum(input_tokens) as input_tokens, sum(output_tokens) as output_tokens, round(sum(estimated_cost_usd), 4) as usd
from public.usage_records group by 1 order by 1 desc;
```
Retries and failed extractions also cost tokens. Gemini free tier terms differ on data use; use a paid key for client data and read Google's current data-use terms (*check*).
**Supabase**: Free plan = no automatic backups and no point-in-time recovery; Pro starts at about 25 USD per month with daily backups kept 7 days; point-in-time recovery is an add-on of about 100 USD per month per 7 days of retention (*check* https://supabase.com/pricing). Storage and bandwidth beyond the included amounts are billed; invoice files are at most 4 MB each (1,000 invoices is at most about 4 GB).
**Vercel**: the free Hobby plan is for non-commercial use; a paid product should use a paid plan (*check* https://vercel.com/pricing). Function duration and bandwidth are metered.
**Others**: domain name, optional Google Cloud and Microsoft Entra (free to register), your own support time.

## 3. Backups
- **Database**: turn on daily backups (Supabase Pro) and, if clients' books depend on it, point-in-time recovery. Do a **restore drill** into a scratch project before launch and note how long it took.
- **Storage bucket (`invoices`)**: database backups do **not** include the files in Storage. Supabase does not restore deleted files for you. Options: periodic copy of the bucket to your own cloud storage (script with the service-role key, run from your computer or a scheduler), and keep the original invoices at the client as well. Decide and test one.
- **Secrets**: keep `INTEGRATION_ENCRYPTION_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `GEMINI_API_KEY`, OAuth secrets in a password manager. Without the encryption key all stored cloud tokens are unreadable (users reconnect; no invoice data is lost).
- **Code**: GitHub; tag each release.
- **Before every migration**: take a manual backup or confirm last night's backup is good.

## 4. Data retention and deletion
- Nothing is deleted automatically. Invoices, extracted data, review history, export history and usage records stay until deleted.
- **Deleting an invoice** (button): marked `pending_deletion`, the file is removed from storage, then the row and its extracted data and line items are removed. If file removal fails the row stays `pending_deletion` so it can be retried. Quota already used for it is not given back.
- **Deleting a user's account** does not delete the firm or its data (they remain, without a member). **Deleting a firm in SQL removes all its rows but not its files**; delete the folder `<firm_id>/` in the `invoices` bucket through the Storage API or dashboard. (Both are pinned by `phase2_isolation.test.sql`.)
- Backups keep deleted data until they expire (7 days on Pro daily backups, longer with PITR). Say this in your privacy notice.
- Cloud connections: "disconnect" revokes and clears stored tokens; sync records are removed with the connection. Rows already written into a customer's Google Sheet or Excel file stay there.
- The AI provider receives the invoice file for each extraction. State this in your privacy notice and get client consent. Indian personal-data law (DPDP Act) obligations such as notice, consent, grievance contact and breach reporting are the operator's responsibility; get legal advice.
- Suggested policy to decide before launch: keep invoices for the period the firm must keep records, then delete; write the number of years here: ____.

## 5. Operational risks and what to do
| Risk | Effect | Mitigation |
|------|--------|-----------|
| Wrong extraction accepted by a tired reviewer | wrong ITC or Tally entry | mandatory review, second-review sample, warnings, reconciliation with GSTR-2B |
| Gemini outage, price or model change | extraction fails or costs more | retries and clear errors exist; watch the provider status page; re-run the accuracy eval (`npm run eval:extraction`) before changing `GEMINI_MODEL` |
| Gemini cost spike (abuse or retries) | bill | per-firm upload, minute and concurrency limits and plan quotas; set a budget alert in Google Cloud |
| Leaked service-role key | full database access | store only in Vercel server env; rotate in Supabase and redeploy; the repo scan test guards against committing it |
| Lost `INTEGRATION_ENCRYPTION_KEY` | all cloud connections must be redone | keep a copy; rotation uses `INTEGRATION_ENCRYPTION_KEY_PREVIOUS` |
| Google/Microsoft change APIs or revoke the app | sync stops | status shows "reconnect"/errors; keep CSV/XLSX export as the fallback |
| Google app left in "Testing" | refresh tokens die after 7 days | complete verification before real customers |
| Database migration mistake | outage or data loss | backup first, scratch-project rehearsal, SQL tests, rollback notes |
| Storage bucket not backed up | lost invoice originals | bucket copy job (section 3) |
| Orphaned data after account deletion | privacy exposure | delete firm and bucket folder as in section 4; build an account-deletion workflow before scale |
| Preview deployment with `BILLING_ALLOW_UNPAID_UPGRADES=true` and real data | free paid plans | never use real customer data on Preview; leave the flag unset |
| Sign-up abuse | cost, storage | email confirmation, upload limits; add CAPTCHA or Vercel firewall rules if abused |
| No monitoring | silent failures | watch Vercel logs and Supabase logs; add an error tracker and an uptime check before launch |
| Single developer / single region | slow recovery | document access, keep a second admin on Vercel, Supabase and Google Cloud |

## 6. Background worker, quota and upload cap (migration 018)
**Worker.** `/api/cron/extraction` fails stale jobs of ALL firms (`reap_stale_extraction_jobs`) and runs queued ones (`list_queued_extraction_jobs`: oldest first, fair between firms, jobs younger than 15 s are left to their browser). Before this, a stale job was cleaned up only when a new claim for the same firm arrived, and queued jobs ran only while the browser kept calling `/extract`. Setup: run `018_quota_worker_upload_cap.sql`, set `CRON_SECRET` (long random value), deploy. `vercel.json` calls the route every minute; Vercel sends the secret as `Authorization: Bearer <secret>`. Any other scheduler works with the same header. Without `CRON_SECRET` the route answers 503. Every job is claimed atomically, so the worker and a browser never run the same invoice twice. Check it with: `curl -H "Authorization: Bearer $CRON_SECRET" https://<your-app>/api/cron/extraction` (answer: `{"ok":true,"reaped":..,"listed":..,"started":..}`). Note: per-minute crons and a 200 s function need a Vercel plan that allows them.
**Quota.** `stale_timeout` and `internal_error` now consume the quota unit: the Gemini call may have started and been billed. Provider failures (`provider_*`) and `invoice_removed` stay free. A retry of the same invoice in the same period still costs no second unit.
**Upload cap.** The daily cap is reserved in `upload_events` under a per-firm lock (no check-then-insert race) and counted from that table, so deleting invoices does not lower it. A failed upload (storage error, duplicate file) gives its slot back; an uploaded invoice keeps it. The slot functions are service-role only.
