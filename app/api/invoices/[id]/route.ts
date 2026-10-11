import { json } from "@/lib/api/json";
import { createClient } from "@/lib/supabase/server";
import { isSameOrigin } from "@/lib/security/origin";
import { UUID_RE } from "@/lib/invoices/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Deletion workflow: authorize -> mark pending_deletion -> remove file -> delete row.
// If the file cannot be removed the row stays as pending_deletion, so the request can be retried.
export async function DELETE(request: Request, { params }: { params: { id: string } }) {
  if (!isSameOrigin(request)) return json({ error: "Forbidden." }, 403);
  if (!UUID_RE.test(params.id)) return json({ error: "Not found." }, 404);

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return json({ error: "Please log in again." }, 401);

  // RLS already hides other firms' invoices; a miss and a foreign id look identical.
  const { data: invoice } = await supabase
    .from("invoices")
    .select("id, firm_id, storage_path, uploaded_by")
    .eq("id", params.id)
    .maybeSingle();
  if (!invoice) return json({ error: "Not found." }, 404);

  const { data: member } = await supabase
    .from("firm_members")
    .select("role")
    .eq("firm_id", invoice.firm_id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!member) return json({ error: "Not found." }, 404);

  const allowed =
    member.role === "owner" || member.role === "admin" || invoice.uploaded_by === user.id;
  if (!allowed) return json({ error: "You don't have permission to delete this invoice." }, 403);

  const { error: markError } = await supabase
    .from("invoices")
    .update({ status: "pending_deletion", deletion_requested_at: new Date().toISOString() })
    .eq("id", invoice.id);
  if (markError) {
    console.error("invoice_delete_mark_failed", { invoiceId: invoice.id });
    return json({ error: "The invoice could not be deleted. Try again." }, 500);
  }

  const { error: removeError } = await supabase.storage.from("invoices").remove([invoice.storage_path]);
  if (removeError) {
    console.error("invoice_delete_storage_failed", { invoiceId: invoice.id });
    return json({ error: "The file could not be removed yet. Try again." }, 502);
  }

  const { error: deleteError } = await supabase.from("invoices").delete().eq("id", invoice.id);
  if (deleteError) {
    console.error("invoice_delete_row_failed", { invoiceId: invoice.id });
    return json({ error: "The invoice could not be deleted. Try again." }, 500);
  }

  return json({ ok: true });
}
