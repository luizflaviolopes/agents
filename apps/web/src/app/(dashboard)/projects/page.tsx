import type { Metadata } from "next";
import { redirect } from "next/navigation";
import type { Project } from "@agent-fleet/shared";
import { getSessionUser } from "@/lib/api/page-data";
import { getAdminClient } from "@/lib/supabase/admin";
import { ProjectsGrid } from "./projects-grid";

export const metadata: Metadata = { title: "Projects" };

export default async function ProjectsPage({
  searchParams,
}: {
  searchParams: Promise<{ new?: string }>;
}) {
  const { new: openNew } = await searchParams;
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const admin = getAdminClient();
  const { data: projects } = await admin
    .from("projects")
    .select("*")
    .eq("owner_id", user.id)
    .order("created_at", { ascending: false });

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-8 sm:py-8">
      <ProjectsGrid
        initialProjects={(projects ?? []) as Project[]}
        openNewOnMount={openNew === "1"}
      />
    </div>
  );
}
