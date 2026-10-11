import type { Metadata } from "next";
import { DashboardLive } from "@/components/dashboard/DashboardLive";
import { getPrimaryMembership, requireUser } from "@/lib/auth/session";
import { getLimits } from "@/lib/extraction/config";
import { formatDate } from "@/lib/format";
import type { JobRow, Summary } from "@/lib/review/client-types";
import type { Activity } from "@/lib/sample-data";

export const metadata: Metadata = { title: "Dashboard | AI Asis" };
export const dynamic = "force-dynamic";

interface JobQueryRow {
  id: string;
  status: string;
  error_code: string | null;
  finished_at: string | null;
  queued_at: string;
  invoices: { original_filename: string } | { original_filename: string }[] | null;
}

export default async function DashboardPage() {
  const { supabase, user } = await requireUser();
  const membership = await getPrimaryMembership(supabase, user.id);
  const limits = getLimits();

  const [{ data: profile }, { data: firm }, summaryRes, jobsRes, exportsRes, eventsRes] = await Promise.all([
    supabase.from("profiles").select("full_name").eq("id", user.id).maybeSingle(),
    membership ? supabase.from("firms").select("name").eq("id", membership.firmId).maybeSingle() : Promise.resolve({ data: null }),
    membership ? supabase.rpc("review_summary", { p_firm_id: membership.firmId }) : Promise.resolve({ data: null, error: null }),
    membership
      ? supabase
          .from("processing_jobs")
          .select("id, status, error_code, finished_at, queued_at, invoices(original_filename)")
          .eq("firm_id", membership.firmId)
          .order("created_at", { ascending: false })
          .limit(15)
      : Promise.resolve({ data: [] }),
    membership
      ? supabase.from("export_history").select("id, format, invoice_count, created_at").eq("firm_id", membership.firmId).order("created_at", { ascending: false }).limit(5)
      : Promise.resolve({ data: [] }),
    membership
      ? supabase.from("review_events").select("id, action, created_at, invoices(original_filename)").eq("firm_id", membership.firmId).order("created_at", { ascending: false }).limit(5)
      : Promise.resolve({ data: [] }),
  ]);

  const nameOf = (rel: { original_filename: string } | { original_filename: string }[] | null | undefined) =>
    (Array.isArray(rel) ? rel[0]?.original_filename : rel?.original_filename) ?? "an invoice";

  const jobs: JobRow[] = ((jobsRes.data ?? []) as unknown as JobQueryRow[]).map((j) => ({
    id: j.id,
    status: j.status,
    error_code: j.error_code,
    finished_at: j.finished_at,
    queued_at: j.queued_at,
    filename: nameOf(j.invoices),
  }));

  const verbs: Record<string, string> = { edit: "edited", verify: "verified", unverify: "verification removed for" };
  const events = ((eventsRes.data ?? []) as unknown as { id: string; action: string; created_at: string; invoices: { original_filename: string } | { original_filename: string }[] | null }[]).map((e) => ({
    at: e.created_at,
    item: { id: `ev-${e.id}`, message: `You ${verbs[e.action] ?? e.action} ${nameOf(e.invoices)}`, time: formatDate(e.created_at), tone: (e.action === "verify" ? "success" : "info") as Activity["tone"] },
  }));
  const exportsAct = ((exportsRes.data ?? []) as { id: string; format: string; invoice_count: number; created_at: string }[]).map((x) => ({
    at: x.created_at,
    item: { id: `ex-${x.id}`, message: `${x.format.toUpperCase()} export of ${x.invoice_count} invoice${x.invoice_count === 1 ? "" : "s"}`, time: formatDate(x.created_at), tone: "success" as Activity["tone"] },
  }));
  const activity: Activity[] = [...events, ...exportsAct].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 6).map((x) => x.item);

  const summary = summaryRes.error || !summaryRes.data ? null : (summaryRes.data as Summary);

  return (
    <DashboardLive
      displayName={(profile as { full_name: string | null } | null)?.full_name ?? user.email ?? "Account"}
      firmName={(firm as { name: string } | null)?.name ?? "Your firm"}
      summary={summary}
      summaryError={!summary && !!membership}
      monthlyLimit={limits.monthlyLimit}
      jobs={jobs}
      activity={activity}
      maxBatchFiles={limits.batchMaxFiles}
    />
  );
}
