import { json } from "@/lib/api/json";
import { readJsonBody } from "@/lib/api/body";
import { createClient } from "@/lib/supabase/server";
import { getPrimaryMembership } from "@/lib/auth/session";
import { isSameOrigin } from "@/lib/security/origin";
import { getLimits } from "@/lib/extraction/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BATCHES_PER_HOUR = 60;

// Declares a batch of N files before they are uploaded. The server enforces the limit:
// the database refuses to attach more than N invoices to the batch.
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

  const limits = getLimits();
  if (typeof fileCount !== "number" || !Number.isInteger(fileCount) || fileCount < 1) {
    return json({ error: "Choose at least one file." }, 400);
  }
  if (fileCount > limits.batchMaxFiles) {
    return json({ error: `You can upload up to ${limits.batchMaxFiles} files at a time.`, maxFiles: limits.batchMaxFiles }, 400);
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
  if (error || !data) {
    console.error("batch_insert_failed", { code: error?.code ?? null });
    return json({ error: "The batch could not be created. Try again." }, 500);
  }
  return json({ batchId: (data as { id: string }).id, maxFiles: limits.batchMaxFiles }, 201);
}
