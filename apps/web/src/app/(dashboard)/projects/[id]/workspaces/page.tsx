import type { Metadata } from "next";
import type { Workspace, WorkspaceRepo } from "@agent-fleet/shared";
import { createClient } from "@/lib/supabase/server";
import { WorkspacesPanel } from "./workspaces-panel";

export const metadata: Metadata = { title: "Workspaces" };

export default async function WorkspacesPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: workspaces } = await supabase
    .from("workspaces")
    .select("*")
    .eq("project_id", id)
    .order("created_at", { ascending: true });

  const workspaceIds = (workspaces ?? []).map((w: Workspace) => w.id);
  const { data: repos } = workspaceIds.length
    ? await supabase
        .from("workspace_repos")
        .select("*")
        .in("workspace_id", workspaceIds)
        .order("created_at", { ascending: true })
    : { data: [] as WorkspaceRepo[] };

  return (
    <WorkspacesPanel
      projectId={id}
      initialWorkspaces={(workspaces ?? []) as Workspace[]}
      initialRepos={(repos ?? []) as WorkspaceRepo[]}
    />
  );
}
