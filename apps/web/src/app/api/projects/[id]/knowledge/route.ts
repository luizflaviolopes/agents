import { NextResponse } from "next/server";
import { createKnowledgeSchema } from "@agent-fleet/shared";
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

/**
 * Provenance agent names joined in for the UI ("Added by <agent>" lines).
 * The two FKs on agent_knowledge → agents must be disambiguated by name.
 */
const DOC_SELECT =
  "*, created_by:agents!agent_knowledge_created_by_agent_id_fkey(name), updated_by:agents!agent_knowledge_updated_by_agent_id_fkey(name)";

/**
 * GET /api/projects/[id]/knowledge — the project-scoped knowledge docs
 * (shared by all agents of the project), with provenance agent names.
 */
export const GET = apiHandler(async (_request: Request, { params }: Params) => {
  const { id } = await params;
  const user = await requireUser();
  await requireProjectAccess(user.id, id);
  const admin = getAdminClient();

  const { data: docs, error } = await admin
    .from("agent_knowledge")
    .select(DOC_SELECT)
    .eq("project_id", id)
    .order("created_at", { ascending: true });
  if (error) return jsonError(500, error.message);
  return NextResponse.json({ docs: docs ?? [] });
});

/**
 * POST /api/projects/[id]/knowledge — add a project-scoped doc. Project
 * scope only holds kind 'knowledge' (voice docs are agent-scoped; enforced
 * by createKnowledgeSchema). Provenance stays null = human-authored.
 */
export const POST = apiHandler(async (request: Request, { params }: Params) => {
  const { id } = await params;
  const user = await requireUser();
  await requireProjectAccess(user.id, id);
  // scope/projectId always come from the path — a body value cannot
  // override them.
  const input = await parseBody(request, createKnowledgeSchema, {
    scope: "project",
    projectId: id,
    agentId: undefined,
  });
  const admin = getAdminClient();

  const { data: doc, error } = await admin
    .from("agent_knowledge")
    .insert({
      project_id: id,
      agent_id: null,
      kind: input.kind,
      title: input.title,
      content: input.content,
    })
    .select(DOC_SELECT)
    .single();
  if (error || !doc) {
    return jsonError(500, error?.message ?? "Failed to create knowledge doc");
  }
  return NextResponse.json({ doc }, { status: 201 });
});
