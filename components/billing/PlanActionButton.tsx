"use client";

import { Button } from "@/components/ui/Button";
import { messageClass, usePlanChange } from "@/components/billing/usePlanChange";

interface Props {
  planCode: string;
  planName: string;
  kind: "upgrade" | "downgrade";
}

// Upgrade / downgrade button with its own message (used on the pricing page). Only rendered for owners and admins.
export function PlanActionButton({ planCode, planName, kind }: Props) {
  const { busyCode, message, change } = usePlanChange();

  function onClick() {
    if (kind === "downgrade" && !window.confirm(`Switch to ${planName} at the end of the current billing period? Your current plan stays active until then.`)) return;
    void change(planCode);
  }

  return (
    <div className="space-y-3">
      <Button variant={kind === "upgrade" ? "primary" : "secondary"} className="w-full" loading={busyCode === planCode} disabled={busyCode !== null} onClick={onClick}>
        {kind === "upgrade" ? `Upgrade to ${planName}` : `Downgrade to ${planName}`}
      </Button>
      <div role="status" aria-live="polite">
        {message && <p className={messageClass[message.tone]}>{message.text}</p>}
      </div>
    </div>
  );
}
