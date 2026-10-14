# GST portal verification and vendor fraud warnings

Code: `lib/extraction/gst-portal.ts`. Runs inside `runExtraction()` after the GST validation and before the final audit.

## Data source
The GST portal's "Search Taxpayer" page has no public API (captcha, scraping not allowed). The app calls a GSTIN lookup service
instead. Default adapter: **gstinapi.in** (`GET /v1/gstin/<GSTIN>`, header `x-api-key`). Free sign-up gives about 100 lookups; the
sandbox GSTIN `00AAAAA0000A1ZT` returns a fixed sample. Another provider = another adapter that returns a `GstRecord`.

## Rules (supplier GSTIN, invoice date D)
| Situation | Flag | Severity |
|---|---|---|
| GSTIN valid in format but unknown to the GST system | `supplier_gstin_not_found` | error |
| Registration date after D | `supplier_gstin_not_yet_registered` | error |
| Cancelled on or before D (or cancelled and a date is missing) | `supplier_gstin_cancelled` | error |
| Cancelled after D (was active on D) | `supplier_gstin_cancelled_later` | info |
| Suspended / any other non-Active status | `supplier_gstin_inactive` | warning |
| Blocked on the portal | `supplier_gstin_blocked` | warning |
| Invoice supplier name differs from registered legal / trade name | `supplier_name_mismatch` | warning |
| Composition dealer charging GST on a tax invoice | `composition_charging_tax` | warning |
| Active and active on D | `supplier_gstin_verified` | info |
| Service down, slow, out of credits | `gst_portal_unavailable` | info (extraction is never blocked) |

Result is saved in `validation_summary.gst_portal` (status, dates, names, `active_on_invoice_date`). Values are never changed.
A GSTIN that fails its own format or check digit is not sent to the service (no credit is used).
Same GSTIN is cached in memory for `GST_PORTAL_CACHE_MINUTES` (per server instance).

## Settings
`GST_PORTAL_API_KEY` (required to run), `GST_PORTAL_CHECK=off`, `GST_PORTAL_BASE_URL`, `GST_PORTAL_TIMEOUT_MS`, `GST_PORTAL_CACHE_MINUTES`.
