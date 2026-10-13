// Encryption of stored cloud tokens (AES-256-GCM). The key lives only in the server environment variable
// INTEGRATION_ENCRYPTION_KEY (32 random bytes, base64). Every secret is bound to an "owner" string (AAD, for example
// "<firm id>:<provider>"), so a token copied to another firm's row cannot be decrypted there.
// Token format: v1.<iv>.<auth tag>.<ciphertext>, each part base64url. Never log the key, the plaintext or the token.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

type Env = Record<string, string | undefined>;
const VERSION = "v1";

export interface Keys { current: Buffer; previous: Buffer | null }

function parseKey(raw: string | undefined, name: string): Buffer {
  if (!raw) throw new Error(`${name} is not set`);
  const key = Buffer.from(raw.trim(), "base64");
  if (key.length !== 32) throw new Error(`${name} must be 32 bytes encoded as base64`);
  return key;
}

export function loadKeys(env: Env = process.env): Keys {
  const current = parseKey(env.INTEGRATION_ENCRYPTION_KEY, "INTEGRATION_ENCRYPTION_KEY");
  const previous = env.INTEGRATION_ENCRYPTION_KEY_PREVIOUS ? parseKey(env.INTEGRATION_ENCRYPTION_KEY_PREVIOUS, "INTEGRATION_ENCRYPTION_KEY_PREVIOUS") : null;
  return { current, previous };
}

export function isEncryptionConfigured(env: Env = process.env): boolean {
  try { loadKeys(env); return true; } catch { return false; }
}

export function encryptSecret(plain: string, aad: string, env: Env = process.env): string {
  const { current } = loadKeys(env);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", current, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [VERSION, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
}

function tryDecrypt(parts: string[], key: Buffer, aad: string): string | null {
  try {
    const iv = Buffer.from(parts[1], "base64url");
    const tag = Buffer.from(parts[2], "base64url");
    const body = Buffer.from(parts[3], "base64url");
    if (iv.length !== 12 || tag.length !== 16) return null;
    const d = createDecipheriv("aes-256-gcm", key, iv);
    d.setAAD(Buffer.from(aad, "utf8"));
    d.setAuthTag(tag);
    return Buffer.concat([d.update(body), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}

// Returns the plaintext, or null when the token is junk, was tampered with, belongs to another owner, or the key is wrong.
export function decryptSecret(token: string | null | undefined, aad: string, env: Env = process.env): string | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) return null;
  let keys: Keys;
  try { keys = loadKeys(env); } catch { return null; }
  return tryDecrypt(parts, keys.current, aad) ?? (keys.previous ? tryDecrypt(parts, keys.previous, aad) : null);
}
