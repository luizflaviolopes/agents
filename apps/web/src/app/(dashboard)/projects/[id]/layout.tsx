import { notFound } from "next/navigation";
import type { Project } from "@agent-fleet/shared";
import { createClient } from "@/lib/supabase/server";
import { TabNav } from "./tab-nav";

export default async function ProjectLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: project } = await supabase
    .from("projects")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (!project) notFound();

  const p = project as Project;

  return (
    <div className="flex h-screen flex-col">
      <header className="shrink-0 border-b border-border px-8 pt-6">
        <div className="flex items-baseline gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{p.name}</h1>
          {p.description && (
            <p className="truncate text-sm text-muted-foreground">
              {p.description}
            </p>
          )}
        </div>
        <TabNav projectId={p.id} />
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}
