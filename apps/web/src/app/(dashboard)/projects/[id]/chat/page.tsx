import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import type { Agent } from "@agent-fleet/shared";
import { getOwnedProject, getSessionUser } from "@/lib/api/page-data";
import { getAdminClient } from "@/lib/supabase/admin";
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

  // Active agents drive the thread selector; messages are loaded (and kept
  // fresh) by the panel's 2.5s poll per thread.
  const admin = getAdminClient();
  const { data: agents } = await admin
    .from("agents")
    .select("*")
    .eq("project_id", id)
    .eq("is_active", true)
    .order("created_at", { ascending: true });

  return <ChatPanel projectId={id} agents={(agents ?? []) as Agent[]} />;
}
