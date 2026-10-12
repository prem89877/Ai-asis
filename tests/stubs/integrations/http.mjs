// MOCK of lib/integrations/http (the real file was not available when these tests were written; see docs/PHASE6_PART2_RELEASE.md).
export class IntegrationError extends Error {
  constructor(code, status = 0, message = code) { super(message); this.name = "IntegrationError"; this.code = code; this.status = status; }
}
const TEXT = {
  auth_expired: "Your connection has expired or was revoked. Reconnect your account.",
  rate_limited: "The provider is limiting requests. Wait a minute and try again.",
  timeout: "The provider took too long to answer. Try again.",
};
export function userMessage(e) {
  if (e instanceof IntegrationError) return { code: e.code, message: TEXT[e.code] ?? "The provider returned an error. Try again." };
  return { code: "unknown", message: "Something went wrong. Try again." }; // never echoes e.message
}
