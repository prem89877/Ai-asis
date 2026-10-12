import { json } from "@/lib/api/json";
import { readJsonBody } from "@/lib/api/body";
import { createClient } from "@/lib/supabase/server";
import { getPrimaryMembership } from "@/lib/auth/session";
import { isSameOrigin } from "@/lib/security/origin";
import { getBillingOverview } from "@/lib/billing/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BATCHES_PER_HOUR = 60;

// Declares a batch of N files before they are uploaded. The limit comes from the firm's plan, read on the server,
// and is enforced again by the database (a trigger on batches), then the database refuses to attach more than N invoices.
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
  const fileCount = (body.value as { fileCount?: unknown } | null)?.fileCount;

  const billing = await getBillingOverview(supabase, membership.firmId);
  if (!billing) return json({ error: "Your plan could not be checked. Try again." }, 503);
  if (!billing.can_process) {
    return json({ error: "Your subscription is not active, so new invoices cannot be uploaded for processing. Open Billing to fix this.", code: "subscription_inactive" }, 402);
  }
  const maxFiles = billing.plan.batch_max_files;
  if (typeof fileCount !== "number" || !Number.isInteger(fileCount) || fileCount < 1) {
    return json({ error: "Choose at least one file." }, 400);
  }
  if (fileCount > maxFiles) {
    return json({ error: `Your ${billing.plan.name} plan allows up to ${maxFiles} files at a time.`, code: "batch_limit", maxFiles }, 400);
  }

  const hourAgo = new Date(Date.now() - 3600 * 1000).toISOString();
  const { count } = await supabase
    .from("batches")
    .select("id", { count: "exact", head: true })
    .eq("firm_id", membership.firmId)
    .eq("created_by", user.id)
    .gte("created_at", hourAgo);
  if ((count ?? 0) >= MAX_BATCHES_PER_HOUR) {
    return json({ error: "Too many uploads in the last hour. Try again later." }, 429, { "Retry-After": "300" });
  }

  const { data, error } = await supabase
    .from("batches")
    .insert({ firm_id: membership.firmId, created_by: user.id, file_count: fileCount })
    .select("id")
    .single();
  if (error?.code === "23514" && error.message?.includes("batch_limit_exceeded")) {
    return json({ error: `Your plan allows up to ${maxFiles} files at a time.`, code: "batch_limit", maxFiles }, 400);
  }
  if (error || !data) {
    console.error("batch_insert_failed", { code: error?.code ?? null });
    return json({ error: "The batch could not be created. Try again." }, 500);
  }
  return json({ batchId: (data as { id: string }).id, maxFiles, quotaRemaining: billing.usage.remaining }, 201);
}
