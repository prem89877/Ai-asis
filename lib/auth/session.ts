import { redirect } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";

export type FirmRole = "owner" | "admin" | "member";

export interface Membership {
  firmId: string;
  role: FirmRole;
}

// For pages: verifies the session with Supabase and redirects to /login if missing.
export async function requireUser() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  return { supabase, user };
}

// The user's firm, resolved on the server. A firm id sent by the browser is never trusted.
export async function getPrimaryMembership(
  supabase: SupabaseClient,
  userId: string
): Promise<Membership | null> {
  const { data } = await supabase
    .from("firm_members")
    .select("firm_id, role")
    .eq("user_id", userId)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  const row = data as { firm_id: string; role: FirmRole };
  return { firmId: row.firm_id, role: row.role };
}
