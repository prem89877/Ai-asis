// Module-resolution hooks used ONLY by route-level tests (registered by tests/helpers/route-harness.mjs).
// They let plain `node --test` load Next.js route files: "@/..." aliases and extensionless imports are resolved, and the
// packages that need a running Next/Supabase (next/server, next/navigation, the Supabase clients) are replaced by small stubs.
// With mockIntegrations the cloud-provider modules (lib/integrations/*) are replaced by mocks too, so no real network,
// token or crypto code is ever touched by these tests.
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
let opts = { mockIntegrations: false };
export function initialize(data) { opts = { ...opts, ...(data ?? {}) }; }

const STUBS = {
  "next/server": "tests/stubs/next-server.mjs",
  "next/navigation": "tests/stubs/next-navigation.mjs",
  "@supabase/supabase-js": "tests/stubs/supabase-js.mjs",
  "@/lib/supabase/server": "tests/stubs/supabase-server.mjs",
  "@/lib/supabase/admin": "tests/stubs/supabase-admin.mjs",
};
const EXTS = ["", ".ts", ".tsx", ".mjs", "/index.ts"];
function tryFile(base) {
  for (const e of EXTS) {
    const p = base + e;
    if (existsSync(p) && statSync(p).isFile()) return p;
  }
  return null;
}

export async function resolve(spec, context, next) {
  let target = null;
  if (STUBS[spec]) target = path.join(ROOT, STUBS[spec]);
  else if (spec.startsWith("@/")) {
    const rel = spec.slice(2);
    if (opts.mockIntegrations && rel.startsWith("lib/integrations/")) {
      target = path.join(ROOT, "tests/stubs/integrations", rel.slice("lib/integrations/".length) + ".mjs");
    } else target = tryFile(path.join(ROOT, rel));
  } else if ((spec.startsWith("./") || spec.startsWith("../")) && !path.extname(spec) && context.parentURL?.startsWith("file:")) {
    target = tryFile(path.resolve(path.dirname(fileURLToPath(context.parentURL)), spec));
  }
  if (target) return next(pathToFileURL(target).href, context);
  return next(spec, context);
}
