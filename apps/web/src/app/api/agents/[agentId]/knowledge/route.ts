import { NextResponse } from "next/server";
import { createKnowledgeSchema } from "@agent-fleet/shared";
import {
  apiHandler,
  jsonError,
  parseBody,
  requireAgentAccess,
  requireUser,
} from "@/lib/api/auth";
import { getAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ agentId: string }> };

/** GET /api/agents/[agentId]/knowledge — the agent's knowledge docs. */
export const GET = apiHandler(async (_request: Request, { params }: Params) => {
  const { agentId } = await params;
  const user = await requireUser();
  await requireAgentAccess(user.id, agentId);
  const admin = getAdminClient();

  const { data: docs, error } = await admin
    .from("agent_knowledge")
    .select("*")
    .eq("agent_id", agentId)
    .order("created_at", { ascending: true });
  if (error) return jsonError(500, error.message);
  return NextResponse.json({ docs: docs ?? [] });
});

/** POST /api/agents/[agentId]/knowledge — add a knowledge/voice doc. */
export const POST = apiHandler(async (request: Request, { params }: Params) => {
  const { agentId } = await params;
  const user = await requireUser();
  await requireAgentAccess(user.id, agentId);
  // agentId always comes from the path — a body value cannot override it.
  const input = await parseBody(request, createKnowledgeSchema, { agentId });
  const admin = getAdminClient();

  const { data: doc, error } = await admin
    .from("agent_knowledge")
    .insert({
      agent_id: agentId,
      kind: input.kind,
      title: input.title,
      content: input.content,
    })
    .select()
    .single();
  if (error || !doc) {
    return jsonError(500, error?.message ?? "Failed to create knowledge doc");
  }
  return NextResponse.json({ doc }, { status: 201 });
});
