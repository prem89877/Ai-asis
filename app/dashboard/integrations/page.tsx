import type { Metadata } from "next";
import { DashboardSidebar } from "@/components/dashboard/DashboardSidebar";
import { IntegrationsClient } from "@/components/integrations/IntegrationsClient";
import { getPrimaryMembership, requireUser } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Integrations | AI Asis" };
export const dynamic = "force-dynamic";

export default async function IntegrationsPage() {
  const { supabase, user } = await requireUser();
  const membership = await getPrimaryMembership(supabase, user.id);
  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[240px_1fr]">
      <DashboardSidebar current="integrations" />
      <main className="p-4 sm:p-6 lg:p-8">
        <h1 className="text-2xl font-bold tracking-tight">Integrations</h1>
        <p className="mt-1 text-sm text-ink-muted">Send verified invoices to Google Sheets, Excel Online or Zoho Sheet, create purchase bills in Zoho Books, post vouchers to TallyPrime, and prepare accounting exports.</p>
        <div className="mt-6">
          {membership ? (
            <IntegrationsClient />
          ) : (
            <p role="alert" className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800">No firm was found for this account.</p>
          )}
        </div>
      </main>
    </div>
  );
}
