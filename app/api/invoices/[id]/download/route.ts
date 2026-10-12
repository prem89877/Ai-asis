import { json } from "@/lib/api/json";
import { guard } from "@/lib/api/guard";
import { UUID_RE } from "@/lib/invoices/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Returns a short-lived signed URL. The bucket is private; the URL expires after 60 seconds.
// The invoice must belong to the signed-in user's firm (explicit firm_id filter on top of Row Level Security).
export async function GET(request: Request, { params }: { params: { id: string } }) {
  if (!UUID_RE.test(params.id)) return json({ error: "Not found." }, 404);

  const g = await guard(request, { mutating: false });
  if (!g.ok) return g.response;

  const { data: invoice } = await g.supabase
    .from("invoices")
    .select("storage_path, original_filename, status")
    .eq("id", params.id)
    .eq("firm_id", g.membership.firmId)
    .maybeSingle();
  if (!invoice || invoice.status === "pending_deletion") return json({ error: "Not found." }, 404);

  const { data, error } = await g.supabase.storage
    .from("invoices")
    .createSignedUrl(invoice.storage_path, 60, { download: invoice.original_filename });
  if (error || !data) return json({ error: "The file is not available." }, 404);

  return json({ url: data.signedUrl });
}
