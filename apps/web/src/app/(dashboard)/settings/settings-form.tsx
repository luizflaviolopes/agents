"use client";

import * as React from "react";
import { Check, MessageCircle, RefreshCw } from "lucide-react";
import type { Profile } from "@agent-fleet/shared";
import { createClient } from "@/lib/supabase/client";
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

/** Unambiguous alphabet (no 0/O, 1/I) for link codes. */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function randomLinkCode(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length])
    .join("");
}

export function SettingsForm({
  email,
  initialProfile,
}: {
  email: string;
  initialProfile: Profile | null;
}) {
  const supabase = React.useMemo(() => createClient(), []);
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
    const { error } = await supabase
      .from("profiles")
      .update({ display_name: displayName.trim() || null })
      .eq("id", initialProfile.id);
    setSaving(false);
    if (error) {
      setProfileError(error.message);
      return;
    }
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  }

  async function generateCode() {
    if (!initialProfile) return;
    setGenerating(true);
    setTelegramError(null);
    const code = randomLinkCode();
    const { error } = await supabase
      .from("profiles")
      .update({ telegram_link_code: code })
      .eq("id", initialProfile.id);
    setGenerating(false);
    if (error) {
      setTelegramError(error.message);
      return;
    }
    setLinkCode(code);
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
