# AI Asis: pilot checklist for Indian CA firms

Goal of the pilot: find out, with real (anonymised or consented) purchase invoices, whether AI Asis saves your staff time **without** introducing errors that reach Tally or a GST return. Run it for 2 to 4 weeks with 1 to 3 firms. AI Asis suggests; a person always verifies.

## A. Before you start (once)
- [ ] Firm owner signs up; each staff member gets their own login (roles: owner, admin, member).
- [ ] Written consent from each client whose invoices are uploaded (invoices carry GSTIN, names and amounts). Do not upload Aadhaar, PAN cards, bank statements or anything that is not an invoice.
- [ ] Decide the pilot size: for example 10 clients, 200 invoices. The Pilot plan allows 25 invoices a month, so ask the AI Asis team to raise the limit for the pilot period (plan limits live in the `plans` table).
- [ ] Choose a **gold set**: 30 invoices your staff have already entered correctly in Tally. This measures accuracy later.
- [ ] Name one person as pilot lead, one as backup.

## B. GSTIN handling
- [ ] For 20 invoices, compare the supplier GSTIN and the buyer GSTIN on the paper with the screen, character by character. AI Asis flags a GSTIN whose format or check digit is wrong (`invalid_gstin`). Never clear that flag without looking at the original.
- [ ] Confirm the first two digits (state code) match the supplier's state. A supplier GSTIN that does not match the place of supply drives the CGST+SGST versus IGST check.
- [ ] Check invoices with **no** GSTIN (unregistered supplier, bills of supply): the field should stay empty, not be guessed.
- [ ] Check composition-scheme suppliers and bill-of-supply documents: tax columns should be zero or empty.
- [ ] Look for look-alike characters: `0` and `O`, `1` and `I`, `5` and `S`, `8` and `B`.
- [ ] Target: 0 wrong GSTINs reach an export. Record every miss in the log (section H).

## C. Multi-client handling
- [ ] AI Asis keeps one firm per login group. Check how your staff will separate **clients**: by client record (Clients page) or by naming the batch. Do a dry run with 3 clients.
- [ ] Upload each client's invoices in its own batch; link the invoices to the right client before exporting.
- [ ] Check that Staff A cannot open Staff B's firm data when they belong to different firms (the isolation tests cover this, but also try it by hand with two accounts).
- [ ] Check that the same invoice uploaded twice for the same firm is stopped ("already uploaded").
- [ ] Decide who may delete invoices: members delete only their own uploads; owners and admins delete any.

## D. Verification workflow (the control that matters)
- [ ] Every invoice follows: Upload > Extract > **Review** (original beside fields) > **Verify** > Export.
- [ ] Only **verified** invoices go to Excel, Google Sheets or Tally. Use "verified only" on exports.
- [ ] Reviewer checks, in this order: invoice number, date, supplier name and GSTIN, taxable value, each tax amount, total, place of supply. Then read every yellow or red warning.
- [ ] A different person verifies a 10 percent sample (second review).
- [ ] Measure time per invoice before (manual entry) and after (review only). Note the invoices that took longer than manual entry.
- [ ] Try the bad cases on purpose: blurred photo, rotated scan, handwritten bill, multi-page invoice, invoice in another currency, credit note, invoice with discounts and cess, a PDF with several invoices.
- [ ] Confirm that a failed extraction does not use up quota where it should not (see Billing page) and that you can retry.

## E. Tally ledger naming (Tally export is experimental and off by default)
- [ ] The supplier **ledger name in Tally must equal the supplier name in the export exactly** (spelling, spaces, "Pvt Ltd" versus "Private Limited"). Make a list of your top 30 suppliers with the Tally ledger name next to the name AI Asis extracts.
- [ ] The purchase ledger and the tax ledgers (CGST, SGST, IGST, Cess, Round Off) must already exist with the names configured for the export. Create them first.
- [ ] Import **one** voucher into a **test company** first. Check the party, the amounts, the date, the voucher number and that the voucher balances.
- [ ] Then 10 vouchers, then a month. Never import into the live company until the test company matches your manual entries.
- [ ] Tally exports do not carry HSN, stock items, bill-wise allocation or GST registration details; handle those in Tally as before.
- [ ] Non-INR invoices and credit notes are not supported by the Tally export; enter them manually.
- [ ] Keep the Tally file and the Excel file of the same batch together for audit.

## F. GST return reconciliation checks
- [ ] For one client and one month, compare the AI Asis export with GSTR-2B: for each supplier GSTIN and invoice number, are taxable value and tax amounts the same?
- [ ] List mismatches by cause: wrong extraction (AI Asis error), supplier filed differently (not an AI Asis error), invoice missing from GSTR-2B, invoice number formatting (leading zeros, slashes, spaces).
- [ ] Compare totals: sum of taxable value and of each tax head in the export versus the purchase register in Tally for the same period. The difference should be explained invoice by invoice.
- [ ] Check invoice date versus the tax period you will claim input tax credit in.
- [ ] Check reverse-charge, import and exempt invoices: AI Asis does not decide eligibility of ITC; your staff do.
- [ ] Check the CGST+SGST versus IGST warning on 10 inter-state and 10 intra-state invoices.
- [ ] Do not file a return from AI Asis numbers until the reconciliation for that client has matched for at least two months.

## G. Google Sheets / Excel Online (only if you test them)
- [ ] Use a test spreadsheet, not the client's master file. Do not change the header row afterwards (a changed header stops the sync with a clear message).
- [ ] Sync 5 invoices, press Sync again: no duplicate rows. Sync an invoice with the same invoice number twice from two uploads: the second must be reported as a duplicate.
- [ ] Revoke AI Asis in your Google or Microsoft account and sync: the app must ask you to reconnect.
- [ ] Note: this was never tested against real Google or Microsoft accounts by the developers. Treat every result as new information and report it.

## H. How to report problems
For every problem, send one message (email or the support channel agreed for the pilot) with:
1. **Who and when**: your login email, date and time (IST).
2. **What you did**: the page and the buttons you pressed.
3. **What you expected** and **what happened**: copy the red or yellow message exactly.
4. **The invoice**: file name and the AI Asis invoice id (shown in the review page); send the invoice only if the client consented.
5. **A screenshot** with client names hidden if needed.
6. **Severity**: *Wrong number reached an export* (critical), *wrong number caught in review* (important), *slow or annoying* (normal), *idea*.
Never send passwords, API keys or the contents of `.env`. Log everything in a shared sheet: date, client, invoice, field, AI value, correct value, caught in review (yes/no), time lost.

## I. Pilot exit criteria (agree them before you start)
- [ ] Field accuracy on the gold set, for invoice number, date, GSTIN, taxable value, total: at or above the level your firm accepts (write the number down first; there is no built-in promise).
- [ ] Zero critical issues open.
- [ ] Reconciliation to GSTR-2B and to the Tally register matched for two consecutive months for the pilot clients.
- [ ] Staff time per invoice is lower than manual entry, including review.
- [ ] Every user understands that verification is their responsibility.
