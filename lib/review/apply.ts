// Applies a validated review request to the current record: merges values, updates per-field status,
// remembers the first original value of every corrected field and builds the audit summary.
// Pure functions. Nothing here touches the database.
import { normalizeInvoiceNumber } from "../extraction/normalize.ts";
import type { FieldMeta } from "../extraction/types.ts";
import { HEADER_FIELDS, ITEM_FIELDS } from "./fields.ts";
import type { HeaderColumn, HeaderValues } from "./fields.ts";
import type { ItemInput, ReviewInput } from "./input.ts";
import type { CorrectedField, CurrentRecord, ReviewChanges, StoredItemRow } from "./types.ts";

export interface AppliedReview {
  header: HeaderValues;
  invoiceNumberNorm: string | null;
  fieldStatus: Record<string, FieldMeta>;
  corrected: Record<string, CorrectedField>;
  items: StoredItemRow[] | null; // null = line items untouched
  changes: ReviewChanges;
  headerChanged: boolean;
}

function same(a: string | number | null, b: string | number | null): boolean {
  if (a === null || b === null) return a === b;
  if (typeof a === "number" || typeof b === "number") return Number(a) === Number(b);
  return a === b;
}

// A human-entered value is certain from the model's point of view: confidence 1.
function humanMeta(value: string | number | null): FieldMeta {
  if (value === null) return { state: "missing", confidence: 1 };
  if (typeof value === "number" && value === 0) return { state: "zero", confidence: 1, source: "human" };
  return { state: "value", confidence: 1, source: "human" };
}

export function applyReview(current: CurrentRecord, input: ReviewInput, userId: string, nowIso: string): AppliedReview {
  const header = { ...current.header } as HeaderValues;
  const fieldStatus: Record<string, FieldMeta> = { ...current.field_status };
  const corrected: Record<string, CorrectedField> = { ...current.corrected_fields };
  const changes: ReviewChanges = { header: {} };

  for (const def of HEADER_FIELDS) {
    if (!(def.column in input.header)) continue;
    const next = input.header[def.column] ?? null;
    const prev = current.header[def.column];
    if (same(prev, next)) continue;
    header[def.column] = next;
    changes.header[def.column] = { from: prev, to: next };
    if (def.statusKey !== "document_type") fieldStatus[def.statusKey] = humanMeta(next);
    if (!corrected[def.column]) corrected[def.column] = { original: prev, at: nowIso, by: userId };
  }
  const headerChanged = Object.keys(changes.header).length > 0;

  let items: StoredItemRow[] | null = null;
  if (input.items) {
    const built = input.items.map((it, idx) => buildItem(it, current.items[idx]));
    const unchanged =
      built.length === current.items.length &&
      built.every((row, idx) => ITEM_FIELDS.every((f) => same(row[f.key], current.items[idx][f.key])));
    if (!unchanged) {
      items = built;
      changes.items = { before: current.items.length, after: built.length };
    }
  }

  const inv = header.invoice_number;
  return {
    header,
    invoiceNumberNorm: typeof inv === "string" ? normalizeInvoiceNumber(inv) : null,
    fieldStatus,
    corrected,
    items,
    changes,
    headerChanged,
  };
}

function buildItem(input: ItemInput, prior: StoredItemRow | undefined): StoredItemRow {
  const status: Record<string, FieldMeta> = {};
  for (const f of ITEM_FIELDS) {
    const value = input[f.key];
    const priorMeta = prior?.field_status[f.statusKey];
    if (prior && same(prior[f.key], value) && priorMeta) status[f.statusKey] = priorMeta;
    else if (prior && same(prior[f.key], value) && value === null) status[f.statusKey] = priorMeta ?? humanMeta(null);
    else status[f.statusKey] = humanMeta(value);
  }
  return { ...input, field_status: status };
}
