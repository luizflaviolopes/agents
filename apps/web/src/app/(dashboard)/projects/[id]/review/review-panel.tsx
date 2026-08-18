"use client";

import * as React from "react";
import Link from "next/link";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Inbox,
  X,
} from "lucide-react";
import type {
  GmailActionPayload,
  McpToolCallActionPayload,
  PendingActionRow,
  PendingActionType,
  SlackActionPayload,
} from "@agent-fleet/shared";
import { api } from "@/lib/api-client";
import { usePolling } from "@/lib/use-polling";
import { timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState } from "@/components/empty-state";

/** Pending action + the names joined in by the API. */
interface PendingActionJoined extends PendingActionRow {
  agent: { name: string } | null;
  task: { title: string } | null;
}

const ACTION_TYPE_META: Record<
  PendingActionType,
  { label: string; className: string }
> = {
  slack_reply: {
    label: "slack reply",
    className: "border-transparent bg-violet-500/15 text-violet-400",
  },
  slack_message: {
    label: "slack message",
    className: "border-transparent bg-violet-500/15 text-violet-400",
  },
  gmail_reply: {
    label: "gmail reply",
    className: "border-transparent bg-rose-500/15 text-rose-400",
  },
  gmail_send: {
    label: "gmail send",
    className: "border-transparent bg-rose-500/15 text-rose-400",
  },
  mcp_tool_call: {
    label: "mcp call",
    className: "border-transparent bg-sky-500/15 text-sky-400",
  },
};

function ActionTypeBadge({ type }: { type: PendingActionType }) {
  const meta = ACTION_TYPE_META[type] ?? ACTION_TYPE_META.slack_message;
  return (
    <Badge variant="outline" className={meta.className}>
      {meta.label}
    </Badge>
  );
}

/** The editable "main text" of a payload: Slack text or Gmail body. */
function mainTextKey(type: PendingActionType): "text" | "body" {
  return type.startsWith("slack") ? "text" : "body";
}

function mainText(action: PendingActionJoined): string {
  return action.action_type.startsWith("slack")
    ? ((action.payload as SlackActionPayload).text ?? "")
    : ((action.payload as GmailActionPayload).body ?? "");
}

/**
 * True when the owner may edit the payload before approving. False for
 * 'mcp_tool_call': its arguments are frozen on purpose — approving one means
 * approving that exact call, and the API rejects an edited payload for it.
 */
function isEditable(action: PendingActionJoined): boolean {
  return action.action_type !== "mcp_tool_call";
}

export function ReviewPanel({ projectId }: { projectId: string }) {
  // Poll all actions every 3s — pending cards + the decided history feed.
  const { data, loading, refresh } = usePolling<PendingActionJoined[]>(
    React.useCallback(async () => {
      const { actions } = await api<{ actions: PendingActionJoined[] }>(
        `/api/projects/${projectId}/pending-actions`,
      );
      return actions;
    }, [projectId]),
    3000,
    [projectId],
  );

  const actions = data ?? [];
  const pending = actions.filter((a) => a.status === "pending");
  const decided = actions.filter((a) => a.status !== "pending").slice(0, 30);

  return (
    <div className="mx-auto max-w-3xl px-4 py-4 sm:px-8 sm:py-6">
      <div className="mb-5">
        <p className="text-sm text-muted-foreground">
          Agents never act outward directly — outbound Slack messages, emails
          and approval-gated MCP tool calls all wait here for your approval.
        </p>
      </div>

      {loading ? (
        <div className="space-y-4">
          <Skeleton className="h-44" />
          <Skeleton className="h-44" />
        </div>
      ) : pending.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title="Nothing waiting for review"
          description="When an agent proposes a Slack message, an email, or a gated MCP tool call, it shows up here for you to approve, edit, or reject."
        />
      ) : (
        <div className="space-y-4">
          {pending.map((action) => (
            <PendingActionCard
              key={action.id}
              action={action}
              projectId={projectId}
              onDecided={refresh}
            />
          ))}
        </div>
      )}

      {decided.length > 0 && <HistorySection actions={decided} />}
    </div>
  );
}

/* ------------------------------------------------------------------------ */

function PendingActionCard({
  action,
  projectId,
  onDecided,
}: {
  action: PendingActionJoined;
  projectId: string;
  onDecided: () => void;
}) {
  const editable = isEditable(action);
  const original = mainText(action);
  const [text, setText] = React.useState(original);
  const [showRaw, setShowRaw] = React.useState(false);
  const [busy, setBusy] = React.useState<"approved" | "rejected" | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const edited = editable && text !== original;

  async function decide(decision: "approved" | "rejected") {
    setBusy(decision);
    setError(null);
    try {
      await api(`/api/pending-actions/${action.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          decision,
          // Approving with an edited main text sends the edited payload;
          // rejections and untouched approvals keep the original.
          ...(decision === "approved" && edited
            ? {
                payload: {
                  ...(action.payload as unknown as Record<string, unknown>),
                  [mainTextKey(action.action_type)]: text,
                },
              }
            : {}),
        }),
      });
      onDecided();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to decide action");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <CardContent className="pt-5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <ActionTypeBadge type={action.action_type} />
          <span className="text-sm font-medium">
            {action.agent?.name ?? "Unknown agent"}
          </span>
          {action.task_id && action.task && (
            <Link
              href={`/projects/${projectId}?task=${action.task_id}`}
              className="max-w-56 truncate text-sm text-primary underline-offset-4 hover:underline"
            >
              {action.task.title}
            </Link>
          )}
          <span className="ml-auto shrink-0 text-xs text-muted-foreground">
            {timeAgo(action.created_at)}
          </span>
        </div>

        <div className="mt-3 whitespace-pre-wrap rounded-lg border border-border bg-muted/40 p-3 text-sm">
          {action.preview}
        </div>

        {editable ? (
          <>
            <div className="mt-3 space-y-2">
              <Label htmlFor={`action-text-${action.id}`}>
                {action.action_type.startsWith("slack")
                  ? "Message text"
                  : "Email body"}
                {edited && (
                  <span className="ml-2 text-xs font-normal text-amber-400">
                    edited — the edited version will be sent
                  </span>
                )}
              </Label>
              <Textarea
                id={`action-text-${action.id}`}
                rows={Math.min(10, Math.max(3, text.split("\n").length + 1))}
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
            </div>

            <button
              type="button"
              onClick={() => setShowRaw((s) => !s)}
              className="mt-3 inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              {showRaw ? (
                <ChevronDown className="size-3.5" />
              ) : (
                <ChevronRight className="size-3.5" />
              )}
              Raw payload
            </button>
            {showRaw && (
              <pre className="mt-2 max-h-48 overflow-auto rounded-md border border-border bg-background/60 p-2 font-mono text-xs leading-relaxed text-muted-foreground">
                {JSON.stringify(action.payload, null, 2)}
              </pre>
            )}
          </>
        ) : (
          <McpCallDetail action={action} />
        )}

        {error && <p className="mt-3 text-sm text-destructive">{error}</p>}

        <div className="mt-4 flex items-center justify-end gap-2 border-t border-border pt-4">
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            disabled={busy !== null}
            onClick={() => decide("rejected")}
          >
            <X />
            {busy === "rejected" ? "Rejecting…" : "Reject"}
          </Button>
          <Button
            size="sm"
            disabled={busy !== null || (editable && text.trim().length === 0)}
            onClick={() => decide("approved")}
          >
            <Check />
            {busy === "approved"
              ? "Approving…"
              : edited
                ? "Approve edited"
                : "Approve"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------------ */

/**
 * Read-only view of a gated MCP call: which tool on which server, and the exact
 * arguments. Shown expanded rather than behind a toggle because these ARE the
 * decision — for a Slack message the preview carries the meaning, but "update
 * this page" means nothing without seeing which page and with what.
 */
function McpCallDetail({ action }: { action: PendingActionJoined }) {
  const payload = action.payload as McpToolCallActionPayload;

  return (
    <div className="mt-3 space-y-2">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <Label>Call</Label>
        <code className="font-mono text-xs text-foreground">
          {payload.server}.{payload.tool}
        </code>
      </div>
      <Label htmlFor={`action-args-${action.id}`} className="text-muted-foreground">
        Arguments — sent exactly as shown, and not editable
      </Label>
      <pre
        id={`action-args-${action.id}`}
        className="max-h-64 overflow-auto rounded-md border border-border bg-background/60 p-2 font-mono text-xs leading-relaxed text-muted-foreground"
      >
        {JSON.stringify(payload.arguments ?? {}, null, 2)}
      </pre>
      <p className="text-xs text-muted-foreground">
        To change anything, reject this and ask the agent to propose a corrected
        call.
      </p>
    </div>
  );
}

function HistorySection({ actions }: { actions: PendingActionJoined[] }) {
  const [open, setOpen] = React.useState(false);

  return (
    <section className="mt-8">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground"
      >
        {open ? (
          <ChevronDown className="size-3.5" />
        ) : (
          <ChevronRight className="size-3.5" />
        )}
        History ({actions.length})
      </button>

      {open && (
        <ul className="mt-3 divide-y divide-border rounded-lg border border-border">
          {actions.map((action) => (
            <li key={action.id} className="px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <HistoryStatus action={action} />
                <ActionTypeBadge type={action.action_type} />
                <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
                  {action.preview}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {timeAgo(action.decided_at ?? action.created_at)}
                </span>
              </div>
              {action.status === "failed" && action.error && (
                <p className="mt-1.5 font-mono text-xs text-red-400">
                  {action.error}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function HistoryStatus({ action }: { action: PendingActionJoined }) {
  const meta: Record<string, { label: string; className: string }> = {
    executed: { label: "✓ executed", className: "text-emerald-400" },
    approved: { label: "approved", className: "text-emerald-400" },
    failed: { label: "failed", className: "text-red-400" },
    rejected: { label: "rejected", className: "text-muted-foreground" },
  };
  const entry = meta[action.status] ?? meta.rejected;
  return (
    <span className={cn("text-xs font-medium", entry.className)}>
      {entry.label}
    </span>
  );
}
