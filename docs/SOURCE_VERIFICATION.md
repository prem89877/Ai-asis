# Source-grounded second-layer verification

Code: `lib/extraction/source-verify.ts`, hook in `lib/extraction/pipeline.ts`. Tests: `tests/source-verify.test.mjs`.

## What it does
After all existing layers (first / second / audit reading, key figures, parties, vote, line-maths fix) the pipeline looks for values that are **still suspicious**:
unreadable / invalid / low-confidence / missing required fields, GSTINs that fail layout or check digit (or were auto-repaired), values that failed the 3-layer audit (consensus, evidence, rules), values named by an arithmetic mismatch (line, subtotal, total), and unusual GST rates.

- **No suspicious value: no extra AI call** (summary says `not_needed`).
- Otherwise ONE targeted call re-reads only those values (max 14 values, max 6 item rows) from the **original file** (PDF / image bytes) at high media resolution. The saved values are **not shown** to the model (blind). The model must return the exact printed text of the cell/line, the page, a confidence and any other plausible reading.
- The answer is judged **in code**. A value is replaced only when ALL hold: confidence >= 0.9, no alternative reading, the quoted text really contains the value, and a rule that does not depend on the model proves it:
  - GSTIN: re-read passes layout + check digit + state code while the saved one does not (two valid but different GSTINs go to a person).
  - Date: re-read is a real date in range, saved one is not (day/month swaps go to a person).
  - Amounts / quantity / rate: invoice arithmetic gets strictly better, the change is a believable misread (or the arithmetic fully ties).
  - Invoice number: an earlier independent reading already gave the same text. A missing invoice number is only proposed.
- Everything else is **unresolved**: nothing changes, a `source_verify_unresolved` warning (with the proposal and the evidence) goes to the review screen.

## Audit record
- `validation_summary.source_verification`: status, counts, and per value: original, proposed, applied, proof, printed quote, page, confidence, outcome.
- Corrected value: `field_status[...].autoCorrected = {from, to}`, `source = "source_check"`, info flag `source_verify_corrected`. `raw_extraction` keeps the first reading untouched.
- Confirmed values are recorded in the summary only. Existing flags (for example low confidence) are never removed by this layer.

## What "source" means here (honest limits)
- The model receives the **original file** again, not OCR text. The app has **no OCR engine, no coordinates and no image library**, so there is **no region cropping or region OCR**. A targeted read means: only the listed values, high resolution, with a verbatim quote and page that the code checks.
- `mediaResolution: MEDIA_RESOLUTION_HIGH` is sent for this call only. If the provider rejects it, one retry without it is made. **It was not tested against the live Gemini API** (no network here).
- The quote is checked by code, but the model could still invent a quote that contains its value. That is why a quote alone never corrects anything.

## Safety
- Works on copies. Timeout, provider error, truncated / malformed JSON, thrown error or too little time: values stay exactly as extracted, an info flag says the check did not run, the invoice is still saved.
- Runs before the maths checks, so flags and the GST engine see corrected values. API key stays server-side (same Gemini client).
- Item-value corrections respect `EXTRACTION_LINE_FIX=off` (then only proposed). Foreign-currency invoices without a printed exchange rate are not corrected.
- Cost: one extra call only for invoices with suspicious values. It needs about 8 s of the run budget left after the other layers; otherwise it is skipped with an info note.

## New environment variable
`EXTRACTION_SOURCE_VERIFY` (default on; `off` disables). Needs `EXTRACTION_VERIFY` on as well (`EXTRACTION_VERIFY=off` means "one call only"). Added because this layer costs an extra provider call and needs its own kill switch, like the other layers. No other variable was added and no disabled feature was enabled.
