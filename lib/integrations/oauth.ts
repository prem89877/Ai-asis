// Small OAuth helpers shared by Google and Microsoft: PKCE (RFC 7636), single-use state, id_token email.
import { createHash, randomBytes } from "node:crypto";

export function newState(): string { return randomBytes(32).toString("base64url"); }
export function newCodeVerifier(): string { return randomBytes(48).toString("base64url"); } // 64 characters
export function codeChallenge(verifier: string): string { return createHash("sha256").update(verifier).digest("base64url"); }
// Only the hash of the state is stored, so a database read cannot be replayed against the callback.
export function hashState(state: string): string { return createHash("sha256").update(state).digest("hex"); }

export interface IdTokenClaims { email: string | null }

// Reads the e-mail from an id_token received directly from the provider's token endpoint over TLS.
// It is used only as a display label ("connected as ..."), never for authorisation, so the signature is not verified here.
export function readIdTokenClaims(idToken: string | undefined | null): IdTokenClaims {
  try {
    if (!idToken) return { email: null };
    const payload = idToken.split(".")[1];
    if (!payload) return { email: null };
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
    const raw = typeof claims.email === "string" ? claims.email : typeof claims.preferred_username === "string" ? claims.preferred_username : null;
    return { email: raw && raw.length <= 254 && raw.includes("@") ? raw : null };
  } catch {
    return { email: null };
  }
}
