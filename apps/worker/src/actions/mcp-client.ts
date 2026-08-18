import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServerConfig, McpWriteCredential } from "@agent-fleet/shared";
import { logger } from "../lib/logger.js";

/**
 * The worker's own MCP client, used by the deterministic action executor to
 * make an approved `mcp_tool_call` (0010).
 *
 * This is the piece that makes the gate generic. The executor does not know
 * what a pull request or a Notion page is: it connects to the server the agent
 * named, forwards the frozen arguments, and lets the target server validate
 * them against its own input schema. Gating a new MCP server therefore costs
 * no new action type, payload schema or executor branch — which is the whole
 * reason the gate could be extended past Slack and Gmail at all.
 *
 * No model is involved. That is the point: the arguments were fixed when the
 * owner approved them, and nothing between approval and the call can change
 * them.
 */

/** Ceiling on one approved call. Override with MCP_CALL_TIMEOUT_SECONDS. */
const CALL_TIMEOUT_MS = parsePositiveInt(process.env.MCP_CALL_TIMEOUT_SECONDS, 120) * 1_000;
/** Ceiling on the returned text recorded in the project chat. */
const RESULT_MAX_CHARS = 4_000;

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Calls `tool` on `server` with `args` and returns the text it produced.
 *
 * `credential`, when present, is the write token from the project integration
 * named by `server.integration`; it REPLACES the credential in the server's own
 * env/headers for this call. Absent means the call goes out with whatever
 * credential the agent itself holds — still approved, but no longer isolated
 * from the LLM session (see McpServerConfig.integration).
 *
 * Throws with an operator-readable message on any failure; the caller turns
 * that into the action's `error`.
 */
export async function callMcpTool(
  server: McpServerConfig,
  tool: string,
  args: Record<string, unknown>,
  credential: McpWriteCredential | null,
): Promise<string> {
  const transport = buildTransport(server, credential);
  const client = new Client(
    { name: "agent-fleet-action-executor", version: "1.0.0" },
    { capabilities: {} },
  );

  try {
    await client.connect(transport);
  } catch (err) {
    throw new Error(
      `Could not connect to the MCP server "${server.name}": ${errorText(err)}. ` +
        `Check the server's configuration on the proposing agent` +
        (server.integration
          ? `, and the ${server.integration} integration's write token.`
          : "."),
    );
  }

  try {
    const result = await client.callTool({ name: tool, arguments: args }, undefined, {
      timeout: CALL_TIMEOUT_MS,
    });

    const text = resultText(result.content);
    if (result.isError) {
      throw new Error(
        `The MCP server "${server.name}" rejected ${tool}: ${text || "no details returned"}`,
      );
    }
    return text;
  } finally {
    // Always tear the connection (and, for stdio, the spawned process) down —
    // the executor runs in a long-lived loop, so a leak here accumulates
    // sockets or child processes for the lifetime of the worker.
    try {
      await client.close();
    } catch (err) {
      logger.warn("actions", `failed to close MCP client for server "${server.name}"`, err);
    }
  }
}

/** Builds the transport for `server`, with the credential applied. */
function buildTransport(server: McpServerConfig, credential: McpWriteCredential | null) {
  if (server.type === "stdio") {
    if (!server.command) {
      throw new Error(
        `MCP server "${server.name}" is type stdio but has no command configured.`,
      );
    }
    return new StdioClientTransport({
      command: server.command,
      args: server.args ?? [],
      // getDefaultEnvironment() is the MCP SDK's curated safe subset (PATH,
      // HOME, and friends) rather than the worker's environment, so an
      // npx-launched server still starts but the worker's own secrets —
      // SUPABASE_SERVICE_ROLE_KEY above all — never reach it. Same reasoning
      // as buildAgentEnv() applies to agent subprocesses.
      env: { ...getDefaultEnvironment(), ...(server.env ?? {}), ...credentialEnv(server, credential) },
      // Without this the server's stderr lands in the worker's own stderr,
      // interleaved with unrelated logs and attributed to nothing.
      stderr: "pipe",
    });
  }

  // The integration may point the executor at a different endpoint than the
  // agent uses — see McpIntegrationConfig.url. This is what lets an agent sit
  // on a read-only endpoint while approved writes still reach a write-capable
  // one.
  const target = credential?.url ?? server.url;
  if (!target) {
    throw new Error(
      `MCP server "${server.name}" is type ${server.type} but has no url configured.`,
    );
  }
  const url = new URL(target);
  const headers = { ...(server.headers ?? {}), ...credentialHeaders(server, credential) };

  return server.type === "sse"
    ? new SSEClientTransport(url, { requestInit: { headers } })
    : new StreamableHTTPClientTransport(url, { requestInit: { headers } });
}

/**
 * The env entry carrying the write token for a stdio server. `envVar` is
 * required in that case: unlike a remote server, where `Authorization` is a
 * safe default, there is no guessing which variable a given stdio server reads
 * (GITHUB_PERSONAL_ACCESS_TOKEN, NOTION_TOKEN, …) and guessing wrong would send
 * the call out authenticated as the agent instead of failing loudly.
 */
function credentialEnv(
  server: McpServerConfig,
  credential: McpWriteCredential | null,
): Record<string, string> {
  if (!credential) return {};
  if (!credential.envVar) {
    throw new Error(
      `The ${server.integration} integration has no 'envVar' set, so its write token ` +
        `cannot be passed to the stdio MCP server "${server.name}". Set envVar to the ` +
        `variable that server reads its token from.`,
    );
  }
  return { [credential.envVar]: credential.writeToken };
}

/**
 * The header carrying the write token for an http/sse server. With no
 * `headerName` it becomes `Authorization: Bearer <token>`, which is what
 * GitHub's and Notion's hosted MCP endpoints expect; a custom `headerName`
 * receives the token verbatim, so a scheme (if the server wants one) belongs in
 * the token itself.
 */
function credentialHeaders(
  _server: McpServerConfig,
  credential: McpWriteCredential | null,
): Record<string, string> {
  if (!credential) return {};
  return credential.headerName
    ? { [credential.headerName]: credential.writeToken }
    : { Authorization: `Bearer ${credential.writeToken}` };
}

/** Flattens MCP result content into text, noting any non-text parts. */
function resultText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const item = block as { type?: string; text?: string };
    if (item.type === "text" && typeof item.text === "string") parts.push(item.text);
    else if (item.type) parts.push(`[${item.type} content]`);
  }
  const text = parts.join("\n").trim();
  return text.length > RESULT_MAX_CHARS ? `${text.slice(0, RESULT_MAX_CHARS)}…` : text;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
