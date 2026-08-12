"use client";

import * as React from "react";
import { Check, MessageCircle, RefreshCw } from "lucide-react";
import type { Profile } from "@agent-fleet/shared";
import { api } from "@/lib/api-client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function SettingsForm({
  email,
  initialProfile,
}: {
  email: string;
  initialProfile: Profile | null;
}) {
  const [displayName, setDisplayName] = React.useState(
    initialProfile?.display_name ?? "",
  );
  const [saved, setSaved] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [profileError, setProfileError] = React.useState<string | null>(null);

  const [linkCode, setLinkCode] = React.useState(
    initialProfile?.telegram_link_code ?? null,
  );
  const [generating, setGenerating] = React.useState(false);
  const [telegramError, setTelegramError] = React.useState<string | null>(null);
  const telegramLinked = Boolean(initialProfile?.telegram_chat_id);

  async function saveProfile(e: React.FormEvent) {
    e.preventDefault();
    if (!initialProfile) return;
    setSaving(true);
    setProfileError(null);
    setSaved(false);
    try {
      await api<{ profile: Profile }>("/api/profile", {
        method: "PATCH",
        body: JSON.stringify({ displayName: displayName.trim() || null }),
      });
    } catch (err) {
      setSaving(false);
      setProfileError(
        err instanceof Error ? err.message : "Failed to save profile",
      );
      return;
    }
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  }

  async function generateCode() {
    if (!initialProfile) return;
    setGenerating(true);
    setTelegramError(null);
    try {
      // The code is generated and stored server-side.
      const { code } = await api<{ code: string }>(
        "/api/profile/telegram-code",
        { method: "POST" },
      );
      setLinkCode(code);
    } catch (err) {
      setTelegramError(
        err instanceof Error ? err.message : "Failed to generate a code",
      );
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Profile</CardTitle>
          <CardDescription>How you appear across Agent Fleet.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={saveProfile} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="settings-email">Email</Label>
              <Input id="settings-email" value={email} disabled />
            </div>
            <div className="space-y-2">
              <Label htmlFor="settings-name">Display name</Label>
              <Input
                id="settings-name"
                placeholder="Ada Lovelace"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
              />
            </div>
            {profileError && (
              <p className="text-sm text-destructive">{profileError}</p>
            )}
            <div className="flex items-center gap-3">
              <Button type="submit" disabled={saving}>
                {saving ? "Saving…" : "Save"}
              </Button>
              {saved && (
                <span className="inline-flex items-center gap-1 text-sm text-emerald-400">
                  <Check className="size-4" />
                  Saved
                </span>
              )}
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <MessageCircle className="size-4 text-primary" />
            Telegram
          </CardTitle>
          <CardDescription>
            Link a Telegram account to talk to your project managers from
            anywhere.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {telegramLinked ? (
            <div className="flex items-center gap-2">
              <Badge variant="success">Linked</Badge>
              <span className="text-sm text-muted-foreground">
                Your Telegram account is connected.
              </span>
            </div>
          ) : linkCode ? (
            <div className="rounded-lg border border-border bg-muted/40 p-4">
              <p className="text-sm">
                Send this command to the Agent Fleet bot on Telegram:
              </p>
              <code className="mt-2 block w-fit rounded-md bg-background px-3 py-1.5 font-mono text-sm text-primary">
                /link {linkCode}
              </code>
              <p className="mt-2 text-xs text-muted-foreground">
                The code stays valid until you generate a new one.
              </p>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              Generate a one-time code, then send it to the bot with the /link
              command.
            </p>
          )}
          {telegramError && (
            <p className="text-sm text-destructive">{telegramError}</p>
          )}
          {!telegramLinked && (
            <Button
              variant="outline"
              onClick={generateCode}
              disabled={generating}
            >
              <RefreshCw className={generating ? "animate-spin" : ""} />
              {linkCode ? "Generate new code" : "Generate link code"}
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
