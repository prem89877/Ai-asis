// Static security audit, run as a test so it keeps running on every `npm test`. It reads source files only.
// It is a safety net, not a proof: it catches the common mistakes (committed secrets, a route without a session check,
// a mutating route without the same-origin check, a tenant query without a firm filter, server code in a browser bundle).
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "out"]);
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}
const rel = (p) => path.relative(ROOT, p).split(path.sep).join("/");
const files = walk(ROOT);
const read = (p) => readFileSync(p, "utf8");
const TEXT = /\.(ts|tsx|mjs|js|json|md|sql|css|yml|yaml|toml|example|env)$/i;

test("no real secrets are committed (API keys, JWTs, private keys, OAuth secrets)", () => {
  const patterns = [
    [/AIza[0-9A-Za-z_-]{35}/, "Google API key"],
    [/GOCSPX-[0-9A-Za-z_-]{20,}/, "Google OAuth client secret"],
    [/\bsk-[A-Za-z0-9_-]{24,}/, "secret API key (sk-...)"],
    [/\bsb_secret_[A-Za-z0-9_-]{16,}/, "Supabase secret key"],
    [/eyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}/, "JWT (e.g. Supabase anon or service_role key)"],
    [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, "private key"],
    [/\b(?:ghp|gho|github_pat)_[A-Za-z0-9_]{20,}/, "GitHub token"],
    [/\bAKIA[0-9A-Z]{16}\b/, "AWS access key"],
  ];
  const hits = [];
  for (const f of files) {
    if (!TEXT.test(f) && !path.basename(f).startsWith(".env")) continue;
    const text = read(f);
    for (const [re, label] of patterns) if (re.test(text)) hits.push(`${rel(f)}: ${label}`);
  }
  assert.deepEqual(hits, []);
});

test("no real .env file is in the project folder, and .gitignore keeps every .env file out of git except .env.example", () => {
  const envFiles = files.map(rel).filter((f) => /(^|\/)\.env(\..+)?$/.test(f) && !f.endsWith(".env.example"));
  assert.deepEqual(envFiles, [], "remove local env files before zipping or committing");
  const ignore = read(path.join(ROOT, ".gitignore")).split(/\r?\n/).map((l) => l.trim());
  assert.ok(ignore.includes(".env") || ignore.includes(".env*"), ".gitignore must ignore plain .env files");
  assert.ok(ignore.includes(".env*.local") || ignore.includes(".env*"), ".gitignore must ignore .env.local");
  assert.ok(ignore.includes("node_modules"));
});

test("only harmless values use the NEXT_PUBLIC_ prefix (it is copied into every browser)", () => {
  const names = new Set();
  for (const f of files) if (/\.(ts|tsx|mjs|example)$/.test(f) || f.endsWith(".env.example")) for (const m of read(f).matchAll(/NEXT_PUBLIC_[A-Z0-9_]+/g)) names.add(m[0]);
  const allowed = new Set(["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "NEXT_PUBLIC_SITE_URL", "NEXT_PUBLIC_GOOGLE_AUTH_ENABLED"]);
  const unexpected = [...names].filter((n) => !allowed.has(n));
  assert.deepEqual(unexpected, [], "a new NEXT_PUBLIC_ variable must be reviewed: it is public");
});

test("browser components never import server-only code or read server secrets", () => {
  const serverOnly = [/lib\/supabase\/admin/, /lib\/integrations\/(store|crypto|oauth|google|microsoft|sync|route-helpers)/, /lib\/billing\/server/, /lib\/export\/run/, /lib\/extraction\/(gemini|pipeline|config)/];
  const secrets = /SUPABASE_SERVICE_ROLE_KEY|GEMINI_API_KEY|INTEGRATION_ENCRYPTION_KEY|OAUTH_CLIENT_SECRET/;
  const bad = [];
  for (const f of files.filter((x) => /\.(tsx?|jsx?)$/.test(x) && !rel(x).startsWith("tests/"))) {
    const text = read(f);
    if (!/^\s*["']use client["']/m.test(text.slice(0, 200))) continue;
    for (const re of serverOnly) if (re.test(text)) bad.push(`${rel(f)} imports ${re}`);
    if (secrets.test(text)) bad.push(`${rel(f)} mentions a server secret`);
  }
  assert.deepEqual(bad, []);
});

// Routes that are intentionally reachable without a normal app session. Each entry needs a reason.
const PUBLIC_ROUTES = {
  "app/auth/callback/route.ts": "Supabase email/OAuth sign-in landing; code exchange is the authentication; redirect target is sanitised",
};
const routeFiles = files.filter((f) => /\/route\.ts$/.test(f) && (rel(f).startsWith("app/api/") || rel(f).startsWith("app/auth/")));

test("every API route authenticates the caller (guard, session lookup or the connection helper)", () => {
  const missing = [];
  for (const f of routeFiles) {
    const r = rel(f);
    if (PUBLIC_ROUTES[r]) continue;
    const t = read(f);
    if (!/\bguard\(|managerWithConnection\(|auth\.getUser\(|getPrimaryMembership\(/.test(t)) missing.push(r);
  }
  assert.deepEqual(missing, [], "add an auth check, or list the route in PUBLIC_ROUTES with a reason");
  assert.ok(routeFiles.length >= 20, "route discovery works");
});

test("every route that changes data checks the Origin header (CSRF defence), directly or through guard/managerWithConnection", () => {
  const missing = [];
  for (const f of routeFiles) {
    const r = rel(f);
    const t = read(f);
    const mutating = /export\s+async\s+function\s+(POST|PUT|PATCH|DELETE)\b/.test(t);
    if (!mutating) continue;
    const ok = /mutating:\s*true/.test(t) || /isSameOrigin\(/.test(t) || /managerWithConnection\([^)]*,\s*true\s*\)/.test(t);
    if (!ok) missing.push(r);
  }
  assert.deepEqual(missing, []);
});

test("GET routes that start a state change are limited to the OAuth callback (state + PKCE protected)", () => {
  const risky = [];
  for (const f of routeFiles) {
    const r = rel(f);
    const t = read(f);
    const start = t.search(/export\s+async\s+function\s+GET\b/);
    if (start === -1) continue;
    const next = t.slice(start + 10).search(/export\s+async\s+function\s/);
    const body = next === -1 ? t.slice(start) : t.slice(start, start + 10 + next);
    if (/\.(insert|update|delete|upsert)\(/.test(body) && !/oauth\/\[provider\]\/callback|auth\/callback/.test(r)) risky.push(r);
  }
  assert.deepEqual(risky, [], "GET must be read-only");
});

// Tables that hold one firm's data. A query on them must name the firm (explicit filter on top of Row Level Security).
const TENANT = ["clients", "invoices", "extracted_data", "line_items", "processing_jobs", "usage_records", "export_history", "export_preferences",
  "batches", "review_events", "subscriptions", "usage_ledger", "billing_events", "integration_connections", "sync_records", "invoice_review_list", "firm_members"];
// Reviewed exceptions: the row is fetched by its id and the handler then compares its firm / membership explicitly.
const FIRM_FILTER_REVIEWED = {
  "app/api/invoices/[id]/route.ts": "loads the invoice by id, then checks the caller's membership in THAT firm and the role before deleting",
  "app/api/invoices/[id]/extract/route.ts": "loads the invoice by id, then rejects it unless invoice.firm_id equals the caller's firm",
};
test("every query on a tenant table in an API route names the firm (firm_id filter), except reviewed cases", () => {
  const flagged = [];
  for (const f of routeFiles) {
    const r = rel(f);
    if (FIRM_FILTER_REVIEWED[r]) continue;
    const t = read(f);
    for (const m of t.matchAll(/\.from\(\s*"([a-z_]+)"\s*\)/g)) {
      if (!TENANT.includes(m[1])) continue;
      if (/storage\s*$/.test(t.slice(Math.max(0, m.index - 40), m.index))) continue; // storage.from("invoices") is the file bucket, not a table
      const end = t.indexOf(";", m.index);
      const stmt = t.slice(m.index, end === -1 ? undefined : end + 1);
      if (!/firm_id|firmId/.test(stmt)) flagged.push(`${r}: .from("${m[1]}") without a firm filter`);
    }
  }
  assert.deepEqual(flagged, []);
  for (const [r, why] of Object.entries(FIRM_FILTER_REVIEWED)) assert.ok(existsSync(path.join(ROOT, r)) && why.length > 20, `reviewed exception is stale: ${r}`);
});

test("the delete and extract routes really do the explicit firm comparison their exemption relies on", () => {
  const del = read(path.join(ROOT, "app/api/invoices/[id]/route.ts"));
  assert.match(del, /firm_members/);
  assert.match(del, /\.eq\("firm_id"/);
  const ext = read(path.join(ROOT, "app/api/invoices/[id]/extract/route.ts"));
  assert.match(ext, /firm_id\s*!==\s*g\.membership\.firmId|firm_id\s*!==\s*membership\.firmId|firmId\s*!==/);
});

test("the service-role client is created only in server-side modules", () => {
  const users = files.filter((f) => /\.(ts|tsx)$/.test(f) && /createAdminClient\(/.test(read(f)) && !/lib\/supabase\/admin\.ts$/.test(f)).map(rel);
  for (const u of users) assert.ok(u.startsWith("app/api/") || u.startsWith("lib/") || u.startsWith("app/auth/") || u.startsWith("app/dashboard/"), `${u} is outside server code`);
  for (const u of users.filter((x) => x.endsWith(".tsx") && !x.startsWith("app/"))) assert.fail(`component ${u} uses the admin client`);
});

test("no code logs tokens, secrets or whole request bodies", () => {
  const bad = [];
  for (const f of files.filter((x) => /\.(ts|tsx)$/.test(x) && !rel(x).startsWith("tests/"))) {
    for (const m of read(f).matchAll(/console\.(log|error|warn|info)\(([^;]*)\)/g)) {
      if (/access_token|refresh_token|client_secret|api[_-]?key|authorization|service_role|password|code_verifier/i.test(m[2])) bad.push(`${rel(f)}: ${m[0].slice(0, 80)}`);
    }
  }
  assert.deepEqual(bad, []);
});

test("production responses never carry raw database or provider error text (debug detail is a local-only switch)", () => {
  const dbg = read(path.join(ROOT, "lib/api/debug.ts"));
  assert.match(dbg, /NODE_ENV\s*!==\s*"production"/);
  for (const f of routeFiles) {
    const t = read(f);
    if (/detail:\s*errDetail\(/.test(t)) assert.match(t, /DEBUG_ERRORS\s*\?/, `${rel(f)} must only send detail behind DEBUG_ERRORS`);
  }
});
