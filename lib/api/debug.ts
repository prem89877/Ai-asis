// TEMPORARY (remove in the next phase): shows the exact technical error in the export dialog so a failing export can be diagnosed.
// Set to false, or delete this file and every "TEMP-DEBUG" line, to go back to the normal short messages.
export const DEBUG_ERRORS = true;

export function errDetail(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as { message?: unknown; code?: unknown; details?: unknown; hint?: unknown };
    return [e.code, e.message, e.details, e.hint].filter((x) => typeof x === "string" && x).join(" | ") || "unknown error";
  }
  return String(err);
}
