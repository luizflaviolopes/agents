import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import type { Agent } from "@agent-fleet/shared";
import { getOwnedProject, getSessionUser } from "@/lib/api/page-data";
import { getAdminClient } from "@/lib/supabase/admin";
import { Board } from "./board";

export const metadata: Metadata = { title: "Board" };

export default async function BoardPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ task?: string }>;
}) {
  const { id } = await params;
  const { task } = await searchParams;

  const user = await getSessionUser();
  if (!user) redirect("/login");
  const project = await getOwnedProject(user.id, id);
  if (!project) notFound();

  // Agents change rarely — fetch them server-side; tasks are polled by the
  // Board itself (every 3s via /api/projects/[id]/tasks).
  const admin = getAdminClient();
  const { data: agents } = await admin
    .from("agents")
    .select("*")
    .eq("project_id", id)
    .order("created_at", { ascending: true });

  return (
    <Board
      projectId={id}
      agents={(agents ?? []) as Agent[]}
      initialTaskId={task}
    />
  );
}
