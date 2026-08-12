import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getOwnedProject, getSessionUser } from "@/lib/api/page-data";
import { WorkspacesPanel } from "./workspaces-panel";

export const metadata: Metadata = { title: "Workspaces" };

export default async function WorkspacesPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const project = await getOwnedProject(user.id, id);
  if (!project) notFound();

  // Workspaces + repo clone statuses are polled by the panel (every 3s).
  return <WorkspacesPanel projectId={id} />;
}
