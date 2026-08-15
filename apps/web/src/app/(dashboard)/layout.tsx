import { redirect } from "next/navigation";
import type { Profile, Project } from "@agent-fleet/shared";
import { getSessionUser } from "@/lib/api/page-data";
import { getAdminClient } from "@/lib/supabase/admin";
import { Sidebar } from "@/components/sidebar";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const admin = getAdminClient();
  const [{ data: projects }, { data: profile }] = await Promise.all([
    admin
      .from("projects")
      .select("*")
      .eq("owner_id", user.id)
      .order("created_at", { ascending: false }),
    admin.from("profiles").select("*").eq("id", user.id).maybeSingle(),
  ]);

  return (
    <div className="flex h-dvh flex-col md:flex-row">
      <Sidebar
        projects={(projects ?? []) as Project[]}
        email={user.email ?? ""}
        displayName={(profile as Profile | null)?.display_name ?? null}
      />
      <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">{children}</main>
    </div>
  );
}
