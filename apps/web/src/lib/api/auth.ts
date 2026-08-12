import "server-only";
import { NextResponse } from "next/server";
import type { User } from "@supabase/supabase-js";
import type { z } from "zod";
import type {
  Agent,
  AgentKnowledgeRow,
  PendingActionRow,
  Project,
  ScheduleRow,
  Task,
  TaskRun,
  Workspace,
  WorkspaceRepo,
} from "@agent-fleet/shared";
import { createClient } from "@/lib/supabase/server";
import { getAdminClient } from "@/lib/supabase/admin";

/** JSON error response in the shape every API route uses: `{ error }`. */
export function jsonError(status: number, message: string): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

/**
 * Thrown by the require* helpers below; `apiHandler` converts it back into
 * the wrapped response. Never leaves the route-handler layer.
 */
export class ApiResponseError extends Error {
  constructor(public readonly response: NextResponse) {
    super("API response error");
  }
}

/**
 * Wrap a route handler so thrown `ApiResponseError`s become their response
 * and anything else becomes a 500. Usage:
 *
 *   export const GET = apiHandler(async (request, { params }) => { ... });
 */
export function apiHandler<Args extends unknown[]>(
  handler: (...args: Args) => Promise<NextResponse>,
): (...args: Args) => Promise<NextResponse> {
  return async (...args: Args) => {
    try {
      return await handler(...args);
    } catch (err) {
      if (err instanceof ApiResponseError) return err.response;
      console.error("[api] unhandled error:", err);
      return jsonError(500, "Internal server error");
    }
  };
}

/** Read the session from cookies (@supabase/ssr). Throws a 401 when absent. */
export async function requireUser(): Promise<User> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new ApiResponseError(jsonError(401, "Unauthorized"));
  return user;
}

/**
 * Ownership check: the project must exist and be owned by `userId`.
 * 404 when missing, 403 when owned by someone else.
 */
export async function requireProjectAccess(
  userId: string,
  projectId: string,
): Promise<Project> {
  const admin = getAdminClient();
  const { data: project, error } = await admin
    .from("projects")
    .select("*")
    .eq("id", projectId)
    .maybeSingle();
  if (error) throw new ApiResponseError(jsonError(500, error.message));
  if (!project) throw new ApiResponseError(jsonError(404, "Project not found"));
  if ((project as Project).owner_id !== userId) {
    throw new ApiResponseError(jsonError(403, "Forbidden"));
  }
  return project as Project;
}

/** Workspace access: walk workspace → project → owner. */
export async function requireWorkspaceAccess(
  userId: string,
  workspaceId: string,
): Promise<Workspace> {
  const admin = getAdminClient();
  const { data: workspace, error } = await admin
    .from("workspaces")
    .select("*")
    .eq("id", workspaceId)
    .maybeSingle();
  if (error) throw new ApiResponseError(jsonError(500, error.message));
  if (!workspace) {
    throw new ApiResponseError(jsonError(404, "Workspace not found"));
  }
  await requireProjectAccess(userId, (workspace as Workspace).project_id);
  return workspace as Workspace;
}

/** Repo access: walk repo → workspace → project → owner. */
export async function requireRepoAccess(
  userId: string,
  repoId: string,
): Promise<WorkspaceRepo> {
  const admin = getAdminClient();
  const { data: repo, error } = await admin
    .from("workspace_repos")
    .select("*")
    .eq("id", repoId)
    .maybeSingle();
  if (error) throw new ApiResponseError(jsonError(500, error.message));
  if (!repo) throw new ApiResponseError(jsonError(404, "Repository not found"));
  await requireWorkspaceAccess(userId, (repo as WorkspaceRepo).workspace_id);
  return repo as WorkspaceRepo;
}

/** Agent access: walk agent → project → owner. */
export async function requireAgentAccess(
  userId: string,
  agentId: string,
): Promise<Agent> {
  const admin = getAdminClient();
  const { data: agent, error } = await admin
    .from("agents")
    .select("*")
    .eq("id", agentId)
    .maybeSingle();
  if (error) throw new ApiResponseError(jsonError(500, error.message));
  if (!agent) throw new ApiResponseError(jsonError(404, "Agent not found"));
  await requireProjectAccess(userId, (agent as Agent).project_id);
  return agent as Agent;
}

/** Task access: walk task → project → owner. */
export async function requireTaskAccess(
  userId: string,
  taskId: string,
): Promise<Task> {
  const admin = getAdminClient();
  const { data: task, error } = await admin
    .from("tasks")
    .select("*")
    .eq("id", taskId)
    .maybeSingle();
  if (error) throw new ApiResponseError(jsonError(500, error.message));
  if (!task) throw new ApiResponseError(jsonError(404, "Task not found"));
  await requireProjectAccess(userId, (task as Task).project_id);
  return task as Task;
}

/** Run access: walk task_run → task → project → owner. */
export async function requireRunAccess(
  userId: string,
  runId: string,
): Promise<TaskRun> {
  const admin = getAdminClient();
  const { data: run, error } = await admin
    .from("task_runs")
    .select("*")
    .eq("id", runId)
    .maybeSingle();
  if (error) throw new ApiResponseError(jsonError(500, error.message));
  if (!run) throw new ApiResponseError(jsonError(404, "Run not found"));
  await requireTaskAccess(userId, (run as TaskRun).task_id);
  return run as TaskRun;
}

/** Pending-action access: walk pending_action → project → owner. */
export async function requirePendingActionAccess(
  userId: string,
  actionId: string,
): Promise<PendingActionRow> {
  const admin = getAdminClient();
  const { data: action, error } = await admin
    .from("pending_actions")
    .select("*")
    .eq("id", actionId)
    .maybeSingle();
  if (error) throw new ApiResponseError(jsonError(500, error.message));
  if (!action) {
    throw new ApiResponseError(jsonError(404, "Pending action not found"));
  }
  await requireProjectAccess(userId, (action as PendingActionRow).project_id);
  return action as PendingActionRow;
}

/** Schedule access: walk schedule → project → owner. */
export async function requireScheduleAccess(
  userId: string,
  scheduleId: string,
): Promise<ScheduleRow> {
  const admin = getAdminClient();
  const { data: schedule, error } = await admin
    .from("schedules")
    .select("*")
    .eq("id", scheduleId)
    .maybeSingle();
  if (error) throw new ApiResponseError(jsonError(500, error.message));
  if (!schedule) {
    throw new ApiResponseError(jsonError(404, "Schedule not found"));
  }
  await requireProjectAccess(userId, (schedule as ScheduleRow).project_id);
  return schedule as ScheduleRow;
}

/** Knowledge-doc access: walk doc → agent → project → owner. */
export async function requireKnowledgeAccess(
  userId: string,
  docId: string,
): Promise<AgentKnowledgeRow> {
  const admin = getAdminClient();
  const { data: doc, error } = await admin
    .from("agent_knowledge")
    .select("*")
    .eq("id", docId)
    .maybeSingle();
  if (error) throw new ApiResponseError(jsonError(500, error.message));
  if (!doc) {
    throw new ApiResponseError(jsonError(404, "Knowledge doc not found"));
  }
  await requireAgentAccess(userId, (doc as AgentKnowledgeRow).agent_id);
  return doc as AgentKnowledgeRow;
}

/**
 * Zod validation wrapper: parse the JSON body against a schema, throwing a
 * 400 with the first issue's message on failure. `extra` merges fixed values
 * (usually IDs from the URL) over the raw body before validation.
 */
export async function parseBody<S extends z.ZodTypeAny>(
  request: Request,
  schema: S,
  extra?: Record<string, unknown>,
): Promise<z.infer<S>> {
  const raw = await request.json().catch(() => null);
  const candidate = {
    ...(raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}),
    ...extra,
  };
  const parsed = schema.safeParse(candidate);
  if (!parsed.success) {
    throw new ApiResponseError(
      jsonError(400, parsed.error.errors[0]?.message ?? "Invalid request"),
    );
  }
  return parsed.data;
}
