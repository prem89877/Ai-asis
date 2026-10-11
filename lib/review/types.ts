// Shared shapes for the review workflow. No runtime code.
import type { FieldMeta, ReviewFlag } from "../extraction/types.ts";
import type { HeaderValues, ItemValues } from "./fields.ts";

export type ReviewAction = "save" | "verify" | "unverify";

export interface FieldChange {
  from: string | number | null;
  to: string | number | null;
}

export interface ReviewChanges {
  header: Record<string, FieldChange>;
  items?: { before: number; after: number };
}

export interface StoredItemRow extends ItemValues {
  field_status: Record<string, FieldMeta>;
}

// What the database holds for one invoice before a review request is applied.
export interface CurrentRecord {
  header: HeaderValues;
  field_status: Record<string, FieldMeta>;
  corrected_fields: Record<string, CorrectedField>;
  items: StoredItemRow[];
  updated_at: string;
}

export interface CorrectedField {
  original: string | number | null;
  at: string;
  by: string;
}

export type { FieldMeta, ReviewFlag };
