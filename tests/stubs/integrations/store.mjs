// MOCK of lib/integrations/store: records calls instead of touching a database or decrypting anything.
export async function getAccessToken(admin, conn) {
  const h = globalThis.__h.integ;
  h.calls.push(["getAccessToken", conn.id]);
  if (h.tokenError) throw h.tokenError;
  return "mock-access-token";
}
export function makeLedger(admin, conn, onFail) { globalThis.__h.integ.onFail = onFail; return { claim: async () => ({ kind: "claimed" }), finish: async () => {} }; }
export async function markNeedsReauth(admin, conn) { globalThis.__h.integ.calls.push(["markNeedsReauth", conn.id]); }
export async function recordConnectionError(admin, conn, message) { globalThis.__h.integ.calls.push(["recordConnectionError", conn.id, message]); }
export const isZohoProvider = (p) => p === "zoho_sheet" || p === "zoho_books";
export const isOAuthProvider = (p) => ["google_sheets", "microsoft_excel", "zoho_sheet", "zoho_books"].includes(p);
export function readTallySecret() { return globalThis.__h.integ.tallySecret ?? null; }
