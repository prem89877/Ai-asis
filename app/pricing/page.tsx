import type { Metadata } from "next";
import { Button } from "@/components/ui/Button";
import { Navbar } from "@/components/landing/Navbar";
import { Footer } from "@/components/landing/Footer";
import { PlanCard } from "@/components/billing/PlanCard";
import { PlanActionButton } from "@/components/billing/PlanActionButton";
import { createClient } from "@/lib/supabase/server";
import { getPrimaryMembership } from "@/lib/auth/session";
import { getBillingOverview, listPlans } from "@/lib/billing/server";
import { FALLBACK_PLANS, changeKind } from "@/lib/billing/plans";
import type { BillingOverview } from "@/lib/billing/types";

export const metadata: Metadata = {
  title: "Pricing | AI Asis",
  description: "Simple monthly plans for CAs, tax consultants and accounting teams. Start free.",
};
export const dynamic = "force-dynamic";

export default async function PricingPage() {
  let plans: Awaited<ReturnType<typeof listPlans>> = { plans: [], fromDatabase: false };
  let overview: BillingOverview | null = null;
  let canManage = false;
  let signedIn = false;

  try {
    const supabase = createClient();
    plans = await listPlans(supabase);
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user) {
      signedIn = true;
      const membership = await getPrimaryMembership(supabase, user.id);
      if (membership) {
        overview = await getBillingOverview(supabase, membership.firmId);
        canManage = membership.role === "owner" || membership.role === "admin";
      }
    }
  } catch {
    // Supabase is not configured: show the built-in plan list to logged-out visitors.
    plans = { plans: FALLBACK_PLANS, fromDatabase: false };
  }

  const current = overview?.plan ?? null;
  const pendingCode = overview?.subscription.pending?.plan_code ?? null;

  return (
    <>
      <Navbar />
      <main className="section-y">
        <div className="container-page">
          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">Pricing</h1>
          <p className="mt-3 max-w-2xl text-ink-muted">
            Pick the plan that matches how many invoices you process each month. Every account starts on Pilot, and you can change plans from Billing.
          </p>
          <p className="mt-2 text-sm text-ink-muted">
            Proposed pricing: prices and limits may change before launch. {!plans.fromDatabase && "Showing default plan details."}
          </p>

          {signedIn && current && (
            <p className="mt-6 rounded-lg border border-blue-200 bg-brand-soft p-3 text-sm text-blue-900">
              You are on the <strong>{current.name}</strong> plan.{" "}
              {!canManage && "Only the firm owner or an admin can change it."}
            </p>
          )}

          <div className="mt-10 grid gap-6 lg:grid-cols-3">
            {plans.plans.map((p) => {
              const kind = current ? changeKind(current, p) : null;
              const firstPaid = plans.plans.find((x) => x.price_paise > 0)?.code === p.code;
              return (
                <PlanCard key={p.code} plan={p} badge={kind === "current" ? "Current plan" : undefined} highlight={kind === "current" || (!current && firstPaid)}>
                  {!current ? (
                    <Button href={signedIn ? "/dashboard" : "/register"} className="w-full">{signedIn ? "Go to dashboard" : "Start free"}</Button>
                  ) : kind === "current" ? (
                    <Button variant="secondary" className="w-full" disabled>Current plan</Button>
                  ) : pendingCode === p.code ? (
                    <Button href="/dashboard/billing" variant="secondary" className="w-full">Change pending: open Billing</Button>
                  ) : canManage && kind ? (
                    <PlanActionButton planCode={p.code} planName={p.name} kind={kind} />
                  ) : (
                    <p className="text-sm text-ink-muted">Ask your firm owner or admin to change the plan.</p>
                  )}
                </PlanCard>
              );
            })}
          </div>

          {!signedIn && (
            <p className="mt-6 text-sm text-ink-muted">Start free on Pilot, then upgrade any time from your Billing page. Online payment is not available yet.</p>
          )}
        </div>
      </main>
      <Footer />
    </>
  );
}
