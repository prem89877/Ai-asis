import test from "node:test";
import assert from "node:assert/strict";
import { checkGstin, gstinChecksumChar, gstinKind } from "../lib/extraction/normalize.ts";
import { rawStateCode } from "../lib/gst/states.ts";

const withCheck = (first14) => first14 + gstinChecksumChar(first14);

test("regular GSTIN still needs Z in position 14", () => {
  assert.equal(checkGstin(withCheck("29ABCDE1234F1Z")).ok, true);
  assert.equal(checkGstin(withCheck("29ABCDE1234F1X")).ok, false);
});

test("TDS and TCS ids (14th character D / C) are accepted", () => {
  const tds = withCheck("07DELD01234C1D");
  const tcs = withCheck("07DELD01234C1C");
  assert.equal(gstinKind(tds), "tds");
  assert.equal(gstinKind(tcs), "tcs");
  assert.equal(checkGstin(tds).ok, true);
  assert.equal(checkGstin(tcs).ok, true);
  assert.deepEqual(checkGstin(tcs.slice(0, 14) + (tcs[14] === "A" ? "B" : "A")), { ok: false, reason: "checksum" });
});

test("UIN layout is accepted (layout only)", () => {
  assert.equal(gstinKind("0717UNO00044UNK"), "uin");
  assert.equal(checkGstin("0717UNO00044UNK").ok, true);
});

test("stateOf ignores leading whitespace", () => {
  assert.equal(rawStateCode("  29ABCDE1234F1Z5", "gstin"), "29");
  assert.equal(rawStateCode("\n 27 - Maharashtra", "place"), "27");
});
