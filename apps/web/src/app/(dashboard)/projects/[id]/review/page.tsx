import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getOwnedProject, getSessionUser } from "@/lib/api/page-data";
import { ReviewPanel } from "./review-panel";

export const metadata: Metadata = { title: "Review" };

export default async function ReviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const project = await getOwnedProject(user.id, id);
  if (!project) notFound();

  // Pending actions are polled by the panel itself (every 3s).
  return <ReviewPanel projectId={id} />;
}
