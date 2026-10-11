import { json } from "@/lib/api/json";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getPrimaryMembership } from "@/lib/auth/session";
import { isSameOrigin } from "@/lib/security/origin";
import { UUID_RE } from "@/lib/invoices/validation";
import { getCheckConfig, getGeminiConfig, getLimits } from "@/lib/extraction/config";
import { userMessage } from "@/lib/extraction/errors";
import { callGemini } from "@/lib/extraction/gemini";
import { runExtraction } from "@/lib/extraction/pipeline";
import { createSupabaseFiles, createSupabaseStore } from "@/lib/extraction/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// One invoice per request. Keep this above EXTRACTION_DEADLINE_MS (default 52 s).
export const maxDuration = 60;

interface ClaimResult {
  result: "claimed" | "not_found" | "no_job" | "already_processing" | "not_queued" | "busy";
  job_id?: string;
  storage_path?: string;
  mime_type?: string;
  sha256?: string;
}

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
  const limits = getLimits();

  try {
    const { data, error } = await admin.rpc("claim_extraction_job", {
      p_invoice_id: params.id,
      p_firm_id: membership.firmId,
      p_max_concurrent: limits.maxConcurrent,
      p_stale_seconds: limits.staleSeconds,
    });
    if (error || !data) {
      console.error("claim_failed", { invoiceId: params.id, code: error?.code ?? null });
      return json({ error: "Processing could not be started. Try again." }, 500);
    }
    const claim = data as ClaimResult;
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
    if (claim.result !== "claimed" || !claim.job_id || !claim.storage_path || !claim.mime_type || !claim.sha256) {
      return json({ error: "Processing could not be started. Try again." }, 500);
    }

    const result = await runExtraction(
      {
        store: createSupabaseStore(admin),
        files: createSupabaseFiles(admin),
        gemini: callGemini,
        geminiConfig,
        checkConfig: getCheckConfig(),
        maxPdfPages: limits.maxPdfPages,
      },
      {
        jobId: claim.job_id,
        invoiceId: params.id,
        firmId: membership.firmId,
        userId: user.id,
        storagePath: claim.storage_path,
        mime: claim.mime_type,
        sha256: claim.sha256,
      }
    );

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
