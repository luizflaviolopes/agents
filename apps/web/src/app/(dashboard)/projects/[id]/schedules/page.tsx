import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import type { Agent } from "@agent-fleet/shared";
import { getOwnedProject, getSessionUser } from "@/lib/api/page-data";
import { getAdminClient } from "@/lib/supabase/admin";
import { SchedulesPanel } from "./schedules-panel";

export const metadata: Metadata = { title: "Schedules" };

export default async function SchedulesPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const project = await getOwnedProject(user.id, id);
  if (!project) notFound();

  // Agents change rarely — fetch them server-side for the assignee select;
  // schedules are polled by the panel itself (every 10s).
  const admin = getAdminClient();
  const { data: agents } = await admin
    .from("agents")
    .select("*")
    .eq("project_id", id)
    .order("created_at", { ascending: true });

  return <SchedulesPanel projectId={id} agents={(agents ?? []) as Agent[]} />;
}
