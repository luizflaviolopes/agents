import { NextResponse } from "next/server";
import { z } from "zod";
import { AGENT_AUTH_MODES, mcpServerSchema } from "@agent-fleet/shared";
import { apiHandler, parseBody, requireUser } from "@/lib/api/auth";
import { deleteAgent, updateAgent } from "@/lib/agents/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ agentId: string }> };

const updateAgentSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  /** Managers keep their role; specialist ↔ librarian is allowed. */
  role: z.enum(["specialist", "librarian"]).optional(),
  instructions: z.string().optional(),
  model: z.string().min(1).optional(),
  workspaceId: z.string().uuid().nullable().optional(),
  plugins: z.array(z.string()).optional(),
  mcpServers: z.array(mcpServerSchema).optional(),
  allowedTools: z.array(z.string()).optional(),
  disallowedTools: z.array(z.string()).optional(),
  /** Credential the agent's runs authenticate with (0013). */
  authMode: z.enum(AGENT_AUTH_MODES).optional(),
  isActive: z.boolean().optional(),
});

/** PATCH /api/agents/[agentId] — update config / toggle active. */
export const PATCH = apiHandler(async (request: Request, { params }: Params) => {
  const { agentId } = await params;
  const user = await requireUser();
  const input = await parseBody(request, updateAgentSchema);
  const agent = await updateAgent(user.id, agentId, input);
  return NextResponse.json({ agent });
});

/** DELETE /api/agents/[agentId] — delete a specialist (managers are kept). */
export const DELETE = apiHandler(async (_request: Request, { params }: Params) => {
  const { agentId } = await params;
  const user = await requireUser();
  await deleteAgent(user.id, agentId);
  return NextResponse.json({ ok: true });
});
