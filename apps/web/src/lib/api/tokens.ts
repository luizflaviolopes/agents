import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { API_TOKEN_PREFIX } from "@agent-fleet/shared";
import type { ApiTokenRow } from "@agent-fleet/shared";
import { getAdminClient } from "@/lib/supabase/admin";

/**
 * Personal access tokens (migration 0012): minting, and the verification the
 * MCP endpoint runs on every request.
 *
 * The plaintext exists in exactly two places — the response that mints it and
 * the caller's config file. What this module stores is its SHA-256, which is
 * also how it looks a token up: hash what was presented, select by hash. No
 * comparison against a stored secret ever runs, so there is no comparison to
 * leak timing through.
 */

/** 32 bytes of entropy, base64url — no padding, safe in a header. */
const TOKEN_BYTES = 32;

/** Characters of the secret shown in the UI so tokens can be told apart. */
const HINT_CHARS = 6;

/**
 * How stale `last_used_at` may get before a request refreshes it. The column
 * exists so an owner can spot a token nothing uses any more; that question is
 * answered just as well by "some time today" as by the exact second, and this
 * keeps a busy MCP session from writing a row on every single tool call.
 */
const LAST_USED_REFRESH_MS = 5 * 60 * 1000;

export function hashToken(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

export interface MintedToken {
  /** Shown to the owner once, then unrecoverable. */
  plaintext: string;
  hash: string;
  hint: string;
}

export function mintToken(): MintedToken {
  const secret = randomBytes(TOKEN_BYTES).toString("base64url");
  const plaintext = `${API_TOKEN_PREFIX}${secret}`;
  return {
    plaintext,
    hash: hashToken(plaintext),
    hint: `${API_TOKEN_PREFIX}${secret.slice(0, HINT_CHARS)}`,
  };
}

/** The bearer credential on a request, from `Authorization` or `X-Api-Key`. */
export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (header) {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match) return match[1].trim();
  }
  // Not every MCP client can set an arbitrary Authorization header; the ones
  // that only offer a generic API-key field land here.
  return request.headers.get("x-api-key")?.trim() || null;
}

/**
 * The user a request's token authenticates as, or null when there is no
 * usable token — absent, unknown, revoked or expired.
 *
 * Null for all four on purpose. Telling an unauthenticated caller *which* of
 * those it hit tells an attacker holding a guessed string whether it ever
 * existed, and tells a legitimate owner nothing they cannot see in Settings.
 */
export async function authenticateToken(
  request: Request,
): Promise<{ userId: string; tokenId: string } | null> {
  const presented = bearerToken(request);
  if (!presented) return null;

  const admin = getAdminClient();
  const { data, error } = await admin
    .from("api_tokens")
    .select("*")
    .eq("token_hash", hashToken(presented))
    .maybeSingle();
  if (error || !data) return null;

  const token = data as ApiTokenRow;
  if (token.revoked_at) return null;
  if (token.expires_at && Date.parse(token.expires_at) <= Date.now()) {
    return null;
  }

  const lastUsed = token.last_used_at ? Date.parse(token.last_used_at) : 0;
  if (Date.now() - lastUsed > LAST_USED_REFRESH_MS) {
    const { error: touchError } = await admin
      .from("api_tokens")
      .update({ last_used_at: new Date().toISOString() })
      .eq("id", token.id);
    // A failed bookkeeping write must not cost the caller their request.
    if (touchError) {
      console.error("[tokens] last_used_at update failed:", touchError.message);
    }
  }

  return { userId: token.user_id, tokenId: token.id };
}
