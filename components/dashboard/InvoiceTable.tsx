import { FileText } from "lucide-react";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { StatusBadge } from "@/components/ui/Badge";
import { inrFormatter, type Invoice } from "@/lib/sample-data";

const headers = ["Vendor", "Invoice no.", "Date", "GSTIN", "Taxable", "GST", "Status"];

export function InvoiceTable({ invoices, loading }: { invoices: Invoice[]; loading?: boolean }) {
  return (
    <section aria-labelledby="invoices-title" className="rounded-xl border border-slate-200 bg-white shadow-card">
      <h2 id="invoices-title" className="border-b border-slate-100 px-5 py-4 text-base font-semibold">Invoices</h2>
      {loading ? (
        <div className="space-y-3 p-5">
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-9 w-full" />)}
        </div>
      ) : invoices.length === 0 ? (
        <EmptyState icon={FileText} title="No invoices yet" description="Upload your first invoices to see extracted data here." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-sm">
            <caption className="sr-only">Sample invoice list</caption>
            <thead className="bg-slate-50 text-ink-muted">
              <tr>
                {headers.map((h) => (
                  <th key={h} scope="col" className="px-5 py-3 font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {invoices.map((inv) => (
                <tr key={inv.id}>
                  <td className="px-5 py-3 font-medium">{inv.vendor}</td>
                  <td className="px-5 py-3">{inv.invoiceNo}</td>
                  <td className="px-5 py-3">{inv.date}</td>
                  <td className="px-5 py-3 tabular-nums">{inv.gstin}</td>
                  <td className="px-5 py-3 tabular-nums">{inrFormatter.format(inv.taxable)}</td>
                  <td className="px-5 py-3 tabular-nums">{inrFormatter.format(inv.gst)}</td>
                  <td className="px-5 py-3"><StatusBadge status={inv.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
