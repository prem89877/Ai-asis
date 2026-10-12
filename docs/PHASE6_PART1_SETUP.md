# Phase 6, Part 1: Google Sheets, Microsoft Excel Online and Tally-compatible export

## What was built (and what was verified)

| Feature | Built | Verified here |
|---|---|---|
| Google OAuth (code + PKCE, offline access), encrypted token storage, revoke | Yes | Logic unit-tested with mocked HTTP. **Not tested with real Google credentials.** |
| Choose spreadsheet (paste link, or create new) + worksheet, map columns | Yes | URL parsing / mapping unit-tested. UI **not run in a browser**. |
| Google Sheets append with duplicate prevention, retries, error messages | Yes | Sync engine unit-tested with fakes and mocked HTTP. **No live Sheets call made.** |
| Microsoft OAuth (code + PKCE), `Files.ReadWrite`, refresh-token rotation | Yes | Mocked HTTP only. **Not tested with a real Microsoft account.** |
| Choose workbook, worksheet or table, append rows (table API or plain sheet) | Yes | Request shapes unit-tested. **Graph behaviour not confirmed live.** |
| Tally-compatible XML / JSON / CSV | Yes, experimental | Well-formed XML and balanced vouchers tested. **Never imported into Tally.** Off by default. |
| Database migration (RLS, column-level token protection, claim/finish functions) | Yes | **SQL not executed** (no PostgreSQL available). Run on a scratch project first. |
| TypeScript check / `next build` / lint | n/a | **Not run**: no network, so `npm install` was impossible. Run `npm ci && npm run typecheck && npm run build` before deploying. |

`npm test`: 174 tests pass (existing 128 + 46 new, plain Node, no network).

## Setup

1. Run the migration `supabase/migrations/20261014000001_phase6_integrations.sql` (after the earlier ones).
2. Generate the encryption key and add the variables from `.env.example` (section "Phase 6 Part 1") in Vercel. `SUPABASE_SERVICE_ROLE_KEY` must already be set.
3. **Google**: Cloud Console, enable *Google Sheets API*, create an OAuth client (Web). Redirect URI: `https://YOUR-DOMAIN/api/integrations/oauth/google_sheets/callback` (add `http://localhost:3000/...` for local). Consent screen scopes: `openid`, `email`, `.../auth/spreadsheets`. While the app is in *Testing*, only listed test users can connect, and refresh tokens expire after 7 days. For real customers the `spreadsheets` scope is *sensitive*, so Google's verification is required. A narrower design (`drive.file` + Google Picker) avoids that but is not built.
4. **Microsoft**: Entra admin centre, new registration, platform *Web*, redirect URI `https://YOUR-DOMAIN/api/integrations/oauth/microsoft_excel/callback`. API permissions (delegated, Microsoft Graph): `Files.ReadWrite`, `offline_access`, `openid`, `profile`, `email`. Create a client secret (it expires; note the date). Some work tenants block user consent and need an admin to approve.
5. Redeploy, open **Dashboard > Integrations**, connect, choose the file, map the columns, press *Sync verified invoices*.

## How syncing behaves

* Only **verified** invoices are sent. One row per invoice (invoice-level fields; line items are not synced).
* The **AI Asis ID** column is mandatory in the mapping. Before appending, the sheet's ID column is read, so a row written by an earlier attempt whose response was lost is recognised and not added again.
* Duplicates are blocked at three levels: per-invoice ledger (`sync_records`), the same supplier GSTIN + invoice number + financial year uploaded as a different file, and the ID check in the sheet itself.
* Appends are one request per run (max 25 invoices). Appends are retried only on HTTP 429; after a timeout or 5xx the run stops and the next run checks the sheet first. Reads are retried up to 3 times with backoff.
* If someone edits the header row after mapping, sync stops with a clear message instead of writing into the wrong columns.
* Google writes use `RAW` (text such as `=1+1` can never become a formula). Excel text that looks like a formula, number or date is prefixed with `'` so it stays text (unverified against live Excel).
* Excel: an Excel **table** is recommended. A plain worksheet needs headers in row 1 and is written below the last used row; someone typing into the sheet at the same moment could collide.
* Roles: any member sees status; only owner/admin connect, map, sync and disconnect. A connection uses the connecting person's own cloud authorisation.

## Tokens, revocation, expiry

* Refresh and access tokens are encrypted (AES-256-GCM, bound to firm + provider) before storage. Browsers cannot read token columns (column-level grant). Passwords are never requested.
* *Disconnect* deletes stored tokens and, for Google, revokes the token at Google. Microsoft offers no call to revoke a delegated refresh token: tell users to also remove the app in their Microsoft account's app permissions.
* If a token is revoked or expires, the connection becomes *needs reauthorisation* and the UI asks the user to reconnect. Microsoft rotates refresh tokens on every refresh; the new one is stored each time.
* Rotating `INTEGRATION_ENCRYPTION_KEY`: set the new key, keep the old as `INTEGRATION_ENCRYPTION_KEY_PREVIOUS`, ask users to reconnect, then remove the old key.

## Tally-compatible export (experimental, off by default)

Set `TALLY_EXPORT_ENABLED=true` to show it. It builds **purchase vouchers** from verified INR invoices; it never connects to or posts into Tally.

| Voucher field | From |
|---|---|
| DATE | invoice date (YYYYMMDD) |
| VOUCHERNUMBER / REFERENCE | invoice number |
| PARTYLEDGERNAME and the credit entry | supplier name (the total) |
| Purchase ledger (debit) | taxable value |
| CGST / SGST / IGST / Cess ledgers (debit) | the matching tax amounts, if not zero |
| Round-off ledger | difference up to INR 1.00 between total and parts |
| NARRATION | AI Asis ID and supplier GSTIN |

Limitations: the party and all ledger names must already exist in Tally with exactly those names (supplier names must match the ledger name in Tally). No GST registration details, HSN, stock items or bill-wise allocation are exported. Credit notes, non-INR invoices, missing numbers/dates and invoices whose parts differ from the total by more than INR 1 are skipped and listed with a reason. Tally exports are not counted in export history or quota. **Import a sample into a copy of a test company in your Tally version before any real use.** CSV is a voucher-line layout; no particular import utility has been tested with it.

## Not done / open

* Real end-to-end runs against Google, Microsoft and Tally (need your credentials and a Tally install).
* Running the migration and RLS checks on a database; a SQL test file for Phase 6 was not written.
* `npm install`, `tsc`, `next build`, lint.
* Line-item sync, Google Picker / `drive.file` option, automatic scheduled retries (retry is "press Sync again").
* The TEMP-DEBUG error detail from earlier phases (`lib/api/debug.ts`, `DEBUG_ERRORS = true`) is still on; switch it off before production.
