"use client";

import * as React from "react";
import { Plus, Trash2, X } from "lucide-react";
import type {
  Agent,
  McpApprovalPolicy,
  McpServerConfig,
  McpServerType,
} from "@agent-fleet/shared";
import { DEFAULT_MODEL, MCP_INTEGRATION_TYPES } from "@agent-fleet/shared";
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
  env: string; // stdio only — KEY=VALUE, one per line
  headers: string; // http/sse only — Name: value, one per line
  /** Approval policy (0010). */
  approval: McpApprovalPolicy;
  /** Comma-separated tool names to gate; empty gates every tool. */
  askTools: string;
  /** Integration holding the write token, or "" for none. */
  integration: string;
}

/** A fresh, ungated server row — the shape "Add server" starts from. */
export function emptyMcpServerRow(): McpServerRow {
  return {
    name: "",
    type: "stdio",
    command: "",
    args: "",
    url: "",
    env: "",
    headers: "",
    approval: "never",
    askTools: "",
    integration: "",
  };
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
  /** Built-in tool limits (0009); empty = unrestricted. */
  allowedTools: string[];
  disallowedTools: string[];
}

/** "Bash, Write" ⇄ ["Bash", "Write"] for the tool-limit inputs. */
export function parseToolList(raw: string): string[] {
  return raw
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
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
    allowedTools: [],
    disallowedTools: [],
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
    allowedTools: [...(agent.allowed_tools ?? [])],
    disallowedTools: [...(agent.disallowed_tools ?? [])],
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
    headers: Object.entries(config.headers ?? {})
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n"),
    approval: config.approval ?? "never",
    askTools: (config.askTools ?? []).join(", "),
    integration: config.integration ?? "",
  };
}

/**
 * Parses "KEY=value" / "Name: value" lines. The delimiter is whichever of
 * `=` and `:` comes first, so both `Authorization: Bearer x` and
 * `SOME_URL=https://x` split where the user meant them to.
 */
function parseKeyValueLines(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    const colon = trimmed.indexOf(":");
    const candidates = [eq, colon].filter((i) => i > 0);
    if (candidates.length === 0) continue;
    const split = Math.min(...candidates);
    out[trimmed.slice(0, split).trim()] = trimmed.slice(split + 1).trim();
  }
  return out;
}

export function rowToMcpConfig(row: McpServerRow): McpServerConfig {
  const config: McpServerConfig = {
    name: row.name.trim(),
    type: row.type,
  };
  if (row.type === "stdio") {
    if (row.command.trim()) config.command = row.command.trim();
    const args = row.args.split(/\s+/).filter(Boolean);
    if (args.length > 0) config.args = args;
    // env belongs to the spawned process — stdio only.
    const env = parseKeyValueLines(row.env);
    if (Object.keys(env).length > 0) config.env = env;
  } else {
    if (row.url.trim()) config.url = row.url.trim();
    // Remote servers authenticate with request headers, not env.
    const headers = parseKeyValueLines(row.headers);
    if (Object.keys(headers).length > 0) config.headers = headers;
  }
  // Approval settings (0010). 'never' and an empty tool list are the absent
  // state, so an ungated server serialises exactly as it did before 0010.
  if (row.approval === "ask") {
    config.approval = "ask";
    const askTools = parseToolList(row.askTools);
    if (askTools.length > 0) config.askTools = askTools;
    if (row.integration) {
      config.integration = row.integration as NonNullable<McpServerConfig["integration"]>;
    }
  }
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

      {/* Built-in tool limits (0009) */}
      <div className="space-y-2">
        <Label htmlFor="agent-allowed-tools">Tool limits</Label>
        <Input
          id="agent-allowed-tools"
          placeholder="Only these built-in tools, e.g. Read, Grep, WebFetch (blank = all)"
          value={value.allowedTools.join(", ")}
          onChange={(e) => set("allowedTools", parseToolList(e.target.value))}
        />
        <Input
          id="agent-disallowed-tools"
          placeholder="Never these built-in tools, e.g. Bash, Write, Edit"
          value={value.disallowedTools.join(", ")}
          onChange={(e) => set("disallowedTools", parseToolList(e.target.value))}
        />
        <p className="text-xs text-muted-foreground">
          Capability limits on Claude&apos;s built-in tools, enforced by the runtime rather than by
          instructions. Agents that read untrusted text — tickets, PR descriptions, diffs — should not
          have <code>Bash</code>. Fleet tools (notify_user, ask_agent, spawn_tasks) and MCP servers are
          unaffected.
        </p>
      </div>

      {/* MCP servers */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label>MCP servers</Label>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => set("mcpServers", [...value.mcpServers, emptyMcpServerRow()])}
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
                <div className="grid grid-cols-[1fr_6rem_auto] items-end gap-2 sm:grid-cols-[1fr_8rem_auto]">
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
                {server.type === "stdio" ? (
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">
                      Env (KEY=value, one per line)
                    </Label>
                    <Textarea
                      rows={2}
                      className="font-mono text-xs"
                      placeholder={"GITHUB_PERSONAL_ACCESS_TOKEN=github_pat_…"}
                      value={server.env}
                      onChange={(e) =>
                        updateServer(index, { env: e.target.value })
                      }
                    />
                  </div>
                ) : (
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">
                      Headers (Name: value, one per line)
                    </Label>
                    <Textarea
                      rows={2}
                      className="font-mono text-xs"
                      placeholder={"Authorization: Bearer github_pat_…"}
                      value={server.headers}
                      onChange={(e) =>
                        updateServer(index, { headers: e.target.value })
                      }
                    />
                  </div>
                )}

                <McpApprovalFields
                  server={server}
                  onChange={(patch) => updateServer(index, patch)}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------ */

/**
 * Approval policy for one MCP server (0010).
 *
 * The gate is per-server rather than global because the interesting setting is
 * per-server: a repo-reading agent wants its GitHub reads to stay instant and
 * only `create_pull_request` to wait for a human.
 */
function McpApprovalFields({
  server,
  onChange,
}: {
  server: McpServerRow;
  onChange: (patch: Partial<McpServerRow>) => void;
}) {
  const gated = server.approval === "ask";
  const allTools = parseToolList(server.askTools).length === 0;

  return (
    <div className="space-y-2 border-t border-border pt-2">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Approval</Label>
          <Select
            value={server.approval}
            onChange={(e) =>
              onChange({ approval: e.target.value as McpApprovalPolicy })
            }
          >
            <option value="never">Run without asking</option>
            <option value="ask">Ask before running</option>
          </Select>
        </div>
        {gated && (
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">
              Write token from
            </Label>
            <Select
              value={server.integration}
              onChange={(e) => onChange({ integration: e.target.value })}
            >
              <option value="">
                the agent&apos;s own credentials above
              </option>
              {MCP_INTEGRATION_TYPES.map((type) => (
                <option key={type} value={type}>
                  the {type} integration
                </option>
              ))}
            </Select>
          </div>
        )}
      </div>

      {gated && (
        <>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">
              Tools needing approval (comma separated)
            </Label>
            <Input
              placeholder="create_pull_request, merge_pull_request"
              value={server.askTools}
              onChange={(e) => onChange({ askTools: e.target.value })}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            {allTools ? (
              <>
                <strong className="font-medium text-foreground">
                  Every tool on this server needs approval.
                </strong>{" "}
                Naming tools narrows the gate to those — but that is a snapshot:
                a tool the server adds later would not be gated until you add it
                here. Leaving this empty is the setting that stays correct on its
                own.
              </>
            ) : (
              <>
                Only these tools are gated; every other tool on this server runs
                inline. Nothing detects writes for you — a tool you forget to
                list runs unasked, and a tool the server adds later is not gated
                until you add it.
              </>
            )}
          </p>
          <p className="text-xs text-muted-foreground">
            Approval alone does not keep a write token away from the agent. Put
            a read-only credential in the fields above and the write token in an
            integration, and the token only ever exists in the server-side
            executor — that part no prompt can talk its way past.
          </p>
        </>
      )}
    </div>
  );
}
