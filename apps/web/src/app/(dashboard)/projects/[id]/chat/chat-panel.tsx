"use client";

import * as React from "react";
import { MessageSquare, SendHorizonal } from "lucide-react";
import type { Message } from "@agent-fleet/shared";
import { sendMessageSchema } from "@agent-fleet/shared";
import { api } from "@/lib/api-client";
import { usePolling } from "@/lib/use-polling";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState } from "@/components/empty-state";

export function ChatPanel({ projectId }: { projectId: string }) {
  // Accumulated messages; the poll fetches incrementally via ?after=<iso>
  // and merges (dedup by id) — manager replies arrive this way now that the
  // Realtime subscription is gone.
  const messagesRef = React.useRef<Message[]>([]);

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
      const url = last
        ? `/api/projects/${projectId}/messages?after=${encodeURIComponent(last.created_at)}`
        : `/api/projects/${projectId}/messages`;
      const { messages } = await api<{ messages: Message[] }>(url);
      return mergeMessages(messages);
    }, [projectId, mergeMessages]),
    2500,
    [projectId],
  );

  const [draft, setDraft] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [sending, setSending] = React.useState(false);
  const bottomRef = React.useRef<HTMLDivElement>(null);

  const messageCount = messages?.length ?? 0;
  React.useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messageCount]);

  async function send() {
    setError(null);
    const parsed = sendMessageSchema.safeParse({
      projectId,
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
          body: JSON.stringify({ content: parsed.data.content }),
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
    <div className="mx-auto flex h-full max-w-3xl flex-col px-6">
      <div className="flex-1 space-y-4 overflow-y-auto py-6">
        {loading ? (
          <div className="space-y-3 pt-6">
            <Skeleton className="h-12 w-2/3" />
            <Skeleton className="ml-auto h-12 w-2/3" />
            <Skeleton className="h-12 w-1/2" />
          </div>
        ) : messageCount === 0 ? (
          <EmptyState
            icon={MessageSquare}
            title="Talk to your manager"
            description="Describe what you need. The manager agent will break it into tasks and route them to your specialists."
            className="mt-10 border-none"
          />
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
                    {message.sender === "user" ? "You" : "Manager"}
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

      <div className="shrink-0 border-t border-border py-4">
        {error && <p className="mb-2 text-sm text-destructive">{error}</p>}
        <div className="flex items-end gap-2">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Message the manager… (Enter to send, Shift+Enter for a new line)"
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
    </div>
  );
}
