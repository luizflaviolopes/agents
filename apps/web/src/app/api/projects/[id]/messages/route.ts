import { NextResponse } from "next/server";
import { sendMessageSchema } from "@agent-fleet/shared";
import type { Agent } from "@agent-fleet/shared";
import {
  apiHandler,
  jsonError,
  parseBody,
  requireProjectAccess,
  requireUser,
} from "@/lib/api/auth";
import { getAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/projects/[id]/messages — one chat thread, oldest first (max 300).
 * `?agentId=<uuid>` selects the direct thread with that agent;
 * `?agentId=none` or absent selects the manager thread (agent_id IS NULL).
 * `?after=<iso timestamp>` returns messages created at or after that instant
 * (inclusive so same-millisecond inserts aren't dropped — the client dedupes
 * by id).
 */
export const GET = apiHandler(async (request: Request, { params }: Params) => {
  const { id } = await params;
  const user = await requireUser();
  await requireProjectAccess(user.id, id);
  const admin = getAdminClient();

  const searchParams = new URL(request.url).searchParams;
  const agentId = searchParams.get("agentId");
  const after = searchParams.get("after");

  let query = admin
    .from("messages")
    .select("*")
    .eq("project_id", id)
    .order("created_at", { ascending: true })
    .limit(300);
  if (!agentId || agentId === "none") {
    query = query.is("agent_id", null);
  } else if (UUID_RE.test(agentId)) {
    query = query.eq("agent_id", agentId);
  } else {
    return jsonError(400, "Invalid 'agentId' value — expected a uuid or 'none'");
  }
  if (after) {
    if (Number.isNaN(Date.parse(after))) {
      return jsonError(400, "Invalid 'after' value — expected an ISO timestamp");
    }
    query = query.gte("created_at", after);
  }

  const { data: messages, error } = await query;
  if (error) return jsonError(500, error.message);
  return NextResponse.json({ messages: messages ?? [] });
});

/**
 * POST /api/projects/[id]/messages — user message over the web channel.
 * An optional `agentId` targets the direct thread with that agent (0005);
 * omitted = the manager thread (agent_id NULL).
 */
export const POST = apiHandler(async (request: Request, { params }: Params) => {
  const { id } = await params;
  const user = await requireUser();
  await requireProjectAccess(user.id, id);
  const input = await parseBody(request, sendMessageSchema, {
    projectId: id,
    channel: "web",
  });
  const admin = getAdminClient();

  if (input.agentId) {
    // The thread's agent must belong to this project and be active.
    const { data: agent, error: agentError } = await admin
      .from("agents")
      .select("id, project_id, is_active")
      .eq("id", input.agentId)
      .maybeSingle();
    if (agentError) return jsonError(500, agentError.message);
    const found = agent as Pick<Agent, "id" | "project_id" | "is_active"> | null;
    if (!found || found.project_id !== id) {
      return jsonError(400, "Agent does not belong to this project");
    }
    if (!found.is_active) {
      return jsonError(400, "Agent is inactive");
    }
  }

  const { data: message, error } = await admin
    .from("messages")
    .insert({
      project_id: id,
      agent_id: input.agentId ?? null,
      sender: "user",
      channel: "web",
      content: input.content,
    })
    .select()
    .single();
  if (error || !message) {
    return jsonError(500, error?.message ?? "Failed to send message");
  }
  return NextResponse.json({ message }, { status: 201 });
});
