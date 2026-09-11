import type { Metadata } from "next";
import { redirect } from "next/navigation";
import type { ApiTokenSummary, ProfileSummary } from "@agent-fleet/shared";
import { getSessionUser } from "@/lib/api/page-data";
import { claudeTokenStatus, PROFILE_SUMMARY_COLUMNS } from "@/lib/api/profile";
import { getAdminClient } from "@/lib/supabase/admin";
import { ClaudeSubscriptionCard } from "./claude-subscription-card";
import { McpAccessCard } from "./mcp-access-card";
import { SettingsForm } from "./settings-form";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const admin = getAdminClient();
  // Same rule as the token hash below: the profile's Claude Code token (0014)
  // is not selected, so it cannot reach the browser by accident. The hint and
  // the timestamp beside it are what this page actually shows.
  const { data: profile } = await admin
    .from("profiles")
    .select(PROFILE_SUMMARY_COLUMNS)
    .eq("id", user.id)
    .maybeSingle();

  // Never `select("*")` here: the hash is the one column that must not leave
  // the server, and the safest way to keep it in is to never ask for it.
  const { data: tokens } = await admin
    .from("api_tokens")
    .select(
      "id, user_id, name, hint, expires_at, revoked_at, last_used_at, created_at",
    )
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });

  return (
    <div className="mx-auto max-w-2xl px-4 py-6 sm:px-8 sm:py-8">
      <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Your profile and integrations.
      </p>
      <div className="mt-6 space-y-6">
        <SettingsForm
          email={user.email ?? ""}
          initialProfile={profile as ProfileSummary | null}
        />
        <ClaudeSubscriptionCard
          initialStatus={claudeTokenStatus(profile as ProfileSummary | null)}
        />
        <McpAccessCard
          initialTokens={(tokens ?? []) as ApiTokenSummary[]}
          endpoint={
            process.env.WEB_URL
              ? `${process.env.WEB_URL.replace(/\/+$/, "")}/api/mcp`
              : ""
          }
        />
      </div>
    </div>
  );
}
