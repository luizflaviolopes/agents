import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import type { Agent, Workspace } from "@agent-fleet/shared";
import { getOwnedProject, getSessionUser } from "@/lib/api/page-data";
import { getAdminClient } from "@/lib/supabase/admin";
import { AgentsPanel } from "./agents-panel";

export const metadata: Metadata = { title: "Agents" };

export default async function AgentsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const project = await getOwnedProject(user.id, id);
  if (!project) notFound();

  const admin = getAdminClient();
  const [{ data: agents }, { data: workspaces }] = await Promise.all([
    admin
      .from("agents")
      .select("*")
      .eq("project_id", id)
      .order("created_at", { ascending: true }),
    admin
      .from("workspaces")
      .select("*")
      .eq("project_id", id)
      .order("created_at", { ascending: true }),
  ]);

  return (
    <AgentsPanel
      projectId={id}
      initialAgents={(agents ?? []) as Agent[]}
      workspaces={(workspaces ?? []) as Workspace[]}
    />
  );
}
