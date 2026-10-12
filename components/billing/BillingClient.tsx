"use client";

import Link from "next/link";
import { CalendarClock, Info } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { PlanCard } from "@/components/billing/PlanCard";
import { SubscriptionBadge } from "@/components/billing/SubscriptionBadge";
import { messageClass, usePlanChange } from "@/components/billing/usePlanChange";
import { changeKind, formatPlanPrice, usageLevel, usagePercent } from "@/lib/billing/plans";
import { formatDayIST } from "@/lib/format";
import type { BillingOverview, PlanInfo } from "@/lib/billing/types";

interface Props {
  overview: BillingOverview;
  plans: PlanInfo[];
  /** true for owner and admin. The server checks the role again on every change. */
  canManage: boolean;
}

export function BillingClient({ overview, plans, canManage }: Props) {
  const { busyCode, message, change } = usePlanChange();
  const { plan, subscription, usage } = overview;
  const pending = subscription.pending;
  const pct = usagePercent(usage.used, usage.limit);
  const level = usageLevel(usage.used, usage.limit);
  const barColor = level === "full" ? "bg-red-600" : level === "warning" ? "bg-amber-500" : "bg-success";

  function choose(target: PlanInfo, kind: "upgrade" | "downgrade") {
    if (kind === "downgrade" && !window.confirm(`Switch to ${target.name} at the end of the current billing period? Your current plan stays active until then.`)) return;
    void change(target.code);
  }

  return (
    <div className="space-y-6">
      <div role="status" aria-live="polite">
        {message && <p className={messageClass[message.tone]}>{message.text}</p>}
      </div>

      <section aria-labelledby="current-plan" className="rounded-xl border border-slate-200 bg-white shadow-card">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 px-5 py-4">
          <div>
            <h2 id="current-plan" className="text-base font-semibold">Current plan</h2>
            <p className="mt-1 text-2xl font-bold tracking-tight">
              {plan.name}
              <span className="ml-2 text-base font-medium text-ink-muted">
                {formatPlanPrice(plan)}{plan.price_paise > 0 ? " /month" : ""}
              </span>
            </p>
            {plan.is_proposed && <p className="mt-0.5 text-xs text-ink-muted">Proposed pricing</p>}
          </div>
          <SubscriptionBadge status={subscription.status} />
        </div>

        <div className="grid gap-6 p-5 text-sm lg:grid-cols-2">
          <div>
            <div className="flex justify-between">
              <span>Invoices used this period</span>
              <span className="font-medium tabular-nums">{usage.used.toLocaleString("en-IN")} / {usage.limit.toLocaleString("en-IN")}</span>
            </div>
            <div className="mt-1 h-2 overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Invoices used this billing period">
              <div className={`h-full ${barColor}`} style={{ width: `${pct}%` }} />
            </div>
            <p className="mt-2 text-ink-muted">
              {usage.remaining.toLocaleString("en-IN")} remaining.
              {level === "warning" && " You are close to your limit."}
              {level === "full" && " Your limit is reached: new invoices stay uploaded until you upgrade or the period renews."}
            </p>
            <p className="mt-1 text-xs text-ink-muted">A retry of the same invoice does not use another unit, and failures caused by our service or the AI provider are not counted.</p>
          </div>

          <dl className="grid grid-cols-2 gap-4">
            <div>
              <dt className="text-xs text-ink-muted">Billing period</dt>
              <dd className="font-medium">{formatDayIST(subscription.current_period_start)} to {formatDayIST(subscription.current_period_end)}</dd>
            </div>
            <div>
              <dt className="text-xs text-ink-muted">Renews / resets on</dt>
              <dd className="font-medium">{formatDayIST(subscription.current_period_end)}</dd>
            </div>
            <div>
              <dt className="text-xs text-ink-muted">Files per upload</dt>
              <dd className="font-medium tabular-nums">Up to {plan.batch_max_files.toLocaleString("en-IN")}</dd>
            </div>
            <div>
              <dt className="text-xs text-ink-muted">Invoices per period</dt>
              <dd className="font-medium tabular-nums">{plan.monthly_invoice_limit.toLocaleString("en-IN")}</dd>
            </div>
          </dl>
        </div>

        {subscription.status !== "active" && subscription.status !== "trialing" && (
          <p role="alert" className="mx-5 mb-5 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800">
            Your subscription is {subscription.status === "past_due" ? "past due" : "suspended"}, so new invoices cannot be processed. Online payment is not available yet; contact support to resolve this.
          </p>
        )}
      </section>

      {pending && (
        <section aria-labelledby="pending-change" className="rounded-xl border border-blue-200 bg-brand-soft p-5">
          <h2 id="pending-change" className="flex items-center gap-2 text-base font-semibold text-blue-900">
            <CalendarClock className="h-4 w-4" aria-hidden />
            Pending plan change
          </h2>
          <p className="mt-2 text-sm text-blue-900">
            {pending.kind === "downgrade"
              ? `Your plan will change to ${pending.plan_name ?? pending.plan_code} on ${pending.effective_at ? formatDayIST(pending.effective_at) : "the next renewal"}. ${plan.name} stays active until then.`
              : `An upgrade to ${pending.plan_name ?? pending.plan_code} is waiting for payment. Your plan will change once payment is confirmed. Online payment is not available yet, so ${plan.name} stays active for now.`}
          </p>
          {canManage && (
            <Button variant="secondary" className="mt-4" loading={busyCode === plan.code} disabled={busyCode !== null} onClick={() => void change(plan.code)}>
              Cancel change
            </Button>
          )}
        </section>
      )}

      <section aria-labelledby="change-plan">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <h2 id="change-plan" className="text-base font-semibold">{canManage ? "Change plan" : "Available plans"}</h2>
          <Link href="/pricing" className="text-sm font-medium text-brand hover:underline">Compare on the pricing page</Link>
        </div>
        {!canManage && (
          <p className="mt-2 flex items-start gap-2 rounded-lg border border-slate-200 bg-white p-3 text-sm text-ink-muted">
            <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            Only the firm owner or an admin can change the plan. You can see the details here.
          </p>
        )}
        <div className="mt-4 grid gap-6 lg:grid-cols-3">
          {plans.map((p) => {
            const kind = changeKind(plan, p);
            return (
              <PlanCard key={p.code} plan={p} badge={kind === "current" ? "Current plan" : undefined} highlight={kind === "current"}>
                {kind === "current" ? (
                  <Button variant="secondary" className="w-full" disabled>Current plan</Button>
                ) : pending?.plan_code === p.code ? (
                  <Button variant="secondary" className="w-full" disabled>Change pending</Button>
                ) : canManage ? (
                  <Button variant={kind === "upgrade" ? "primary" : "secondary"} className="w-full" loading={busyCode === p.code} disabled={busyCode !== null} onClick={() => choose(p, kind)}>
                    {kind === "upgrade" ? `Upgrade to ${p.name}` : `Downgrade to ${p.name}`}
                  </Button>
                ) : null}
              </PlanCard>
            );
          })}
        </div>
        <p className="mt-4 text-xs text-ink-muted">
          Downgrades start at the end of the current billing period. Choosing Pilot is how you cancel a paid plan. Upgrades that need payment apply only after payment is confirmed; online payment is not available yet.
        </p>
      </section>
    </div>
  );
}
