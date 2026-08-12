import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getOwnedProject, getSessionUser } from "@/lib/api/page-data";
import { ChatPanel } from "./chat-panel";

export const metadata: Metadata = { title: "Chat" };

export default async function ChatPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const project = await getOwnedProject(user.id, id);
  if (!project) notFound();

  // Messages are loaded (and kept fresh) by the panel's 2.5s poll.
  return <ChatPanel projectId={id} />;
}
