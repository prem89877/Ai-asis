# Extraction layers (how an invoice is read and double-checked)

The model never decides a final value on its own. Every value is read more than once and the readings are compared in plain code.

## The layers

| # | Layer | Sees the first reading? | Output | Switch |
|---|---|---|---|---|
| 1 | First reading | - | complete invoice | always on |
| 2 | Second reading | yes (as data that may be wrong) | complete invoice | `EXTRACTION_VERIFY` |
| 3 | Audit reading: counts the rows twice, reads cell by cell | **no (blind)** | complete invoice | `EXTRACTION_AUDIT` |
| 4 | Key-figures reading: totals box, amount in words, IRN / ack no / e-way bill only | **no (blind)** | small JSON | `EXTRACTION_TOTAL_CHECK` |

Layers 2, 3 and 4 start together right after layer 1, so the run takes about as long as one extra reading. If one of them fails, the others are still used and an info note (`recheck_unavailable`, `audit_unavailable`, `keyfigures_unavailable`) says which one is missing. All three are ON unless set to `off`. Each layer is one more Gemini call (see `usage_records`: `verify_*`, `audit_*`, `keyfigures_*`).

## Voting (`reconcileMany` in verify.ts)
- Same value in every reading: kept, stored with `source = "recheck"`.
- Most readings agree (2 of 3, 3 of 4): that value wins, silently.
- No majority: a rule that can be proven decides (GSTIN check digit, valid date, valid HSN, IRN/ack/e-way format and length, invoice arithmetic).
- Nothing can decide: first reading kept, confidence 0.5, warning `recheck_mismatch` showing all values.
- A reading with no value never outvotes a reading that has one.
- Number of item rows: the count most readings agree on; else the reading whose rows add up to the invoice taxable value; else the first reading and warning `recheck_item_count`.

## Grand total (`resolveGrandTotal` in total-check.ts)
Witnesses for a grand total value: each AI reading that gave it, the printed **amount in words** (parsed to a number in code, English words, Indian and international scales), and the **invoice arithmetic**.
- The value chosen by the vote is replaced only by a value with at least 3 witnesses and more witnesses than the chosen one (info `grand_total_corrected`).
- Fewer than 2 witnesses: warning `grand_total_unconfirmed`, confidence lowered to 0.5.
- Figures and printed words disagree: `grand_total_words_mismatch` (warning; info when 3 or more witnesses back the figure and the words were read inconsistently).
- Words that cannot be parsed are skipped, never guessed.
- The result is kept in `validation_summary.total_consensus` (`status`, `witnesses`, `sources`, `readings`, `words_value`, `words_match`).

## Flags that used to repeat, and why they should not come back
- **"Item N: This line is negative..."** was raised for every negative line. Now negative lines are judged once per invoice (see GST_ENGINE.md). The usual real cause of a wrong negative is a "-" in an empty cell being read as a minus sign: the prompts now say a dash is never a minus sign, and a negative line whose signs disagree, or that only ties when positive, is a warning.
- **"The IRN is not 64 hexadecimal characters"** came from long IRNs being cut short or carrying the label / line breaks. Now: labels, spaces, line breaks and dashes are removed; O/Q for 0 and I/l for 1 are repaired only when that yields exactly 64 hex characters (and reported); the IRN is read by up to four readings and the one with 64 hex characters wins; the prompts say to use `unreadable` instead of guessing. If it is still wrong the note says how many characters were found.

## Tuning
- Cheaper / faster: `EXTRACTION_AUDIT=off` and/or `EXTRACTION_TOTAL_CHECK=off`.
- The deadline (`EXTRACTION_DEADLINE_MS`, default 52 s) still applies. If less than 12 s is left after the first reading, the extra layers are skipped with a note.
