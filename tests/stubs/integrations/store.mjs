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
