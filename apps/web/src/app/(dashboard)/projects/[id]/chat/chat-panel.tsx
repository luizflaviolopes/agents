"use client";

import * as React from "react";
import { MessageSquare, SendHorizonal } from "lucide-react";
import type { Message } from "@agent-fleet/shared";
import { sendMessageSchema } from "@agent-fleet/shared";
import { createClient } from "@/lib/supabase/client";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState } from "@/components/empty-state";

export function ChatPanel({
  projectId,
  initialMessages,
}: {
  projectId: string;
  initialMessages: Message[];
}) {
  const supabase = React.useMemo(() => createClient(), []);
  const [messages, setMessages] = React.useState<Message[]>(initialMessages);
  const [draft, setDraft] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [sending, setSending] = React.useState(false);
  const bottomRef = React.useRef<HTMLDivElement>(null);

  // Manager replies arrive asynchronously via Realtime.
  React.useEffect(() => {
    const channel = supabase
      .channel(`chat:${projectId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "messages",
          filter: `project_id=eq.${projectId}`,
        },
        (payload) => {
          const message = payload.new as Message;
          setMessages((prev) =>
            prev.some((m) => m.id === message.id) ? prev : [...prev, message],
          );
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [projectId, supabase]);

  React.useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  async function send() {
    setError(null);
    const parsed = sendMessageSchema.safeParse({
      projectId,
      content: draft.trim(),
      channel: "web",
    });
    if (!parsed.success) return;

    setSending(true);
    const { data, error: insertError } = await supabase
      .from("messages")
      .insert({
        project_id: parsed.data.projectId,
        sender: "user",
        channel: parsed.data.channel,
        content: parsed.data.content,
      })
      .select()
      .single();

    setSending(false);
    if (insertError || !data) {
      setError(insertError?.message ?? "Failed to send message");
      return;
    }

    const message = data as Message;
    setMessages((prev) =>
      prev.some((m) => m.id === message.id) ? prev : [...prev, message],
    );
    setDraft("");
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
        {messages.length === 0 ? (
          <EmptyState
            icon={MessageSquare}
            title="Talk to your manager"
            description="Describe what you need. The manager agent will break it into tasks and route them to your specialists."
            className="mt-10 border-none"
          />
        ) : (
          messages.map((message) => (
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
