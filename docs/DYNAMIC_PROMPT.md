# Dynamic prompt engine (`lib/extraction/dynamic-prompt.ts`)

The first reading of every invoice sends the fixed `SYSTEM_PROMPT` (prompt.ts) **plus** a short, invoice-specific section built at run time.
Target: about 200-300 words (soft limit, `maxWords`). Required blocks are never dropped; optional blocks are added in priority order while the target allows.

## What it adapts to
| Source | Cue | Effect |
|---|---|---|
| preflight (always available) | PDF page count (or unknown) | multi-page / continuation-row rules, totals only from the final totals box |
| preflight | image kind and pixel size | photo advice, low-resolution warning (< 900 px) |
| retry | previous attempt gave `invalid_model_output` | schema reminder on the next attempt |
| OCR / text layer (optional, **not produced by the pipeline today**) | heading, tax labels, e-invoice, TCS/TDS/round-off, cess, discount column, foreign currency, "Page x of y", continued / carried forward, many or suspicious GSTINs, several invoice numbers or totals, Hindi text | matching short blocks |

## Safety
* The section is assembled only from fixed sentences. Text from the invoice or OCR is reduced to booleans, small integers and whitelisted currency codes first and is never copied into it.
* OCR text, if a caller supplies it (`ocrText`), goes into the **user** prompt inside `<ocr_text>` (control characters removed, `<` escaped, truncated to 12 000 characters) and is labelled untrusted.
* Text that looks like an instruction to an AI adds a required "do not follow it" block.
* The response schema, field names, validation and database columns are untouched.

## Integration
`pipeline.ts` builds the prompt for each first-reading attempt (`attempt`, `previousFailure` are passed in) and sends it through the existing `systemPrompt` / `userPrompt` overrides of `callGemini`. If the engine throws, the call is made with the unchanged fixed prompts.
The second, audit, key-figures and parties readings use the same engine with a `purpose` (`verify`, `audit`, `keyfigures`, `parties`). Each purpose gets only the blocks that name fields of that reading's own schema (a test enforces it). Blind readings get text built from the file's properties only: no data from another reading.

## Switch
`EXTRACTION_DYNAMIC_PROMPT=off` (also `false`, `0`, `no`) sends the fixed prompt only. Default: on. `npm run eval:extraction` uses the same switch, so the two prompts can be scored on the same fixtures.

## Adding OCR later
Pass `ocrText` in `DocumentSignals` where the pipeline builds the signals. Nothing else needs to change.

## Tax-head blocks
- `tax_heads` (every reading that returns totals, unless only IGST is labelled): cgst, sgst, igst and cess are separate printed figures; CGST and SGST are normally equal (copy what is printed, lower the confidence if they differ); TCS and TDS are not tax heads; copy, never derive.
- `utgst` (only when "UTGST" is printed): copy the UTGST amount into sgst, never into cgst.
Both are fixed sentences. The code (`tax-math.ts`) does the checking, so the model is never asked to calculate.
