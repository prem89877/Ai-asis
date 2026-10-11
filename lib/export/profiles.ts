// Export profiles: the extension point for accounting-software formats.
//
// "standard" (CSV / XLSX, configurable columns) is the only profile that exists and is tested.
// A Tally-compatible profile is only a PLANNED entry. There is NO Tally integration in this codebase:
// no XML, no ledger mapping, no import has been written or tested against Tally. Do not describe it as supported.
//
// To add a profile later: implement ExportProfile (map invoices + items to the target layout), register it here with
// status "available" only after it has been tried in the target software with real data, and add it to the
// export_history.profile values used by the UI.
import type { ExportInvoice, ExportItem } from "./columns.ts";

export interface ProfileOutput {
  fileName: string;
  contentType: string;
  bytes: Uint8Array;
}

export interface ExportProfile {
  id: string;
  label: string;
  formats: readonly ("csv" | "xlsx")[];
  status: "available" | "planned";
  note: string;
  build?(invoices: ExportInvoice[], items: Map<string, ExportItem[]>, options: Record<string, unknown>): ProfileOutput;
}

export const EXPORT_PROFILES: readonly ExportProfile[] = [
  {
    id: "standard",
    label: "Standard (CSV / Excel)",
    formats: ["csv", "xlsx"],
    status: "available",
    note: "Choose and order your own columns. Separate CGST, SGST, IGST and cess columns.",
  },
  {
    id: "tally",
    label: "Tally-compatible",
    formats: [],
    status: "planned",
    note: "Planned, not built and not tested with Tally. Not available.",
  },
];

export function getAvailableProfile(id: string): ExportProfile | null {
  const p = EXPORT_PROFILES.find((x) => x.id === id);
  return p && p.status === "available" ? p : null;
}
