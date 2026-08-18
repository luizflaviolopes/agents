import type { McpServerConfig } from "@agent-fleet/shared";

/**
 * Which of an agent's MCP tool calls need the owner's approval, and how the
 * gate is named on both sides of it (0010).
 *
 * The gate exists because an MCP write credential in `agents.mcp_servers` is a
 * credential inside an LLM session, and agents read text they did not write —
 * issue bodies, PR descriptions, Slack threads, Notion pages. Anything an
 * agent reads can therefore ask it to spend that credential. Approval alone
 * does not fix that (see McpServerConfig.integration for the part that does);
 * it makes the spending visible and stoppable.
 *
 * Read tools are never gated, deliberately: an approval prompt the owner sees
 * forty times a day is an approval prompt the owner stops reading.
 */

/** Prefix the Agent SDK gives a tool from a named MCP server. */
const SDK_TOOL_PREFIX = "mcp__";

/** One approval-gated call: the configured server, plus the bare tool name. */
export interface GatedCall {
  server: McpServerConfig;
  tool: string;
}

/** The SDK's name for `tool` on `server` — `mcp__<server>__<tool>`. */
export function sdkToolName(serverName: string, tool: string): string {
  return `${SDK_TOOL_PREFIX}${serverName}__${tool}`;
}

/** Case-insensitive lookup of a configured server by name. */
export function findServer(
  configs: McpServerConfig[],
  name: string,
): McpServerConfig | undefined {
  const needle = name.trim().toLowerCase();
  return configs.find((config) => config?.name?.trim().toLowerCase() === needle);
}

/**
 * True when `tool` on `server` requires approval.
 *
 * An empty or absent `askTools` gates every tool on the server. That is the
 * safe reading of "I want this server gated": the failure mode of the other
 * reading is a write that slips through because nobody listed it.
 */
export function gatesTool(server: McpServerConfig, tool: string): boolean {
  if (server.approval !== "ask") return false;
  const listed = server.askTools ?? [];
  if (listed.length === 0) return true;
  const needle = tool.trim().toLowerCase();
  return listed.some((name) => name.trim().toLowerCase() === needle);
}

/** Every server with an 'ask' policy. */
export function gatedServers(configs: McpServerConfig[]): McpServerConfig[] {
  return configs.filter((config) => config?.approval === "ask");
}

/** True when at least one server is gated — i.e. the gate is worth wiring up. */
export function hasGatedServers(configs: McpServerConfig[]): boolean {
  return gatedServers(configs).length > 0;
}

/**
 * Resolves an SDK tool name to the gated call it denotes, or null when the
 * call may run inline (not an MCP tool, unknown server, or an ungated tool).
 *
 * Matches against the configured server names rather than splitting on
 * `__`, because a server name may itself contain `__` and splitting would
 * silently mis-attribute the call — the wrong direction for a security gate
 * to fail in.
 */
export function resolveGatedCall(
  configs: McpServerConfig[],
  sdkTool: string,
): GatedCall | null {
  if (!sdkTool.startsWith(SDK_TOOL_PREFIX)) return null;
  for (const server of gatedServers(configs)) {
    const prefix = `${SDK_TOOL_PREFIX}${server.name}__`;
    if (!sdkTool.startsWith(prefix)) continue;
    const tool = sdkTool.slice(prefix.length);
    if (tool.length > 0 && gatesTool(server, tool)) return { server, tool };
    return null;
  }
  return null;
}

/**
 * The system-prompt paragraph describing the gate, or "" when nothing is
 * gated. Duplicating what the PreToolUse hook says on denial is deliberate:
 * the hook teaches only after a wasted turn, and an agent that knows the
 * shape up front can do its reading first and propose writes at the end —
 * which matters because proposing ends the run (see `propose_tool_call`).
 */
export function mcpApprovalRule(configs: McpServerConfig[]): string {
  const gated = gatedServers(configs);
  if (gated.length === 0) return "";

  const lines = gated.map((server) => {
    const listed = server.askTools ?? [];
    const scope =
      listed.length === 0
        ? "every tool"
        : listed.length <= 12
          ? listed.join(", ")
          : `${listed.slice(0, 12).join(", ")} (+${listed.length - 12} more)`;
    return `- ${server.name}: ${scope}`;
  });

  return [
    "Some of your MCP tools require the project owner's approval before they run:",
    ...lines,
    "Calling one of those directly fails. Propose it with the fleet propose_tool_call " +
      "tool instead: the owner approves or rejects it, and a deterministic executor " +
      "makes the call afterwards — you never see its return value.",
    "So do all of your reading and reasoning FIRST and propose gated calls LAST. " +
      "Proposing one ends this run (it lands in 'review' awaiting the owner), which " +
      "means you cannot chain a gated write into later steps of the same run. If a " +
      "task genuinely needs the result of a write to continue, say so in your final " +
      "answer instead of guessing.",
  ].join("\n");
}
