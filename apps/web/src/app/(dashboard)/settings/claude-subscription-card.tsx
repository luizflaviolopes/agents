"use client";

import * as React from "react";
import { Check, CreditCard, Trash2 } from "lucide-react";
import type { ClaudeTokenStatus } from "@agent-fleet/shared";
import { api } from "@/lib/api-client";
import { timeAgo } from "@/lib/format";
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
import { ConfirmDialog } from "@/components/confirm-dialog";

/**
 * Where the owner pastes the Claude Code token their 'subscription' agents run
 * on (0014).
 *
 * The field is write-only by design: a saved token is shown as a hint and a
 * date, never as something recoverable. Replacing it is pasting a new one —
 * there is nothing to edit in place, which is also how rotation works.
 */
export function ClaudeSubscriptionCard({
  initialStatus,
}: {
  initialStatus: ClaudeTokenStatus;
}) {
  const [status, setStatus] = React.useState(initialStatus);
  const [token, setToken] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [removing, setRemoving] = React.useState(false);

  async function saveToken(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const { status: next } = await api<{ status: ClaudeTokenStatus }>(
        "/api/profile/claude-token",
        { method: "PUT", body: JSON.stringify({ token: token.trim() }) },
      );
      setStatus(next);
      setToken("");
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save the token");
    } finally {
      setSaving(false);
    }
  }

  async function removeToken() {
    setError(null);
    try {
      const { status: next } = await api<{ status: ClaudeTokenStatus }>(
        "/api/profile/claude-token",
        { method: "DELETE" },
      );
      setStatus(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove the token");
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <CreditCard className="size-4 text-primary" />
          Claude Code subscription
        </CardTitle>
        <CardDescription>
          The credential your agents use when their billing is set to{" "}
          <strong>Claude Code subscription</strong> instead of the Anthropic
          API. Runs draw on this subscription&apos;s quota, and cost nothing per
          token. Agents billed to the API ignore it.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="rounded-lg border border-border bg-muted/40 p-4">
          <p className="text-sm text-muted-foreground">
            Generate a token on any machine you are logged into Claude Code on,
            then paste what it prints:
          </p>
          <pre className="mt-2 overflow-x-auto rounded-md bg-background px-3 py-2 font-mono text-xs leading-relaxed text-foreground">
            claude setup-token
          </pre>
        </div>

        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">Saved token</span>
              {status.hint ? (
                <Badge variant="success">Active</Badge>
              ) : (
                <Badge variant="secondary">None</Badge>
              )}
            </div>
            <p className="mt-0.5 font-mono text-xs text-muted-foreground">
              {status.hint ?? "Subscription agents fall back to the worker machine's own login."}
            </p>
          </div>
          {status.setAt && (
            <div className="text-xs text-muted-foreground">
              Saved {timeAgo(status.setAt)}
            </div>
          )}
          {status.hint && (
            <Button variant="ghost" size="sm" onClick={() => setRemoving(true)}>
              <Trash2 className="size-4" />
              Remove
            </Button>
          )}
        </div>

        <form onSubmit={saveToken} className="flex flex-wrap items-end gap-3">
          <div className="min-w-64 flex-1 space-y-2">
            <Label htmlFor="claude-token">
              {status.hint ? "Replace token" : "Token"}
            </Label>
            <Input
              id="claude-token"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="sk-ant-oat…"
              value={token}
              onChange={(event) => setToken(event.target.value)}
            />
          </div>
          <Button type="submit" disabled={saving || token.trim().length === 0}>
            {saved ? <Check className="size-4" /> : null}
            {saving ? "Saving…" : saved ? "Saved" : "Save token"}
          </Button>
        </form>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <p className="text-xs text-muted-foreground">
          A new token takes effect on the next task run — nothing to restart.
          One quota covers every subscription agent on this account, so when it
          runs out they all stall at once; keep agents you need a prompt answer
          from on the API.
        </p>
      </CardContent>

      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        title="Remove the saved token?"
        description="Agents billed to the Claude Code subscription will fall back to the worker machine's own login, and fail with a clear error if it has none. Their billing setting is left unchanged."
        confirmLabel="Remove"
        onConfirm={removeToken}
      />
    </Card>
  );
}
