import type { Metadata } from "next";
import type { Agent, Task } from "@agent-fleet/shared";
import { createClient } from "@/lib/supabase/server";
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
  const supabase = await createClient();

  const [{ data: tasks }, { data: agents }] = await Promise.all([
    supabase
      .from("tasks")
      .select("*")
      .eq("project_id", id)
      .order("priority", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(400),
    supabase
      .from("agents")
      .select("*")
      .eq("project_id", id)
      .order("created_at", { ascending: true }),
  ]);

  return (
    <Board
      projectId={id}
      initialTasks={(tasks ?? []) as Task[]}
      agents={(agents ?? []) as Agent[]}
      initialTaskId={task}
    />
  );
}
