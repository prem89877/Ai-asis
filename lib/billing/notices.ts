// Turns the answer of POST /api/invoices/enqueue into a message for the dashboard.
// Dependency-free so it can be unit tested. The server decides everything; this only explains it.

export interface Notice {
  /** true = good news, false = something the person should act on */
  ok: boolean;
  text: string;
  /** show a link to the plans / billing page */
  upgrade: boolean;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function describeEnqueue(status: number, data: Record<string, unknown>, uploaded: number): Notice {
  const code = typeof data.code === "string" ? data.code : null;
  const serverError = typeof data.error === "string" ? data.error : null;
  const queued = Array.isArray(data.enqueued) ? data.enqueued.length : 0;
  const skipped = Array.isArray(data.skipped) ? (data.skipped as { reason?: unknown }[]) : [];
  const quotaSkipped = skipped.filter((s) => s.reason === "quota_exceeded").length;
  const kept = `${plural(uploaded, "file was", "files were")} saved and stay "Uploaded"`;

  if (status >= 400) {
    if (code === "quota_exceeded") {
      return { ok: false, upgrade: true, text: `Your plan's invoice limit for this billing period is used up, so nothing was processed. ${kept}. You can process them after you upgrade or when the next period starts.` };
    }
    if (code === "subscription_inactive") {
      return { ok: false, upgrade: true, text: `${serverError ?? "Your subscription is not active."} ${kept}.` };
    }
    if (code === "batch_limit") {
      return { ok: false, upgrade: true, text: `${serverError ?? "That is more files than your plan allows at a time."} ${kept}.` };
    }
    if (code === "no_subscription") {
      return { ok: false, upgrade: false, text: `${serverError ?? "No subscription was found for your firm."} ${kept}.` };
    }
    return { ok: false, upgrade: false, text: serverError ?? "Could not queue extraction." };
  }

  if (quotaSkipped > 0) {
    return {
      ok: false,
      upgrade: true,
      text: `${plural(queued, "invoice was", "invoices were")} queued. ${plural(quotaSkipped, "invoice was", "invoices were")} not queued because your plan's invoice limit is reached. They stay "Uploaded" and can be processed after you upgrade or when the next period starts.`,
    };
  }
  return { ok: true, upgrade: false, text: "" };
}
