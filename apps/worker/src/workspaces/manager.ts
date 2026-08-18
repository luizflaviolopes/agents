import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Workspace, WorkspaceRepo } from "@agent-fleet/shared";
import { logger } from "../lib/logger.js";

const execFileAsync = promisify(execFile);

const SWEEP_INTERVAL_MS = 60_000;

/**
 * Manages workspace directories on disk and clones their GitHub repos.
 * Layout: WORKSPACES_ROOT/<workspace_id>/<repo folder_name>
 */
export class WorkspaceManager {
  private sweepTimer: NodeJS.Timeout | undefined;
  private sweeping = false;

  constructor(
    private readonly supabase: SupabaseClient,
    private readonly workspacesRoot: string,
    /**
     * Worker-wide GITHUB_TOKEN, used only for projects with no github
     * integration. Prefer the per-project `cloneToken` — see
     * `resolveCloneToken`.
     */
    private readonly fallbackToken?: string,
  ) {}

  /** Absolute path of a workspace directory. */
  workspaceDir(workspaceId: string): string {
    return path.join(this.workspacesRoot, workspaceId);
  }

  /** Creates the workspace directory if it does not exist and returns its path. */
  async ensureWorkspace(workspace: Pick<Workspace, "id">): Promise<string> {
    const dir = this.workspaceDir(workspace.id);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  /**
   * Clones every 'pending' repo of the workspace. Sets clone_status through
   * 'cloning' → 'ready' | 'error'. Never throws — a failed clone is recorded
   * on the row and logged.
   */
  async syncRepos(workspaceId: string): Promise<void> {
    const { data, error } = await this.supabase
      .from("workspace_repos")
      .select("*")
      .eq("workspace_id", workspaceId)
      .eq("clone_status", "pending");

    if (error) {
      logger.error("workspaces", `failed to list repos for workspace ${workspaceId}: ${error.message}`);
      return;
    }

    for (const repo of (data ?? []) as WorkspaceRepo[]) {
      await this.cloneRepo(repo);
    }
  }

  private async cloneRepo(repo: WorkspaceRepo): Promise<void> {
    const wsDir = this.workspaceDir(repo.workspace_id);
    const targetDir = path.join(wsDir, repo.folder_name);
    // Resolved inside the try so a lookup failure is recorded on the row like
    // any other clone failure, but declared out here so the catch can redact.
    let token: string | undefined;

    try {
      token = await this.resolveCloneToken(repo.workspace_id);
      await mkdir(wsDir, { recursive: true });

      // Already on disk (e.g. from a previous run) — just mark it ready.
      if (existsSync(targetDir)) {
        await this.setCloneStatus(repo.id, "ready", null);
        return;
      }

      await this.setCloneStatus(repo.id, "cloning", null);

      const cloneUrl = this.injectToken(repo.repo_url, token);
      logger.info(
        "workspaces",
        `cloning ${repo.repo_url} (branch ${repo.branch}) into ${targetDir}`,
      );

      // execFile with an argument array — user input is never shell-interpolated.
      await execFileAsync(
        "git",
        ["clone", "--branch", repo.branch, "--single-branch", cloneUrl, repo.folder_name],
        { cwd: wsDir, maxBuffer: 10 * 1024 * 1024 },
      );

      await this.setCloneStatus(repo.id, "ready", null);
      logger.info("workspaces", `repo ${repo.folder_name} ready in workspace ${repo.workspace_id}`);
    } catch (err) {
      const message = redactToken(errorMessage(err), token).slice(0, 4000);
      logger.error("workspaces", `clone failed for ${repo.repo_url}: ${message}`);
      await this.setCloneStatus(repo.id, "error", message);
    }
  }

  /**
   * The read-only PAT this workspace's repos clone with: the owning project's
   * github integration `cloneToken`, falling back to the worker-wide
   * GITHUB_TOKEN when the project has no integration.
   *
   * Per project rather than per agent on purpose. A workspace is cloned once
   * into one directory and read by however many agents point at it, so a
   * per-agent token would mean whichever agent ran first decided what everyone
   * else reads. The credential belongs to the checkout, not to the reader.
   *
   * Resolved per clone rather than cached, so rotating a project's token takes
   * effect on the next clone instead of the next worker restart. Clones are
   * rare; two queries are cheaper than a staleness bug.
   */
  private async resolveCloneToken(workspaceId: string): Promise<string | undefined> {
    const { data: workspace, error: wsError } = await this.supabase
      .from("workspaces")
      .select("project_id")
      .eq("id", workspaceId)
      .maybeSingle();
    if (wsError) {
      logger.warn(
        "workspaces",
        `failed to resolve project for workspace ${workspaceId}: ${wsError.message}`,
      );
      return this.fallbackToken;
    }

    const projectId = (workspace as { project_id?: string } | null)?.project_id;
    if (!projectId) return this.fallbackToken;

    const { data, error } = await this.supabase
      .from("integrations")
      .select("config")
      .eq("project_id", projectId)
      .eq("type", "github")
      .maybeSingle();
    if (error) {
      logger.warn(
        "workspaces",
        `failed to load the github integration for project ${projectId}: ${error.message}`,
      );
      return this.fallbackToken;
    }

    const config = (data as { config?: Record<string, unknown> } | null)?.config;
    const cloneToken = config?.cloneToken;
    return typeof cloneToken === "string" && cloneToken.length > 0
      ? cloneToken
      : this.fallbackToken;
  }

  private async setCloneStatus(repoId: string, status: string, errorText: string | null): Promise<void> {
    try {
      const { error } = await this.supabase
        .from("workspace_repos")
        .update({ clone_status: status, error: errorText })
        .eq("id", repoId);
      if (error) {
        logger.error("workspaces", `failed to set clone_status=${status} for repo ${repoId}: ${error.message}`);
      }
    } catch (err) {
      logger.error("workspaces", `failed to set clone_status=${status} for repo ${repoId}`, err);
    }
  }

  /** Injects the clone token into https GitHub clone URLs for private repos. */
  private injectToken(repoUrl: string, token: string | undefined): string {
    if (!token) return repoUrl;
    const match = /^https:\/\/github\.com\/(.+)$/i.exec(repoUrl.trim());
    if (!match) return repoUrl;
    return `https://x-access-token:${token}@github.com/${match[1]}`;
  }

  /** Periodic sweep that clones any pending repos across all workspaces. */
  startSweep(): void {
    if (this.sweepTimer) return;
    const run = () => {
      void this.sweepOnce();
    };
    this.sweepTimer = setInterval(run, SWEEP_INTERVAL_MS);
    run();
    logger.info("workspaces", `pending-repo sweep started (every ${SWEEP_INTERVAL_MS / 1000}s)`);
  }

  stopSweep(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
  }

  private async sweepOnce(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const { data, error } = await this.supabase
        .from("workspace_repos")
        .select("*")
        .eq("clone_status", "pending");
      if (error) {
        logger.error("workspaces", `sweep failed to list pending repos: ${error.message}`);
        return;
      }
      for (const repo of (data ?? []) as WorkspaceRepo[]) {
        await this.cloneRepo(repo);
      }
    } catch (err) {
      logger.error("workspaces", "sweep crashed", err);
    } finally {
      this.sweeping = false;
    }
  }
}

/**
 * Ensures the clone token never leaks into a stored error message or a log
 * line — `workspace_repos.error` is rendered in the workspaces panel, and git
 * echoes the remote URL on failure.
 */
function redactToken(text: string, token: string | undefined): string {
  if (!token) return text;
  return text.split(token).join("***");
}

function errorMessage(err: unknown): string {
  if (err && typeof err === "object") {
    const maybe = err as { stderr?: unknown; message?: unknown };
    if (typeof maybe.stderr === "string" && maybe.stderr.trim().length > 0) return maybe.stderr.trim();
    if (typeof maybe.message === "string") return maybe.message;
  }
  return String(err);
}
