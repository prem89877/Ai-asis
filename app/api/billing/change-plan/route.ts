import { json } from "@/lib/api/json";
import { readJsonBody } from "@/lib/api/body";
import { guard } from "@/lib/api/guard";
import { allowUnpaidUpgrades } from "@/lib/billing/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { ChangePlanResult } from "@/lib/billing/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PLAN_CODE_RE = /^[a-z][a-z0-9_]{1,31}$/;

const MESSAGES: Record<ChangePlanResult, string> = {
  upgraded: "Your plan has been upgraded.",
  payment_required: "Upgrade requested. Your plan will change once payment is confirmed. Online payment is not available yet.",
  downgrade_scheduled: "Downgrade scheduled. Your current plan stays active until the end of the billing period.",
  pending_cancelled: "The scheduled plan change was cancelled.",
  unchanged: "You are already on this plan.",
};

// Upgrade, downgrade or cancel a scheduled change. The browser sends only the plan code.
// The firm and the user's role come from the database; the price, limits and effect come from the plans table.
export async function POST(request: Request) {
  const g = await guard(request, { mutating: true });
  if (!g.ok) return g.response;

  const body = await readJsonBody(request);
  if (!body.ok) return json({ error: body.message }, body.status);
  const planCode = (body.value as { planCode?: unknown } | null)?.planCode;
  if (typeof planCode !== "string" || !PLAN_CODE_RE.test(planCode)) return json({ error: "Choose a valid plan." }, 400);

  const admin = createAdminClient();
  if (!admin) return json({ error: "Billing is not configured on this server." }, 503);

  const { data, error } = await admin.rpc("change_plan", {
    p_firm_id: g.membership.firmId,
    p_user_id: g.user.id,
    p_new_plan: planCode,
    p_allow_unpaid_upgrade: allowUnpaidUpgrades(),
  });
  if (error || !data) {
    console.error("change_plan_failed", { code: error?.code ?? null });
    return json({ error: "The plan could not be changed. Try again." }, 500);
  }

  const result = (data as { result: string; effective_at?: string; pending_plan_code?: string }).result;
  if (result === "forbidden") return json({ error: "Only the firm owner or an admin can change the plan." }, 403);
  if (result === "unknown_plan") return json({ error: "That plan is not available." }, 400);
  if (result === "no_subscription") return json({ error: "No subscription found for this firm." }, 409);
  if (!(result in MESSAGES)) return json({ error: "The plan could not be changed. Try again." }, 500);

  const kind = result as ChangePlanResult;
  const out = data as { effective_at?: string; pending_plan_code?: string };
  return json(
    { result: kind, message: MESSAGES[kind], pendingPlanCode: out.pending_plan_code ?? null, effectiveAt: out.effective_at ?? null },
    kind === "payment_required" ? 202 : 200
  );
}
