import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Service-role Supabase client for server code (API routes, server
 * components). Bypasses Postgres privileges entirely — every caller MUST
 * enforce ownership in application code (see src/lib/api/auth.ts).
 *
 * `server-only` guarantees this module can never be pulled into a client
 * bundle. The client is created lazily so `next build` never needs the
 * service-role key at build time.
 */
let adminClient: SupabaseClient | null = null;

export function getAdminClient(): SupabaseClient {
  if (adminClient) return adminClient;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set — the web server now performs all data access with the service-role key.",
    );
  }

  adminClient = createClient(url, key, {
    auth: { persistSession: false },
  });
  return adminClient;
}
