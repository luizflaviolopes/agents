import { NextResponse } from "next/server";
import { updateKnowledgeSchema } from "@agent-fleet/shared";
import {
  apiHandler,
  jsonError,
  parseBody,
  requireKnowledgeAccess,
  requireUser,
} from "@/lib/api/auth";
import { getAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ docId: string }> };

/**
 * Provenance agent names joined in for the UI ("Added by <agent>" lines).
 * The two FKs on agent_knowledge → agents must be disambiguated by name.
 */
const DOC_SELECT =
  "*, created_by:agents!agent_knowledge_created_by_agent_id_fkey(name), updated_by:agents!agent_knowledge_updated_by_agent_id_fkey(name)";

/**
 * PATCH /api/knowledge/[docId] — edit a knowledge/voice doc (either scope;
 * the access walk-up handles both). A human edit nulls out
 * updated_by_agent_id (provenance contract, 0005).
 */
export const PATCH = apiHandler(async (request: Request, { params }: Params) => {
  const { docId } = await params;
  const user = await requireUser();
  const existing = await requireKnowledgeAccess(user.id, docId);
  const input = await parseBody(request, updateKnowledgeSchema);
  const admin = getAdminClient();

  if (input.kind === "voice" && existing.project_id !== null) {
    return jsonError(400, "kind 'voice' is only valid for agent-scoped docs");
  }

  const patch: Record<string, unknown> = {};
  if (input.kind !== undefined) patch.kind = input.kind;
  if (input.title !== undefined) patch.title = input.title;
  if (input.content !== undefined) patch.content = input.content;
  if (Object.keys(patch).length === 0) return jsonError(400, "Nothing to update");
  // This route is only reached by the web UI — the edit is human-authored.
  patch.updated_by_agent_id = null;

  const { data: doc, error } = await admin
    .from("agent_knowledge")
    .update(patch)
    .eq("id", docId)
    .select(DOC_SELECT)
    .single();
  if (error || !doc) {
    return jsonError(500, error?.message ?? "Failed to update knowledge doc");
  }
  return NextResponse.json({ doc });
});

/** DELETE /api/knowledge/[docId] — remove a knowledge/voice doc. */
export const DELETE = apiHandler(
  async (_request: Request, { params }: Params) => {
    const { docId } = await params;
    const user = await requireUser();
    await requireKnowledgeAccess(user.id, docId);
    const admin = getAdminClient();

    const { error } = await admin
      .from("agent_knowledge")
      .delete()
      .eq("id", docId);
    if (error) return jsonError(500, error.message);
    return NextResponse.json({ ok: true });
  },
);
