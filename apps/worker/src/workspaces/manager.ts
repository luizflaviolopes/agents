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
    private readonly githubToken?: string,
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

    try {
      await mkdir(wsDir, { recursive: true });

      // Already on disk (e.g. from a previous run) — just mark it ready.
      if (existsSync(targetDir)) {
        await this.setCloneStatus(repo.id, "ready", null);
        return;
      }

      await this.setCloneStatus(repo.id, "cloning", null);

      const cloneUrl = this.injectToken(repo.repo_url);
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
      const message = this.redactToken(errorMessage(err)).slice(0, 4000);
      logger.error("workspaces", `clone failed for ${repo.repo_url}: ${message}`);
      await this.setCloneStatus(repo.id, "error", message);
    }
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

  /** Injects GITHUB_TOKEN into https GitHub clone URLs for private repos. */
  private injectToken(repoUrl: string): string {
    if (!this.githubToken) return repoUrl;
    const match = /^https:\/\/github\.com\/(.+)$/i.exec(repoUrl.trim());
    if (!match) return repoUrl;
    return `https://x-access-token:${this.githubToken}@github.com/${match[1]}`;
  }

  /** Ensures the token never leaks into stored error messages or logs. */
  private redactToken(text: string): string {
    if (!this.githubToken) return text;
    return text.split(this.githubToken).join("***");
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

function errorMessage(err: unknown): string {
  if (err && typeof err === "object") {
    const maybe = err as { stderr?: unknown; message?: unknown };
    if (typeof maybe.stderr === "string" && maybe.stderr.trim().length > 0) return maybe.stderr.trim();
    if (typeof maybe.message === "string") return maybe.message;
  }
  return String(err);
}
