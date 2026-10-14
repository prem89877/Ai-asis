# Structured extraction and field mapping

Flow: Gemini answer -> `parse-json.ts` -> `validateModelOutput` (strict schema) -> votes / checks -> `item-rows.ts` -> `normalizeExtraction` -> `store.complete` (`complete_extraction_job`) -> review form / invoice table (`lib/review`) -> export (`lib/export`, Tally).

* **Parsing** (`parse-json.ts`): accepts JSON, a code fence, or one complete object inside plain words. Never repairs. A cut-off answer is `truncated` and counts as `invalid_model_output` (retried, then the run fails and nothing is saved).
* **Missing vs zero**: `status` present + 0 = genuine zero (`field_status.state = "zero"`); missing / unreadable stay `null` with their own state.
* **Precision**: values are stored as read, never recomputed. More decimals than the column holds raise `amount_precision`; the reading as received is kept in `raw_extraction`.
* **Duplicate item rows** (`item-rows.ts`): a repeated block of identical rows is removed only when the remaining rows add up to the invoice taxable value and the repeat does not (info `duplicate_item_rows_removed`). If the total cannot settle it, rows stay and `possible_duplicate_item_rows` (warning) is raised. Genuine repeated items are kept. Switch: `EXTRACTION_DEDUPE_ROWS=off`.
* Unchanged: database schema, routes, authentication, review and Tally / CSV / XLSX export code.
