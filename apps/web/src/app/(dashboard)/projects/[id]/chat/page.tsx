import type { Metadata } from "next";
import type { Message } from "@agent-fleet/shared";
import { createClient } from "@/lib/supabase/server";
import { ChatPanel } from "./chat-panel";

export const metadata: Metadata = { title: "Chat" };

export default async function ChatPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: messages } = await supabase
    .from("messages")
    .select("*")
    .eq("project_id", id)
    .order("created_at", { ascending: true })
    .limit(300);

  return (
    <ChatPanel projectId={id} initialMessages={(messages ?? []) as Message[]} />
  );
}
