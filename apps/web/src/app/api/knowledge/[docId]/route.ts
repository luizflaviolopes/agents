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

/** PATCH /api/knowledge/[docId] — edit a knowledge/voice doc. */
export const PATCH = apiHandler(async (request: Request, { params }: Params) => {
  const { docId } = await params;
  const user = await requireUser();
  await requireKnowledgeAccess(user.id, docId);
  const input = await parseBody(request, updateKnowledgeSchema);
  const admin = getAdminClient();

  const patch: Record<string, unknown> = {};
  if (input.kind !== undefined) patch.kind = input.kind;
  if (input.title !== undefined) patch.title = input.title;
  if (input.content !== undefined) patch.content = input.content;
  if (Object.keys(patch).length === 0) return jsonError(400, "Nothing to update");

  const { data: doc, error } = await admin
    .from("agent_knowledge")
    .update(patch)
    .eq("id", docId)
    .select()
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
