import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Creates the service-role Supabase client used by the worker.
 * Bypasses RLS — this client must never be exposed outside the worker.
 */
export function createServiceClient(url: string, serviceRoleKey: string): SupabaseClient {
  return createClient(url, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}
