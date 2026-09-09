import { NextResponse } from "next/server";
import type { ApiTokenRow, ApiTokenSummary } from "@agent-fleet/shared";
import { createApiTokenSchema } from "@agent-fleet/shared";
import { apiHandler, jsonError, parseBody, requireUser } from "@/lib/api/auth";
import { mintToken } from "@/lib/api/tokens";
import { getAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Personal access tokens (0012), managed from Settings.
 *
 * These routes authenticate the way every other route does — the session
 * cookie — and deliberately NOT with a token. Minting is the one operation a
 * stolen token must not be able to perform on its own behalf, and keeping it
 * behind the browser session means a compromised token can be revoked without
 * racing a copy of itself.
 */

/** Everything but the hash: what the caller may see about their own tokens. */
const SUMMARY_COLUMNS =
  "id, user_id, name, hint, expires_at, revoked_at, last_used_at, created_at";

/** GET /api/profile/tokens — the caller's tokens, newest first. */
export const GET = apiHandler(async () => {
  const user = await requireUser();
  const admin = getAdminClient();

  const { data, error } = await admin
    .from("api_tokens")
    .select(SUMMARY_COLUMNS)
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });
  if (error) return jsonError(500, error.message);
  return NextResponse.json({ tokens: (data ?? []) as ApiTokenSummary[] });
});

/**
 * POST /api/profile/tokens — mint a token.
 *
 * The response is the only time `token` is ever returned; the row keeps its
 * hash and its hint, and nothing can reconstruct the plaintext from those.
 */
export const POST = apiHandler(async (request: Request) => {
  const user = await requireUser();
  const input = await parseBody(request, createApiTokenSchema);
  const admin = getAdminClient();

  const { plaintext, hash, hint } = mintToken();
  const expiresAt = input.expiresInDays
    ? new Date(
        Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000,
      ).toISOString()
    : null;

  const { data, error } = await admin
    .from("api_tokens")
    .insert({
      user_id: user.id,
      name: input.name.trim(),
      token_hash: hash,
      hint,
      expires_at: expiresAt,
    })
    .select(SUMMARY_COLUMNS)
    .single();
  if (error || !data) {
    return jsonError(500, error?.message ?? "Failed to create token");
  }

  return NextResponse.json(
    { token: plaintext, record: data as ApiTokenSummary },
    { status: 201 },
  );
});
