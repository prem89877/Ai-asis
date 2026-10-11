import { Check } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";

// PLACEHOLDER PLANS: final pricing and limits are not decided.
const plans = [
  { name: "Free", price: "₹0", note: "To try the workflow", features: ["Limited invoices per month", "Excel export", "Email support"], cta: "Start Free", highlight: true, href: "/register" },
  { name: "Professional", price: "To be announced", note: "For CAs and consultants", features: ["Higher invoice volume", "Bulk upload", "Verification workflow"], cta: "Join the waitlist", highlight: false, href: "/register" },
  { name: "Business", price: "To be announced", note: "For wholesalers and teams", features: ["Team access", "Priority support", "Custom limits"], cta: "Contact us", highlight: false, href: "/register" },
];

export function Pricing() {
  return (
    <section id="pricing" className="section-y border-y border-slate-200 bg-white">
      <div className="container-page">
        <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">Pricing</h2>
        <p className="mt-3 max-w-2xl text-ink-muted">Placeholder plans. Final pricing will be published before launch.</p>
        <div className="mt-12 grid gap-6 lg:grid-cols-3">
          {plans.map((p) => (
            <div key={p.name} className={cn("flex flex-col rounded-xl border bg-canvas p-6", p.highlight ? "border-brand ring-1 ring-brand" : "border-slate-200")}>
              <h3 className="text-lg font-semibold">{p.name}</h3>
              <p className="mt-3 text-3xl font-bold tracking-tight">{p.price}</p>
              <p className="mt-1 text-sm text-ink-muted">{p.note}</p>
              <ul className="mt-6 flex-1 space-y-3 text-sm">
                {p.features.map((f) => (
                  <li key={f} className="flex items-start gap-2">
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-success-ink" aria-hidden />
                    {f}
                  </li>
                ))}
              </ul>
              <Button href={p.href} variant={p.highlight ? "primary" : "secondary"} className="mt-8">{p.cta}</Button>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
