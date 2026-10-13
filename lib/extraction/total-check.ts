// Grand total: multi-layer confirmation, the same idea as the GSTIN check digit but for money.
//
// A grand total is accepted with confidence only when several INDEPENDENT witnesses agree on it:
//   - each AI reading of the document (first, second, audit reading, key-figures reading),
//   - the amount in words printed on the invoice, turned into a number here in code (a second, separate print of the total),
//   - the invoice arithmetic (taxable + taxes + TCS - TDS +/- round-off, see gst-engine.ts).
// Rules (nothing is invented, the AI never gets the last word):
//   - The value the readings vote already chose (`merged`) stays unless another value has at least 3 witnesses AND more witnesses.
//   - A value with fewer than 2 witnesses is flagged for a person to compare with the original.
//   - A total that disagrees with the printed amount in words is flagged.
import { validateInvoiceTotals } from "./gst-engine.ts";
import { normalizeExtraction, toPaise } from "./normalize.ts";
import type { CheckOptions } from "./checks.ts";
import type { ModelField, ModelOutput, ReviewFlag } from "./types.ts";

// ---- Amount in words -> number ------------------------------------------------------------------------------------------

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const SCALES: Record<string, number> = {
  thousand: 1_000, lakh: 100_000, lakhs: 100_000, lac: 100_000, lacs: 100_000, crore: 10_000_000, crores: 10_000_000,
  million: 1_000_000, millions: 1_000_000, billion: 1_000_000_000,
};
const CURRENCY_WORDS = new Set(["rupees", "rupee", "rs", "inr", "indian", "dollars", "dollar", "usd", "us", "euro", "euros", "eur", "pounds", "pound", "gbp", "currency"]);
const MINOR_WORDS = new Set(["paise", "paisa", "cents", "cent"]);
const IGNORE = new Set(["only", "and", "of", "the", "a", "no", "nil"]);

// Words of one whole number ("one lakh twenty three thousand four hundred") -> number, or null if a word is not understood.
function numberFromWords(tokens: string[]): number | null {
  let total = 0;
  let current = 0;
  let seen = false;
  for (const t of tokens) {
    if (t in UNITS) { current += UNITS[t]; seen = true; }
    else if (t in TENS) { current += TENS[t]; seen = true; }
    else if (t === "hundred") { current = (current === 0 ? 1 : current) * 100; seen = true; }
    else if (t in SCALES) { total += (current === 0 ? 1 : current) * SCALES[t]; current = 0; seen = true; }
    else return null;
  }
  return seen ? total + current : null;
}

export interface WordsAmount {
  value: number; // INR (or the invoice currency), with paise
  hasMinor: boolean; // the words state paise / cents, so the figure is exact to the paisa
}

// "Rupees One Thousand One Hundred Eighty Only", "One Lakh Rupees and Fifty Paise Only", "INR Five Hundred Only" ...
// Returns null when anything is not understood: the words check is then simply skipped, never guessed.
export function parseAmountInWords(raw: string | null | undefined): WordsAmount | null {
  if (typeof raw !== "string") return null;
  if (/[0-9]/.test(raw)) return null;
  const tokens = raw.toLowerCase().replace(/&/g, " and ").split(/[^a-z]+/).filter(Boolean);
  if (tokens.length === 0) return null;

  let rupeeTokens: string[] = [];
  let minorTokens: string[] = [];
  const minorAt = tokens.findIndex((t) => MINOR_WORDS.has(t));
  const body = minorAt >= 0 ? tokens.slice(0, minorAt) : tokens;
  const afterMinor = minorAt >= 0 ? tokens.slice(minorAt + 1) : [];
  if (afterMinor.some((t) => !IGNORE.has(t))) return null;

  if (minorAt >= 0) {
    const cur = body.findIndex((t) => CURRENCY_WORDS.has(t));
    const nums = (arr: string[]) => arr.filter((t) => !CURRENCY_WORDS.has(t) && !IGNORE.has(t));
    if (cur >= 0 && body.slice(0, cur).some((t) => t in UNITS || t in TENS || t === "hundred" || t in SCALES)) {
      // "<rupees> Rupees <paise> Paise": the currency word sits between the two numbers
      rupeeTokens = nums(body.slice(0, cur));
      minorTokens = nums(body.slice(cur + 1));
    } else {
      // "Rupees <rupees> and <paise> Paise": split at the last "and"
      const andAt = body.lastIndexOf("and");
      if (andAt < 0) return null;
      rupeeTokens = nums(body.slice(0, andAt));
      minorTokens = nums(body.slice(andAt + 1));
    }
  } else {
    rupeeTokens = body.filter((t) => !CURRENCY_WORDS.has(t) && !IGNORE.has(t));
  }

  const rupees = rupeeTokens.length === 0 && minorAt >= 0 ? 0 : numberFromWords(rupeeTokens);
  if (rupees === null) return null;
  let minor = 0;
  if (minorAt >= 0) {
    const m = numberFromWords(minorTokens);
    if (m === null || m < 0 || m > 99) return null;
    minor = m;
  }
  return { value: Math.round((rupees + minor / 100) * 100) / 100, hasMinor: minorAt >= 0 };
}

// ---- Consensus ------------------------------------------------------------------------------------------------------------

export type ReadingSource = "first" | "second" | "audit" | "keyfigures";

export interface ReadingTotal {
  source: ReadingSource;
  total: ModelField<number> | undefined;
  words: ModelField<string> | undefined;
}

export interface TotalCandidate {
  value: number;
  witnesses: string[]; // reading names, "words", "arithmetic"
}

export type TotalStatus = "confirmed" | "supported" | "corrected" | "unconfirmed" | "single_reading" | "no_value";

export interface GrandTotalVerdict {
  status: TotalStatus;
  field: ModelField<number> | null; // value to store, null when no reading had a total
  candidates: TotalCandidate[];
  witnessCount: number; // witnesses of the final value
  wordsValue: number | null;
  wordsMatch: boolean | null; // null when the words were absent or could not be understood
  flags: ReviewFlag[];
}

const WORDS_EXACT_PAISE = 1; // words that state paise must match to the paisa
const WORDS_NO_PAISE_PAISE = 99; // words without paise ignore the fraction of the printed total

function presentNumber(f: ModelField<number> | undefined): f is ModelField<number> & { value: number } {
  return !!f && f.status === "present" && typeof f.value === "number" && Number.isFinite(f.value);
}

export function resolveGrandTotal(readings: ReadingTotal[], merged: ModelOutput, opts: CheckOptions): GrandTotalVerdict {
  const byPaise = new Map<number, { cand: TotalCandidate; conf: number }>();
  for (const r of readings) {
    if (!presentNumber(r.total)) continue;
    const key = toPaise(r.total.value);
    const hit = byPaise.get(key) ?? { cand: { value: r.total.value, witnesses: [] }, conf: 1 };
    hit.cand.witnesses.push(r.source);
    hit.conf = Math.min(hit.conf, r.total.confidence);
    byPaise.set(key, hit);
  }
  const entries = Array.from(byPaise.values());
  // The value chosen so far (first reading, or the value the field-by-field vote settled on) is the one to beat.
  const firstPaise = presentNumber(merged.grand_total) ? toPaise(merged.grand_total.value) : null;

  // Amount in words: the most frequent understood reading of the words is one more witness.
  const parsedWords = readings
    .map((r) => (r.words && r.words.status === "present" ? parseAmountInWords(r.words.value) : null))
    .filter((w): w is WordsAmount => w !== null);
  let words: WordsAmount | null = null;
  let wordsVotes = 0; // how many readings gave these same words
  if (parsedWords.length > 0) {
    const tally = new Map<number, number>();
    for (const w of parsedWords) tally.set(toPaise(w.value), (tally.get(toPaise(w.value)) ?? 0) + 1);
    const [top, votes] = Array.from(tally.entries()).sort((a, b) => b[1] - a[1])[0];
    words = parsedWords.find((w) => toPaise(w.value) === top) ?? null;
    wordsVotes = votes;
  }
  const wordsTol = (w: WordsAmount) => (w.hasMinor ? WORDS_EXACT_PAISE : WORDS_NO_PAISE_PAISE);
  const matchesWords = (value: number): boolean => words !== null && Math.abs(toPaise(value) - toPaise(words.value)) < wordsTol(words);

  if (entries.length === 0) {
    return { status: "no_value", field: null, candidates: [], witnessCount: 0, wordsValue: words ? words.value : null, wordsMatch: null, flags: [] };
  }

  // Witnesses that are not AI readings.
  for (const { cand } of entries) {
    if (matchesWords(cand.value)) cand.witnesses.push("words");
    const probe = JSON.parse(JSON.stringify(merged)) as ModelOutput;
    probe.grand_total = { status: "present", value: cand.value, confidence: 1 };
    const n = normalizeExtraction(probe, { model: "total-check" });
    const t = validateInvoiceTotals(n.extracted, n.items, { tolerancePaise: opts.tolerancePaise });
    if (t.passed === true) cand.witnesses.push("arithmetic");
  }

  const rank = (c: TotalCandidate): number[] => [
    c.witnesses.length,
    firstPaise !== null && toPaise(c.value) === firstPaise ? 1 : 0,
    c.witnesses.includes("arithmetic") ? 1 : 0,
  ];
  const sorted = [...entries].sort((a, b) => {
    const ra = rank(a.cand), rb = rank(b.cand);
    for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return rb[i] - ra[i];
    return 0;
  });
  const best = sorted[0];
  const firstEntry = firstPaise !== null ? byPaise.get(firstPaise) ?? null : null;

  let final = best;
  let corrected = false;
  if (firstEntry && best !== firstEntry) {
    if (best.cand.witnesses.length >= 3 && best.cand.witnesses.length > firstEntry.cand.witnesses.length) {
      corrected = true;
    } else {
      final = firstEntry;
    }
  } else if (!firstEntry && best.cand.witnesses.length < 2) {
    // The first reading had no total and nothing else supports a value: leave the merged value as the vote decided.
    final = best;
  }

  const count = final.cand.witnesses.length;
  const aiReadings = readings.length;
  const flags: ReviewFlag[] = [];
  const candidates = sorted.map((e) => ({ value: e.cand.value, witnesses: e.cand.witnesses }));

  if (corrected) {
    flags.push({
      code: "grand_total_corrected", severity: "info", field: "grand_total",
      message: `The grand total was corrected after cross-checking ${aiReadings} readings, the printed amount in words and the invoice arithmetic.`,
      details: { before: firstEntry ? firstEntry.cand.value : null, corrected: final.cand.value, witnesses: final.cand.witnesses },
    });
  }
  const unconfirmed = count < 2 && aiReadings >= 2;
  if (unconfirmed) {
    flags.push({
      code: "grand_total_unconfirmed", severity: "warning", field: "grand_total",
      message: "The grand total could not be confirmed: the readings gave different values and neither the amount in words nor the invoice arithmetic supports it. Compare it with the original.",
      details: { candidates },
    });
  }
  let wordsMatch: boolean | null = null;
  if (words !== null) {
    wordsMatch = matchesWords(final.cand.value);
    if (!wordsMatch) {
      flags.push({
        // Two readings that both read the same different words probably mean the invoice itself prints figures and words differently.
        code: "grand_total_words_mismatch", severity: count >= 3 && wordsVotes < 2 ? "info" : "warning", field: "grand_total",
        message: "The grand total in figures and the amount in words printed on the invoice do not match. Check the original.",
        details: { figures: final.cand.value, words: words.value },
      });
    }
  }

  const status: TotalStatus = unconfirmed ? "unconfirmed" : corrected ? "corrected" : count >= 3 ? "confirmed" : aiReadings < 2 && words === null ? "single_reading" : "supported";
  const agreeing = readings.filter((r) => presentNumber(r.total) && toPaise(r.total.value) === toPaise(final.cand.value));
  const conf = Math.min(...agreeing.map((r) => (r.total as ModelField<number>).confidence), unconfirmed ? 0.5 : 1);
  return {
    status,
    field: { status: "present", value: final.cand.value, confidence: Math.round(conf * 1000) / 1000 },
    candidates,
    witnessCount: count,
    wordsValue: words ? words.value : null,
    wordsMatch,
    flags,
  };
}
