import { AlertTriangle, FileSpreadsheet, ScanText, ShieldCheck, UploadCloud } from "lucide-react";

const features = [
  { icon: UploadCloud, title: "Bulk invoice upload", text: "Drop in many invoices at once instead of handling them one by one." },
  { icon: ScanText, title: "AI GST extraction", text: "Pull GSTIN, invoice number, dates, taxable value and GST amounts into structured fields." },
  { icon: AlertTriangle, title: "Error detection", text: "Flag missing fields, mismatched tax totals and unreadable pages before they reach your books." },
  { icon: ShieldCheck, title: "Verification", text: "Review each flagged invoice side by side with its extracted data and confirm it." },
  { icon: FileSpreadsheet, title: "Excel export", text: "Export verified invoices to a clean spreadsheet your accounting workflow can use." },
];

export function Features() {
  return (
    <section id="features" className="section-y border-y border-slate-200 bg-white">
      <div className="container-page">
        <h2 className="max-w-2xl text-3xl font-bold tracking-tight sm:text-4xl">
          Everything between the invoice and your books
        </h2>
        <p className="mt-3 max-w-2xl text-ink-muted">
          Planned capabilities for AI Asis. These are the interface and workflow for Phase 1; backend features arrive in later phases.
        </p>
        <ul className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {features.map(({ icon: Icon, title, text }) => (
            <li key={title} className="rounded-xl border border-slate-200 bg-canvas p-6">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-success-soft text-success-ink">
                <Icon className="h-5 w-5" aria-hidden />
              </div>
              <h3 className="mt-4 text-lg font-semibold">{title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-ink-muted">{text}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
