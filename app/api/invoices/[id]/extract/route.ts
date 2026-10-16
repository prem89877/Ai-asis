import { json } from "@/lib/api/json";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getPrimaryMembership } from "@/lib/auth/session";
import { isSameOrigin } from "@/lib/security/origin";
import { UUID_RE } from "@/lib/invoices/validation";
import { getGeminiConfig } from "@/lib/extraction/config";
import { userMessage } from "@/lib/extraction/errors";
import { claimJob, isFullClaim, runClaimedJob } from "@/lib/extraction/worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// One invoice per request. Keep this above EXTRACTION_DEADLINE_MS (default 150 s) and below EXTRACTION_STALE_SECONDS (default 240 s).
export const maxDuration = 200;

// Runs extraction for one queued invoice. The Gemini key and the service-role key stay on the server.
export async function POST(request: Request, { params }: { params: { id: string } }) {
  if (!isSameOrigin(request)) return json({ error: "Forbidden." }, 403);
  if (!UUID_RE.test(params.id)) return json({ error: "Not found." }, 404);

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return json({ error: "Please log in again." }, 401);

  const membership = await getPrimaryMembership(supabase, user.id);
  if (!membership) return json({ error: "No firm found for this account." }, 403);

  // RLS hides other firms' invoices; a miss and a foreign id look identical.
  const { data: invoice } = await supabase.from("invoices").select("id, firm_id").eq("id", params.id).maybeSingle();
  if (!invoice || (invoice as { firm_id: string }).firm_id !== membership.firmId) {
    return json({ error: "Not found." }, 404);
  }

  const admin = createAdminClient();
  const geminiConfig = getGeminiConfig();
  if (!admin || !geminiConfig) return json({ error: "AI extraction is not configured on this server." }, 503);

  try {
    const claim = await claimJob(admin, params.id, membership.firmId);
    if (!claim) return json({ error: "Processing could not be started. Try again." }, 500);
    switch (claim.result) {
      case "not_found":
        return json({ error: "Not found." }, 404);
      case "no_job":
      case "not_queued":
        return json({ error: "This invoice is not queued for extraction." }, 409);
      case "already_processing":
        return json({ error: "This invoice is already being processed." }, 409);
      case "busy":
        return json({ error: "Other invoices are being processed. Retrying shortly." }, 429, { "Retry-After": "5" });
    }
    if (!isFullClaim(claim)) {
      return json({ error: "Processing could not be started. Try again." }, 500);
    }

    const result = await runClaimedJob(admin, geminiConfig, claim, { invoiceId: params.id, firmId: membership.firmId, userId: user.id });

    return json({
      status: result.outcome,
      errorCode: result.errorCode,
      message: userMessage(result.errorCode),
      flagCount: result.flagCount,
      attempts: result.attempts,
    });
  } catch {
    console.error("extract_route_failed", { invoiceId: params.id });
    return json({ error: "Processing failed. Try again." }, 500);
  }
}
