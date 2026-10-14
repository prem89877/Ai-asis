// Duplicate item rows. A multi-page invoice can be read with a block of rows twice (a page overlap, a repeated page). But the
// same item can also be genuinely billed twice in a row. So a repeat is removed ONLY when the invoice's own taxable total proves
// it: the item rows add up to the printed taxable value without the repeat and do not add up with it. Otherwise the rows stay,
// and when the total cannot settle it a warning asks a person to look. The reading as received is kept by the caller.
import { toPaise } from "./normalize.ts";
import type { ModelField, ModelItem, ModelOutput, ReviewFlag } from "./types.ts";

const MAX_BLOCK = 20;

const val = <T>(f: ModelField<T> | undefined): T | null => (f && f.status === "present" ? (f.value as T) : null);

function rowKey(it: ModelItem): string | null {
  const desc = val(it.description);
  const taxable = val(it.taxable_value);
  const total = val(it.line_total);
  if (desc === null || (taxable === null && total === null)) return null; // not enough on the row to call it a repeat
  return JSON.stringify([
    desc.replace(/\s+/g, " ").trim().toLowerCase(), val(it.hsn_sac), (val(it.unit) ?? "").toLowerCase(),
    val(it.quantity), val(it.unit_price), val(it.discount), taxable, val(it.gst_rate), val(it.tax_amount), total,
  ]);
}

// 0-based indexes of rows that repeat the rows right before them (a single row, or a block of up to MAX_BLOCK rows).
export function findRepeatedRows(items: ModelItem[]): number[] {
  const keys = items.map(rowKey);
  const marked = new Set<number>();
  let i = 0;
  while (i < items.length) {
    let hit = 0;
    for (let len = Math.min(MAX_BLOCK, Math.floor((items.length - i) / 2)); len >= 1; len--) {
      let same = true;
      for (let k = 0; k < len && same; k++) same = keys[i + k] !== null && keys[i + k] === keys[i + len + k];
      if (same) { hit = len; break; }
    }
    if (hit > 0) {
      for (let k = 0; k < hit; k++) marked.add(i + hit + k);
      i += hit;
    } else i += 1;
  }
  return Array.from(marked).sort((a, b) => a - b);
}

export interface ItemRowsResult {
  model: ModelOutput; // same object when nothing was removed
  removed: number[]; // 1-based positions in the reading as received
  flags: ReviewFlag[];
}

export function dedupeItemRows(model: ModelOutput, opts: { tolerancePaise: number }): ItemRowsResult {
  const same: ItemRowsResult = { model, removed: [], flags: [] };
  const repeated = findRepeatedRows(model.line_items);
  if (repeated.length === 0) return same;

  const positions = repeated.map((i) => i + 1);
  const taxable = model.line_items.map((it) => val(it.taxable_value));
  const invoiceTaxable = val(model.taxable_value);
  const evidence = invoiceTaxable !== null && taxable.every((t) => t !== null);
  if (evidence) {
    const target = toPaise(invoiceTaxable as number);
    const sum = (skip: Set<number>) => taxable.reduce<number>((a, t, i) => (skip.has(i) ? a : a + toPaise(t as number)), 0);
    const drop = new Set(repeated);
    const withAll = Math.abs(sum(new Set()) - target);
    const without = Math.abs(sum(drop) - target);
    const removedSum = Math.abs(sum(new Set(taxable.map((_, i) => i).filter((i) => !drop.has(i)))));
    if (withAll <= opts.tolerancePaise) return same; // the rows add up as they are: genuine repeated items
    if (without <= opts.tolerancePaise && removedSum > opts.tolerancePaise) {
      return {
        model: { ...model, line_items: model.line_items.filter((_, i) => !drop.has(i)) },
        removed: positions,
        flags: [{ code: "duplicate_item_rows_removed", severity: "info", message: "Repeated item rows were removed because the remaining rows add up to the invoice taxable value and the repeated rows do not. The original reading is kept.", details: { positions } }],
      };
    }
  }
  return {
    ...same,
    flags: [{
      code: "possible_duplicate_item_rows", severity: "warning", itemPosition: positions[0],
      message: "Some item rows are identical to the rows before them. They were kept. Check the original: they may be one page read twice, or the same item billed twice.",
      details: { positions, total_check: evidence ? "rows_do_not_add_up_either_way" : "not_available" },
    }],
  };
}
