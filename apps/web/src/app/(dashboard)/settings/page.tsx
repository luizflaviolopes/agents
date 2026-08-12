import type { Metadata } from "next";
import { redirect } from "next/navigation";
import type { Profile } from "@agent-fleet/shared";
import { getSessionUser } from "@/lib/api/page-data";
import { getAdminClient } from "@/lib/supabase/admin";
import { SettingsForm } from "./settings-form";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const admin = getAdminClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .maybeSingle();

  return (
    <div className="mx-auto max-w-2xl px-8 py-8">
      <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Your profile and integrations.
      </p>
      <div className="mt-6">
        <SettingsForm
          email={user.email ?? ""}
          initialProfile={profile as Profile | null}
        />
      </div>
    </div>
  );
}
