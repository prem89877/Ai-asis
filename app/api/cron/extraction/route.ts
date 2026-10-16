import { timingSafeEqual } from "node:crypto";
import { json } from "@/lib/api/json";
import { createAdminClient } from "@/lib/supabase/admin";
import { getGeminiConfig } from "@/lib/extraction/config";
import { runWorkerCycle } from "@/lib/extraction/worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Same budget as /api/invoices/[id]/extract: above EXTRACTION_DEADLINE_MS, below EXTRACTION_STALE_SECONDS.
export const maxDuration = 200;

function secretMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false; // timingSafeEqual needs equal lengths; the length of a secret is not a secret worth protecting here
  return timingSafeEqual(a, b);
}

// Background worker entry point. A scheduler (Vercel Cron, Supabase pg_cron + pg_net, any cron service) calls it every minute:
// it fails stale jobs of ALL firms and runs queued ones, so extraction no longer depends on an open browser tab.
// Authorization: "Authorization: Bearer <CRON_SECRET>" (Vercel Cron sends exactly this when CRON_SECRET is set). Without CRON_SECRET the route is closed.
async function handle(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return json({ error: "Not configured." }, 503);
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token || !secretMatches(token, secret)) return json({ error: "Forbidden." }, 403);

  const admin = createAdminClient();
  const geminiConfig = getGeminiConfig();
  if (!admin || !geminiConfig) return json({ error: "AI extraction is not configured on this server." }, 503);

  try {
    const summary = await runWorkerCycle(admin, geminiConfig);
    return json({ ok: true, ...summary });
  } catch {
    console.error("cron_extraction_failed");
    return json({ error: "Worker cycle failed." }, 500);
  }
}

export const GET = handle;
export const POST = handle;
