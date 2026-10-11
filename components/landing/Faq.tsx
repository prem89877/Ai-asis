import { ChevronDown } from "lucide-react";

const faqs = [
  { q: "Is AI Asis live yet?", a: "Not yet. This release is the Phase 1 interface. Upload, extraction and export will be connected in later phases." },
  { q: "Who is AI Asis for?", a: "Indian CAs, tax consultants, wholesalers and small businesses that handle many GST invoices." },
  { q: "What will it extract?", a: "The plan is to extract fields such as vendor, GSTIN, invoice number, date, taxable value and GST amounts." },
  { q: "Will I be able to check the results?", a: "Yes. The workflow is designed so you review flagged invoices before exporting anything." },
  { q: "How will my invoice data be handled?", a: "Data handling and security details will be published before the product accepts real invoices." },
];

export function Faq() {
  return (
    <section id="faq" className="section-y">
      <div className="container-page max-w-3xl">
        <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">Frequently asked questions</h2>
        <div className="mt-10 divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white">
          {faqs.map((f) => (
            <details key={f.q} className="group p-5">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-semibold [&::-webkit-details-marker]:hidden">
                {f.q}
                <ChevronDown className="h-5 w-5 shrink-0 transition-transform group-open:rotate-180" aria-hidden />
              </summary>
              <p className="mt-3 text-sm leading-relaxed text-ink-muted">{f.a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
