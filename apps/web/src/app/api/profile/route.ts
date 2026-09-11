import { NextResponse } from "next/server";
import { z } from "zod";
import { apiHandler, jsonError, parseBody, requireUser } from "@/lib/api/auth";
import { PROFILE_SUMMARY_COLUMNS } from "@/lib/api/profile";
import { getAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const updateProfileSchema = z.object({
  displayName: z.string().max(120).nullable(),
});

/**
 * GET /api/profile — the signed-in user's profile row, minus the Claude Code
 * token (0014). That column is never selected into a response; what Settings
 * needs is the hint stored beside it.
 */
export const GET = apiHandler(async () => {
  const user = await requireUser();
  const admin = getAdminClient();

  const { data: profile, error } = await admin
    .from("profiles")
    .select(PROFILE_SUMMARY_COLUMNS)
    .eq("id", user.id)
    .maybeSingle();
  if (error) return jsonError(500, error.message);
  if (!profile) return jsonError(404, "Profile not found");
  return NextResponse.json({ profile });
});

/** PATCH /api/profile — update display_name. */
export const PATCH = apiHandler(async (request: Request) => {
  const user = await requireUser();
  const input = await parseBody(request, updateProfileSchema);
  const admin = getAdminClient();

  const { data: profile, error } = await admin
    .from("profiles")
    .update({ display_name: input.displayName?.trim() || null })
    .eq("id", user.id)
    .select(PROFILE_SUMMARY_COLUMNS)
    .single();
  if (error || !profile) {
    return jsonError(500, error?.message ?? "Failed to update profile");
  }
  return NextResponse.json({ profile });
});
