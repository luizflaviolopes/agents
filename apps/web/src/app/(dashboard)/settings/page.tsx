import type { Metadata } from "next";
import { redirect } from "next/navigation";
import type { Profile } from "@agent-fleet/shared";
import { createClient } from "@/lib/supabase/server";
import { SettingsForm } from "./settings-form";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
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
