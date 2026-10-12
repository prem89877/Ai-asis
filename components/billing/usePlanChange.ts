"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export interface ChangeMessage {
  tone: "success" | "info" | "error";
  text: string;
}

// The browser sends ONLY a plan code. The server decides who may change the plan, what it costs,
// whether it applies now or later, and what the quota becomes. The answer is shown as it is.
export function usePlanChange() {
  const router = useRouter();
  const [busyCode, setBusyCode] = useState<string | null>(null);
  const [message, setMessage] = useState<ChangeMessage | null>(null);

  async function change(planCode: string) {
    if (busyCode) return;
    setBusyCode(planCode);
    setMessage(null);
    try {
      const res = await fetch("/api/billing/change-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planCode }),
      });
      const data = (await res.json().catch(() => ({}))) as { result?: string; message?: string; error?: string };
      if (!res.ok) {
        setMessage({ tone: "error", text: data.error ?? "The plan could not be changed. Try again." });
      } else {
        // 202 payment_required is not an error and not a success: the plan has NOT changed yet.
        setMessage({ tone: data.result === "payment_required" ? "info" : "success", text: data.message ?? "Done." });
      }
      router.refresh();
    } catch {
      setMessage({ tone: "error", text: "Network error. Try again." });
    } finally {
      setBusyCode(null);
    }
  }

  return { busyCode, message, change };
}

export const messageClass: Record<ChangeMessage["tone"], string> = {
  success: "rounded-lg border border-emerald-300 bg-success-soft p-3 text-sm text-success-ink",
  info: "rounded-lg border border-blue-200 bg-brand-soft p-3 text-sm text-blue-900",
  error: "rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800",
};
