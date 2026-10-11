// Shared authorization for the Phase 4 routes. Every route calls this first:
//   same-origin check (mutations) -> verified session -> firm membership resolved from the database.
// A firm id sent by the browser is never trusted. Data reads use the user's session (Row Level Security) AND an explicit
// firm_id filter; writes use the service role only after this guard has passed, and always carry firm_id.
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { json } from "@/lib/api/json";
import { getPrimaryMembership, type Membership } from "@/lib/auth/session";
import { isSameOrigin } from "@/lib/security/origin";
import { createClient } from "@/lib/supabase/server";

export type Guard =
  | { ok: true; supabase: SupabaseClient; user: User; membership: Membership }
  | { ok: false; response: Response };

export async function guard(request: Request, opts: { mutating: boolean }): Promise<Guard> {
  if (opts.mutating && !isSameOrigin(request)) return { ok: false, response: json({ error: "Forbidden." }, 403) };
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, response: json({ error: "Please log in again." }, 401) };
  const membership = await getPrimaryMembership(supabase, user.id);
  if (!membership) return { ok: false, response: json({ error: "No firm found for this account." }, 403) };
  return { ok: true, supabase, user, membership };
}
