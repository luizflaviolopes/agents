import { NextResponse } from "next/server";
import { z } from "zod";
import { decidePendingActionSchema } from "@agent-fleet/shared";
import {
  apiHandler,
  jsonError,
  parseBody,
  requirePendingActionAccess,
  requireUser,
} from "@/lib/api/auth";
import { getAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ actionId: string }> };

/**
 * Payload shapes the deterministic executor sends (SlackActionPayload /
 * GmailActionPayload in db-types). An edited payload must still be a valid
 * one — unknown keys are stripped, required keys enforced.
 */
const slackActionPayloadSchema = z.object({
  channel: z.string().min(1),
  thread_ts: z.string().optional(),
  text: z.string().min(1),
});

const gmailActionPayloadSchema = z.object({
  to: z.string().min(1),
  cc: z.string().optional(),
  subject: z.string(),
  body: z.string().min(1),
  thread_id: z.string().optional(),
  in_reply_to_message_id: z.string().optional(),
});

/**
 * PATCH /api/pending-actions/[actionId] — approve or reject a pending
 * action, optionally with an edited payload (merged over the stored one and
 * validated against the action type's shape). Only allowed while the action
 * is still 'pending' — 409 otherwise.
 *
 * 'mcp_tool_call' payloads are not editable: the arguments the owner reviewed
 * have to be the arguments the executor sends, and an edited argument object is
 * a call nobody has actually inspected against the target tool's schema.
 * Rejecting and re-proposing is the way to change one.
 */
export const PATCH = apiHandler(async (request: Request, { params }: Params) => {
  const { actionId } = await params;
  const user = await requireUser();
  const action = await requirePendingActionAccess(user.id, actionId);
  const input = await parseBody(request, decidePendingActionSchema);

  if (action.status !== "pending") {
    return jsonError(409, `Action is already ${action.status}`);
  }

  const patch: Record<string, unknown> = {
    status: input.decision,
    decided_at: new Date().toISOString(),
  };

  if (input.payload !== undefined) {
    if (action.action_type === "mcp_tool_call") {
      return jsonError(
        400,
        "An MCP tool call's arguments are frozen — approve it as proposed, or reject it and " +
          "have the agent propose a corrected call.",
      );
    }
    const merged = {
      ...(action.payload as unknown as Record<string, unknown>),
      ...input.payload,
    };
    const shape = action.action_type.startsWith("slack")
      ? slackActionPayloadSchema
      : gmailActionPayloadSchema;
    const parsed = shape.safeParse(merged);
    if (!parsed.success) {
      return jsonError(
        400,
        `Invalid edited payload: ${parsed.error.errors[0]?.message ?? "invalid"}`,
      );
    }
    patch.payload = parsed.data;
  }

  const admin = getAdminClient();
  // The status guard in the update makes the decision race-safe: if another
  // decision (or the executor) got there first, no row matches → 409.
  const { data: updated, error } = await admin
    .from("pending_actions")
    .update(patch)
    .eq("id", actionId)
    .eq("status", "pending")
    .select()
    .maybeSingle();
  if (error) return jsonError(500, error.message);
  if (!updated) return jsonError(409, "Action is no longer pending");
  return NextResponse.json({ action: updated });
});
