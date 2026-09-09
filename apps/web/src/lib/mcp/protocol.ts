import "server-only";

/**
 * A minimal, stateless MCP server over Streamable HTTP.
 *
 * Why hand-rolled rather than @modelcontextprotocol/sdk: that package's
 * server transports speak Node's `IncomingMessage`/`ServerResponse`, and a
 * Next.js route handler is handed a Web `Request` and must return a Web
 * `Response`. Bridging the two costs more code than the protocol itself does
 * at this surface area — the whole of it is below, and every branch is a
 * shape the spec pins down.
 *
 * Stateless on purpose: no session id is issued, so nothing has to be kept
 * between calls and the endpoint scales the way the rest of the web app does.
 * The spec allows exactly this — a server MAY answer a POST with a single
 * JSON object instead of an SSE stream, and MAY omit `Mcp-Session-Id` when it
 * has no session to resume. What we give up is server-initiated messages
 * (sampling, progress notifications, listChanged), none of which a
 * configuration API needs.
 */

export const SERVER_NAME = "agent-fleet";
export const SERVER_VERSION = "1.0.0";

/**
 * Protocol revisions we answer to, newest first. `initialize` echoes the
 * client's version when it is one of these and otherwise offers our latest,
 * which is what the spec asks of a server that cannot speak what was asked
 * for — the client then decides whether to continue.
 */
export const SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
] as const;

export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

/** JSON-RPC 2.0 error codes used here. */
export const RPC_PARSE_ERROR = -32700;
export const RPC_INVALID_REQUEST = -32600;
export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INVALID_PARAMS = -32602;
export const RPC_INTERNAL_ERROR = -32603;

export type JsonRpcId = string | number | null;

export interface JsonRpcMessage {
  jsonrpc?: unknown;
  /** Absent on notifications, which get no response. */
  id?: JsonRpcId;
  method?: unknown;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export function rpcResult(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

export function rpcError(
  id: JsonRpcId,
  code: number,
  message: string,
): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/** One MCP tool: what `tools/list` advertises and `tools/call` dispatches to. */
export interface McpTool<Ctx> {
  name: string;
  title: string;
  description: string;
  /** JSON Schema (draft 2020-12 subset) for the tool's arguments. */
  inputSchema: Record<string, unknown>;
  /**
   * Read-only tools are hinted as such so clients can skip the confirmation
   * they put in front of anything that writes.
   */
  readOnly?: boolean;
  /**
   * Set only for tools that destroy something. The spec's default for a
   * writing tool is `destructiveHint: true`, which would put the same warning
   * in front of "create an agent" as in front of "delete one" — and a warning
   * that fires on everything is one the reader stops seeing.
   */
  destructive?: boolean;
  handler: (args: Record<string, unknown>, ctx: Ctx) => Promise<unknown>;
}

/** The `tools/list` entry for a tool, minus the handler. */
function toolDescriptor<Ctx>(tool: McpTool<Ctx>) {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: {
      title: tool.title,
      readOnlyHint: Boolean(tool.readOnly),
      destructiveHint: Boolean(tool.destructive),
    },
  };
}

/** Whatever a tool handler returns, rendered as MCP tool content. */
function toolContent(value: unknown) {
  const text =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text }] };
}

export interface HandleOptions<Ctx> {
  tools: McpTool<Ctx>[];
  ctx: Ctx;
  /**
   * Turns a thrown error into the message the caller sees. Lets the route
   * decide what is safe to surface (an ownership failure: yes; a stack
   * trace: no).
   */
  describeError: (error: unknown) => string;
  /** Shown to the client after `initialize`, as guidance for the model. */
  instructions?: string;
}

/**
 * Handle one JSON-RPC message. Returns the response to send, or null for a
 * notification (which the spec answers with 202 and an empty body).
 */
export async function handleMessage<Ctx>(
  message: JsonRpcMessage,
  options: HandleOptions<Ctx>,
): Promise<JsonRpcResponse | null> {
  const id = message.id ?? null;
  const isNotification = message.id === undefined;
  const method = typeof message.method === "string" ? message.method : null;

  if (!method) {
    return isNotification
      ? null
      : rpcError(id, RPC_INVALID_REQUEST, "Missing method");
  }

  // Notifications: acknowledged by producing nothing. 'initialized' is the
  // handshake's third leg and the only one clients reliably send; the rest
  // (cancelled, progress) are equally safe to drop on a stateless server.
  if (method.startsWith("notifications/")) return null;

  const params =
    message.params && typeof message.params === "object"
      ? (message.params as Record<string, unknown>)
      : {};

  switch (method) {
    case "initialize": {
      const asked = params.protocolVersion;
      const protocolVersion =
        typeof asked === "string" &&
        (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(asked)
          ? asked
          : LATEST_PROTOCOL_VERSION;
      return rpcResult(id, {
        protocolVersion,
        // Tools only. No resources, prompts, or sampling: the surface is a
        // configuration API, and advertising a capability we do not serve
        // just earns a round-trip that fails.
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        ...(options.instructions
          ? { instructions: options.instructions }
          : {}),
      });
    }

    case "ping":
      return rpcResult(id, {});

    case "tools/list":
      return rpcResult(id, { tools: options.tools.map(toolDescriptor) });

    case "tools/call": {
      const name = params.name;
      if (typeof name !== "string") {
        return rpcError(id, RPC_INVALID_PARAMS, "Missing tool name");
      }
      const tool = options.tools.find((candidate) => candidate.name === name);
      if (!tool) {
        return rpcError(id, RPC_METHOD_NOT_FOUND, `Unknown tool: ${name}`);
      }
      const args =
        params.arguments && typeof params.arguments === "object"
          ? (params.arguments as Record<string, unknown>)
          : {};
      try {
        return rpcResult(id, toolContent(await tool.handler(args, options.ctx)));
      } catch (err) {
        // A tool that fails reports it IN the result, not as a JSON-RPC
        // error: the model is supposed to read "Project not found" and try
        // something else, which it cannot do if the failure never reaches it.
        return rpcResult(id, {
          content: [{ type: "text", text: options.describeError(err) }],
          isError: true,
        });
      }
    }

    default:
      return isNotification
        ? null
        : rpcError(id, RPC_METHOD_NOT_FOUND, `Unknown method: ${method}`);
  }
}
