import { createBrowserClient } from "@supabase/ssr";

// Browser client: uses only the public anon key. Access is limited by Row Level Security.
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL as string,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY as string
  );
}
