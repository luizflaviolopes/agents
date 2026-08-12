import "server-only";
import type { User } from "@supabase/supabase-js";
import type { Project } from "@agent-fleet/shared";
import { createClient } from "@/lib/supabase/server";
import { getAdminClient } from "@/lib/supabase/admin";

/**
 * Helpers for SERVER COMPONENTS (pages/layouts). Auth still comes from the
 * session cookie; data comes from the admin client with an explicit owner
 * filter — the browser's anon key can no longer read tables.
 */

/** Signed-in user from the session cookie, or null. */
export async function getSessionUser(): Promise<User | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}

/**
 * The project, but only if it exists AND is owned by `userId`.
 * Callers treat null as `notFound()`.
 */
export async function getOwnedProject(
  userId: string,
  projectId: string,
): Promise<Project | null> {
  const admin = getAdminClient();
  const { data } = await admin
    .from("projects")
    .select("*")
    .eq("id", projectId)
    .eq("owner_id", userId)
    .maybeSingle();
  return (data as Project | null) ?? null;
}
