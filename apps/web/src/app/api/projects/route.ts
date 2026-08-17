import { NextResponse } from "next/server";
import type { Project } from "@agent-fleet/shared";
import { createProjectSchema, DEFAULT_AGENTS } from "@agent-fleet/shared";
import { apiHandler, jsonError, parseBody, requireUser } from "@/lib/api/auth";
import { getAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type CountRow = { count: number };
type ProjectWithCounts = Project & {
  agents: CountRow[] | null;
  tasks: CountRow[] | null;
};

/** GET /api/projects — the signed-in user's projects, newest first. */
export const GET = apiHandler(async () => {
  const user = await requireUser();
  const admin = getAdminClient();

  const { data, error } = await admin
    .from("projects")
    .select("*, agents(count), tasks(count)")
    .eq("owner_id", user.id)
    .order("created_at", { ascending: false });
  if (error) return jsonError(500, error.message);

  const projects = ((data ?? []) as ProjectWithCounts[]).map(
    ({ agents, tasks, ...project }) => ({
      ...project,
      agent_count: agents?.[0]?.count ?? 0,
      task_count: tasks?.[0]?.count ?? 0,
    }),
  );

  return NextResponse.json({ projects });
});

/** POST /api/projects — create a project + its manager agent. */
export const POST = apiHandler(async (request: Request) => {
  const user = await requireUser();
  const input = await parseBody(request, createProjectSchema);
  const admin = getAdminClient();

  const { data: project, error: projectError } = await admin
    .from("projects")
    .insert({
      owner_id: user.id,
      name: input.name,
      description: input.description ?? null,
    })
    .select()
    .single();
  if (projectError || !project) {
    return jsonError(500, projectError?.message ?? "Failed to create project");
  }

  // Every project starts with the same three agents: the manager that routes
  // work to specialists, the project manager (Notion digest + roadmap) and the
  // librarian that curates the project's knowledge. The latter two need no
  // workspace; the project manager still needs its Notion MCP server and
  // "Notion sources" doc before it can do the Notion half of its job (see
  // docs/PROJECT-MANAGEMENT-AGENTS.md).
  const { error: agentError } = await admin.from("agents").insert(
    DEFAULT_AGENTS.map(({ name, role, instructions }) => ({
      project_id: (project as Project).id,
      name,
      role,
      instructions,
    })),
  );
  if (agentError) {
    // Best-effort rollback so we never leave a half-staffed project behind.
    await admin.from("projects").delete().eq("id", (project as Project).id);
    return jsonError(500, `Default agent creation failed: ${agentError.message}`);
  }

  return NextResponse.json({ project }, { status: 201 });
});
