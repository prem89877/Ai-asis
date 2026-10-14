# Extraction layers (how an invoice is read and double-checked)

The model never decides a final value on its own. Every value is read more than once and the readings are compared in plain code.

## The layers

| # | Layer | Sees the first reading? | Output | Switch |
|---|---|---|---|---|
| 1 | First reading | - | complete invoice | always on |
| 2 | Second reading | yes (as data that may be wrong) | complete invoice | `EXTRACTION_VERIFY` |
| 3 | Audit reading: counts the rows twice, reads cell by cell | **no (blind)** | complete invoice | `EXTRACTION_AUDIT` |
| 4 | Key-figures reading: totals box, amount in words, IRN / ack no / e-way bill only | **no (blind)** | small JSON | `EXTRACTION_TOTAL_CHECK` |
| 5 | Parties reading: supplier / buyer name, GSTIN, PAN, state, **every GSTIN printed on the document with its role** | **no (blind)** | small JSON | `EXTRACTION_PARTIES_CHECK` |

Layers 2, 3, 4 and 5 start together right after layer 1, so the run takes about as long as one extra reading. If one of them fails, the others are still used and an info note (`recheck_unavailable`, `audit_unavailable`, `keyfigures_unavailable`, `parties_unavailable`) says which one is missing. All four are ON unless set to `off`. Each layer is one more Gemini call (see `usage_records`: `verify_*`, `audit_*`, `keyfigures_*`).

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

## GSTIN (supplier and buyer): how it is read and checked (`party-check.ts`)
A GSTIN is the value that is most often misread (one wrong character), and a wrong GSTIN breaks GST filing. So it has the most witnesses.

**Reading.** The first, second, audit and the blind parties reading all give a supplier and a buyer GSTIN. The prompts say what "supplier" and "buyer" mean (issuer vs bill-to, never ship-to) and that a PAN is never a GSTIN.

**Voting** (`voteGstin`), in this order:
1. Same 15 characters in every reading: kept.
2. Readings differ, exactly one distinct value passes layout + Modulo-36 check digit + valid state code: that one.
3. Two different valid numbers: a strict majority decides, otherwise it stays a conflict.
4. No reading is valid on its own: **character by character** is tried only to build a *proposal*. A GSTIN that no reading gave as a whole is never saved: the value that was read stays and a `gstin_char_proposed` warning shows the assembled number for the reviewer. A single check-digit-valid reading also does not outvote more readings that agree on another value (`conflict`, first reading kept).
5. Nothing proves anything: first reading kept, `recheck_mismatch` as before. No character is ever invented.

**Evidence** (`judgeGstin`). Witnesses = readings that gave exactly this value + the printed PAN (characters 3-12 are the PAN) + the state printed in the supplier block (characters 1-2) + the value being in the list of all printed GSTINs with the right role.
- `verified`: valid and at least 3 witnesses, nothing contradicts it.
- `probable`: valid, fewer than 3 witnesses.
- `unverified`: layout / check digit / state code fails.
- `conflict`: a printed PAN or state differs, the printed role is the other party, supplier = buyer, or the readings disagree and nothing proves one.
- `absent`: no reading found one (normal for B2C).

**Mix-up repair.** If both numbers are valid and the document prints each next to the other party in every reading that shows it, they are swapped back (`gstin_roles_swapped`, warning). A tie between valid numbers is broken only by the printed role. If supplier and buyer came out as the same number, the buyer GSTIN printed in the bill-to block is used when there is exactly one.

**Retry.** While a GSTIN is neither `verified` nor `absent`, up to `EXTRACTION_PARTIES_RETRIES` (default 1) more blind parties readings run, if the deadline allows. Each is one more witness; the vote and the evidence are recomputed. A GSTIN that every reading prints identically and that fails the check digit is not retried (it is most likely a print error and stays `gstin_checksum_note`).

## Final verification gate (`final-audit.ts`): three layers over the whole content
Runs after normalization and the GST engine. It only adds a report (`validation_summary.verification`) and flags. It never changes a value.

| Layer | Name | What it checks |
|---|---|---|
| 1 | rules | GSTIN layout, check digit, state code, PAN inside the GSTIN; supplier is not buyer; date after 1 Jul 2017 and not in the future; printed state code and state name agree; currency code; IRN / ack / e-way format; HSN; the GST engine's arithmetic verdict |
| 2 | consensus | every header value and every item cell against **every** full reading. Needs a strict majority of the readings that had a value, or a rule that proves it (valid check digit while the others fail it, valid date / HSN, arithmetic ties) |
| 3 | evidence | GSTIN verdict (witnesses above), supplier / buyer name and place of supply against the parties reading (names are compared softly: "Acme" = "Acme Pvt Ltd"), grand total consensus status |

A field is `verified` only if it passed every layer that had something to say about it; otherwise `needs_review` with the layers and reasons. Flags: `gstin_unverified` / `gstin_conflict` (one per GSTIN, not repeated when `invalid_gstin` or `gstin_checksum_note` already explains it), and ONE `verification_failed` for all other fields. Any warning sends the invoice to review. `verification.passed` / `complete` and `verification.gstin.*` (status, vote method, witnesses, evidence, problems) are stored with the invoice.

## Line-item maths auto-correction (lib/extraction/line-fix.ts)

When `quantity x unit price (less discount) x exchange rate` does not equal a line's taxable value, the system first tries to
repair a misread digit (INR 10,000 read as 1,000) before a human is asked.

A value is corrected only when ALL of this holds:

1. The line fails the normal line arithmetic (same tolerance, discount and exchange-rate rules).
2. Only quantity, unit price or taxable value can change; the solved value must look like a real misread (dropped or added digit,
   shifted decimal point, one wrong digit, two swapped digits).
3. Score of at least 2 and strictly higher than any other candidate. One point per independent witness (GST amount = taxable x rate,
   line total = taxable + GST, sum of items = invoice taxable value) plus one point when the model's confidence for that field is
   clearly the lowest of the three and below `EXTRACTION_LINE_FIX_MAX_CONFIDENCE` (default 0.95).
4. A value the model read with confidence at or above that limit is corrected only when all three witnesses agree.
5. Foreign currency lines are corrected only when the invoice prints an exchange rate.

Audit trail: `field_status[...].autoCorrected = { from, to }` (source `computed`), an info flag `line_item_auto_corrected` (with the
original value, witnesses and original confidence) and the untouched `raw_extraction`. If nothing can be proven the line keeps its
`arithmetic_line_mismatch` warning and an info note `line_autofix_skipped` gives the reason. Switch off with `EXTRACTION_LINE_FIX=off`.
