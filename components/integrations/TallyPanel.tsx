"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";

interface Skipped { invoiceId: string; invoiceNumber: string | null; reason: string }

// EXPERIMENTAL. Available by default; hidden only when the server has TALLY_EXPORT_ENABLED=false. Nothing is sent to Tally: it downloads a file.
export function TallyPanel({ available }: { available: boolean }) {
  const [format, setFormat] = useState<"xml" | "json" | "csv">("xml");
  const [cfg, setCfg] = useState({ voucherType: "Purchase", purchaseLedger: "Purchase", cgstLedger: "Input CGST", sgstLedger: "Input SGST", igstLedger: "Input IGST", cessLedger: "Input Cess", roundOffLedger: "Round Off", companyName: "" });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [skipped, setSkipped] = useState<Skipped[]>([]);

  async function run() {
    setBusy(true); setMsg(null); setSkipped([]);
    try {
      const list = await fetch("/api/review/invoices?status=verified&idsOnly=1", { cache: "no-store" });
      const lj = (await list.json().catch(() => null)) as { ids?: string[] } | null;
      const ids = (lj?.ids ?? []).slice(0, 500);
      if (ids.length === 0) { setMsg("No verified invoices found to export."); return; }
      const res = await fetch("/api/exports/tally", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ format, config: cfg, invoiceIds: ids }) });
      const data = (await res.json().catch(() => null)) as { error?: string; content?: string; fileName?: string; contentType?: string; count?: number; skipped?: Skipped[] } | null;
      if (!res.ok || !data?.content) { setMsg(data?.error ?? "The export failed."); setSkipped(data?.skipped ?? []); return; }
      const url = URL.createObjectURL(new Blob([data.content], { type: data.contentType ?? "text/plain" }));
      const a = document.createElement("a");
      a.href = url; a.download = data.fileName ?? `ai-asis-tally.${format}`; a.click();
      URL.revokeObjectURL(url);
      setMsg(`${data.count} voucher${data.count === 1 ? "" : "s"} exported.`);
      setSkipped(data.skipped ?? []);
    } catch {
      setMsg("Network problem. Try again.");
    } finally { setBusy(false); }
  }

  const input = "h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm";
  const labels: [keyof typeof cfg, string][] = [["voucherType", "Voucher type"], ["purchaseLedger", "Purchase ledger"], ["cgstLedger", "CGST ledger"], ["sgstLedger", "SGST ledger"], ["igstLedger", "IGST ledger"], ["cessLedger", "Cess ledger"], ["roundOffLedger", "Round-off ledger"], ["companyName", "Tally company (optional)"]];

  return (
    <section className="rounded-xl border border-slate-200 bg-white shadow-card" aria-labelledby="tally-h">
      <div className="border-b border-slate-100 px-5 py-4">
        <h2 id="tally-h" className="text-base font-semibold">Tally-compatible export <span className="ml-2 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-900">Experimental</span></h2>
        <p className="mt-0.5 text-xs text-ink-muted">Creates a purchase-voucher file from verified invoices. Not yet verified against Tally: import it into a COPY of a test company first. Nothing is posted automatically.</p>
      </div>
      <div className="space-y-4 px-5 py-4 text-sm">
        {!available ? <p className="text-ink-muted">Turned off on this server (TALLY_EXPORT_ENABLED=false).</p> : (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              {labels.map(([k, l]) => (
                <label key={k} className="block">{l}
                  <input className={`${input} mt-1`} value={cfg[k]} onChange={(e) => setCfg((c) => ({ ...c, [k]: e.target.value }))} />
                </label>
              ))}
            </div>
            <p className="text-xs text-ink-muted">Party and tax ledgers must already exist in Tally with exactly these names. Supplier names are used as party ledger names.</p>
            <div className="flex flex-wrap items-center gap-3">
              <select aria-label="File format" className={`${input} max-w-[160px]`} value={format} onChange={(e) => setFormat(e.target.value as "xml" | "json" | "csv")}>
                <option value="xml">XML</option><option value="json">JSON</option><option value="csv">CSV</option>
              </select>
              <Button onClick={run} loading={busy}>Export verified invoices</Button>
            </div>
          </>
        )}
        {msg && <p role="status">{msg}</p>}
        {skipped.length > 0 && (
          <ul className="list-disc space-y-1 pl-5 text-amber-900">
            {skipped.slice(0, 20).map((s) => <li key={s.invoiceId}>{s.invoiceNumber ?? s.invoiceId.slice(0, 8)}: {s.reason}</li>)}
          </ul>
        )}
      </div>
    </section>
  );
}
