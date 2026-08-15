"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FolderKanban, Plus } from "lucide-react";
import type { Project } from "@agent-fleet/shared";
import { createProjectSchema } from "@agent-fleet/shared";
import { api } from "@/lib/api-client";
import { timeAgo } from "@/lib/format";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import { Textarea } from "@/components/ui/textarea";
import { EmptyState } from "@/components/empty-state";

export function ProjectsGrid({
  initialProjects,
  openNewOnMount,
}: {
  initialProjects: Project[];
  openNewOnMount?: boolean;
}) {
  const router = useRouter();
  const [projects, setProjects] = React.useState(initialProjects);
  const [open, setOpen] = React.useState(Boolean(openNewOnMount));
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  async function createProject(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const parsed = createProjectSchema.safeParse({
      name: name.trim(),
      description: description.trim() || undefined,
    });
    if (!parsed.success) {
      setError(parsed.error.errors[0]?.message ?? "Invalid input");
      return;
    }

    setBusy(true);
    let project: Project;
    try {
      // The API creates the project AND its manager agent server-side.
      const created = await api<{ project: Project }>("/api/projects", {
        method: "POST",
        body: JSON.stringify(parsed.data),
      });
      project = created.project;
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to create project",
      );
      setBusy(false);
      return;
    }

    setProjects((prev) => [project, ...prev]);
    setOpen(false);
    setName("");
    setDescription("");
    setBusy(false);
    router.push(`/projects/${project.id}`);
    router.refresh();
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Projects</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Each project has its own agents, workspaces and task queue.
          </p>
        </div>
        <Button onClick={() => setOpen(true)}>
          <Plus />
          New project
        </Button>
      </div>

      {projects.length === 0 ? (
        <EmptyState
          icon={FolderKanban}
          title="No projects yet"
          description="Create your first project — a manager agent will be set up automatically to route work for you."
          action={
            <Button onClick={() => setOpen(true)}>
              <Plus />
              New project
            </Button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((project) => (
            <Link key={project.id} href={`/projects/${project.id}`}>
              <Card className="h-full transition-colors hover:border-primary/40 hover:bg-accent/40">
                <CardHeader>
                  <CardTitle className="truncate text-base">
                    {project.name}
                  </CardTitle>
                  <CardDescription className="line-clamp-2 min-h-[2.5rem]">
                    {project.description || "No description"}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <p className="text-xs text-muted-foreground">
                    Created {timeAgo(project.created_at)}
                  </p>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New project</DialogTitle>
            <DialogDescription>
              A manager agent is created automatically to receive your requests
              and distribute tasks.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={createProject} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="project-name">Name</Label>
              <Input
                id="project-name"
                placeholder="Acme website revamp"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="project-description">Description (optional)</Label>
              <Textarea
                id="project-description"
                placeholder="What is this project about?"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <DialogFooter className="mt-0">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? "Creating…" : "Create project"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
