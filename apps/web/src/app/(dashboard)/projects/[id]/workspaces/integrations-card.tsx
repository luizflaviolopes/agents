"use client";

import * as React from "react";
import { FileText, Github, Mail, MessageSquare } from "lucide-react";
import type { IntegrationType } from "@agent-fleet/shared";
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

/** Masked view of one integration as returned by the API (never secrets). */
interface IntegrationView {
  type: IntegrationType;
  configured: boolean;
  config: Record<string, unknown>;
  updatedAt: string | null;
}

function configString(view: IntegrationView | undefined, key: string): string {
  const value = view?.config?.[key];
  return typeof value === "string" ? value : "";
}

/**
 * Per-project outbound credentials for the worker's deterministic action
 * executor. Secrets are write-only: the API returns them masked and this
 * card never renders a full secret after save.
 */
export function IntegrationsCard({ projectId }: { projectId: string }) {
  const [integrations, setIntegrations] = React.useState<
    IntegrationView[] | null
  >(null);

  React.useEffect(() => {
    let cancelled = false;
    api<{ integrations: IntegrationView[] }>(
      `/api/projects/${projectId}/integrations`,
    )
      .then(({ integrations }) => {
        if (!cancelled) setIntegrations(integrations);
      })
      .catch(() => {
        if (!cancelled) setIntegrations([]);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const slack = integrations?.find((i) => i.type === "slack");
  const gmail = integrations?.find((i) => i.type === "gmail");
  const github = integrations?.find((i) => i.type === "github");
  const notion = integrations?.find((i) => i.type === "notion");

  function onSaved(saved: IntegrationView) {
    setIntegrations((prev) =>
      (prev ?? []).map((i) => (i.type === saved.type ? saved : i)),
    );
  }

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle className="text-base">Integrations</CardTitle>
        <CardDescription>
          Outbound credentials used only by the server-side executor after
          you approve an action in Review — agents never see them.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <SlackIntegrationForm
            projectId={projectId}
            view={slack}
            onSaved={onSaved}
          />
          <GmailIntegrationForm
            projectId={projectId}
            view={gmail}
            onSaved={onSaved}
          />
          <McpIntegrationForm
            projectId={projectId}
            type="github"
            label="GitHub"
            icon={Github}
            tokenPlaceholder="github_pat_…"
            envVarPlaceholder="GITHUB_PERSONAL_ACCESS_TOKEN"
            writeUrlPlaceholder="https://api.githubcopilot.com/mcp/"
            cloneTokenPlaceholder="github_pat_… (Contents: Read)"
            view={github}
            onSaved={onSaved}
          />
          <McpIntegrationForm
            projectId={projectId}
            type="notion"
            label="Notion"
            icon={FileText}
            tokenPlaceholder="ntn_…"
            envVarPlaceholder="NOTION_TOKEN"
            writeUrlPlaceholder="https://mcp.notion.com/mcp"
            view={notion}
            onSaved={onSaved}
          />
        </div>
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------------ */

function SectionHeader({
  icon: Icon,
  label,
  view,
}: {
  icon: typeof MessageSquare;
  label: string;
  view: IntegrationView | undefined;
}) {
  return (
    <div className="flex items-center gap-2">
      <Icon className="size-4 text-muted-foreground" />
      <span className="text-sm font-semibold">{label}</span>
      {view?.configured ? (
        <Badge variant="success">configured</Badge>
      ) : (
        <Badge variant="muted">not configured</Badge>
      )}
    </div>
  );
}

async function putIntegration(
  projectId: string,
  type: IntegrationType,
  config: Record<string, string>,
): Promise<IntegrationView> {
  const { integration } = await api<{ integration: IntegrationView }>(
    `/api/projects/${projectId}/integrations`,
    { method: "PUT", body: JSON.stringify({ type, config }) },
  );
  return integration;
}

function SlackIntegrationForm({
  projectId,
  view,
  onSaved,
}: {
  projectId: string;
  view: IntegrationView | undefined;
  onSaved: (saved: IntegrationView) => void;
}) {
  const [token, setToken] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const maskedToken = configString(view, "userToken");

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const saved = await putIntegration(projectId, "slack", {
        userToken: token.trim(),
      });
      onSaved(saved);
      setToken("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="space-y-3">
      <SectionHeader icon={MessageSquare} label="Slack" view={view} />
      <div className="space-y-2">
        <Label htmlFor="slack-user-token">User OAuth token</Label>
        <Input
          id="slack-user-token"
          type="password"
          autoComplete="off"
          placeholder={maskedToken || "xoxp-…"}
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          xoxp- user token — used only by the server-side executor after your
          approval.
        </p>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Button type="submit" size="sm" disabled={busy || !token.trim()}>
        {busy ? "Saving…" : view?.configured ? "Replace token" : "Save"}
      </Button>
    </form>
  );
}

function GmailIntegrationForm({
  projectId,
  view,
  onSaved,
}: {
  projectId: string;
  view: IntegrationView | undefined;
  onSaved: (saved: IntegrationView) => void;
}) {
  const [clientId, setClientId] = React.useState("");
  const [clientSecret, setClientSecret] = React.useState("");
  const [refreshToken, setRefreshToken] = React.useState("");
  const [emailAddress, setEmailAddress] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  // clientId / emailAddress are not secrets — prefill them once loaded so
  // updating only the secrets doesn't force retyping everything.
  const loadedRef = React.useRef(false);
  React.useEffect(() => {
    if (loadedRef.current || !view?.configured) return;
    loadedRef.current = true;
    setClientId(configString(view, "clientId"));
    setEmailAddress(configString(view, "emailAddress"));
  }, [view]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const saved = await putIntegration(projectId, "gmail", {
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim(),
        refreshToken: refreshToken.trim(),
        emailAddress: emailAddress.trim(),
      });
      onSaved(saved);
      setClientSecret("");
      setRefreshToken("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="space-y-3">
      <SectionHeader icon={Mail} label="Gmail" view={view} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="gmail-client-id">Client ID</Label>
          <Input
            id="gmail-client-id"
            autoComplete="off"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="gmail-client-secret">Client secret</Label>
          <Input
            id="gmail-client-secret"
            type="password"
            autoComplete="off"
            placeholder={configString(view, "clientSecret")}
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="gmail-refresh-token">Refresh token</Label>
          <Input
            id="gmail-refresh-token"
            type="password"
            autoComplete="off"
            placeholder={configString(view, "refreshToken")}
            value={refreshToken}
            onChange={(e) => setRefreshToken(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="gmail-email-address">Email address</Label>
          <Input
            id="gmail-email-address"
            type="email"
            autoComplete="off"
            placeholder="agent@company.com"
            value={emailAddress}
            onChange={(e) => setEmailAddress(e.target.value)}
          />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        OAuth app credentials for the executor to send mail as this address.
        All four fields are required on every save.
      </p>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Button
        type="submit"
        size="sm"
        disabled={
          busy ||
          !clientId.trim() ||
          !clientSecret.trim() ||
          !refreshToken.trim() ||
          !emailAddress.trim()
        }
      >
        {busy ? "Saving…" : view?.configured ? "Replace credentials" : "Save"}
      </Button>
    </form>
  );
}

/**
 * Write credential for an MCP-reached integration (github/notion — 0010).
 *
 * These have no bespoke sender: the action executor connects to the MCP server
 * the agent named and attaches this token to its own connection. So unlike
 * Slack and Gmail, the config has to say WHERE the token goes — a header for a
 * remote server, an environment variable for a stdio one.
 *
 * The point of keeping it here rather than on the agent is that the agent's
 * session never holds it. Give the agent a read-only token and this one only
 * ever exists inside the executor, so a prompt injection in an issue body has
 * nothing to spend.
 */
function McpIntegrationForm({
  projectId,
  type,
  label,
  icon,
  tokenPlaceholder,
  envVarPlaceholder,
  writeUrlPlaceholder,
  cloneTokenPlaceholder,
  view,
  onSaved,
}: {
  projectId: string;
  type: IntegrationType;
  label: string;
  icon: typeof MessageSquare;
  tokenPlaceholder: string;
  envVarPlaceholder: string;
  writeUrlPlaceholder: string;
  /** github only: shows the clone-token field when set. */
  cloneTokenPlaceholder?: string;
  view: IntegrationView | undefined;
  onSaved: (saved: IntegrationView) => void;
}) {
  const [writeToken, setWriteToken] = React.useState("");
  const [cloneToken, setCloneToken] = React.useState("");
  const [headerName, setHeaderName] = React.useState("");
  const [envVar, setEnvVar] = React.useState("");
  const [url, setUrl] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  // headerName / envVar are not secrets — prefill them so replacing only the
  // token doesn't silently drop them.
  const loadedRef = React.useRef(false);
  React.useEffect(() => {
    if (loadedRef.current || !view?.configured) return;
    loadedRef.current = true;
    setHeaderName(configString(view, "headerName"));
    setEnvVar(configString(view, "envVar"));
    setUrl(configString(view, "url"));
  }, [view]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const saved = await putIntegration(projectId, type, {
        // Omit rather than send "" — the config schema is strict, an empty
        // header name would be a header with no name, and an omitted secret
        // means "keep the stored one" (the route carries it over).
        ...(writeToken.trim() ? { writeToken: writeToken.trim() } : {}),
        ...(cloneToken.trim() ? { cloneToken: cloneToken.trim() } : {}),
        ...(headerName.trim() ? { headerName: headerName.trim() } : {}),
        ...(envVar.trim() ? { envVar: envVar.trim() } : {}),
        ...(url.trim() ? { url: url.trim() } : {}),
      });
      onSaved(saved);
      setWriteToken("");
      setCloneToken("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="space-y-3">
      <SectionHeader icon={icon} label={label} view={view} />
      <div className="space-y-2">
        <Label htmlFor={`${type}-write-token`}>Write token</Label>
        <Input
          id={`${type}-write-token`}
          type="password"
          autoComplete="off"
          placeholder={configString(view, "writeToken") || tokenPlaceholder}
          value={writeToken}
          onChange={(e) => setWriteToken(e.target.value)}
        />
      </div>
      {cloneTokenPlaceholder && (
        <div className="space-y-2">
          <Label htmlFor={`${type}-clone-token`}>
            Clone token{" "}
            <span className="font-normal text-muted-foreground">
              (optional, read-only)
            </span>
          </Label>
          <Input
            id={`${type}-clone-token`}
            type="password"
            autoComplete="off"
            placeholder={configString(view, "cloneToken") || cloneTokenPlaceholder}
            value={cloneToken}
            onChange={(e) => setCloneToken(e.target.value)}
          />
        </div>
      )}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={`${type}-header-name`}>
            Header name{" "}
            <span className="font-normal text-muted-foreground">
              (http/sse)
            </span>
          </Label>
          <Input
            id={`${type}-header-name`}
            autoComplete="off"
            placeholder="Authorization: Bearer …"
            value={headerName}
            onChange={(e) => setHeaderName(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${type}-env-var`}>
            Env variable{" "}
            <span className="font-normal text-muted-foreground">(stdio)</span>
          </Label>
          <Input
            id={`${type}-env-var`}
            autoComplete="off"
            placeholder={envVarPlaceholder}
            value={envVar}
            onChange={(e) => setEnvVar(e.target.value)}
          />
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${type}-write-url`}>
          Write endpoint{" "}
          <span className="font-normal text-muted-foreground">
            (optional, http/sse)
          </span>
        </Label>
        <Input
          id={`${type}-write-url`}
          autoComplete="off"
          placeholder={writeUrlPlaceholder}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        Used for approved <code>{type}</code> MCP calls from any agent whose
        server points here. Leave the header name empty for the default{" "}
        <code>Authorization: Bearer &lt;token&gt;</code>, which is what the
        hosted GitHub and Notion MCP endpoints expect; a custom header receives
        the token verbatim. A stdio server needs the env variable instead.
      </p>
      <p className="text-xs text-muted-foreground">
        Set the write endpoint when read-only is a property of the URL rather
        than of the token — point the agent at a read-only endpoint and put the
        write-capable one here, and the agent cannot write even in principle.
      </p>
      {cloneTokenPlaceholder && (
        <p className="text-xs text-muted-foreground">
          The clone token is what the worker clones this project&apos;s
          workspace repos with — a separate, read-only PAT needing only{" "}
          <code>Contents: Read</code>. It never enters an agent session; agents
          only ever see the checkout. Leave a token field blank to keep the one
          already saved.
        </p>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Button
        type="submit"
        size="sm"
        disabled={
          busy ||
          (!view?.configured && !writeToken.trim() && !cloneToken.trim())
        }
      >
        {busy ? "Saving…" : "Save"}
      </Button>
    </form>
  );
}
