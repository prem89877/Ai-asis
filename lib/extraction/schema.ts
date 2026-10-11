// Strict validation of the model's JSON and the schema sent to Gemini.
// The model is untrusted: anything that does not match exactly is rejected, never repaired.
import {
  DOCUMENT_TYPES,
  HEADER_AMOUNT_FIELDS,
  HEADER_TEXT_FIELDS,
  ITEM_NUMBER_FIELDS,
  ITEM_TEXT_FIELDS,
} from "./types.ts";
import type { FieldStatus, ModelOutput } from "./types.ts";

export const MAX_LINE_ITEMS = 200;
const MAX_TEXT = 500;
const MAX_ERRORS = 25;

export type ValidationResult =
  | { ok: true; data: ModelOutput }
  | { ok: false; errors: string[] };

const STATUSES: readonly FieldStatus[] = ["present", "missing", "unreadable"];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function checkKeys(obj: Record<string, unknown>, allowed: readonly string[], path: string, errors: string[]) {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) errors.push(`${path}.${key}: unexpected key`);
  }
  for (const key of allowed) {
    if (!(key in obj)) errors.push(`${path}.${key}: required`);
  }
}

function checkField(value: unknown, kind: "string" | "number", path: string, errors: string[]) {
  if (!isRecord(value)) {
    errors.push(`${path}: must be an object`);
    return;
  }
  checkKeys(value, ["status", "value", "confidence"], path, errors);

  const status = value.status;
  if (typeof status !== "string" || !STATUSES.includes(status as FieldStatus)) {
    errors.push(`${path}.status: must be present, missing or unreadable`);
    return;
  }
  const c = value.confidence;
  if (typeof c !== "number" || !Number.isFinite(c) || c < 0 || c > 1) {
    errors.push(`${path}.confidence: must be a number from 0 to 1`);
  }

  const v = value.value;
  if (status !== "present") {
    // A field that is missing or unreadable must not carry a value. No guessing.
    if (v !== null) errors.push(`${path}.value: must be null when status is ${status}`);
    return;
  }
  if (kind === "string") {
    if (typeof v !== "string" || v.trim() === "") {
      errors.push(`${path}.value: must be a non-empty string when present`);
    } else if (v.length > MAX_TEXT) {
      errors.push(`${path}.value: too long`);
    }
  } else if (typeof v !== "number" || !Number.isFinite(v)) {
    errors.push(`${path}.value: must be a finite number when present`);
  }
}

export function validateModelOutput(input: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isRecord(input)) return { ok: false, errors: ["root: must be an object"] };

  checkKeys(input, ["document_type", "line_items", ...HEADER_TEXT_FIELDS, ...HEADER_AMOUNT_FIELDS], "root", errors);

  if (typeof input.document_type !== "string" || !(DOCUMENT_TYPES as readonly string[]).includes(input.document_type)) {
    errors.push("root.document_type: not an allowed value");
  }
  for (const key of HEADER_TEXT_FIELDS) {
    if (key in input) checkField(input[key], "string", key, errors);
  }
  for (const key of HEADER_AMOUNT_FIELDS) {
    if (key in input) checkField(input[key], "number", key, errors);
  }

  const items = input.line_items;
  if (!Array.isArray(items)) {
    errors.push("root.line_items: must be an array");
  } else if (items.length > MAX_LINE_ITEMS) {
    errors.push(`root.line_items: more than ${MAX_LINE_ITEMS} items`);
  } else {
    items.forEach((item, i) => {
      const path = `line_items[${i}]`;
      if (!isRecord(item)) {
        errors.push(`${path}: must be an object`);
        return;
      }
      checkKeys(item, [...ITEM_TEXT_FIELDS, ...ITEM_NUMBER_FIELDS], path, errors);
      for (const key of ITEM_TEXT_FIELDS) if (key in item) checkField(item[key], "string", `${path}.${key}`, errors);
      for (const key of ITEM_NUMBER_FIELDS) if (key in item) checkField(item[key], "number", `${path}.${key}`, errors);
    });
  }

  if (errors.length > 0) return { ok: false, errors: errors.slice(0, MAX_ERRORS) };
  return { ok: true, data: input as unknown as ModelOutput };
}

// ---- Gemini responseSchema (OpenAPI subset). Validation above stays the real gate. ----------

function fieldSchema(valueType: "STRING" | "NUMBER") {
  return {
    type: "OBJECT",
    properties: {
      status: { type: "STRING", enum: ["present", "missing", "unreadable"] },
      value: { type: valueType, nullable: true },
      confidence: { type: "NUMBER" },
    },
    required: ["status", "value", "confidence"],
    propertyOrdering: ["status", "value", "confidence"],
  };
}

export function buildResponseSchema() {
  const itemProps: Record<string, unknown> = {};
  for (const k of ITEM_TEXT_FIELDS) itemProps[k] = fieldSchema("STRING");
  for (const k of ITEM_NUMBER_FIELDS) itemProps[k] = fieldSchema("NUMBER");
  const itemKeys = [...ITEM_TEXT_FIELDS, ...ITEM_NUMBER_FIELDS];

  const props: Record<string, unknown> = {
    document_type: { type: "STRING", enum: [...DOCUMENT_TYPES] },
  };
  for (const k of HEADER_TEXT_FIELDS) props[k] = fieldSchema("STRING");
  for (const k of HEADER_AMOUNT_FIELDS) props[k] = fieldSchema("NUMBER");
  props.line_items = {
    type: "ARRAY",
    items: { type: "OBJECT", properties: itemProps, required: itemKeys, propertyOrdering: itemKeys },
  };

  const keys = ["document_type", ...HEADER_TEXT_FIELDS, ...HEADER_AMOUNT_FIELDS, "line_items"];
  return { type: "OBJECT", properties: props, required: keys, propertyOrdering: keys };
}
