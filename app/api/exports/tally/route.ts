import { json } from "@/lib/api/json";
import { readJsonBody } from "@/lib/api/body";
import { guard } from "@/lib/api/guard";
import type { ExportInvoice } from "@/lib/export/columns";
import { CHUNK, INVOICE_SELECT, istStamp } from "@/lib/export/run";
import { UUID_RE } from "@/lib/invoices/validation";
import { buildVouchers, toTallyCsv, toTallyJson, toTallyXml, validateTallyConfig } from "@/lib/tally/build";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const MAX_INVOICES = 500;
const FORMATS = { xml: { ext: "xml", type: "application/xml; charset=utf-8" }, json: { ext: "json", type: "application/json; charset=utf-8" }, csv: { ext: "csv", type: "text/csv; charset=utf-8" } } as const;

// EXPERIMENTAL Tally-compatible purchase-voucher file. OFF unless TALLY_EXPORT_ENABLED=true. It only builds a file: nothing is sent
// to Tally and nothing is posted. Only VERIFIED invoices of the signed-in user's own firm are read (explicit firm_id filter on
// top of Row Level Security). NOT recorded in export history yet (see docs/PHASE6_PART2_RELEASE.md).
export async function POST(request: Request) {
  if (process.env.TALLY_EXPORT_ENABLED !== "true") return json({ error: "Not found." }, 404);
  const g = await guard(request, { mutating: true });
  if (!g.ok) return g.response;
  const { firmId } = g.membership;

  const body = await readJsonBody(request, 64 * 1024);
  if (!body.ok) return json({ error: body.message }, body.status);
  const b = body.value as Record<string, unknown> | null;
  if (!b || typeof b !== "object" || Array.isArray(b)) return json({ error: "Invalid request." }, 400);

  const format = typeof b.format === "string" && b.format in FORMATS ? (b.format as keyof typeof FORMATS) : null;
  if (!format) return json({ error: "Choose XML, JSON or CSV." }, 400);
  const cfg = validateTallyConfig(b.config);
  if (!cfg.ok) return json({ error: cfg.message }, 400);
  const raw = b.invoiceIds;
  if (!Array.isArray(raw) || raw.length === 0 || !raw.every((v) => typeof v === "string" && UUID_RE.test(v))) return json({ error: "Select the invoices to export." }, 400);
  const ids = Array.from(new Set(raw as string[]));
  if (ids.length > MAX_INVOICES) return json({ error: `Select at most ${MAX_INVOICES} invoices per export.` }, 400);

  const invoices: ExportInvoice[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const { data, error } = await g.supabase.from("invoice_review_list").select(INVOICE_SELECT).eq("firm_id", firmId).in("id", ids.slice(i, i + CHUNK));
    if (error) return json({ error: "The invoices could not be loaded. Try again." }, 500);
    invoices.push(...((data ?? []) as unknown as ExportInvoice[]));
  }
  const found = new Set(invoices.map((v) => v.id));
  const missing = ids.filter((id) => !found.has(id)).map((id) => ({ invoiceId: id, invoiceNumber: null, reason: "Not found." }));

  const { vouchers, skipped } = buildVouchers(invoices, cfg.config);
  const allSkipped = [...skipped, ...missing];
  if (vouchers.length === 0) return json({ error: "None of the selected invoices can be exported to Tally. See the reasons below.", skipped: allSkipped }, 422);

  const content = format === "xml" ? toTallyXml(vouchers, cfg.config) : format === "json" ? toTallyJson(vouchers, allSkipped, cfg.config) : toTallyCsv(vouchers);
  return json({ content, fileName: `ai-asis-tally-${istStamp(new Date())}.${FORMATS[format].ext}`, contentType: FORMATS[format].type, count: vouchers.length, skipped: allSkipped });
}
