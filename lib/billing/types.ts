// Shapes returned by the billing database functions. Safe to import from client components.

export type SubscriptionStatus = "active" | "trialing" | "past_due" | "suspended";

export interface PlanInfo {
  code: string;
  name: string;
  tagline: string | null;
  price_paise: number;
  price_max_paise: number | null;
  currency: string;
  monthly_invoice_limit: number;
  batch_max_files: number;
  features: string[];
  sort_order: number;
  is_proposed: boolean;
}

export interface PendingChange {
  plan_code: string;
  plan_name: string | null;
  kind: "downgrade" | "upgrade_awaiting_payment";
  effective_at: string | null;
}

export interface BillingOverview {
  plan: PlanInfo;
  subscription: {
    status: SubscriptionStatus;
    current_period_start: string;
    current_period_end: string;
    pending: PendingChange | null;
  };
  usage: { used: number; limit: number; remaining: number };
  can_process: boolean;
}

export type ChangePlanResult =
  | "upgraded"
  | "payment_required"
  | "downgrade_scheduled"
  | "pending_cancelled"
  | "unchanged";
