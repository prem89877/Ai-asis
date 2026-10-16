import { createHash, randomUUID } from "node:crypto";
import { json } from "@/lib/api/json";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getPrimaryMembership } from "@/lib/auth/session";
import { isSameOrigin } from "@/lib/security/origin";
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_MB, UUID_RE, sanitizeFilename, validateUpload } from "@/lib/invoices/validation";
import { getLimits } from "@/lib/extraction/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!isSameOrigin(request)) return json({ error: "Forbidden." }, 403);

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return json({ error: "Please log in again." }, 401);

  // The firm comes from the database, never from the request.
  const membership = await getPrimaryMembership(supabase, user.id);
  if (!membership) return json({ error: "No firm found for this account." }, 403);

  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_UPLOAD_BYTES + 64 * 1024) {
    return json({ error: `File is too large. The maximum is ${MAX_UPLOAD_MB} MB.` }, 413);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json({ error: "Invalid upload." }, 400);
  }
  const file = form.get("file");
  if (!(file instanceof File)) return json({ error: "No file was provided." }, 400);

  // Optional batch. The batch must belong to the user's firm; its size limit is enforced by the database.
  const batchField = form.get("batch_id");
  let batchId: string | null = null;
  if (batchField !== null) {
    if (typeof batchField !== "string" || !UUID_RE.test(batchField)) return json({ error: "Invalid batch." }, 400);
    const { data: batch } = await supabase
      .from("batches")
      .select("id")
      .eq("id", batchField)
      .eq("firm_id", membership.firmId)
      .maybeSingle();
    if (!batch) return json({ error: "Batch not found." }, 404);
    batchId = batchField;
  }

  if (file.size > MAX_UPLOAD_BYTES) {
    return json({ error: `File is too large. The maximum is ${MAX_UPLOAD_MB} MB.` }, 413);
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const check = validateUpload(bytes);
  if (!check.ok) return json({ error: check.message }, check.status);

  // Abuse protection: cap uploads per firm per rolling 24 hours. The slot is reserved in the database under a per-firm lock
  // (count and insert in one step), so parallel uploads cannot pass the limit together, and it is counted from upload_events, not from
  // invoices, so deleting an invoice never gives a slot back. Done after validation, so a rejected file does not use a slot.
  const invoiceId = randomUUID();
  const admin = createAdminClient();
  if (!admin) return json({ error: "Uploads are not configured on this server." }, 503);
  const slot = await admin.rpc("reserve_upload_slot", { p_firm_id: membership.firmId, p_user_id: user.id, p_invoice_id: invoiceId, p_limit: getLimits().uploadsPerDay });
  const slotData = slot.data as { result?: string; id?: string } | null;
  if (slot.error || !slotData) {
    console.error("upload_slot_failed", { code: slot.error?.code ?? null });
    return json({ error: "The upload could not be started. Try again." }, 500);
  }
  if (slotData.result === "limit") {
    return json({ error: "The daily upload limit for your firm has been reached. Try again tomorrow." }, 429, { "Retry-After": "3600" });
  }
  const slotId = slotData.id ?? null;
  // A failed upload (storage error, duplicate file) gives its slot back; an invoice that exists keeps it (enforced in the database).
  const giveSlotBack = async () => {
    if (!slotId) return;
    const r = await admin.rpc("release_upload_slot", { p_firm_id: membership.firmId, p_event_id: slotId });
    if (r.error) console.error("upload_slot_release_failed", { code: r.error.code ?? null });
  };

  const storagePath = `${membership.firmId}/${invoiceId}.${check.file.ext}`;
  const sha256 = createHash("sha256").update(bytes).digest("hex");

  const { error: uploadError } = await supabase.storage
    .from("invoices")
    .upload(storagePath, bytes, { contentType: check.file.mime, upsert: false });
  if (uploadError) {
    console.error("invoice_storage_upload_failed", { invoiceId });
    await giveSlotBack();
    return json({ error: "The file could not be stored. Try again." }, 502);
  }

  const { error: insertError } = await supabase.from("invoices").insert({
    id: invoiceId,
    firm_id: membership.firmId,
    uploaded_by: user.id,
    storage_path: storagePath,
    original_filename: sanitizeFilename(file.name, check.file.ext),
    mime_type: check.file.mime,
    size_bytes: bytes.length,
    sha256,
    status: "uploaded",
    batch_id: batchId,
  });

  if (insertError) {
    // Do not leave an orphan file behind.
    await supabase.storage.from("invoices").remove([storagePath]);
    await giveSlotBack();
    if (insertError.code === "23505") {
      return json({ error: "This file has already been uploaded." }, 409);
    }
    if (insertError.code === "23514" && insertError.message?.includes("batch_full")) {
      return json({ error: "This batch already has the maximum number of files." }, 409);
    }
    console.error("invoice_insert_failed", { invoiceId, code: insertError.code ?? null });
    return json({ error: "The invoice could not be saved. Try again." }, 500);
  }

  return json({ id: invoiceId }, 201);
}
