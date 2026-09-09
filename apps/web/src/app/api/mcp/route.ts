import { NextResponse } from "next/server";
import { ApiResponseError } from "@/lib/api/auth";
import { authenticateToken } from "@/lib/api/tokens";
import {
  handleMessage,
  rpcError,
  RPC_INVALID_REQUEST,
  RPC_PARSE_ERROR,
  type JsonRpcMessage,
  type JsonRpcResponse,
} from "@/lib/mcp/protocol";
import {
  FLEET_INSTRUCTIONS,
  FLEET_TOOLS,
  type McpToolContext,
} from "@/lib/mcp/tools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The fleet's MCP endpoint: how a Claude Code (or any MCP client) session on
 * the owner's own machine configures the agents of their account.
 *
 *   claude mcp add --transport http agent-fleet https://fleet.example.com/api/mcp \
 *     --header "Authorization: Bearer aft_..."
 *
 * Authentication is a personal access token (migration 0012), minted in
 * Settings. Deliberately not the session cookie the rest of the API uses: a
 * client outside the browser has no way to obtain or refresh one, and every
 * workaround for that ends with a password in a config file.
 *
 * The token authenticates HERE and nowhere else — no other route accepts it,
 * because no other route calls `authenticateToken`. So the blast radius of a
 * leaked token is exactly the tool list in src/lib/mcp/tools.ts, and minting
 * more tokens is not on it.
 *
 * Note what this endpoint deliberately does NOT do: set CORS headers. Without
 * `Access-Control-Allow-Origin`, a browser on some other site cannot read a
 * response from here even if it could somehow present a token — the
 * DNS-rebinding protection the transport spec asks for, obtained by not
 * opting out of the same-origin policy in the first place.
 */

/** Never surface an internal failure's text; ApiResponseError is ours to show. */
function describeError(error: unknown): string {
  if (error instanceof ApiResponseError) return error.message;
  console.error("[mcp] tool error:", error);
  return "Internal error";
}

function jsonRpcResponse(
  body: JsonRpcResponse | JsonRpcResponse[],
): NextResponse {
  return NextResponse.json(body, {
    // A single JSON object in place of an SSE stream: what the Streamable
    // HTTP transport permits a server with no session state to answer with.
    headers: { "cache-control": "no-store" },
  });
}

export async function POST(request: Request): Promise<Response> {
  const auth = await authenticateToken(request);
  if (!auth) {
    // No `WWW-Authenticate` header on purpose. It is the signal that starts a
    // client's OAuth discovery dance, and there is no authorization server
    // here to discover — a client that follows it would spend three requests
    // to arrive at this same 401, with a confusing error instead of this one.
    return NextResponse.json(
      {
        error:
          "Unauthorized. Send a personal access token from Settings as " +
          "'Authorization: Bearer <token>'.",
      },
      { status: 401 },
    );
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return jsonRpcResponse(
      rpcError(null, RPC_PARSE_ERROR, "Request body is not valid JSON"),
    );
  }

  const ctx: McpToolContext = { userId: auth.userId };
  const options = {
    tools: FLEET_TOOLS,
    ctx,
    describeError,
    instructions: FLEET_INSTRUCTIONS,
  };

  // Arrays are the batching form of JSON-RPC 2.0. The 2025-06-18 revision of
  // MCP dropped it, but older clients still send it and the handling is one
  // map, so accepting both costs nothing.
  const messages = Array.isArray(payload) ? payload : [payload];
  if (messages.length === 0) {
    return jsonRpcResponse(
      rpcError(null, RPC_INVALID_REQUEST, "Empty request"),
    );
  }

  const responses: JsonRpcResponse[] = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") {
      responses.push(
        rpcError(null, RPC_INVALID_REQUEST, "Message is not an object"),
      );
      continue;
    }
    const response = await handleMessage(message as JsonRpcMessage, options);
    if (response) responses.push(response);
  }

  // Nothing to answer means the batch was notifications only — 202 with an
  // empty body, per the transport spec.
  if (responses.length === 0) return new Response(null, { status: 202 });

  return jsonRpcResponse(Array.isArray(payload) ? responses : responses[0]);
}

/**
 * GET opens the server-to-client SSE stream in the Streamable HTTP transport.
 * This server is stateless and never initiates messages, so it declines —
 * which the spec provides for explicitly.
 */
export function GET(): Response {
  return new Response("Method Not Allowed", {
    status: 405,
    headers: { allow: "POST" },
  });
}

/** DELETE terminates a session. There are none to terminate. */
export function DELETE(): Response {
  return new Response("Method Not Allowed", {
    status: 405,
    headers: { allow: "POST" },
  });
}
