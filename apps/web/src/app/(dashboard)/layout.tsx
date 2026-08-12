import { redirect } from "next/navigation";
import type { Profile, Project } from "@agent-fleet/shared";
import { createClient } from "@/lib/supabase/server";
import { Sidebar } from "@/components/sidebar";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const [{ data: projects }, { data: profile }] = await Promise.all([
    supabase
      .from("projects")
      .select("*")
      .order("created_at", { ascending: false }),
    supabase.from("profiles").select("*").eq("id", user.id).maybeSingle(),
  ]);

  return (
    <div className="flex min-h-screen">
      <Sidebar
        projects={(projects ?? []) as Project[]}
        email={user.email ?? ""}
        displayName={(profile as Profile | null)?.display_name ?? null}
      />
      <main className="min-w-0 flex-1">{children}</main>
    </div>
  );
}
