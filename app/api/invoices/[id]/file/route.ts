import { guard } from "@/lib/api/guard";
import { json } from "@/lib/api/json";
import { UUID_RE } from "@/lib/invoices/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Streams the ORIGINAL file for the side-by-side preview. The bucket stays private: the user is authorized,
// the invoice must belong to the user's firm, and the file is served with fixed, safe headers.
// next.config.mjs allows framing of this one route by this site (SAMEORIGIN) so the PDF viewer can show it.
export async function GET(request: Request, { params }: { params: { id: string } }) {
  if (!UUID_RE.test(params.id)) return json({ error: "Not found." }, 404);
  const g = await guard(request, { mutating: false });
  if (!g.ok) return g.response;

  const { data: invoice } = await g.supabase
    .from("invoices")
    .select("storage_path, mime_type, original_filename, status, firm_id")
    .eq("id", params.id)
    .eq("firm_id", g.membership.firmId)
    .maybeSingle();
  if (!invoice || invoice.status === "pending_deletion") return json({ error: "Not found." }, 404);

  const { data: blob, error } = await g.supabase.storage.from("invoices").download(invoice.storage_path);
  if (error || !blob) return json({ error: "The file is not available." }, 404);

  const mime = ["application/pdf", "image/jpeg", "image/png"].includes(invoice.mime_type) ? invoice.mime_type : "application/octet-stream";
  const asciiName = invoice.original_filename.replace(/[^A-Za-z0-9._-]/g, "_");
  return new Response(blob, {
    headers: {
      "Content-Type": mime,
      "Content-Disposition": `inline; filename="${asciiName}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "SAMEORIGIN",
      // Only framing is restricted: a stricter CSP (default-src 'none') can stop browsers' built-in PDF viewers from loading.
      "Content-Security-Policy": "frame-ancestors 'self'",
    },
  });
}
