import type { Metadata } from "next";
import { DashboardSidebar } from "@/components/dashboard/DashboardSidebar";
import { BillingClient } from "@/components/billing/BillingClient";
import { getPrimaryMembership, requireUser } from "@/lib/auth/session";
import { getBillingOverview, listPlans } from "@/lib/billing/server";

export const metadata: Metadata = { title: "Billing | AI Asis" };
export const dynamic = "force-dynamic";

export default async function BillingPage() {
  const { supabase, user } = await requireUser();
  const membership = await getPrimaryMembership(supabase, user.id);
  const [overview, { plans }] = await Promise.all([
    membership ? getBillingOverview(supabase, membership.firmId) : Promise.resolve(null),
    listPlans(supabase),
  ]);
  // Role comes from the database. The server re-checks it on every plan change; this only decides which buttons to show.
  const canManage = membership?.role === "owner" || membership?.role === "admin";

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[240px_1fr]">
      <DashboardSidebar current="billing" />
      <main className="p-4 sm:p-6 lg:p-8">
        <h1 className="text-2xl font-bold tracking-tight">Billing</h1>
        <p className="mt-1 text-sm text-ink-muted">Your plan, usage and subscription status.</p>
        <div className="mt-6">
          {overview ? (
            <BillingClient overview={overview} plans={plans} canManage={canManage} />
          ) : (
            <p role="alert" className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800">
              {membership
                ? "Billing details could not be loaded. If you just updated the app, check that the Phase 5 database migrations have been run."
                : "No firm was found for this account."}
            </p>
          )}
        </div>
      </main>
    </div>
  );
}
