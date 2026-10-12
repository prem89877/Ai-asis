import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { PlanCard } from "@/components/billing/PlanCard";
import { listPublicPlans } from "@/lib/billing/server";

// Same plan data as the pricing page (the plans table). Refreshed at most every 5 minutes.
export async function Pricing() {
  const { plans } = await listPublicPlans();
  const firstPaid = plans.find((p) => p.price_paise > 0)?.code;

  return (
    <section id="pricing" className="section-y border-y border-slate-200 bg-white">
      <div className="container-page">
        <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">Pricing</h2>
        <p className="mt-3 max-w-2xl text-ink-muted">
          Proposed pricing: plans and limits may change before launch.{" "}
          <Link href="/pricing" className="font-medium text-brand hover:underline">See full pricing</Link>
        </p>
        <div className="mt-12 grid gap-6 lg:grid-cols-3">
          {plans.map((p) => (
            <PlanCard key={p.code} plan={p} highlight={p.code === firstPaid}>
              <Button href="/register" variant={p.code === firstPaid ? "primary" : "secondary"} className="w-full">Start free</Button>
            </PlanCard>
          ))}
        </div>
      </div>
    </section>
  );
}
