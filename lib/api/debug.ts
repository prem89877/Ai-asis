// Optional technical error detail for local debugging. OFF by default and ALWAYS off in production builds
// (Vercel production and preview both run with NODE_ENV=production), so database error text is never sent to browsers.
// To use it on your own machine only: start `next dev` with AI_ASIS_DEBUG_ERRORS=1.
export const DEBUG_ERRORS = process.env.NODE_ENV !== "production" && process.env.AI_ASIS_DEBUG_ERRORS === "1";

export function errDetail(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as { message?: unknown; code?: unknown; details?: unknown; hint?: unknown };
    return [e.code, e.message, e.details, e.hint].filter((x) => typeof x === "string" && x).join(" | ") || "unknown error";
  }
  return String(err);
}
