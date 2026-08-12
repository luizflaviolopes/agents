import { NextResponse } from "next/server";
import { sendMessageSchema } from "@agent-fleet/shared";
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
 * GET /api/projects/[id]/messages — project chat, oldest first (max 300).
 * `?after=<iso timestamp>` returns messages created at or after that instant
 * (inclusive so same-millisecond inserts aren't dropped — the client dedupes
 * by id).
 */
export const GET = apiHandler(async (request: Request, { params }: Params) => {
  const { id } = await params;
  const user = await requireUser();
  await requireProjectAccess(user.id, id);
  const admin = getAdminClient();

  const after = new URL(request.url).searchParams.get("after");
  let query = admin
    .from("messages")
    .select("*")
    .eq("project_id", id)
    .order("created_at", { ascending: true })
    .limit(300);
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

/** POST /api/projects/[id]/messages — user message over the web channel. */
export const POST = apiHandler(async (request: Request, { params }: Params) => {
  const { id } = await params;
  const user = await requireUser();
  await requireProjectAccess(user.id, id);
  const input = await parseBody(request, sendMessageSchema, {
    projectId: id,
    channel: "web",
  });
  const admin = getAdminClient();

  const { data: message, error } = await admin
    .from("messages")
    .insert({
      project_id: id,
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
