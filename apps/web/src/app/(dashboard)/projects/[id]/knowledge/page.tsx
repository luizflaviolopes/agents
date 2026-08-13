import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getOwnedProject, getSessionUser } from "@/lib/api/page-data";
import { KnowledgePanel } from "./knowledge-panel";

export const metadata: Metadata = { title: "Knowledge" };

export default async function KnowledgePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const project = await getOwnedProject(user.id, id);
  if (!project) notFound();

  // Docs are loaded by the panel from the knowledge API route.
  return <KnowledgePanel projectId={id} />;
}
