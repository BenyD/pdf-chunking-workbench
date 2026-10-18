import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export const BUCKET = "chunklab";

let client: SupabaseClient | null = null;

/** Server-only client. The service role bypasses RLS; never ship it to the browser. */
export function supabaseAdmin(): SupabaseClient {
  if (!client) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set");
    client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  }
  return client;
}

export function publicUrl(path: string): string {
  return `/storage/object/public/${BUCKET}/${path}`;      // proxied by next.config.ts rewrites
}
