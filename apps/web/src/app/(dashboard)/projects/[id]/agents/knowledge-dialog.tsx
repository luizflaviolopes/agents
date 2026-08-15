"use client";

import * as React from "react";
import { BookOpen, Mic, Pencil, Plus, Trash2 } from "lucide-react";
import type { Agent, KnowledgeKind } from "@agent-fleet/shared";
import { api } from "@/lib/api-client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { ConfirmDialog } from "@/components/confirm-dialog";
import {
  ProvenanceLine,
  type KnowledgeDocJoined,
} from "@/components/knowledge-provenance";

const KIND_GROUPS: { kind: KnowledgeKind; label: string; icon: typeof Mic }[] =
  [
    { kind: "voice", label: "Voice profiles", icon: Mic },
    { kind: "knowledge", label: "Knowledge", icon: BookOpen },
  ];

interface EditorState {
  doc: KnowledgeDocJoined | null; // null = creating
  kind: KnowledgeKind;
  title: string;
  content: string;
}

/**
 * Knowledge docs manager for one agent: docs are injected into the agent's
 * system prompt by the worker ('voice' docs under a "Voice profiles"
 * heading).
 */
export function KnowledgeDialog({
  agent,
  onClose,
}: {
  agent: Agent | null;
  onClose: () => void;
}) {
  const [docs, setDocs] = React.useState<KnowledgeDocJoined[] | null>(null);
  const [editor, setEditor] = React.useState<EditorState | null>(null);
  const [deleteDoc, setDeleteDoc] = React.useState<KnowledgeDocJoined | null>(
    null,
  );
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  // Load the docs whenever the dialog opens for an agent.
  React.useEffect(() => {
    if (!agent) {
      setDocs(null);
      setEditor(null);
      setError(null);
      return;
    }
    let cancelled = false;
    api<{ docs: KnowledgeDocJoined[] }>(`/api/agents/${agent.id}/knowledge`)
      .then(({ docs }) => {
        if (!cancelled) setDocs(docs);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "Failed to load docs",
          );
          setDocs([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [agent]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!agent || !editor) return;
    if (!editor.title.trim()) {
      setError("Give the doc a title.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (editor.doc) {
        const { doc } = await api<{ doc: KnowledgeDocJoined }>(
          `/api/knowledge/${editor.doc.id}`,
          {
            method: "PATCH",
            body: JSON.stringify({
              kind: editor.kind,
              title: editor.title.trim(),
              content: editor.content,
            }),
          },
        );
        setDocs((prev) =>
          (prev ?? []).map((d) => (d.id === doc.id ? doc : d)),
        );
      } else {
        const { doc } = await api<{ doc: KnowledgeDocJoined }>(
          `/api/agents/${agent.id}/knowledge`,
          {
            method: "POST",
            body: JSON.stringify({
              kind: editor.kind,
              title: editor.title.trim(),
              content: editor.content,
            }),
          },
        );
        setDocs((prev) => [...(prev ?? []), doc]);
      }
      setEditor(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save doc");
    } finally {
      setBusy(false);
    }
  }

  async function remove(doc: KnowledgeDocJoined) {
    try {
      await api(`/api/knowledge/${doc.id}`, { method: "DELETE" });
      setDocs((prev) => (prev ?? []).filter((d) => d.id !== doc.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete doc");
    }
  }

  return (
    <>
      <Dialog open={Boolean(agent)} onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Knowledge — {agent?.name}</DialogTitle>
            <DialogDescription>
              Persistent docs injected into this agent&apos;s system prompt on
              every run. Voice docs should state WHO and WHEN the voice
              applies (recipient, channel, language) plus tone examples.
            </DialogDescription>
          </DialogHeader>

          {editor ? (
            <form onSubmit={save} className="space-y-4">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_10rem]">
                <div className="space-y-2">
                  <Label htmlFor="doc-title">Title</Label>
                  <Input
                    id="doc-title"
                    placeholder="e.g. Casual voice for #general"
                    value={editor.title}
                    onChange={(e) =>
                      setEditor({ ...editor, title: e.target.value })
                    }
                    autoFocus
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="doc-kind">Kind</Label>
                  <Select
                    id="doc-kind"
                    value={editor.kind}
                    onChange={(e) =>
                      setEditor({
                        ...editor,
                        kind: e.target.value as KnowledgeKind,
                      })
                    }
                  >
                    <option value="knowledge">Knowledge</option>
                    <option value="voice">Voice profile</option>
                  </Select>
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="doc-content">Content (markdown)</Label>
                <Textarea
                  id="doc-content"
                  rows={14}
                  className="font-mono text-xs leading-relaxed"
                  placeholder={
                    editor.kind === "voice"
                      ? "## When this voice applies\nReplies to customers in #support, in English.\n\n## Tone\nWarm, concise, no exclamation marks.\n\n## Examples\n…"
                      : "Anything this agent should always know."
                  }
                  value={editor.content}
                  onChange={(e) =>
                    setEditor({ ...editor, content: e.target.value })
                  }
                />
                {editor.kind === "voice" && (
                  <p className="text-xs text-muted-foreground">
                    Multiple voices are supported — the agent picks per
                    message, so say who/when this one applies in the content
                    itself.
                  </p>
                )}
              </div>
              {error && <p className="text-sm text-destructive">{error}</p>}
              <DialogFooter className="mt-0">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setEditor(null);
                    setError(null);
                  }}
                >
                  Back
                </Button>
                <Button type="submit" disabled={busy}>
                  {busy ? "Saving…" : editor.doc ? "Save changes" : "Add doc"}
                </Button>
              </DialogFooter>
            </form>
          ) : (
            <div className="space-y-5">
              <div className="max-h-[56vh] space-y-5 overflow-y-auto pr-1">
                {docs === null ? (
                  <div className="space-y-2">
                    <Skeleton className="h-10" />
                    <Skeleton className="h-10" />
                  </div>
                ) : (
                  KIND_GROUPS.map(({ kind, label, icon: Icon }) => {
                    const group = docs.filter((d) => d.kind === kind);
                    return (
                      <section key={kind}>
                        <h3 className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          <Icon className="size-3.5" />
                          {label}
                        </h3>
                        {group.length === 0 ? (
                          <p className="rounded-lg border border-dashed border-border p-3 text-sm text-muted-foreground">
                            No {label.toLowerCase()} yet.
                          </p>
                        ) : (
                          <ul className="divide-y divide-border rounded-lg border border-border">
                            {group.map((doc) => (
                              <li
                                key={doc.id}
                                className="flex items-center gap-3 px-3 py-2.5"
                              >
                                <div className="min-w-0 flex-1">
                                  <div className="truncate text-sm font-medium">
                                    {doc.title}
                                  </div>
                                  <ProvenanceLine doc={doc} />
                                </div>
                                <Badge
                                  variant={
                                    kind === "voice" ? "info" : "secondary"
                                  }
                                  className="shrink-0"
                                >
                                  {kind}
                                </Badge>
                                <Button
                                  variant="ghost"
                                  size="iconSm"
                                  aria-label={`Edit ${doc.title}`}
                                  onClick={() =>
                                    setEditor({
                                      doc,
                                      kind: doc.kind,
                                      title: doc.title,
                                      content: doc.content,
                                    })
                                  }
                                >
                                  <Pencil />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="iconSm"
                                  className="text-muted-foreground hover:text-destructive"
                                  aria-label={`Delete ${doc.title}`}
                                  onClick={() => setDeleteDoc(doc)}
                                >
                                  <Trash2 />
                                </Button>
                              </li>
                            ))}
                          </ul>
                        )}
                      </section>
                    );
                  })
                )}
              </div>
              {error && <p className="text-sm text-destructive">{error}</p>}
              <DialogFooter className="mt-0">
                <Button type="button" variant="ghost" onClick={onClose}>
                  Close
                </Button>
                <Button
                  type="button"
                  onClick={() =>
                    setEditor({
                      doc: null,
                      kind: "knowledge",
                      title: "",
                      content: "",
                    })
                  }
                >
                  <Plus />
                  Add doc
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={Boolean(deleteDoc)}
        onOpenChange={(open) => !open && setDeleteDoc(null)}
        title={`Delete "${deleteDoc?.title}"?`}
        description="The doc will no longer be injected into the agent's system prompt. This cannot be undone."
        onConfirm={async () => {
          if (deleteDoc) await remove(deleteDoc);
        }}
      />
    </>
  );
}
