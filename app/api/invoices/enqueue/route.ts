import { json } from "@/lib/api/json";
import { readJsonBody } from "@/lib/api/body";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getPrimaryMembership } from "@/lib/auth/session";
import { isSameOrigin } from "@/lib/security/origin";
import { UUID_RE } from "@/lib/invoices/validation";
import { getGeminiConfig, getLimits } from "@/lib/extraction/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface EnqueueResult {
  error?: "no_subscription" | "subscription_inactive" | "batch_limit";
  max?: number;
  enqueued: { invoice_id: string; job_id: string }[];
  skipped: { invoice_id: string; reason: string }[];
  quota?: { used: number; limit: number; remaining: number };
}

// Absolute ceiling on one request, whatever the plan says. The plan's own batch limit is enforced in the database.
const MAX_IDS_PER_REQUEST = 100;

// Queues uploaded (or failed) invoices for extraction. The plan's invoice quota, batch limit and subscription status
// are enforced in the database (enqueue_metered_jobs); the browser cannot choose or raise any limit.
export async function POST(request: Request) {
  if (!isSameOrigin(request)) return json({ error: "Forbidden." }, 403);

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return json({ error: "Please log in again." }, 401);

  const membership = await getPrimaryMembership(supabase, user.id);
  if (!membership) return json({ error: "No firm found for this account." }, 403);

  const body = await readJsonBody(request);
  if (!body.ok) return json({ error: body.message }, body.status);
  const raw = (body.value as { invoiceIds?: unknown } | null)?.invoiceIds;
  const limits = getLimits();
  if (!Array.isArray(raw) || raw.length === 0 || !raw.every((v) => typeof v === "string" && UUID_RE.test(v))) {
    return json({ error: "Invalid request." }, 400);
  }
  const ids = Array.from(new Set(raw as string[]));
  if (ids.length > MAX_IDS_PER_REQUEST) return json({ error: "Too many invoices in one request." }, 400);

  // Do not queue work that cannot run.
  const admin = createAdminClient();
  if (!admin || !getGeminiConfig()) return json({ error: "AI extraction is not configured on this server." }, 503);

  const { data, error } = await admin.rpc("enqueue_metered_jobs", {
    p_firm_id: membership.firmId,
    p_user_id: user.id,
    p_invoice_ids: ids,
    p_per_minute_limit: limits.perMinuteLimit,
    p_max_runs: limits.maxRunsPerInvoice,
  });
  if (error || !data) {
    console.error("enqueue_failed", { code: error?.code ?? null });
    return json({ error: "The invoices could not be queued. Try again." }, 500);
  }

  const result = data as EnqueueResult;
  if (result.error === "batch_limit") {
    return json({ error: `Your plan allows up to ${result.max} invoices at a time.`, code: "batch_limit", maxFiles: result.max }, 400);
  }
  if (result.error === "subscription_inactive") {
    return json({ error: "Your subscription is not active, so new invoices cannot be processed. Open Billing to fix this.", code: "subscription_inactive" }, 402);
  }
  if (result.error) {
    return json({ error: "No subscription was found for your firm. Contact support.", code: "no_subscription" }, 409);
  }
  const enqueued = result.enqueued.map((e) => ({ invoiceId: e.invoice_id, jobId: e.job_id }));
  const skipped = result.skipped.map((s) => ({ invoiceId: s.invoice_id, reason: s.reason }));
  const seen = new Set([...enqueued.map((e) => e.invoiceId), ...skipped.map((s) => s.invoiceId)]);
  for (const id of ids) if (!seen.has(id)) skipped.push({ invoiceId: id, reason: "not_found" });

  if (enqueued.length === 0) {
    if (skipped.some((s) => s.reason === "quota_exceeded")) {
      return json({ error: "You have used all invoices included in your plan this month. Upgrade your plan to process more.", code: "quota_exceeded", quota: result.quota ?? null, enqueued, skipped }, 402);
    }
    if (skipped.some((s) => s.reason === "rate_limited")) {
      return json({ error: "Too many invoices queued in the last minute. Wait a moment and try again.", enqueued, skipped }, 429, { "Retry-After": "30" });
    }
  }
  return json({ enqueued, skipped, quota: result.quota ?? null });
}
