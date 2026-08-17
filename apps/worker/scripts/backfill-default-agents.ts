/**
 * Backfill the default agents onto pre-existing projects.
 *
 * Every new project is created with three agents (Manager, Project Manager,
 * Librarian — see packages/shared/src/default-agents.ts and
 * POST /api/projects). Projects created before that behavior existed are
 * missing some of them; this script adds whichever are absent:
 *
 * - Manager          — added if the project has no agent with role 'manager'
 * - Librarian        — added if the project has no agent with role 'librarian'
 * - Project Manager  — added if the project has no agent named
 *                      'Project Manager' (case-insensitive; role 'specialist'
 *                      is not unique, so the name is the identity here)
 *
 * Run from the repo root:
 *   pnpm --filter @agent-fleet/worker exec node --import tsx scripts/backfill-default-agents.ts
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { DEFAULT_AGENTS } from "@agent-fleet/shared";

// Load env from the repo root .env (same convention as the worker itself).
const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({
  path: path.resolve(here, "..", "..", "..", ".env"),
  quiet: true,
});

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
if (!supabaseUrl || !serviceRoleKey) {
  console.error(
    "Missing NEXT_PUBLIC_SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY in the root .env",
  );
  process.exit(1);
}

const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

interface ProjectRow {
  id: string;
  name: string;
}

interface AgentRow {
  project_id: string;
  name: string;
  role: string;
}

async function main(): Promise<void> {
  const { data: projects, error: projectsError } = await admin
    .from("projects")
    .select("id, name")
    .order("created_at", { ascending: true });
  if (projectsError) throw new Error(`Failed to list projects: ${projectsError.message}`);

  const { data: agents, error: agentsError } = await admin
    .from("agents")
    .select("project_id, name, role");
  if (agentsError) throw new Error(`Failed to list agents: ${agentsError.message}`);

  const agentsByProject = new Map<string, AgentRow[]>();
  for (const agent of (agents ?? []) as AgentRow[]) {
    const list = agentsByProject.get(agent.project_id) ?? [];
    list.push(agent);
    agentsByProject.set(agent.project_id, list);
  }

  let totalCreated = 0;
  for (const project of (projects ?? []) as ProjectRow[]) {
    const existing = agentsByProject.get(project.id) ?? [];
    const hasRole = (role: string) => existing.some((a) => a.role === role);
    const hasName = (name: string) =>
      existing.some((a) => a.name.toLowerCase() === name.toLowerCase());

    const missing = DEFAULT_AGENTS.filter((template) =>
      template.role === "specialist"
        ? !hasName(template.name)
        : !hasRole(template.role),
    );

    if (missing.length === 0) {
      console.log(`[${project.name}] all default agents present — nothing to do`);
      continue;
    }

    const { error: insertError } = await admin.from("agents").insert(
      missing.map(({ name, role, instructions }) => ({
        project_id: project.id,
        name,
        role,
        instructions,
      })),
    );
    if (insertError) {
      console.error(
        `[${project.name}] FAILED to create ${missing.map((m) => m.name).join(", ")}: ${insertError.message}`,
      );
      process.exitCode = 1;
      continue;
    }

    totalCreated += missing.length;
    console.log(
      `[${project.name}] created: ${missing.map((m) => `${m.name} (${m.role})`).join(", ")}`,
    );
  }

  console.log(
    `Done. ${totalCreated} agent(s) created across ${(projects ?? []).length} project(s).`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
