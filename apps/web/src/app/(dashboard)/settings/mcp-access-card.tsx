"use client";

import * as React from "react";
import { Copy, Check, KeyRound, Plus, Trash2 } from "lucide-react";
import type { ApiTokenSummary } from "@agent-fleet/shared";
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
import { Select } from "@/components/ui/select";
import { ConfirmDialog } from "@/components/confirm-dialog";

const EXPIRY_OPTIONS = [
  { value: "", label: "No expiry" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "365", label: "1 year" },
];

/** Live status of a token row — a revoked or expired token is dead weight. */
function tokenState(token: ApiTokenSummary): "active" | "revoked" | "expired" {
  if (token.revoked_at) return "revoked";
  if (token.expires_at && Date.parse(token.expires_at) <= Date.now()) {
    return "expired";
  }
  return "active";
}

export function McpAccessCard({
  initialTokens,
  endpoint,
}: {
  initialTokens: ApiTokenSummary[];
  /** Absolute URL of /api/mcp, or "" when WEB_URL is not configured. */
  endpoint: string;
}) {
  const [tokens, setTokens] = React.useState(initialTokens);
  const [name, setName] = React.useState("");
  const [expiresInDays, setExpiresInDays] = React.useState("");
  const [creating, setCreating] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  /** Set once, right after minting — the only time the plaintext exists here. */
  const [freshToken, setFreshToken] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);
  const [revoking, setRevoking] = React.useState<ApiTokenSummary | null>(null);

  // WEB_URL is what the server knows itself as; without it, the address the
  // browser reached is the next best answer.
  const [origin, setOrigin] = React.useState(endpoint);
  React.useEffect(() => {
    if (!endpoint) setOrigin(`${window.location.origin}/api/mcp`);
  }, [endpoint]);

  const command = [
    "claude mcp add --transport http agent-fleet \\",
    `  ${origin || "https://your-fleet.example.com/api/mcp"} \\`,
    `  --header "Authorization: Bearer ${freshToken ?? "<your-token>"}"`,
  ].join("\n");

  async function createToken(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setError(null);
    setFreshToken(null);
    try {
      const { token, record } = await api<{
        token: string;
        record: ApiTokenSummary;
      }>("/api/profile/tokens", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          ...(expiresInDays ? { expiresInDays: Number(expiresInDays) } : {}),
        }),
      });
      setTokens((current) => [record, ...current]);
      setFreshToken(token);
      setName("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create token");
    } finally {
      setCreating(false);
    }
  }

  async function revokeToken(token: ApiTokenSummary) {
    setError(null);
    try {
      await api(`/api/profile/tokens/${token.id}`, { method: "DELETE" });
      setTokens((current) =>
        current.map((row) =>
          row.id === token.id
            ? { ...row, revoked_at: new Date().toISOString() }
            : row,
        ),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to revoke token");
    }
  }

  async function copy(text: string) {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <KeyRound className="size-4 text-primary" />
          MCP access
        </CardTitle>
        <CardDescription>
          Configure your agents from Claude Code — or any MCP client — on your
          own machine. A token acts as you: it can read and change every
          project and agent on this account.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="rounded-lg border border-border bg-muted/40 p-4">
          <p className="text-sm text-muted-foreground">
            Add the server once, then talk to it from any session:
          </p>
          <pre className="mt-2 overflow-x-auto rounded-md bg-background px-3 py-2 font-mono text-xs leading-relaxed text-foreground">
            {command}
          </pre>
          <Button
            variant="ghost"
            size="sm"
            className="mt-2"
            onClick={() => copy(command)}
          >
            {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
            {copied ? "Copied" : "Copy command"}
          </Button>
        </div>

        {freshToken && (
          <div className="rounded-lg border border-primary/40 bg-primary/5 p-4">
            <p className="text-sm font-medium">
              Copy this token now — it is not shown again.
            </p>
            <code className="mt-2 block overflow-x-auto rounded-md bg-background px-3 py-1.5 font-mono text-sm text-primary">
              {freshToken}
            </code>
          </div>
        )}

        <form onSubmit={createToken} className="flex flex-wrap items-end gap-3">
          <div className="min-w-48 flex-1 space-y-2">
            <Label htmlFor="token-name">Token name</Label>
            <Input
              id="token-name"
              placeholder="Laptop"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
            />
          </div>
          <div className="w-36 space-y-2">
            <Label htmlFor="token-expiry">Expires</Label>
            <Select
              id="token-expiry"
              value={expiresInDays}
              onChange={(event) => setExpiresInDays(event.target.value)}
            >
              {EXPIRY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </div>
          <Button type="submit" disabled={creating || !name.trim()}>
            <Plus className="size-4" />
            {creating ? "Creating…" : "Create token"}
          </Button>
        </form>

        {error && <p className="text-sm text-destructive">{error}</p>}

        {tokens.length === 0 ? (
          <p className="text-sm text-muted-foreground">No tokens yet.</p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {tokens.map((token) => {
              const state = tokenState(token);
              return (
                <li
                  key={token.id}
                  className="flex flex-wrap items-center gap-3 px-4 py-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">
                        {token.name}
                      </span>
                      {state === "revoked" && (
                        <Badge variant="destructive">Revoked</Badge>
                      )}
                      {state === "expired" && (
                        <Badge variant="warning">Expired</Badge>
                      )}
                    </div>
                    <p className="mt-0.5 font-mono text-xs text-muted-foreground">
                      {token.hint}…
                    </p>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {token.last_used_at
                      ? `Last used ${timeAgo(token.last_used_at)}`
                      : "Never used"}
                    <span className="mx-1.5">·</span>
                    Created {timeAgo(token.created_at)}
                  </div>
                  {state !== "revoked" && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setRevoking(token)}
                    >
                      <Trash2 className="size-4" />
                      Revoke
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>

      <ConfirmDialog
        open={Boolean(revoking)}
        onOpenChange={(open) => !open && setRevoking(null)}
        title="Revoke this token?"
        description={
          revoking
            ? `"${revoking.name}" stops working immediately. Any machine using it will need a new token.`
            : ""
        }
        confirmLabel="Revoke"
        onConfirm={async () => {
          if (revoking) await revokeToken(revoking);
        }}
      />
    </Card>
  );
}
