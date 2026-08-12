import type { Metadata } from "next";
import type { Project } from "@agent-fleet/shared";
import { createClient } from "@/lib/supabase/server";
import { ProjectsGrid } from "./projects-grid";

export const metadata: Metadata = { title: "Projects" };

export default async function ProjectsPage({
  searchParams,
}: {
  searchParams: Promise<{ new?: string }>;
}) {
  const { new: openNew } = await searchParams;
  const supabase = await createClient();
  const { data: projects } = await supabase
    .from("projects")
    .select("*")
    .order("created_at", { ascending: false });

  return (
    <div className="mx-auto max-w-6xl px-8 py-8">
      <ProjectsGrid
        initialProjects={(projects ?? []) as Project[]}
        openNewOnMount={openNew === "1"}
      />
    </div>
  );
}
