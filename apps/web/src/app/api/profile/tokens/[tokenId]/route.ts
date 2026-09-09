import { NextResponse } from "next/server";
import type { ApiTokenRow } from "@agent-fleet/shared";
import { apiHandler, jsonError, requireUser } from "@/lib/api/auth";
import { getAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ tokenId: string }> };

/**
 * DELETE /api/profile/tokens/[tokenId] — revoke a token.
 *
 * A soft revoke: the row stays so the hash stays claimed and the account's
 * token history remains readable. Revoking twice is not an error — the
 * outcome the caller asked for already holds.
 */
export const DELETE = apiHandler(async (_request: Request, { params }: Params) => {
  const { tokenId } = await params;
  const user = await requireUser();
  const admin = getAdminClient();

  const { data, error } = await admin
    .from("api_tokens")
    .select("id, user_id, revoked_at")
    .eq("id", tokenId)
    .maybeSingle();
  if (error) return jsonError(500, error.message);
  const token = data as Pick<ApiTokenRow, "id" | "user_id" | "revoked_at"> | null;
  if (!token) return jsonError(404, "Token not found");
  if (token.user_id !== user.id) return jsonError(403, "Forbidden");

  if (!token.revoked_at) {
    const { error: revokeError } = await admin
      .from("api_tokens")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", tokenId);
    if (revokeError) return jsonError(500, revokeError.message);
  }
  return NextResponse.json({ ok: true });
});
