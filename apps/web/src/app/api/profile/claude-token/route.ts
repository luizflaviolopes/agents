import { NextResponse } from "next/server";
import { saveClaudeTokenSchema } from "@agent-fleet/shared";
import { apiHandler, jsonError, parseBody, requireUser } from "@/lib/api/auth";
import { claudeTokenHint, claudeTokenStatus } from "@/lib/api/profile";
import { getAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The owner's Claude Code subscription token (0014), managed from Settings.
 *
 * This is where the credential for `auth_mode: 'subscription'` agents lives
 * now. Before, it was CLAUDE_CODE_OAUTH_TOKEN in the worker's environment,
 * which made rotating a token — a routine thing that has nothing to do with
 * shipping — into an edit of .env on the server plus a container recreate.
 * Saved here it takes effect on the next run: the worker reads it per run.
 *
 * The route never returns the token, only the hint and the timestamp. There is
 * no GET: the page already loads that status server-side, and an endpoint that
 * hands a live credential back to the browser is one XSS away from being an
 * exfiltration route.
 */

/** Columns describing the saved token — never the token itself. */
const STATUS_COLUMNS = "claude_code_token_hint, claude_code_token_set_at";

/** PUT /api/profile/claude-token — save (or replace) the token. */
export const PUT = apiHandler(async (request: Request) => {
  const user = await requireUser();
  const input = await parseBody(request, saveClaudeTokenSchema);
  const admin = getAdminClient();

  const { data, error } = await admin
    .from("profiles")
    .update({
      claude_code_oauth_token: input.token,
      claude_code_token_hint: claudeTokenHint(input.token),
      claude_code_token_set_at: new Date().toISOString(),
    })
    .eq("id", user.id)
    .select(STATUS_COLUMNS)
    .single();
  if (error || !data) {
    return jsonError(500, error?.message ?? "Failed to save the token");
  }
  return NextResponse.json({ status: claudeTokenStatus(data) });
});

/**
 * DELETE /api/profile/claude-token — remove it.
 *
 * The agents set to 'subscription' are left alone: the worker falls back to
 * whatever credential the worker machine itself has, and fails with a message
 * naming this setting when it has none. Silently moving agents back to the API
 * would swap a stalled fleet for an unexpected bill.
 */
export const DELETE = apiHandler(async () => {
  const user = await requireUser();
  const admin = getAdminClient();

  const { error } = await admin
    .from("profiles")
    .update({
      claude_code_oauth_token: null,
      claude_code_token_hint: null,
      claude_code_token_set_at: null,
    })
    .eq("id", user.id);
  if (error) return jsonError(500, error.message);
  return NextResponse.json({ status: { hint: null, setAt: null } });
});
