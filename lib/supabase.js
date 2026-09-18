import { createClient } from "@supabase/supabase-js";

let client = null;

export function getSupabase() {
  if (client) return client;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;

  if (!url || !key) return null;

  try {
    client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
    return client;
  } catch {
    return null;
  }
}
