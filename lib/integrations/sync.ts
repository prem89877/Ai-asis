// Sends VERIFIED invoices to a spreadsheet through a "driver" (Google Sheets or Excel Online) and a "ledger" (the database).
// Safety rules, each covered by tests/integrations-core.test.mjs:
//  1. Only verified invoices are sent.
//  2. The ledger claims every invoice before anything is written, so a second click, a second tab or a parallel run cannot
//     write it again ("already_synced" / "in_progress"). The same supplier invoice uploaded twice is "duplicate".
//  3. Header row is checked before any write; if somebody changed it, nothing is written.
//  4. All new rows go out in ONE append request. An append is never retried after an unknown outcome (see http.ts).
//  5. Before appending, the sheet's AI Asis ID column is read: rows that are already there (the response of an earlier
//     attempt was lost) are marked synced ("recovered") and are not appended again.
import type { ExportInvoice } from "../export/columns.ts";
import { IntegrationError, userMessage } from "./http.ts";
import { buildRow, dedupeKey, headersMatch } from "./mapping.ts";
import type { DateFormat, Guard, MappingEntry } from "./mapping.ts";

export const MAX_INVOICES_PER_SYNC = 25;

export interface SheetDriver {
  guard: Guard;
  readHeaders(): Promise<string[]>;
  readColumn(index: number): Promise<string[]>;
  append(rows: (string | number)[][]): Promise<{ firstRow: number }>; // firstRow 0 = unknown
}

export type ClaimResult =
  | { kind: "claimed" }
  | { kind: "already_synced" }
  | { kind: "in_progress" }
  | { kind: "duplicate_of"; invoiceId: string };
export interface FinishInfo { status: "synced" | "failed"; code?: string; message?: string; row?: number | null }
export interface SyncLedger {
  claim(invoiceId: string, key: string | null): Promise<ClaimResult>;
  finish(invoiceId: string, result: FinishInfo): Promise<void>;
}

export type SyncStatus = "synced" | "recovered" | "already_synced" | "duplicate" | "not_verified" | "in_progress" | "failed";
export interface SyncResult { invoiceId: string; status: SyncStatus; message?: string; code?: string }

export interface SyncArgs {
  invoices: ExportInvoice[];
  mapping: MappingEntry[];
  dateFormat: DateFormat;
  driver: SheetDriver;
  ledger: SyncLedger;
}

export async function syncInvoices(args: SyncArgs): Promise<SyncResult[]> {
  const { invoices, mapping, dateFormat, driver, ledger } = args;
  const out: SyncResult[] = new Array(invoices.length);
  const claimed: { i: number; inv: ExportInvoice }[] = [];
  const seen = new Map<string, string>(); // dedupe key -> first invoice id in this run

  for (let i = 0; i < invoices.length; i++) {
    const inv = invoices[i];
    if (inv.status !== "verified") { out[i] = { invoiceId: inv.id, status: "not_verified", message: "Only verified invoices are synced." }; continue; }
    const key = dedupeKey(inv);
    if (key && seen.has(key)) { out[i] = { invoiceId: inv.id, status: "duplicate", message: "The same supplier invoice is already in this run." }; continue; }
    const c = await ledger.claim(inv.id, key);
    if (c.kind === "already_synced") { out[i] = { invoiceId: inv.id, status: "already_synced" }; continue; }
    if (c.kind === "in_progress") { out[i] = { invoiceId: inv.id, status: "in_progress", message: "Another sync of this invoice is still running." }; continue; }
    if (c.kind === "duplicate_of") { out[i] = { invoiceId: inv.id, status: "duplicate", message: "The same supplier invoice (same number) was already synced from another upload." }; continue; }
    if (key) seen.set(key, inv.id);
    claimed.push({ i, inv });
  }
  if (claimed.length === 0) return out;

  const open = new Set(claimed.map((c) => c.i)); // claimed, not yet finished
  const failOpen = async (code: string, message: string) => {
    for (const c of claimed) {
      if (!open.has(c.i)) continue;
      await ledger.finish(c.inv.id, { status: "failed", code, message });
      out[c.i] = { invoiceId: c.inv.id, status: "failed", code, message };
      open.delete(c.i);
    }
  };

  try {
    const headers = await driver.readHeaders();
    if (!headersMatch(mapping, headers)) {
      const um = userMessage(new IntegrationError("header_changed"));
      await failOpen(um.code, um.message);
      return out;
    }
    const idIndex = mapping.findIndex((m) => m.field === "id");
    const present = new Set(idIndex >= 0 ? await driver.readColumn(idIndex) : []);

    const toAppend: { i: number; inv: ExportInvoice }[] = [];
    for (const c of claimed) {
      if (present.has(c.inv.id)) {
        await ledger.finish(c.inv.id, { status: "synced", row: null });
        out[c.i] = { invoiceId: c.inv.id, status: "recovered", message: "The row was already in the sheet." };
        open.delete(c.i);
      } else toAppend.push(c);
    }
    if (toAppend.length > 0) {
      const { firstRow } = await driver.append(toAppend.map((c) => buildRow(c.inv, mapping, dateFormat, driver.guard)));
      for (let j = 0; j < toAppend.length; j++) {
        const c = toAppend[j];
        await ledger.finish(c.inv.id, { status: "synced", row: firstRow > 0 ? firstRow + j : null });
        out[c.i] = { invoiceId: c.inv.id, status: "synced" };
        open.delete(c.i);
      }
    }
  } catch (e) {
    const um = userMessage(e);
    await failOpen(um.code, um.message);
  }
  return out;
}
