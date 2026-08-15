"use client";

import * as React from "react";
import { BookOpen, Pencil, Plus, Trash2 } from "lucide-react";
import { api } from "@/lib/api-client";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { EmptyState } from "@/components/empty-state";
import {
  ProvenanceLine,
  type KnowledgeDocJoined,
} from "@/components/knowledge-provenance";

interface EditorState {
  doc: KnowledgeDocJoined | null; // null = creating
  title: string;
  content: string;
}

/**
 * Project-scoped knowledge docs (0005): shared by every agent of the
 * project, injected into all system prompts by the worker. Kind is always
 * 'knowledge' here — voice profiles stay agent-scoped (per-agent dialog).
 */
export function KnowledgePanel({ projectId }: { projectId: string }) {
  const [docs, setDocs] = React.useState<KnowledgeDocJoined[] | null>(null);
  const [editor, setEditor] = React.useState<EditorState | null>(null);
  const [deleteDoc, setDeleteDoc] = React.useState<KnowledgeDocJoined | null>(
    null,
  );
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    api<{ docs: KnowledgeDocJoined[] }>(`/api/projects/${projectId}/knowledge`)
      .then(({ docs }) => {
        if (!cancelled) setDocs(docs);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load docs");
          setDocs([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!editor) return;
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
              title: editor.title.trim(),
              content: editor.content,
            }),
          },
        );
        setDocs((prev) => (prev ?? []).map((d) => (d.id === doc.id ? doc : d)));
      } else {
        const { doc } = await api<{ doc: KnowledgeDocJoined }>(
          `/api/projects/${projectId}/knowledge`,
          {
            method: "POST",
            body: JSON.stringify({
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
    <div className="mx-auto max-w-3xl px-4 py-4 sm:px-8 sm:py-6">
      <div className="mb-5 flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Project knowledge — injected into every agent&apos;s system prompt.
          The librarian curates these; you can edit them here too.
        </p>
        <Button
          size="sm"
          onClick={() => setEditor({ doc: null, title: "", content: "" })}
        >
          <Plus />
          New doc
        </Button>
      </div>

      {docs === null ? (
        <div className="space-y-2">
          <Skeleton className="h-14" />
          <Skeleton className="h-14" />
        </div>
      ) : docs.length === 0 ? (
        <EmptyState
          icon={BookOpen}
          title="No project knowledge yet"
          description="Docs added here are shared by every agent in the project. A librarian agent can also curate them from conversations and task results."
          action={
            <Button
              onClick={() => setEditor({ doc: null, title: "", content: "" })}
            >
              <Plus />
              New doc
            </Button>
          }
        />
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {docs.map((doc) => (
            <li key={doc.id} className="flex items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{doc.title}</div>
                <ProvenanceLine doc={doc} />
              </div>
              <Button
                variant="ghost"
                size="iconSm"
                aria-label={`Edit ${doc.title}`}
                onClick={() =>
                  setEditor({ doc, title: doc.title, content: doc.content })
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
      {error && !editor && (
        <p className="mt-3 text-sm text-destructive">{error}</p>
      )}

      <Dialog
        open={Boolean(editor)}
        onOpenChange={(o) => {
          if (!o) {
            setEditor(null);
            setError(null);
          }
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {editor?.doc ? `Edit ${editor.doc.title}` : "New project doc"}
            </DialogTitle>
            <DialogDescription>
              Shared knowledge for all agents in this project.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={save} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="project-doc-title">Title</Label>
              <Input
                id="project-doc-title"
                placeholder="e.g. Release process"
                value={editor?.title ?? ""}
                onChange={(e) =>
                  setEditor((prev) =>
                    prev ? { ...prev, title: e.target.value } : prev,
                  )
                }
                autoFocus
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="project-doc-content">Content (markdown)</Label>
              <Textarea
                id="project-doc-content"
                rows={14}
                className="font-mono text-xs leading-relaxed"
                placeholder="Anything every agent in this project should always know."
                value={editor?.content ?? ""}
                onChange={(e) =>
                  setEditor((prev) =>
                    prev ? { ...prev, content: e.target.value } : prev,
                  )
                }
              />
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
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? "Saving…" : editor?.doc ? "Save changes" : "Add doc"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={Boolean(deleteDoc)}
        onOpenChange={(open) => !open && setDeleteDoc(null)}
        title={`Delete "${deleteDoc?.title}"?`}
        description="The doc will no longer be injected into the agents' system prompts. This cannot be undone."
        onConfirm={async () => {
          if (deleteDoc) await remove(deleteDoc);
        }}
      />
    </div>
  );
}
