// ONE table of GST state / UT codes, shared by review/gst.ts, extraction/tax-math.ts, extraction/gst-engine.ts and
// extraction/party-check.ts. Before this each of them kept its own copy and the copies had drifted (code 25 was missing in
// two of them, and "Daman and Diu" mapped to 25 in one file and to 26 in another). Change a state here, nowhere else.

// GST state / UT codes (first two digits of a GSTIN and the code printed after the place of supply).
export const STATE_NAMES: Record<string, string> = {
  "01": "Jammu & Kashmir", "02": "Himachal Pradesh", "03": "Punjab", "04": "Chandigarh", "05": "Uttarakhand",
  "06": "Haryana", "07": "Delhi", "08": "Rajasthan", "09": "Uttar Pradesh", "10": "Bihar", "11": "Sikkim",
  "12": "Arunachal Pradesh", "13": "Nagaland", "14": "Manipur", "15": "Mizoram", "16": "Tripura", "17": "Meghalaya",
  "18": "Assam", "19": "West Bengal", "20": "Jharkhand", "21": "Odisha", "22": "Chhattisgarh", "23": "Madhya Pradesh",
  "24": "Gujarat", "25": "Daman & Diu", "26": "Dadra & Nagar Haveli and Daman & Diu", "27": "Maharashtra", "28": "Andhra Pradesh (old)",
  "29": "Karnataka", "30": "Goa", "31": "Lakshadweep", "32": "Kerala", "33": "Tamil Nadu", "34": "Puducherry",
  "35": "Andaman & Nicobar Islands", "36": "Telangana", "37": "Andhra Pradesh", "38": "Ladakh",
  "96": "Foreign country", "97": "Other territory", "99": "Centre jurisdiction",
};

// Extra spellings that people print on invoices. "Daman and Diu" is the old code 25; "Dadra and Nagar Haveli" and the merged
// UT are 26. Code 25 and 26 are ONE Union Territory since 2020, see sameStateCode().
export const NAME_ALIASES: Record<string, string> = {
  "orissa": "21", "pondicherry": "34", "uttaranchal": "05", "chattisgarh": "22", "jammu and kashmir": "01",
  "andaman and nicobar islands": "35", "andaman and nicobar": "35", "dadra and nagar haveli": "26", "daman and diu": "25",
  "dadra and nagar haveli and daman and diu": "26", "new delhi": "07", "nct of delhi": "07", "delhi ncr": "07",
};

// Union Territories WITHOUT a legislature charge UTGST instead of SGST: Chandigarh 04, Daman & Diu 25 (old code),
// Dadra & Nagar Haveli and Daman & Diu 26, Lakshadweep 31, Andaman & Nicobar 35, Ladakh 38.
// Delhi 07, Puducherry 34 and Jammu & Kashmir 01 have a legislature and charge SGST.
export const UTGST_STATE_CODES: ReadonlySet<string> = new Set(["04", "25", "26", "31", "35", "38"]);

// Codes that are not a state (exports, other territory): no intra / inter state rule is applied to them.
export const NO_STATE_CODES: ReadonlySet<string> = new Set(["96", "97"]);

// Code 25 (Daman & Diu) was merged into 26 in 2020, but older GSTINs and invoices still carry 25. A supply between the two
// is a supply inside one UT, so every intra / inter state decision compares the canonical codes.
export function canonicalStateCode(code: string): string {
  return code === "25" ? "26" : code;
}

export function sameStateCode(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && canonicalStateCode(a) === canonicalStateCode(b);
}

// Two digits at the start of a GSTIN, or the code printed in a place of supply ("Karnataka (29)", "29-Karnataka").
// No validation: a code that is not in the table is still returned (callers that need a valid code use stateCodeFromGstin).
export function rawStateCode(text: string | null | undefined, kind: "gstin" | "place"): string | null {
  const t = text?.trim();
  if (!t) return null;
  const m = kind === "gstin" ? /^(\d{2})/.exec(t) : /\((\d{2})\)/.exec(t) ?? /^(\d{2})\b/.exec(t);
  return m ? m[1] : null;
}

// A supply to a Special Economic Zone is ALWAYS an inter-state supply (IGST), even when the SEZ unit is in the supplier's own
// state (IGST Act s.7(5)). The extraction has no SEZ field, so it is read from what the invoice prints: "SEZ" or
// "Special Economic Zone" in the place of supply or in the buyer's name. Nothing is guessed from the GSTIN.
export function isSezSupply(e: { place_of_supply?: string | null; buyer_name?: string | null }): boolean {
  const re = /\bsez\b|special\s+economic\s+zone/i;
  return re.test(e.place_of_supply ?? "") || re.test(e.buyer_name ?? "");
}

// One place for the intra / inter decision. `null` = cannot be decided (a code is missing, or exports / other territory).
export function isIntraStateSupply(supplierState: string | null, placeState: string | null, sez: boolean): boolean | null {
  if (!supplierState || !placeState || NO_STATE_CODES.has(placeState)) return null;
  if (sez) return false;
  return sameStateCode(supplierState, placeState);
}
