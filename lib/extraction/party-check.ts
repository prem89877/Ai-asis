// Supplier / buyer identity checks. Pure code, no network. Used by the pipeline (voting + evidence) and by final-audit.ts.
//
// Principles (same as the rest of the extraction layers):
//  - A GSTIN is never invented. Only characters that some reading really produced are ever used.
//  - A value is accepted automatically only when the full 15 characters pass the layout AND the Modulo-36 check digit.
//  - Everything else is kept as read and reported with the evidence that is missing or contradicting.
//
// Witnesses for one GSTIN (each one is independent of the others):
//   1. every full AI reading that gave it (first, second, audit),
//   2. the blind "parties" reading(s) (prompt.ts: PARTIES_SYSTEM_PROMPT),
//   3. the printed PAN of the party (characters 3 to 12 of a GSTIN ARE the PAN),
//   4. the list of every GSTIN printed on the document (with the role the reading saw next to each),
//   5. the state printed in the party block (characters 1 and 2 of a GSTIN are the state code).
import { NAME_ALIASES, STATE_NAMES } from "../gst/states.ts";
import { checkGstin, nameKey } from "./normalize.ts";
import type { ModelField, ModelOutput, PartiesReading, ReviewFlag } from "./types.ts";

// ---- State codes (GSTIN characters 1-2) -------------------------------------------------------------------------------

// Built from the shared table (lib/gst/states.ts). GSTIN characters 1-2 can never be 96 (foreign country), so it is left out here.
export const STATE_CODES: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(STATE_NAMES).filter(([c]) => c !== "96").map(([c, n]) => [c, n.replace(/&/g, "and")]),
);

// Name -> code, for text such as "Karnataka" or "Tamil Nadu" (place of supply / state printed in a party block).
const NAME_TO_CODE: [string, string][] = [
  ...Object.entries(STATE_CODES).map(([code, name]) => [nameKey(name) as string, code] as [string, string]),
  ...Object.entries(NAME_ALIASES).map(([name, code]) => [nameKey(name) as string, code] as [string, string]),
];

// "Karnataka (29)", "29-Karnataka", "State Code: 29", "Karnataka": the two-digit code if one is printed, else the code of a state name.
export function stateCodeFromText(text: string | null | undefined): string | null {
  if (!text) return null;
  const printed = /\((\d{2})\)/.exec(text) ?? /(?:state\s*code|code)\s*[:\-]?\s*(\d{2})\b/i.exec(text) ?? /^\s*(\d{2})\b/.exec(text);
  if (printed) return STATE_CODES[printed[1]] ? printed[1] : null;
  const key = nameKey(text.replace(/&/g, " and ")); // "Daman & Diu" and "Daman and Diu" are the same name
  if (!key) return null;
  // Longest state name first, so "Andhra Pradesh" is not mistaken for something shorter.
  const hits = NAME_TO_CODE.filter(([n]) => key.includes(n)).sort((a, b) => b[0].length - a[0].length);
  return hits.length ? hits[0][1] : null;
}

// ---- Cleaning / PAN -----------------------------------------------------------------------------------------------------

const GSTIN_LABEL = /^\s*(?:gstin\s*\/\s*uin|gstin|gst\s*no\.?|gst\s*in|uin)\s*(?:no\.?|number|#)?\s*[:=\-\u2013\u2014]?\s*/i;
const PAN_LAYOUT = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

// Removes only what can never be part of a GSTIN: label, spaces, dashes, dots, colons, invisible characters. Upper-cases.
export function normGstin(raw: string): string {
  return raw.replace(GSTIN_LABEL, "").replace(/[\s\-\u2010-\u2015_.:;,|'"`()[\]{}<>\u200B-\u200D\u2060\uFEFF\u00AD]+/g, "").toUpperCase();
}

export function normPan(raw: string): string {
  return raw.replace(/^\s*(?:pan(?:\s*(?:no\.?|number|#))?)\s*[:=\-\u2013\u2014]?\s*/i, "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

export function isPanLayout(v: string): boolean {
  return PAN_LAYOUT.test(v);
}

export function gstinState(g: string): string | null {
  return /^\d{2}/.test(g) ? g.slice(0, 2) : null;
}

export function gstinPan(g: string): string | null {
  return g.length === 15 ? g.slice(2, 12) : null;
}

export function gstinIsValid(g: string): boolean {
  return checkGstin(g).ok && STATE_CODES[g.slice(0, 2)] !== undefined;
}

// ---- Voting ------------------------------------------------------------------------------------------------------------

export type GstinVoteStatus =
  | "unanimous" // every reading gave the same 15 characters
  | "majority" // most readings agree
  | "checksum_pick" // readings differ, exactly one distinct value passes layout + check digit
  | "char_vote" // no reading was right on its own; the character-by-character majority passes layout + check digit
  | "char_search" // a unique combination of characters that were really read passes layout + check digit
  | "conflict" // nothing could prove which value is right
  | "none"; // no reading gave a value

export interface GstinVote {
  value: string | null;
  status: GstinVoteStatus;
  distinct: string[]; // every distinct cleaned value that was read (most votes first)
  corrected: boolean; // the chosen value was not given as a whole by any reading
}

const MAX_COMBINATIONS = 4096;

// `values` are the cleaned GSTIN strings of the readings that gave one (readings without a value are not passed in).
export function voteGstin(values: string[]): GstinVote {
  const cleaned = values.map(normGstin).filter((v) => v !== "");
  if (cleaned.length === 0) return { value: null, status: "none", distinct: [], corrected: false };
  const tally = new Map<string, number>();
  for (const v of cleaned) tally.set(v, (tally.get(v) ?? 0) + 1);
  const distinct = Array.from(tally.entries()).sort((a, b) => b[1] - a[1]).map(([v]) => v);
  if (distinct.length === 1) return { value: distinct[0], status: "unanimous", distinct, corrected: false };

  // 1. Whole values: exactly one distinct value passes layout + check digit.
  const valid = distinct.filter(gstinIsValid);
  if (valid.length === 1) {
    // A check digit that passes is not proof by itself. If more readings of the document agree on a different value, that value
    // is what the document most likely prints (it may be a print error), so nothing is picked and the first reading stays.
    const votes = tally.get(valid[0]) ?? 0;
    const rivalVotes = Math.max(...distinct.filter((v) => v !== valid[0]).map((v) => tally.get(v) ?? 0));
    if (rivalVotes > votes) return { value: null, status: "conflict", distinct, corrected: false };
    return { value: valid[0], status: "checksum_pick", distinct, corrected: false };
  }
  if (valid.length > 1) {
    // Two different VALID numbers (e.g. supplier and buyer mixed up). Only a strict majority decides.
    const top = tally.get(valid[0]) ?? 0;
    const next = tally.get(valid[1]) ?? 0;
    return top > next ? { value: valid[0], status: "majority", distinct, corrected: false } : { value: null, status: "conflict", distinct, corrected: false };
  }

  // 2. No reading is valid on its own. Look at it character by character, but only over 15-character readings.
  const full = cleaned.filter((v) => v.length === 15);
  if (full.length >= 2) {
    const perPos: string[][] = [];
    let majorityString = "";
    for (let i = 0; i < 15; i++) {
      const t = new Map<string, number>();
      for (const v of full) t.set(v[i], (t.get(v[i]) ?? 0) + 1);
      const ranked = Array.from(t.entries()).sort((a, b) => b[1] - a[1]);
      perPos.push(ranked.map(([c]) => c));
      // A position with a tie has no majority character: the search below handles it.
      majorityString += ranked.length === 1 || ranked[0][1] > ranked[1][1] ? ranked[0][0] : "?";
    }
    if (!majorityString.includes("?") && gstinIsValid(majorityString)) {
      return { value: majorityString, status: "char_vote", distinct, corrected: true };
    }
    // Every combination of characters that were really read. Accepted only when exactly one passes.
    let combos = 1;
    for (const p of perPos) combos *= p.length;
    if (combos <= MAX_COMBINATIONS) {
      const found: string[] = [];
      const walk = (i: number, acc: string) => {
        if (found.length > 1) return;
        if (i === 15) {
          if (gstinIsValid(acc)) found.push(acc);
          return;
        }
        for (const c of perPos[i]) walk(i + 1, acc + c);
      };
      walk(0, "");
      if (found.length === 1) return { value: found[0], status: "char_search", distinct, corrected: !distinct.includes(found[0]) };
    }
  }

  // 3. Nothing proves anything. A strict majority of whole readings still wins; otherwise the caller keeps the first reading.
  const top = tally.get(distinct[0]) ?? 0;
  const next = tally.get(distinct[1]) ?? 0;
  if (top >= 2 && top > next) return { value: distinct[0], status: "majority", distinct, corrected: false };
  return { value: null, status: "conflict", distinct, corrected: false };
}

// ---- Evidence -----------------------------------------------------------------------------------------------------------

export type Tri = boolean | null; // true = confirms, false = contradicts, null = no evidence either way

export interface GstinEvidence {
  format_ok: boolean;
  checksum_ok: boolean;
  state_code_ok: boolean;
  pan_layout_ok: boolean;
  pan_printed_match: Tri; // printed PAN of this party equals characters 3-12
  state_printed_match: Tri; // state printed in this party block equals characters 1-2
  in_printed_list: Tri; // this GSTIN is among the GSTINs printed on the document
  role_match: Tri; // the role the readings saw next to it is this party's role
}

export type VerdictStatus =
  | "verified" // valid, enough independent witnesses, nothing contradicts it
  | "probable" // valid, but not enough independent witnesses or some evidence is missing
  | "unverified" // layout / check digit / state code fails, or it was read by a single reading only
  | "conflict" // evidence contradicts it (different PAN, wrong role, same as the other party, readings disagree)
  | "absent"; // no reading found one (normal for B2C invoices)

export interface GstinVerdict {
  field: "supplier_gstin" | "buyer_gstin";
  value: string | null;
  status: VerdictStatus;
  vote: GstinVoteStatus;
  witnesses: number; // readings + evidence that agree with `value`
  readings: number; // readings that took part (full readings + parties readings)
  agreeing: number; // readings that gave exactly `value`
  evidence: GstinEvidence | null;
  problems: string[]; // plain-language reasons why it is not "verified"
  distinct: string[];
}

type Role = "supplier" | "buyer";

function present(f: ModelField<string> | undefined): f is ModelField<string> & { value: string } {
  return !!f && f.status === "present" && typeof f.value === "string" && f.value.trim() !== "";
}

function printedEntries(parties: PartiesReading[]) {
  return parties.flatMap((p) => (p.printed_gstins ?? []).map((e) => ({ value: normGstin(e.value), role: e.role })));
}

export function evidenceFor(gstin: string, role: Role, parties: PartiesReading[]): GstinEvidence {
  const format_ok = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(gstin);
  const checksum_ok = checkGstin(gstin).ok;
  const state_code_ok = STATE_CODES[gstin.slice(0, 2)] !== undefined;
  const pan = gstinPan(gstin);
  const pan_layout_ok = pan !== null && isPanLayout(pan);

  // PAN printed for this party.
  const pans = parties.map((p) => (present(p[`${role}_pan` as const]) ? normPan((p[`${role}_pan` as const] as { value: string }).value) : null)).filter((x): x is string => !!x && isPanLayout(x));
  const pan_printed_match: Tri = pans.length === 0 || pan === null ? null : pans.every((x) => x === pan) ? true : pans.some((x) => x === pan) ? null : false;

  // State printed in this party block (supplier block: "State: Karnataka, Code 29"; buyer: only a clearly labelled state).
  const states = parties
    .map((p) => (role === "supplier" && present(p.supplier_state) ? stateCodeFromText(p.supplier_state.value) : null))
    .filter((x): x is string => !!x);
  const sc = gstinState(gstin);
  const state_printed_match: Tri = states.length === 0 || sc === null ? null : states.every((x) => x === sc) ? true : states.some((x) => x === sc) ? null : false;

  // The GSTIN must be among the printed ones, and carry this role (or an uncertain one).
  const entries = printedEntries(parties);
  const hits = entries.filter((e) => e.value === gstin);
  const in_printed_list: Tri = entries.length === 0 ? null : hits.length > 0;
  const roles = hits.map((h) => h.role).filter((r) => r === "supplier" || r === "buyer");
  const role_match: Tri = roles.length === 0 ? null : roles.every((r) => r === role) ? true : roles.every((r) => r !== role) ? false : null;

  return { format_ok, checksum_ok, state_code_ok, pan_layout_ok, pan_printed_match, state_printed_match, in_printed_list, role_match };
}

// Witness count: readings that gave exactly this value + one for every piece of independent evidence that confirms it.
// At least 3 witnesses and no contradiction = verified.
export const MIN_WITNESSES = 3;

export function judgeGstin(field: GstinVerdict["field"], role: Role, value: string | null, vote: GstinVote, allValues: string[], parties: PartiesReading[]): GstinVerdict {
  const readings = allValues.length;
  if (value === null || value === "") {
    // Nothing could be chosen. If readings gave values they disagree; otherwise the document simply has none.
    if (vote.distinct.length > 0) {
      return { field, value: null, status: "conflict", vote: vote.status, witnesses: 0, readings, agreeing: 0, evidence: null, problems: ["The readings gave different values and nothing could prove which is right."], distinct: vote.distinct };
    }
    return { field, value: null, status: "absent", vote: "none", witnesses: 0, readings, agreeing: 0, evidence: null, problems: [], distinct: [] };
  }
  const evidence = evidenceFor(value, role, parties);
  const agreeing = allValues.map(normGstin).filter((v) => v === value).length;
  let witnesses = agreeing;
  if (evidence.pan_printed_match === true) witnesses += 1;
  if (evidence.state_printed_match === true) witnesses += 1;
  if (evidence.in_printed_list === true && evidence.role_match !== false) witnesses += 1;

  const problems: string[] = [];
  let conflict = false;
  if (!evidence.format_ok) problems.push("The GSTIN layout is not valid (2 digits, 5 letters, 4 digits, 1 letter, 1 entity character, Z, check character).");
  else if (!evidence.checksum_ok) problems.push("The GSTIN check digit does not match.");
  if (evidence.format_ok && !evidence.state_code_ok) problems.push(`The state code ${value.slice(0, 2)} is not a valid GST state code.`);
  if (evidence.pan_printed_match === false) { problems.push("The PAN printed for this party differs from the PAN inside the GSTIN."); conflict = true; }
  if (evidence.state_printed_match === false) { problems.push("The state printed for this party differs from the state code of the GSTIN."); conflict = true; }
  if (evidence.role_match === false) { problems.push(`The document prints this GSTIN next to the ${role === "supplier" ? "buyer" : "supplier"}, not next to the ${role}.`); conflict = true; }
  if (evidence.in_printed_list === false) problems.push("This GSTIN was not found among the GSTINs printed on the document.");
  if (vote.status === "conflict" || (vote.distinct.length > 1 && vote.status === "majority")) problems.push("Some readings gave a different GSTIN.");
  if (vote.corrected) problems.push("No reading was fully right on its own; the value was assembled from the characters the readings agree on and passes the check digit.");

  const structural = evidence.format_ok && evidence.checksum_ok && evidence.state_code_ok;
  let status: VerdictStatus;
  if (conflict) status = "conflict";
  else if (!structural) status = "unverified";
  else if (witnesses >= MIN_WITNESSES && evidence.in_printed_list !== false) status = "verified"; // minority readings may differ: the evidence settles it
  else status = "probable";
  if (status === "probable" && witnesses < MIN_WITNESSES) problems.push(`Only ${witnesses} independent witness(es) confirm this GSTIN (3 are needed).`);
  return { field, value, status, vote: vote.status, witnesses, readings, agreeing, evidence, problems, distinct: vote.distinct };
}

// ---- Putting it together for the pipeline ------------------------------------------------------------------------------

export interface PartiesResolution {
  merged: ModelOutput;
  verdicts: { supplier_gstin: GstinVerdict; buyer_gstin: GstinVerdict };
  flags: ReviewFlag[];
  changed: ("supplier_gstin" | "buyer_gstin")[];
}

function valuesOf(key: "supplier_gstin" | "buyer_gstin", readings: ModelOutput[], parties: PartiesReading[]): string[] {
  const out: string[] = [];
  for (const r of readings) if (present(r[key])) out.push(r[key].value);
  for (const p of parties) if (present(p[key])) out.push(p[key].value);
  return out;
}

// Votes supplier and buyer GSTIN over ALL readings (character by character when needed), repairs a supplier / buyer mix-up that the
// printed roles prove, and judges each result with the evidence. `merged` is the output of the field vote in verify.ts.
export function resolveParties(readings: ModelOutput[], parties: PartiesReading[], merged: ModelOutput): PartiesResolution {
  const flags: ReviewFlag[] = [];
  const changed: ("supplier_gstin" | "buyer_gstin")[] = [];
  const out = JSON.parse(JSON.stringify(merged)) as ModelOutput;

  let supValues = valuesOf("supplier_gstin", readings, parties);
  let buyValues = valuesOf("buyer_gstin", readings, parties);
  let supVote = voteGstin(supValues);
  let buyVote = voteGstin(buyValues);

  // What the document prints next to each GSTIN. "supplier" / "buyer" only when EVERY printed occurrence says so.
  const entries = printedEntries(parties);
  const roleOf = (g: string | null): Role | "other" | null => {
    if (!g) return null;
    const roles = entries.filter((e) => e.value === g).map((e) => e.role);
    if (roles.length === 0) return null;
    if (roles.every((r) => r === "supplier")) return "supplier";
    if (roles.every((r) => r === "buyer")) return "buyer";
    return "other";
  };
  // Tie between valid numbers (for example two readings swapped, two not): the printed role breaks it, if it names exactly one.
  const byRole = (vote: GstinVote, role: Role): GstinVote => {
    if (vote.value !== null || vote.status !== "conflict") return vote;
    const cands = vote.distinct.filter(gstinIsValid).filter((g) => roleOf(g) === role);
    return cands.length === 1 ? { value: cands[0], status: "checksum_pick", distinct: vote.distinct, corrected: false } : vote;
  };
  supVote = byRole(supVote, "supplier");
  buyVote = byRole(buyVote, "buyer");

  // Mix-up repair. Only when the printed roles say so in every reading that shows the number, and both numbers are valid.
  let swapFlagged = false;
  const swapFlag = (): ReviewFlag => ({ code: "gstin_roles_swapped", severity: "warning", message: "The supplier and buyer GSTIN were swapped in the readings. The document prints each number next to the other party, so they were put back. Check the original.", details: {} });
  if (supVote.value && buyVote.value && gstinIsValid(supVote.value) && gstinIsValid(buyVote.value)) {
    if (supVote.value !== buyVote.value && roleOf(supVote.value) === "buyer" && roleOf(buyVote.value) === "supplier") {
      [supValues, buyValues] = [buyValues, supValues];
      [supVote, buyVote] = [buyVote, supVote];
      swapFlagged = true;
      flags.push({ ...swapFlag(), details: { supplier_gstin: supVote.value, buyer_gstin: buyVote.value } });
    }
  }
  // Same number as supplier and as buyer: one of them is a copy error. The printed list may name the right one.
  if (supVote.value && buyVote.value && supVote.value === buyVote.value) {
    const printedBuyer = entries.filter((e) => e.role === "buyer" && e.value !== supVote.value && gstinIsValid(e.value)).map((e) => e.value);
    const uniq = Array.from(new Set(printedBuyer));
    if (uniq.length === 1) {
      buyVote = { value: uniq[0], status: "checksum_pick", distinct: [uniq[0], ...buyVote.distinct], corrected: false };
      buyValues = [...buyValues, uniq[0]];
      flags.push({ code: "gstin_roles_swapped", severity: "warning", field: "buyer_gstin", message: "The buyer GSTIN was the same as the supplier GSTIN. The buyer GSTIN printed in the bill-to block was used instead. Check the original.", details: { buyer_gstin: uniq[0] } });
    }
  }

  const apply = (key: "supplier_gstin" | "buyer_gstin", vote: GstinVote) => {
    if (vote.value === null) return;
    const old = out[key];
    const before = present(old) ? normGstin(old.value) : null;
    if (before === vote.value) return;
    // A GSTIN that no reading produced as a whole (character vote / search) is a guess built from pieces. It is never saved: the
    // first reading stays exactly as read and the assembled number is only offered to the reviewer in a warning.
    if (vote.corrected || vote.status === "char_vote" || vote.status === "char_search") {
      flags.push({
        code: "gstin_char_proposed", severity: "warning", field: key,
        message: `No reading gave this GSTIN as a whole, so it was not applied. A possible value built from the characters the readings agree on is ${vote.value}. Compare it with the original.`,
        details: { proposed: vote.value, kept: before, read_as: vote.distinct, method: vote.status },
      });
      return;
    }
    // Confidence of the new value = the lowest confidence among the readings that gave exactly this value (never raised).
    const confs = [...readings.map((r) => r[key]), ...parties.map((p) => p[key])].filter(present).filter((f) => normGstin(f.value) === vote.value).map((f) => f.confidence);
    const confidence = confs.length ? Math.min(...confs) : Math.min(old.confidence, 0.6);
    out[key] = { status: "present", value: vote.value, confidence };
    changed.push(key);
    if (before !== null) {
      flags.push({
        code: "gstin_vote_corrected", severity: "info", field: key,
        message: "The GSTIN of the first pass was replaced by the value the other readings and the printed evidence support (valid layout and check digit).",
        details: { from: before, to: vote.value, method: vote.status, read_as: vote.distinct },
      });
    }
  };
  const oldSup = present(out.supplier_gstin) ? normGstin(out.supplier_gstin.value) : null;
  const oldBuy = present(out.buyer_gstin) ? normGstin(out.buyer_gstin.value) : null;
  apply("supplier_gstin", supVote);
  apply("buyer_gstin", buyVote);
  // The vote itself put the two numbers back in their places (the first reading had them swapped).
  const newSup = present(out.supplier_gstin) ? normGstin(out.supplier_gstin.value) : null;
  const newBuy = present(out.buyer_gstin) ? normGstin(out.buyer_gstin.value) : null;
  if (!swapFlagged && oldSup && oldBuy && oldSup !== oldBuy && newSup === oldBuy && newBuy === oldSup) {
    flags.push({ ...swapFlag(), details: { supplier_gstin: newSup, buyer_gstin: newBuy } });
  }
  // The first pass had the supplier's number as the buyer's too, and the vote gave the buyer its own number back.
  if (!swapFlagged && oldSup && oldBuy && oldSup === oldBuy && newBuy !== null && newBuy !== newSup) {
    flags.push({ code: "gstin_roles_swapped", severity: "warning", field: "buyer_gstin", message: "The buyer GSTIN was the same as the supplier GSTIN. The buyer GSTIN printed in the bill-to block was used instead. Check the original.", details: { buyer_gstin: newBuy } });
  }

  const verdicts = {
    supplier_gstin: judgeGstin("supplier_gstin", "supplier", present(out.supplier_gstin) ? normGstin(out.supplier_gstin.value) : null, supVote, supValues, parties),
    buyer_gstin: judgeGstin("buyer_gstin", "buyer", present(out.buyer_gstin) ? normGstin(out.buyer_gstin.value) : null, buyVote, buyValues, parties),
  };
  if (verdicts.supplier_gstin.value && verdicts.buyer_gstin.value && verdicts.supplier_gstin.value === verdicts.buyer_gstin.value) {
    for (const v of [verdicts.supplier_gstin, verdicts.buyer_gstin]) {
      v.status = "conflict";
      v.problems.push("The supplier and buyer GSTIN are the same number.");
    }
  }
  return { merged: out, verdicts, flags, changed };
}

// Is `name` (voted) compatible with what the blind parties readings read? Used by final-audit.ts as independent evidence.
export function namesCompatible(a: string | null, b: string | null): boolean | null {
  const x = nameKey(a);
  const y = nameKey(b);
  if (!x || !y) return null;
  if (x === y) return true;
  const [s, l] = x.length <= y.length ? [x, y] : [y, x];
  return s.length >= 5 && l.includes(s); // "Acme Traders" vs "Acme Traders Pvt Ltd"
}
