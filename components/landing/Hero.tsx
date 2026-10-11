import { Button } from "@/components/ui/Button";
import { PreviewLabel } from "@/components/ui/PreviewLabel";
import { StatusBadge } from "@/components/ui/Badge";
import { FileText } from "lucide-react";

const extracted = [
  ["Vendor", "Sample Traders Pvt Ltd"],
  ["Invoice no.", "INV-2041"],
  ["GSTIN", "27AAAAA0000A1Z5"],
  ["Taxable value", "₹42,500.00"],
  ["GST (18%)", "₹7,650.00"],
];

export function Hero() {
  return (
    <section className="section-y">
      <div className="container-page grid items-center gap-12 lg:grid-cols-2">
        <div>
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl lg:text-[3.5rem] lg:leading-[1.08]">
            Turn Invoices Into Accounting-Ready Data.
          </h1>
          <p className="mt-5 max-w-xl text-lg text-ink-muted">
            AI Asis is built for Indian CAs, tax consultants, wholesalers and small businesses who are tired of typing invoice details into spreadsheets.
          </p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <Button href="/register" size="lg">Start Free</Button>
            <Button href="#how-it-works" size="lg" variant="secondary">See How It Works</Button>
          </div>
          <p className="mt-4 text-sm text-ink-muted">
            Phase 1 is the interface. Invoice extraction is not live yet.
          </p>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-card sm:p-6" role="img" aria-label="Preview of an invoice converted into structured fields, using sample data">
          <div className="mb-4 flex items-center justify-between">
            <PreviewLabel />
          </div>
          <div className="grid gap-4 sm:grid-cols-[1fr_1.4fr]">
            <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-slate-300 bg-canvas p-6 text-center">
              <FileText className="h-10 w-10 text-ink-muted" aria-hidden />
              <p className="mt-2 text-sm font-medium">invoice-2041.pdf</p>
              <p className="text-xs text-ink-muted">Sample file</p>
            </div>
            <dl className="divide-y divide-slate-100 text-sm">
              {extracted.map(([k, v]) => (
                <div key={k} className="flex justify-between gap-3 py-2">
                  <dt className="text-ink-muted">{k}</dt>
                  <dd className="text-right font-medium">{v}</dd>
                </div>
              ))}
              <div className="flex items-center justify-between pt-3">
                <dt className="text-ink-muted">Status</dt>
                <dd><StatusBadge status="verified" /></dd>
              </div>
            </dl>
          </div>
        </div>
      </div>
    </section>
  );
}
