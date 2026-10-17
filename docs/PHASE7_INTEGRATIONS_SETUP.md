# Phase 7: Zoho Sheet, Zoho Books and TallyPrime (plus where the Google / Microsoft keys come from)

## What exists (and what was verified)

| Feature | Built | Verified here |
|---|---|---|
| Google Sheets, Microsoft Excel Online | Already built in Phase 6 Part 1 | Mocked HTTP only (see PHASE6_PART1_SETUP.md) |
| **Zoho Sheet**: OAuth per data centre, choose workbook (paste link) + worksheet, column mapping, duplicate-safe append | Yes | Mocked HTTP only. **No real Zoho account was used.** |
| **Zoho Books**: OAuth, choose organisation + expense account, every verified purchase invoice becomes one **Bill**, vendor found by GSTIN or name (created if missing), Zoho's total is compared with the invoice and a wrong bill is deleted again | Yes | Mocked HTTP only. **Zoho field names and tax names were written from the documentation and must be tested on a Zoho trial organisation.** |
| **TallyPrime**: direct push of the same purchase vouchers as the file export, one voucher per request, Tally's answer is read | Yes, experimental | Mocked HTTP only. **Never run against a real TallyPrime.** |
| SQL migration `020_more_integrations.sql` | Yes | **Not executed** (no PostgreSQL here). Run on a scratch project first. |
| `npm test` | 825 pass (803 existing + 22 new) | Plain Node, no network |
| `tsc` | The new server files compile with no errors that are not caused by the missing `node_modules` | Full `npm run typecheck` and `next build` were **not** run (no network): run them before deploying |

## Setup order

1. Run `supabase/migrations/020_more_integrations.sql` (after 010 to 019).
2. Add the variables from `.env.example` (section "Phase 7") in Vercel, redeploy.
3. Dashboard > Integrations: Connect, choose the file / organisation, press **Sync verified invoices**.

## Where the keys come from

**Google Sheets** (`GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`)
1. https://console.cloud.google.com > create a project > APIs & Services > Library > enable **Google Sheets API**.
2. OAuth consent screen: add scopes `openid`, `email`, `.../auth/spreadsheets`; add yourself as a test user.
3. Credentials > Create credentials > OAuth client ID > **Web application**. Redirect URI: `https://YOUR-DOMAIN/api/integrations/oauth/google_sheets/callback`.
4. Copy the client ID and secret. (Testing mode: refresh tokens last 7 days; real customers need Google verification.)

**Microsoft Excel Online** (`MICROSOFT_OAUTH_CLIENT_ID`, `MICROSOFT_OAUTH_CLIENT_SECRET`, `MICROSOFT_OAUTH_TENANT`)
1. https://entra.microsoft.com > App registrations > New registration, platform **Web**, redirect URI `https://YOUR-DOMAIN/api/integrations/oauth/microsoft_excel/callback`.
2. API permissions > Microsoft Graph > Delegated: `Files.ReadWrite`, `offline_access`, `openid`, `profile`, `email`.
3. Certificates & secrets > New client secret: copy the **Value** (not the ID). Application (client) ID = the client ID. Keep `MICROSOFT_OAUTH_TENANT=common`.

**Zoho Sheet and Zoho Books** (`ZOHO_OAUTH_CLIENT_ID`, `ZOHO_OAUTH_CLIENT_SECRET`)
1. Open the API Console of **your** data centre: India https://api-console.zoho.in, US https://api-console.zoho.com, EU https://api-console.zoho.eu.
2. Add Client > **Server-based Applications**. Homepage URL = your site. Authorised redirect URIs (both): `https://YOUR-DOMAIN/api/integrations/oauth/zoho_sheet/callback` and `https://YOUR-DOMAIN/api/integrations/oauth/zoho_books/callback`.
3. Copy Client ID and Client Secret. The user picks the data centre of their own account on the Connect screen (default India); it must match the account, otherwise the sign-in fails.
4. Scopes used: Sheet `ZohoSheet.dataAPI.READ, ZohoSheet.dataAPI.UPDATE`; Books `ZohoBooks.contacts.CREATE/READ, ZohoBooks.bills.CREATE/READ/DELETE, ZohoBooks.settings.READ, ZohoBooks.accountants.READ`.

**TallyPrime** needs no key. It needs a way for the server to reach your PC (below).

## Zoho Books: what is sent, and what is refused

* One bill per verified invoice. Vendor = existing Zoho vendor with the same GSTIN or name, else a new vendor. Each invoice line becomes one bill line (quantity 1, rate = the line's taxable value, so the money is exact; the real quantity goes into the description) with the matching **IGST x%** or **GST x%** tax of your organisation. A round-off of up to the same window the review engine allows becomes the bill's adjustment.
* The AI Asis invoice id is stored as the bill's reference number. If an answer from Zoho was lost, the next sync finds that bill and does not create a second one.
* After creation Zoho's total is compared with the invoice total. A difference above INR 1 deletes the bill again and shows why. If the delete itself fails the message tells you which bill to delete by hand.
* **Refused with a reason (use the Tally or CSV export instead):** cess, TCS, TDS, freight outside the taxable value, foreign currency, credit notes, a GST rate that has no tax in your Zoho organisation (create it under Settings > Taxes), lines that do not add up.
* Zoho state codes (`MH`, `KA`, ...) are filled from the GSTIN and place of supply. If Zoho rejects a state, that invoice fails with Zoho's refusal (shown as "did not accept the request"). **Test this first.**

## Zoho Sheet notes

* Columns are written by header name, so every header must be unique and non-empty; otherwise nothing is written.
* The AI Asis ID column is mandatory, as for Google and Excel.

## TallyPrime direct push (experimental)

TallyPrime is a program on your PC with a small web server (Gateway of Tally > F1 Help > Settings > Connectivity; default port 9000). That PC is not on the internet, so the AI Asis server cannot reach it directly. Options:

1. **Cloudflare Tunnel** (free): `cloudflared tunnel --url http://localhost:9000` gives an https address. Add an access token with Cloudflare Access or a reverse proxy in front: **anyone who has the address could otherwise post vouchers to your books.**
2. Enter that https address (and the token, if any) on Dashboard > Integrations > TallyPrime > Connect. AI Asis asks Tally for its open companies; if it answers, the address is saved **encrypted**.
3. Open the ledger-name form and set the names exactly as in Tally. The ledgers must exist already.

Safety rules in the code: https only, no IP addresses, no `localhost` or internal names, every resolved address must be public, redirects are never followed, the answer is size-limited.

**Limit you must know:** if Tally does not answer after the request left, nobody knows whether the voucher was created. That invoice is marked failed with "Check Tally before pressing Sync again". Nothing is retried automatically. The file export (XML) still works as before, and is the safer way until you have test-imported one voucher.

## Not done / open

* No test against real Zoho Sheet, Zoho Books, TallyPrime accounts. Zoho Sheet's method names (`worksheet.list`, `range.content.get`, `worksheet.records.add`, `worksheet.header.set`) and Zoho Books' field names come from the public documentation and need a live check.
* No route-level test for the new Zoho Books / TallyPrime branches of the sync route (the engines are tested; the route glue is read-checked only).
* Zoho Books: no cess / TCS / TDS, no credit notes, no foreign currency.
* TallyPrime: a tunnel is needed; a small agent on the Tally PC that pulls vouchers (no open port) would be safer and is not built.
