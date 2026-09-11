import "server-only";
import type { ClaudeTokenStatus, Profile, ProfileSummary } from "@agent-fleet/shared";

/**
 * Reading a profile without reading the owner's Claude Code token (0014).
 *
 * `claude_code_oauth_token` is stored in plaintext because the worker has to
 * replay it into an agent subprocess; the only thing keeping it server-side is
 * that nothing outside the worker ever selects it. So no profile read here uses
 * `select("*")` — the same rule 0012 applies to `api_tokens.token_hash`, and
 * for the same reason: the safest way to keep a column out of a response is to
 * never ask the database for it.
 */
export const PROFILE_SUMMARY_COLUMNS =
  "id, display_name, telegram_chat_id, telegram_link_code, claude_code_token_hint, claude_code_token_set_at, created_at";

/** What Settings shows about the saved token, from a profile read without it. */
export function claudeTokenStatus(
  profile: Pick<Profile, "claude_code_token_hint" | "claude_code_token_set_at"> | null,
): ClaudeTokenStatus {
  return {
    hint: profile?.claude_code_token_hint ?? null,
    setAt: profile?.claude_code_token_set_at ?? null,
  };
}

/** Leading and trailing characters of a token — enough to recognise, useless to replay. */
export function claudeTokenHint(token: string): string {
  return `${token.slice(0, 12)}…${token.slice(-4)}`;
}

export type { ProfileSummary };
