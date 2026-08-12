"use client";

import * as React from "react";
import { FolderGit2, GitBranch, Plus, Trash2 } from "lucide-react";
import type { Workspace, WorkspaceRepo } from "@agent-fleet/shared";
import {
  addWorkspaceRepoSchema,
  createWorkspaceSchema,
} from "@agent-fleet/shared";
import { createClient } from "@/lib/supabase/client";
import { repoFolderFromUrl, slugify } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CloneStatusBadge } from "@/components/badges";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { EmptyState } from "@/components/empty-state";

export function WorkspacesPanel({
  projectId,
  initialWorkspaces,
  initialRepos,
}: {
  projectId: string;
  initialWorkspaces: Workspace[];
  initialRepos: WorkspaceRepo[];
}) {
  const supabase = React.useMemo(() => createClient(), []);
  const [workspaces, setWorkspaces] =
    React.useState<Workspace[]>(initialWorkspaces);
  const [repos, setRepos] = React.useState<WorkspaceRepo[]>(initialRepos);
  const [newOpen, setNewOpen] = React.useState(false);
  const [addRepoWorkspace, setAddRepoWorkspace] =
    React.useState<Workspace | null>(null);
  const [deleteWorkspace, setDeleteWorkspace] =
    React.useState<Workspace | null>(null);
  const [deleteRepo, setDeleteRepo] = React.useState<WorkspaceRepo | null>(
    null,
  );

  const workspaceIds = React.useRef(new Set(initialWorkspaces.map((w) => w.id)));

  // Live clone-status updates from the worker.
  React.useEffect(() => {
    const channel = supabase
      .channel(`workspace-repos:${projectId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "workspace_repos" },
        (payload) => {
          if (payload.eventType === "INSERT") {
            const repo = payload.new as WorkspaceRepo;
            if (!workspaceIds.current.has(repo.workspace_id)) return;
            setRepos((prev) =>
              prev.some((r) => r.id === repo.id) ? prev : [...prev, repo],
            );
          } else if (payload.eventType === "UPDATE") {
            const repo = payload.new as WorkspaceRepo;
            setRepos((prev) =>
              prev.map((r) => (r.id === repo.id ? repo : r)),
            );
          } else if (payload.eventType === "DELETE") {
            const old = payload.old as Partial<WorkspaceRepo>;
            setRepos((prev) => prev.filter((r) => r.id !== old.id));
          }
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [projectId, supabase]);

  async function removeWorkspace(ws: Workspace) {
    const { error } = await supabase
      .from("workspaces")
      .delete()
      .eq("id", ws.id);
    if (!error) {
      workspaceIds.current.delete(ws.id);
      setWorkspaces((prev) => prev.filter((w) => w.id !== ws.id));
      setRepos((prev) => prev.filter((r) => r.workspace_id !== ws.id));
    }
  }

  async function removeRepo(repo: WorkspaceRepo) {
    const { error } = await supabase
      .from("workspace_repos")
      .delete()
      .eq("id", repo.id);
    if (!error) {
      setRepos((prev) => prev.filter((r) => r.id !== repo.id));
    }
  }

  return (
    <div className="mx-auto max-w-5xl px-8 py-6">
      <div className="mb-5 flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Workspaces are folders of cloned repositories on the worker&apos;s
          disk.
        </p>
        <Button size="sm" onClick={() => setNewOpen(true)}>
          <Plus />
          New workspace
        </Button>
      </div>

      {workspaces.length === 0 ? (
        <EmptyState
          icon={FolderGit2}
          title="No workspaces yet"
          description="Create a workspace and add repositories — agents attached to it will work inside those clones."
          action={
            <Button onClick={() => setNewOpen(true)}>
              <Plus />
              New workspace
            </Button>
          }
        />
      ) : (
        <div className="space-y-4">
          {workspaces.map((ws) => {
            const wsRepos = repos.filter((r) => r.workspace_id === ws.id);
            return (
              <Card key={ws.id}>
                <CardHeader className="flex-row items-center justify-between space-y-0">
                  <div className="min-w-0">
                    <div className="truncate font-semibold">{ws.name}</div>
                    <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
                      {ws.path}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setAddRepoWorkspace(ws)}
                    >
                      <Plus />
                      Add repository
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="text-muted-foreground hover:text-destructive"
                      aria-label="Delete workspace"
                      onClick={() => setDeleteWorkspace(ws)}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </CardHeader>
                <CardContent>
                  {wsRepos.length === 0 ? (
                    <p className="rounded-lg border border-dashed border-border p-3 text-sm text-muted-foreground">
                      No repositories yet.
                    </p>
                  ) : (
                    <ul className="divide-y divide-border rounded-lg border border-border">
                      {wsRepos.map((repo) => (
                        <li
                          key={repo.id}
                          className="flex items-center gap-3 px-3 py-2.5"
                        >
                          <FolderGit2 className="size-4 shrink-0 text-muted-foreground" />
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm">
                              {repo.repo_url}
                            </div>
                            <div className="truncate font-mono text-xs text-muted-foreground">
                              {repo.folder_name}
                            </div>
                          </div>
                          <Badge variant="outline" className="shrink-0">
                            <GitBranch className="size-3" />
                            {repo.branch}
                          </Badge>
                          <CloneStatusBadge
                            status={repo.clone_status}
                            error={repo.error}
                          />
                          <Button
                            variant="ghost"
                            size="iconSm"
                            className="text-muted-foreground hover:text-destructive"
                            aria-label="Delete repository"
                            onClick={() => setDeleteRepo(repo)}
                          >
                            <Trash2 />
                          </Button>
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <NewWorkspaceDialog
        open={newOpen}
        onOpenChange={setNewOpen}
        projectId={projectId}
        onCreated={(ws) => {
          workspaceIds.current.add(ws.id);
          setWorkspaces((prev) => [...prev, ws]);
        }}
      />

      <AddRepoDialog
        workspace={addRepoWorkspace}
        onClose={() => setAddRepoWorkspace(null)}
        onAdded={(repo) =>
          setRepos((prev) =>
            prev.some((r) => r.id === repo.id) ? prev : [...prev, repo],
          )
        }
      />

      <ConfirmDialog
        open={Boolean(deleteWorkspace)}
        onOpenChange={(open) => !open && setDeleteWorkspace(null)}
        title={`Delete workspace "${deleteWorkspace?.name}"?`}
        description="All repositories in this workspace will be removed. Agents attached to it will lose their workspace."
        onConfirm={async () => {
          if (deleteWorkspace) await removeWorkspace(deleteWorkspace);
        }}
      />

      <ConfirmDialog
        open={Boolean(deleteRepo)}
        onOpenChange={(open) => !open && setDeleteRepo(null)}
        title="Remove repository?"
        description={`"${deleteRepo?.folder_name}" will be removed from the workspace.`}
        confirmLabel="Remove"
        onConfirm={async () => {
          if (deleteRepo) await removeRepo(deleteRepo);
        }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------------ */

function NewWorkspaceDialog({
  open,
  onOpenChange,
  projectId,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  onCreated: (ws: Workspace) => void;
}) {
  const [name, setName] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const path = slugify(name);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const parsed = createWorkspaceSchema.safeParse({
      projectId,
      name: name.trim(),
    });
    if (!parsed.success) {
      setError(parsed.error.errors[0]?.message ?? "Invalid input");
      return;
    }
    if (!path) {
      setError("Name must contain at least one letter or digit.");
      return;
    }

    setBusy(true);
    const supabase = createClient();
    const { data, error: insertError } = await supabase
      .from("workspaces")
      .insert({
        project_id: parsed.data.projectId,
        name: parsed.data.name,
        path,
      })
      .select()
      .single();
    setBusy(false);
    if (insertError || !data) {
      setError(insertError?.message ?? "Failed to create workspace");
      return;
    }
    onCreated(data as Workspace);
    onOpenChange(false);
    setName("");
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New workspace</DialogTitle>
          <DialogDescription>
            A folder on the worker&apos;s disk where repositories are cloned.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={create} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="ws-name">Name</Label>
            <Input
              id="ws-name"
              placeholder="Backend services"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              required
            />
            {path && (
              <p className="font-mono text-xs text-muted-foreground">
                Folder: {path}
              </p>
            )}
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter className="mt-0">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Creating…" : "Create workspace"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------------ */

function AddRepoDialog({
  workspace,
  onClose,
  onAdded,
}: {
  workspace: Workspace | null;
  onClose: () => void;
  onAdded: (repo: WorkspaceRepo) => void;
}) {
  const [url, setUrl] = React.useState("");
  const [branch, setBranch] = React.useState("main");
  const [folder, setFolder] = React.useState("");
  const [folderTouched, setFolderTouched] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const effectiveFolder = folderTouched ? folder : repoFolderFromUrl(url);

  function reset() {
    setUrl("");
    setBranch("main");
    setFolder("");
    setFolderTouched(false);
    setError(null);
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!workspace) return;
    setError(null);

    const parsed = addWorkspaceRepoSchema.safeParse({
      workspaceId: workspace.id,
      repoUrl: url.trim(),
      branch: branch.trim() || "main",
      folderName: effectiveFolder.trim(),
    });
    if (!parsed.success) {
      setError(parsed.error.errors[0]?.message ?? "Invalid input");
      return;
    }

    setBusy(true);
    const supabase = createClient();
    const { data, error: insertError } = await supabase
      .from("workspace_repos")
      .insert({
        workspace_id: parsed.data.workspaceId,
        repo_url: parsed.data.repoUrl,
        branch: parsed.data.branch,
        folder_name: parsed.data.folderName,
      })
      .select()
      .single();
    setBusy(false);
    if (insertError || !data) {
      setError(insertError?.message ?? "Failed to add repository");
      return;
    }
    onAdded(data as WorkspaceRepo);
    onClose();
    reset();
  }

  return (
    <Dialog open={Boolean(workspace)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add repository</DialogTitle>
          <DialogDescription>
            The worker clones it into {workspace?.name} and keeps the clone
            status updated here.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={add} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="repo-url">Repository URL</Label>
            <Input
              id="repo-url"
              type="url"
              placeholder="https://github.com/acme/api"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              autoFocus
              required
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="repo-branch">Branch</Label>
              <Input
                id="repo-branch"
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="repo-folder">Folder name</Label>
              <Input
                id="repo-folder"
                placeholder="api"
                value={effectiveFolder}
                onChange={(e) => {
                  setFolderTouched(true);
                  setFolder(e.target.value);
                }}
              />
            </div>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter className="mt-0">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Adding…" : "Add repository"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
