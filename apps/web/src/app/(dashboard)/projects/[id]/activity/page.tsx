import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getOwnedProject, getSessionUser } from "@/lib/api/page-data";
import { ActivityFeed } from "./activity-feed";

export const metadata: Metadata = { title: "Activity" };

export default async function ActivityPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const project = await getOwnedProject(user.id, id);
  if (!project) notFound();

  // The feed polls /api/projects/[id]/activity every 10s.
  return <ActivityFeed projectId={id} />;
}
