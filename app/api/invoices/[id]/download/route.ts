import { json } from "@/lib/api/json";
import { createClient } from "@/lib/supabase/server";
import { UUID_RE } from "@/lib/invoices/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Returns a short-lived signed URL. The bucket is private; the URL expires after 60 seconds.
export async function GET(_request: Request, { params }: { params: { id: string } }) {
  if (!UUID_RE.test(params.id)) return json({ error: "Not found." }, 404);

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return json({ error: "Please log in again." }, 401);

  const { data: invoice } = await supabase
    .from("invoices")
    .select("storage_path, original_filename, status")
    .eq("id", params.id)
    .maybeSingle();
  if (!invoice || invoice.status === "pending_deletion") return json({ error: "Not found." }, 404);

  const { data, error } = await supabase.storage
    .from("invoices")
    .createSignedUrl(invoice.storage_path, 60, { download: invoice.original_filename });
  if (error || !data) return json({ error: "The file is not available." }, 404);

  return json({ url: data.signedUrl });
}
