"use client";

import * as React from "react";
import { Plus, Trash2, X } from "lucide-react";
import type { Agent, McpServerConfig, McpServerType } from "@agent-fleet/shared";
import { DEFAULT_MODEL } from "@agent-fleet/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { Workspace } from "@agent-fleet/shared";

export const MODEL_OPTIONS = [
  { value: "claude-sonnet-5", label: "Claude Sonnet 5" },
  { value: "claude-opus-5", label: "Claude Opus 5" },
  { value: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
];

export interface McpServerRow {
  name: string;
  type: McpServerType;
  command: string;
  args: string; // space separated
  url: string;
  env: string; // KEY=VALUE, one per line
}

/** Roles the user can pick — managers are never created/changed here. */
export type CreatableRole = "specialist" | "librarian";

export interface AgentFormValue {
  name: string;
  role: CreatableRole;
  instructions: string;
  model: string;
  workspaceId: string; // "" = no workspace
  plugins: string[];
  mcpServers: McpServerRow[];
}

export function emptyAgentForm(): AgentFormValue {
  return {
    name: "",
    role: "specialist",
    instructions: "",
    model: DEFAULT_MODEL,
    workspaceId: "",
    plugins: [],
    mcpServers: [],
  };
}

export function agentToForm(agent: Agent): AgentFormValue {
  return {
    name: agent.name,
    role: agent.role === "librarian" ? "librarian" : "specialist",
    instructions: agent.instructions,
    model: agent.model,
    workspaceId: agent.workspace_id ?? "",
    plugins: [...(agent.plugins ?? [])],
    mcpServers: (agent.mcp_servers ?? []).map(mcpConfigToRow),
  };
}

export function mcpConfigToRow(config: McpServerConfig): McpServerRow {
  return {
    name: config.name,
    type: config.type,
    command: config.command ?? "",
    args: (config.args ?? []).join(" "),
    url: config.url ?? "",
    env: Object.entries(config.env ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join("\n"),
  };
}

export function rowToMcpConfig(row: McpServerRow): McpServerConfig {
  const env: Record<string, string> = {};
  for (const line of row.env.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  const config: McpServerConfig = {
    name: row.name.trim(),
    type: row.type,
  };
  if (row.type === "stdio") {
    if (row.command.trim()) config.command = row.command.trim();
    const args = row.args.split(/\s+/).filter(Boolean);
    if (args.length > 0) config.args = args;
  } else if (row.url.trim()) {
    config.url = row.url.trim();
  }
  if (Object.keys(env).length > 0) config.env = env;
  return config;
}

export function AgentForm({
  value,
  onChange,
  workspaces,
  disableRole,
  librarianTaken,
}: {
  value: AgentFormValue;
  onChange: (value: AgentFormValue) => void;
  workspaces: Workspace[];
  /** Managers keep their role; hides the role select entirely. */
  disableRole?: boolean;
  /**
   * Another agent in the project is already the librarian — the option is
   * disabled (one librarian per project).
   */
  librarianTaken?: boolean;
}) {
  const [pluginDraft, setPluginDraft] = React.useState("");

  function set<K extends keyof AgentFormValue>(
    key: K,
    val: AgentFormValue[K],
  ) {
    onChange({ ...value, [key]: val });
  }

  function addPlugin() {
    const plugin = pluginDraft.trim();
    if (!plugin) return;
    if (!value.plugins.includes(plugin)) {
      set("plugins", [...value.plugins, plugin]);
    }
    setPluginDraft("");
  }

  function updateServer(index: number, patch: Partial<McpServerRow>) {
    set(
      "mcpServers",
      value.mcpServers.map((row, i) =>
        i === index ? { ...row, ...patch } : row,
      ),
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2">
          <Label htmlFor="agent-name">Name</Label>
          <Input
            id="agent-name"
            placeholder="Backend engineer"
            value={value.name}
            onChange={(e) => set("name", e.target.value)}
            required
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="agent-model">Model</Label>
          <Select
            id="agent-model"
            value={value.model}
            onChange={(e) => set("model", e.target.value)}
          >
            {MODEL_OPTIONS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
            {!MODEL_OPTIONS.some((m) => m.value === value.model) && (
              <option value={value.model}>{value.model}</option>
            )}
          </Select>
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="agent-instructions">Instructions</Label>
        <Textarea
          id="agent-instructions"
          placeholder="System prompt: role, responsibilities, guardrails…"
          rows={8}
          className="font-mono text-xs"
          value={value.instructions}
          onChange={(e) => set("instructions", e.target.value)}
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2">
          <Label htmlFor="agent-workspace">Workspace</Label>
          <Select
            id="agent-workspace"
            value={value.workspaceId}
            onChange={(e) => set("workspaceId", e.target.value)}
          >
            <option value="">No workspace</option>
            {workspaces.map((ws) => (
              <option key={ws.id} value={ws.id}>
                {ws.name}
              </option>
            ))}
          </Select>
        </div>
        {!disableRole && (
          <div className="space-y-2">
            <Label htmlFor="agent-role">Role</Label>
            <Select
              id="agent-role"
              value={value.role}
              onChange={(e) => set("role", e.target.value as CreatableRole)}
            >
              <option value="specialist">Specialist</option>
              <option value="librarian" disabled={librarianTaken}>
                Librarian
              </option>
            </Select>
            {librarianTaken ? (
              <p className="text-xs text-muted-foreground">
                Project already has a librarian.
              </p>
            ) : (
              value.role === "librarian" && (
                <p className="text-xs text-muted-foreground">
                  The librarian curates all project knowledge — one per
                  project.
                </p>
              )
            )}
          </div>
        )}
      </div>
      {disableRole && (
        <p className="text-xs text-muted-foreground">
          This agent is the project manager — its role cannot change.
        </p>
      )}

      {/* Plugins */}
      <div className="space-y-2">
        <Label htmlFor="agent-plugins">Plugins</Label>
        <div className="flex gap-2">
          <Input
            id="agent-plugins"
            placeholder="Type a plugin name and press Enter"
            value={pluginDraft}
            onChange={(e) => setPluginDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === ",") {
                e.preventDefault();
                addPlugin();
              }
            }}
          />
          <Button type="button" variant="outline" size="icon" onClick={addPlugin}>
            <Plus />
          </Button>
        </div>
        {value.plugins.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {value.plugins.map((plugin) => (
              <span
                key={plugin}
                className="inline-flex items-center gap-1 rounded-md bg-secondary px-2 py-0.5 text-xs"
              >
                {plugin}
                <button
                  type="button"
                  aria-label={`Remove ${plugin}`}
                  onClick={() =>
                    set(
                      "plugins",
                      value.plugins.filter((p) => p !== plugin),
                    )
                  }
                  className="text-muted-foreground hover:text-foreground"
                >
                  <X className="size-3" />
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* MCP servers */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label>MCP servers</Label>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              set("mcpServers", [
                ...value.mcpServers,
                { name: "", type: "stdio", command: "", args: "", url: "", env: "" },
              ])
            }
          >
            <Plus />
            Add server
          </Button>
        </div>
        {value.mcpServers.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No MCP servers configured.
          </p>
        ) : (
          <div className="space-y-3">
            {value.mcpServers.map((server, index) => (
              <div
                key={index}
                className="space-y-2 rounded-lg border border-border p-3"
              >
                <div className="grid grid-cols-[1fr_8rem_auto] items-end gap-2">
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Name</Label>
                    <Input
                      placeholder="github"
                      value={server.name}
                      onChange={(e) =>
                        updateServer(index, { name: e.target.value })
                      }
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Type</Label>
                    <Select
                      value={server.type}
                      onChange={(e) =>
                        updateServer(index, {
                          type: e.target.value as McpServerType,
                        })
                      }
                    >
                      <option value="stdio">stdio</option>
                      <option value="http">http</option>
                      <option value="sse">sse</option>
                    </Select>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label="Remove server"
                    onClick={() =>
                      set(
                        "mcpServers",
                        value.mcpServers.filter((_, i) => i !== index),
                      )
                    }
                  >
                    <Trash2 />
                  </Button>
                </div>
                {server.type === "stdio" ? (
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">
                        Command
                      </Label>
                      <Input
                        placeholder="npx"
                        value={server.command}
                        onChange={(e) =>
                          updateServer(index, { command: e.target.value })
                        }
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">
                        Args (space separated)
                      </Label>
                      <Input
                        placeholder="-y @modelcontextprotocol/server-github"
                        value={server.args}
                        onChange={(e) =>
                          updateServer(index, { args: e.target.value })
                        }
                      />
                    </div>
                  </div>
                ) : (
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">URL</Label>
                    <Input
                      placeholder="https://mcp.example.com/sse"
                      value={server.url}
                      onChange={(e) =>
                        updateServer(index, { url: e.target.value })
                      }
                    />
                  </div>
                )}
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">
                    Env (KEY=value, one per line)
                  </Label>
                  <Textarea
                    rows={2}
                    className="font-mono text-xs"
                    placeholder={"GITHUB_TOKEN=ghp_…"}
                    value={server.env}
                    onChange={(e) => updateServer(index, { env: e.target.value })}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
