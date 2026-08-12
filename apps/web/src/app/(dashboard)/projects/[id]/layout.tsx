import { notFound, redirect } from "next/navigation";
import { getOwnedProject, getSessionUser } from "@/lib/api/page-data";
import { TabNav } from "./tab-nav";

export default async function ProjectLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const project = await getOwnedProject(user.id, id);
  if (!project) notFound();

  return (
    <div className="flex h-screen flex-col">
      <header className="shrink-0 border-b border-border px-8 pt-6">
        <div className="flex items-baseline gap-3">
          <h1 className="text-xl font-semibold tracking-tight">
            {project.name}
          </h1>
          {project.description && (
            <p className="truncate text-sm text-muted-foreground">
              {project.description}
            </p>
          )}
        </div>
        <TabNav projectId={project.id} />
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}
