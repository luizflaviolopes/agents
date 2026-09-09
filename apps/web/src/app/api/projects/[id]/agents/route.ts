import { NextResponse } from "next/server";
import { z } from "zod";
import { createAgentSchema } from "@agent-fleet/shared";
import { apiHandler, parseBody, requireUser } from "@/lib/api/auth";
import { createAgent, listAgents } from "@/lib/agents/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** GET /api/projects/[id]/agents — the project's agents. */
export const GET = apiHandler(async (_request: Request, { params }: Params) => {
  const { id } = await params;
  const user = await requireUser();
  return NextResponse.json({ agents: await listAgents(user.id, id) });
});

/**
 * Creatable roles: specialists and (at most one) librarian. The manager is
 * created with the project and can never be added here.
 */
const createAgentWithRoleSchema = createAgentSchema.extend({
  role: z.enum(["specialist", "librarian"]).default("specialist"),
});

/** POST /api/projects/[id]/agents — create a specialist/librarian agent. */
export const POST = apiHandler(async (request: Request, { params }: Params) => {
  const { id } = await params;
  const user = await requireUser();
  const input = await parseBody(request, createAgentWithRoleSchema, {
    projectId: id,
  });
  const agent = await createAgent(user.id, id, input);
  return NextResponse.json({ agent }, { status: 201 });
});
