// Safe parsing of the model's text answer. It accepts exactly what a careful reader would: the JSON itself, JSON inside a code
// fence, or one complete JSON object with plain words around it. It never repairs: no added brackets, no fixed quotes, no
// trailing-comma removal. A cut-off answer is reported as "truncated" and is rejected (invented values are worse than none).

export type ParseFailure = "empty" | "not_json" | "truncated" | "not_object";
export type ParseResult = { ok: true; value: Record<string, unknown>; extracted: boolean } | { ok: false; reason: ParseFailure };

function tryParse(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

// Complete {...} objects in the text, string-aware, in order of appearance. "truncated" when the first brace never closes.
function candidateObjects(text: string): { objects: string[]; truncated: boolean } {
  const objects: string[] = [];
  let from = text.indexOf("{");
  let truncated = false;
  while (from >= 0) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let i = from; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end < 0) {
      if (objects.length === 0) truncated = true;
      break;
    }
    objects.push(text.slice(from, end + 1));
    from = text.indexOf("{", from + 1);
  }
  return { objects, truncated };
}

function asObject(v: unknown, extracted: boolean): ParseResult {
  if (typeof v === "object" && v !== null && !Array.isArray(v)) return { ok: true, value: v as Record<string, unknown>, extracted };
  return { ok: false, reason: "not_object" };
}

export function parseModelJson(input: unknown): ParseResult {
  if (typeof input !== "string") return { ok: false, reason: "empty" };
  const text = input.replace(/^\uFEFF/, "").trim();
  if (text === "") return { ok: false, reason: "empty" };

  const direct = tryParse(text);
  if (direct.ok) return asObject(direct.value, false);

  const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(text);
  if (fenced) {
    const f = tryParse(fenced[1]);
    if (f.ok) return asObject(f.value, true);
  }

  const { objects, truncated } = candidateObjects(text);
  if (objects.length === 0) return { ok: false, reason: truncated ? "truncated" : "not_json" };
  // Words with braces can come before the JSON ("{x}"): the first candidate that is a complete JSON object wins.
  for (const o of objects) {
    const inner = tryParse(o);
    if (inner.ok && typeof inner.value === "object" && inner.value !== null && !Array.isArray(inner.value)) return asObject(inner.value, true);
  }
  return { ok: false, reason: "not_json" };
}
