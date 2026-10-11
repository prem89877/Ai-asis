import { NextResponse } from "next/server";

// All invoice API responses are private and must never be cached.
export function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
}
