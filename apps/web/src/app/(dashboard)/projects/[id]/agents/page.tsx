import type { Metadata } from "next";
import type { Agent, Workspace } from "@agent-fleet/shared";
import { createClient } from "@/lib/supabase/server";
import { AgentsPanel } from "./agents-panel";

export const metadata: Metadata = { title: "Agents" };

export default async function AgentsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const [{ data: agents }, { data: workspaces }] = await Promise.all([
    supabase
      .from("agents")
      .select("*")
      .eq("project_id", id)
      .order("created_at", { ascending: true }),
    supabase
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
