// Turns invoices (and their items) into plain tables. Serializers (CSV, XLSX) only format; they never decide content.
import { INVOICE_COLUMNS, ITEM_COLUMNS } from "./columns.ts";
import type { CellValue, ColumnKind, ExportInvoice, ExportItem } from "./columns.ts";

export interface Table {
  name: string;
  headers: string[];
  kinds: ColumnKind[];
  widths: number[];
  rows: CellValue[][];
}

export interface BuildOptions {
  format: "csv" | "xlsx";
  columns: string[];
  itemColumns: string[];
  includeItems: boolean;
}

function colMap<T extends { key: string }>(all: readonly T[]): Map<string, T> {
  return new Map(all.map((c) => [c.key, c]));
}

// Stable, readable order: invoice date, then number, then upload time.
export function sortInvoices(invoices: ExportInvoice[]): ExportInvoice[] {
  return [...invoices].sort((a, b) => {
    const d = (a.invoice_date ?? "9999-12-31").localeCompare(b.invoice_date ?? "9999-12-31");
    if (d !== 0) return d;
    const n = (a.invoice_number ?? "").localeCompare(b.invoice_number ?? "", "en", { numeric: true });
    if (n !== 0) return n;
    return a.created_at.localeCompare(b.created_at);
  });
}

export function buildTables(invoices: ExportInvoice[], items: Map<string, ExportItem[]>, opts: BuildOptions): Table[] {
  const invCols = colMap(INVOICE_COLUMNS);
  const itemCols = colMap(ITEM_COLUMNS);
  const sorted = sortInvoices(invoices);
  const chosen = opts.columns.map((k) => invCols.get(k)).filter((c): c is NonNullable<typeof c> => !!c);
  const itemsOf = (id: string) => (items.get(id) ?? []).slice().sort((a, b) => a.position - b.position);

  const invoiceTable: Table = {
    name: "Invoices",
    headers: chosen.map((c) => c.label),
    kinds: chosen.map((c) => c.kind),
    widths: chosen.map((c) => c.width),
    rows: sorted.map((inv) => chosen.map((c) => c.get(inv))),
  };
  if (!opts.includeItems) return [invoiceTable];

  if (opts.format === "xlsx") {
    // Separate sheet; reference columns repeat the invoice so the sheet can be filtered on its own.
    const ic = opts.itemColumns.map((k) => itemCols.get(k)).filter((c): c is NonNullable<typeof c> => !!c);
    const itemTable: Table = {
      name: "Line items",
      headers: ic.map((c) => c.label),
      kinds: ic.map((c) => c.kind),
      widths: ic.map((c) => c.width),
      rows: sorted.flatMap((inv) => itemsOf(inv.id).map((it) => ic.map((c) => c.get(it, inv)))),
    };
    return [invoiceTable, itemTable];
  }

  // CSV has one table only: one row per item, invoice columns repeated. Invoices without items keep one row.
  const ic = opts.itemColumns.map((k) => itemCols.get(k)).filter((c): c is NonNullable<typeof c> => !!c && !c.reference);
  const flat: Table = {
    name: "Invoices",
    headers: [...invoiceTable.headers, ...ic.map((c) => `Item: ${c.label}`)],
    kinds: [...invoiceTable.kinds, ...ic.map((c) => c.kind)],
    widths: [...invoiceTable.widths, ...ic.map((c) => c.width)],
    rows: [],
  };
  for (const inv of sorted) {
    const base = chosen.map((c) => c.get(inv));
    const its = itemsOf(inv.id);
    if (its.length === 0) flat.rows.push([...base, ...ic.map(() => null)]);
    else for (const it of its) flat.rows.push([...base, ...ic.map((c) => c.get(it, inv))]);
  }
  return [flat];
}
