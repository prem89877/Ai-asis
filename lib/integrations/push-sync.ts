// "Push" sync: one voucher / bill per invoice (Zoho Books, TallyPrime). Same safety rules as the sheet sync (sync.ts):
//  1. only verified invoices; 2. the ledger claims an invoice before anything is sent (second click / second tab / parallel run
//  cannot send it again); 3. the same supplier invoice uploaded twice is a "duplicate"; 4. a send is NEVER retried after an unknown
//  outcome. Each pusher decides what "already there" means for its system (Zoho: bill with our reference number).
import type { ExportInvoice } from "../export/columns.ts";
import { IntegrationError, userMessage } from "./http.ts";
import { dedupeKey } from "./mapping.ts";
import type { SyncLedger, SyncResult } from "./sync.ts";

/** Thrown by a pusher when THIS invoice cannot be sent (unsupported figures, missing tax, ...). The reason is shown to the user. */
export class PushRefusal extends Error {
  code: string;
  constructor(message: string, code = "not_supported") { super(message); this.name = "PushRefusal"; this.code = code; }
}
export interface PushOutcome { recovered?: boolean }
export interface Pusher { push(inv: ExportInvoice): Promise<PushOutcome> }

export const MAX_PUSH_PER_RUN = 15;

export async function pushInvoices(args: { invoices: ExportInvoice[]; pusher: Pusher; ledger: SyncLedger }): Promise<SyncResult[]> {
  const { invoices, pusher, ledger } = args;
  const out: SyncResult[] = [];
  const seen = new Set<string>();
  let stop: { code: string; message: string } | null = null; // an authorisation problem ends the run: every next call would fail the same way

  for (const inv of invoices) {
    if (inv.status !== "verified") { out.push({ invoiceId: inv.id, status: "not_verified", message: "Only verified invoices are synced." }); continue; }
    const key = dedupeKey(inv);
    if (key && seen.has(key)) { out.push({ invoiceId: inv.id, status: "duplicate", message: "The same supplier invoice is already in this run." }); continue; }
    const c = await ledger.claim(inv.id, key);
    if (c.kind === "already_synced") { out.push({ invoiceId: inv.id, status: "already_synced" }); continue; }
    if (c.kind === "in_progress") { out.push({ invoiceId: inv.id, status: "in_progress", message: "Another sync of this invoice is still running." }); continue; }
    if (c.kind === "duplicate_of") { out.push({ invoiceId: inv.id, status: "duplicate", message: "The same supplier invoice (same number) was already synced from another upload." }); continue; }
    if (key) seen.add(key);
    if (stop) { await ledger.finish(inv.id, { status: "failed", code: stop.code, message: stop.message }); out.push({ invoiceId: inv.id, status: "failed", code: stop.code, message: stop.message }); continue; }

    try {
      const r = await pusher.push(inv);
      await ledger.finish(inv.id, { status: "synced", row: null });
      out.push({ invoiceId: inv.id, status: r.recovered ? "recovered" : "synced", ...(r.recovered ? { message: "It was already there." } : {}) });
    } catch (e) {
      let code = "unknown", message = userMessage(e).message;
      if (e instanceof PushRefusal) { code = e.code; message = e.message; }
      else if (e instanceof IntegrationError) {
        code = e.code;
        if (e.code === "auth_expired" || e.code === "permission_denied") stop = { code, message };
      }
      await ledger.finish(inv.id, { status: "failed", code, message });
      out.push({ invoiceId: inv.id, status: "failed", code, message });
    }
  }
  return out;
}
