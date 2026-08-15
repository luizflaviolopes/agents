"use client";

import * as React from "react";
import { MessageSquare, SendHorizonal } from "lucide-react";
import type { Agent, Message } from "@agent-fleet/shared";
import { sendMessageSchema } from "@agent-fleet/shared";
import { api } from "@/lib/api-client";
import { usePolling } from "@/lib/use-polling";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { RoleBadge } from "@/components/badges";
import { EmptyState } from "@/components/empty-state";

/**
 * Project chat with one thread per conversation partner (0005): the manager
 * thread (messages with agent_id NULL — the whole pre-0005 flow) plus a
 * direct thread per active agent. The selector switches threads; each
 * thread keeps the incremental ?after= poll pattern.
 */
export function ChatPanel({
  projectId,
  agents,
}: {
  projectId: string;
  agents: Agent[];
}) {
  // null = the manager thread. The manager-role agent is covered by the
  // "Manager" chip, so only non-manager agents get their own chip.
  const [threadAgentId, setThreadAgentId] = React.useState<string | null>(null);
  const threadAgents = agents.filter((a) => a.role !== "manager");
  const threadAgent = threadAgents.find((a) => a.id === threadAgentId) ?? null;

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col px-4 sm:px-6">
      <div className="flex shrink-0 flex-wrap gap-1.5 border-b border-border py-3">
        <button
          type="button"
          onClick={() => setThreadAgentId(null)}
          className={cn(
            "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
            threadAgentId === null
              ? "border-primary/50 bg-primary/10 text-foreground"
              : "border-border text-muted-foreground hover:border-primary/40 hover:text-foreground",
          )}
        >
          Manager
        </button>
        {threadAgents.map((agent) => (
          <button
            key={agent.id}
            type="button"
            onClick={() => setThreadAgentId(agent.id)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors",
              threadAgentId === agent.id
                ? "border-primary/50 bg-primary/10 text-foreground"
                : "border-border text-muted-foreground hover:border-primary/40 hover:text-foreground",
            )}
          >
            {agent.name}
            <RoleBadge role={agent.role} />
          </button>
        ))}
      </div>

      {/* Keyed by thread so switching starts a fresh poll + message list. */}
      <ChatThread
        key={threadAgentId ?? "manager"}
        projectId={projectId}
        agent={threadAgent}
      />
    </div>
  );
}

/* ------------------------------------------------------------------------ */

/** One chat thread: `agent` null = the manager thread. */
function ChatThread({
  projectId,
  agent,
}: {
  projectId: string;
  agent: Agent | null;
}) {
  // Accumulated messages; the poll fetches incrementally via ?after=<iso>
  // and merges (dedup by id) — replies arrive this way now that the
  // Realtime subscription is gone.
  const messagesRef = React.useRef<Message[]>([]);
  const threadParam = agent ? agent.id : "none";

  const mergeMessages = React.useCallback((incoming: Message[]): Message[] => {
    if (incoming.length > 0) {
      const known = new Set(messagesRef.current.map((m) => m.id));
      const fresh = incoming.filter((m) => !known.has(m.id));
      if (fresh.length > 0) {
        messagesRef.current = [...messagesRef.current, ...fresh].sort((a, b) =>
          (a.created_at ?? "").localeCompare(b.created_at ?? ""),
        );
      }
    }
    return messagesRef.current;
  }, []);

  const {
    data: messages,
    loading,
    refresh,
  } = usePolling<Message[]>(
    React.useCallback(async () => {
      const last = messagesRef.current[messagesRef.current.length - 1];
      const search = new URLSearchParams({ agentId: threadParam });
      if (last) search.set("after", last.created_at);
      const { messages } = await api<{ messages: Message[] }>(
        `/api/projects/${projectId}/messages?${search.toString()}`,
      );
      return mergeMessages(messages);
    }, [projectId, threadParam, mergeMessages]),
    2500,
    [projectId, threadParam],
  );

  const [draft, setDraft] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [sending, setSending] = React.useState(false);
  const bottomRef = React.useRef<HTMLDivElement>(null);

  const messageCount = messages?.length ?? 0;
  React.useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messageCount]);

  /** Label for the incoming side of a bubble. */
  function senderLabel(message: Message): string {
    if (message.sender === "user") return "You";
    if (message.sender === "agent") return agent?.name ?? "Agent";
    return "Manager";
  }

  async function send() {
    setError(null);
    const parsed = sendMessageSchema.safeParse({
      projectId,
      agentId: agent?.id,
      content: draft.trim(),
      channel: "web",
    });
    if (!parsed.success) return;

    setSending(true);
    try {
      const { message } = await api<{ message: Message }>(
        `/api/projects/${projectId}/messages`,
        {
          method: "POST",
          body: JSON.stringify({
            content: parsed.data.content,
            ...(agent ? { agentId: agent.id } : {}),
          }),
        },
      );
      mergeMessages([message]);
      refresh(); // re-render with the merged list immediately
      setDraft("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send message");
    } finally {
      setSending(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  return (
    <>
      <div className="flex-1 space-y-4 overflow-y-auto py-6">
        {loading ? (
          <div className="space-y-3 pt-6">
            <Skeleton className="h-12 w-2/3" />
            <Skeleton className="ml-auto h-12 w-2/3" />
            <Skeleton className="h-12 w-1/2" />
          </div>
        ) : messageCount === 0 ? (
          agent ? (
            <EmptyState
              icon={MessageSquare}
              title={`Start a conversation with ${agent.name}`}
              description="Direct messages go straight to this agent — it replies here with its own tools and knowledge."
              className="mt-10 border-none"
            />
          ) : (
            <EmptyState
              icon={MessageSquare}
              title="Talk to your manager"
              description="Describe what you need. The manager agent will break it into tasks and route them to your specialists."
              className="mt-10 border-none"
            />
          )
        ) : (
          (messages ?? []).map((message) => (
            <div
              key={message.id}
              className={cn(
                "flex",
                message.sender === "user" ? "justify-end" : "justify-start",
              )}
            >
              <div
                className={cn(
                  "max-w-[80%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed",
                  message.sender === "user"
                    ? "rounded-br-sm bg-primary text-primary-foreground"
                    : "rounded-bl-sm border border-border bg-card",
                )}
              >
                <div className="whitespace-pre-wrap">{message.content}</div>
                <div
                  className={cn(
                    "mt-1 flex items-center gap-1.5 text-[10px]",
                    message.sender === "user"
                      ? "text-primary-foreground/70"
                      : "text-muted-foreground",
                  )}
                >
                  <span>
                    {senderLabel(message)}
                    {message.channel === "telegram" ? " · telegram" : ""}
                  </span>
                  <span>{formatDateTime(message.created_at)}</span>
                </div>
              </div>
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>

      <div className="shrink-0 border-t border-border pb-safe pt-3 sm:py-4">
        {error && <p className="mb-2 text-sm text-destructive">{error}</p>}
        <div className="flex items-end gap-2">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={`Message ${agent ? agent.name : "the manager"}… (Enter to send, Shift+Enter for a new line)`}
            rows={2}
            className="resize-none"
          />
          <Button
            size="icon"
            onClick={send}
            disabled={sending || !draft.trim()}
            aria-label="Send message"
          >
            <SendHorizonal />
          </Button>
        </div>
      </div>
    </>
  );
}
