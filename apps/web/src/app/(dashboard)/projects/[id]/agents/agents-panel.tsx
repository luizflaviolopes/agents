"use client";

import * as React from "react";
import {
  BookOpen,
  Bot,
  FolderGit2,
  Pencil,
  Plus,
  Plug,
  Server,
  Sparkles,
  Trash2,
} from "lucide-react";
import type { Agent, McpServerConfig, Workspace } from "@agent-fleet/shared";
import { api } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { RoleBadge } from "@/components/badges";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { EmptyState } from "@/components/empty-state";
import {
  AgentForm,
  agentToForm,
  emptyAgentForm,
  mcpConfigToRow,
  rowToMcpConfig,
  type AgentFormValue,
} from "./agent-form";
import { KnowledgeDialog } from "./knowledge-dialog";

interface BuilderProposal {
  name?: string;
  instructions?: string;
  model?: string;
  plugins?: string[];
  mcpServers?: McpServerConfig[];
  needsWorkspace?: boolean;
  reasoning?: string;
}

export function AgentsPanel({
  projectId,
  initialAgents,
  workspaces,
}: {
  projectId: string;
  initialAgents: Agent[];
  workspaces: Workspace[];
}) {
  const [agents, setAgents] = React.useState<Agent[]>(initialAgents);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [editAgent, setEditAgent] = React.useState<Agent | null>(null);
  const [knowledgeAgent, setKnowledgeAgent] = React.useState<Agent | null>(
    null,
  );
  const [deleteAgent, setDeleteAgent] = React.useState<Agent | null>(null);

  const workspaceName = (id: string | null) =>
    workspaces.find((w) => w.id === id)?.name ?? null;

  async function toggleActive(agent: Agent, active: boolean) {
    setAgents((prev) =>
      prev.map((a) => (a.id === agent.id ? { ...a, is_active: active } : a)),
    );
    try {
      await api<{ agent: Agent }>(`/api/agents/${agent.id}`, {
        method: "PATCH",
        body: JSON.stringify({ isActive: active }),
      });
    } catch {
      // revert on failure
      setAgents((prev) =>
        prev.map((a) => (a.id === agent.id ? { ...a, is_active: !active } : a)),
      );
    }
  }

  async function removeAgent(agent: Agent) {
    try {
      await api(`/api/agents/${agent.id}`, { method: "DELETE" });
      setAgents((prev) => prev.filter((a) => a.id !== agent.id));
    } catch {
      // keep the agent in the list if the server refused the delete
    }
  }

  const sorted = [...agents].sort((a, b) => {
    if (a.role !== b.role) return a.role === "manager" ? -1 : 1;
    return (a.created_at ?? "").localeCompare(b.created_at ?? "");
  });

  return (
    <div className="mx-auto max-w-5xl px-8 py-6">
      <div className="mb-5 flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {agents.length} agent{agents.length === 1 ? "" : "s"} in this project
        </p>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus />
          New agent
        </Button>
      </div>

      {sorted.length === 0 ? (
        <EmptyState
          icon={Bot}
          title="No agents yet"
          description="Add specialist agents to do the work. Describe the agent you want and Claude will draft it for you."
          action={
            <Button onClick={() => setCreateOpen(true)}>
              <Plus />
              New agent
            </Button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {sorted.map((agent) => (
            <Card key={agent.id} className={!agent.is_active ? "opacity-60" : ""}>
              <CardHeader className="flex-row items-start justify-between space-y-0">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-semibold">{agent.name}</span>
                    <RoleBadge role={agent.role} />
                  </div>
                  <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
                    {agent.model}
                  </p>
                </div>
                <Switch
                  checked={agent.is_active}
                  onCheckedChange={(checked) => toggleActive(agent, checked)}
                />
              </CardHeader>
              <CardContent>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1">
                    <FolderGit2 className="size-3.5" />
                    {workspaceName(agent.workspace_id) ?? "No workspace"}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <Plug className="size-3.5" />
                    {agent.plugins?.length ?? 0} plugin
                    {(agent.plugins?.length ?? 0) === 1 ? "" : "s"}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <Server className="size-3.5" />
                    {agent.mcp_servers?.length ?? 0} MCP
                  </span>
                </div>
                <div className="mt-4 flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setEditAgent(agent)}
                  >
                    <Pencil />
                    Edit
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setKnowledgeAgent(agent)}
                  >
                    <BookOpen />
                    Knowledge
                  </Button>
                  {agent.role !== "manager" && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-muted-foreground hover:text-destructive"
                      onClick={() => setDeleteAgent(agent)}
                    >
                      <Trash2 />
                      Delete
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <CreateAgentDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        projectId={projectId}
        workspaces={workspaces}
        onCreated={(agent) => setAgents((prev) => [...prev, agent])}
      />

      <EditAgentDialog
        agent={editAgent}
        workspaces={workspaces}
        onClose={() => setEditAgent(null)}
        onSaved={(agent) =>
          setAgents((prev) => prev.map((a) => (a.id === agent.id ? agent : a)))
        }
      />

      <KnowledgeDialog
        agent={knowledgeAgent}
        onClose={() => setKnowledgeAgent(null)}
      />

      <ConfirmDialog
        open={Boolean(deleteAgent)}
        onOpenChange={(open) => !open && setDeleteAgent(null)}
        title={`Delete ${deleteAgent?.name ?? "agent"}?`}
        description="Queued tasks assigned to this agent will become unassigned. This cannot be undone."
        onConfirm={async () => {
          if (deleteAgent) await removeAgent(deleteAgent);
        }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------------ */

function CreateAgentDialog({
  open,
  onOpenChange,
  projectId,
  workspaces,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  workspaces: Workspace[];
  onCreated: (agent: Agent) => void;
}) {
  const [tab, setTab] = React.useState<"manual" | "builder">("manual");
  const [form, setForm] = React.useState<AgentFormValue>(emptyAgentForm());
  const [idea, setIdea] = React.useState("");
  const [builderNote, setBuilderNote] = React.useState<string | null>(null);
  const [needsWorkspace, setNeedsWorkspace] = React.useState(false);
  const [generating, setGenerating] = React.useState(false);
  const [hasDraft, setHasDraft] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  function reset() {
    setTab("manual");
    setForm(emptyAgentForm());
    setIdea("");
    setBuilderNote(null);
    setNeedsWorkspace(false);
    setHasDraft(false);
    setError(null);
  }

  async function generateDraft() {
    setGenerating(true);
    setError(null);
    try {
      const res = await fetch("/api/agent-builder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idea, projectId }),
      });
      const json = (await res.json()) as {
        proposal?: BuilderProposal;
        error?: string;
      };
      if (!res.ok || !json.proposal) {
        setError(json.error ?? "The agent builder failed. Try again.");
        return;
      }
      const p = json.proposal;
      setForm({
        name: p.name ?? "",
        instructions: p.instructions ?? "",
        model: p.model || emptyAgentForm().model,
        workspaceId: "",
        plugins: p.plugins ?? [],
        mcpServers: (p.mcpServers ?? []).map(mcpConfigToRow),
      });
      setBuilderNote(p.reasoning ?? null);
      setNeedsWorkspace(Boolean(p.needsWorkspace));
      setHasDraft(true);
    } catch {
      setError("Could not reach the agent builder.");
    } finally {
      setGenerating(false);
    }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!form.name.trim()) {
      setError("Give the agent a name.");
      return;
    }
    setBusy(true);
    let created: Agent;
    try {
      const { agent } = await api<{ agent: Agent }>(
        `/api/projects/${projectId}/agents`,
        {
          method: "POST",
          body: JSON.stringify({
            name: form.name.trim(),
            workspaceId: form.workspaceId || null,
            instructions: form.instructions,
            model: form.model,
            plugins: form.plugins,
            mcpServers: form.mcpServers
              .filter((row) => row.name.trim())
              .map(rowToMcpConfig),
          }),
        },
      );
      created = agent;
    } catch (err) {
      setBusy(false);
      setError(err instanceof Error ? err.message : "Failed to create agent");
      return;
    }
    setBusy(false);
    onCreated(created);
    onOpenChange(false);
    reset();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) reset();
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>New agent</DialogTitle>
          <DialogDescription>
            Configure a specialist agent by hand, or describe it and let Claude
            draft the configuration.
          </DialogDescription>
        </DialogHeader>

        <Tabs
          value={tab}
          onValueChange={(v) => setTab(v as "manual" | "builder")}
        >
          <TabsList>
            <TabsTrigger value="manual">Manual</TabsTrigger>
            <TabsTrigger value="builder">
              <Sparkles className="mr-1.5 size-3.5" />
              Describe it
            </TabsTrigger>
          </TabsList>

          <TabsContent value="manual">
            <form onSubmit={save} className="space-y-4">
              <div className="max-h-[52vh] overflow-y-auto pr-1">
                <AgentForm
                  value={form}
                  onChange={setForm}
                  workspaces={workspaces}
                />
              </div>
              {error && <p className="text-sm text-destructive">{error}</p>}
              <DialogFooter className="mt-0">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => onOpenChange(false)}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={busy}>
                  {busy ? "Creating…" : "Create agent"}
                </Button>
              </DialogFooter>
            </form>
          </TabsContent>

          <TabsContent value="builder">
            {!hasDraft ? (
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="agent-idea">
                    Describe the agent you want
                  </Label>
                  <Textarea
                    id="agent-idea"
                    rows={5}
                    placeholder="e.g. A code-review agent that checks pull requests in our API repo for security issues and style violations, and writes a summary comment."
                    value={idea}
                    onChange={(e) => setIdea(e.target.value)}
                  />
                </div>
                {error && <p className="text-sm text-destructive">{error}</p>}
                <DialogFooter className="mt-0">
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => onOpenChange(false)}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    disabled={generating || idea.trim().length === 0}
                    onClick={generateDraft}
                  >
                    <Sparkles />
                    {generating ? "Drafting…" : "Generate draft"}
                  </Button>
                </DialogFooter>
              </div>
            ) : (
              <form onSubmit={save} className="space-y-4">
                {(builderNote || needsWorkspace) && (
                  <div className="rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm">
                    {builderNote && <p>{builderNote}</p>}
                    {needsWorkspace && (
                      <p className="mt-1 text-muted-foreground">
                        This agent likely needs a workspace with cloned
                        repositories — pick one below or create it in the
                        Workspaces tab.
                      </p>
                    )}
                  </div>
                )}
                <div className="max-h-[46vh] overflow-y-auto pr-1">
                  <AgentForm
                    value={form}
                    onChange={setForm}
                    workspaces={workspaces}
                  />
                </div>
                {error && <p className="text-sm text-destructive">{error}</p>}
                <DialogFooter className="mt-0">
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      setHasDraft(false);
                      setBuilderNote(null);
                    }}
                  >
                    Back
                  </Button>
                  <Button type="submit" disabled={busy}>
                    {busy ? "Creating…" : "Create agent"}
                  </Button>
                </DialogFooter>
              </form>
            )}
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------------ */

function EditAgentDialog({
  agent,
  workspaces,
  onClose,
  onSaved,
}: {
  agent: Agent | null;
  workspaces: Workspace[];
  onClose: () => void;
  onSaved: (agent: Agent) => void;
}) {
  const [form, setForm] = React.useState<AgentFormValue>(emptyAgentForm());
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (agent) {
      setForm(agentToForm(agent));
      setError(null);
    }
  }, [agent]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!agent) return;
    if (!form.name.trim()) {
      setError("Give the agent a name.");
      return;
    }
    setBusy(true);
    setError(null);
    let saved: Agent;
    try {
      const { agent: updated } = await api<{ agent: Agent }>(
        `/api/agents/${agent.id}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            name: form.name.trim(),
            instructions: form.instructions,
            model: form.model,
            workspaceId: form.workspaceId || null,
            plugins: form.plugins,
            mcpServers: form.mcpServers
              .filter((row) => row.name.trim())
              .map(rowToMcpConfig),
          }),
        },
      );
      saved = updated;
    } catch (err) {
      setBusy(false);
      setError(err instanceof Error ? err.message : "Failed to save agent");
      return;
    }
    setBusy(false);
    onSaved(saved);
    onClose();
  }

  return (
    <Dialog open={Boolean(agent)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit {agent?.name}</DialogTitle>
        </DialogHeader>
        <form onSubmit={save} className="space-y-4">
          <div className="max-h-[56vh] overflow-y-auto pr-1">
            <AgentForm
              value={form}
              onChange={setForm}
              workspaces={workspaces}
              disableRole={agent?.role === "manager"}
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter className="mt-0">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : "Save changes"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
