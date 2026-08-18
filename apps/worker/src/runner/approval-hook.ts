import type { Options as AgentSdkOptions } from "@anthropic-ai/claude-agent-sdk";
import type { McpServerConfig } from "@agent-fleet/shared";
import { logger } from "../lib/logger.js";
import { hasGatedServers, resolveGatedCall, type GatedCall } from "../lib/mcp-approval.js";

/**
 * The capability half of the MCP approval gate (0010): a PreToolUse hook that
 * refuses gated tool calls in-session and tells the agent to propose them.
 *
 * Why a hook and not a permission mode: agents run with
 * `permissionMode: 'bypassPermissions'`, which is what lets them use Bash and
 * the filesystem without a human at the keyboard. PreToolUse hooks run BEFORE
 * the permission system and are unaffected by that mode — verified against
 * @anthropic-ai/claude-agent-sdk 0.3.228: the hook fires for
 * `mcp__<server>__<tool>`, the model receives `permissionDecisionReason` as an
 * error tool_result, and the tool handler never executes. So this is a
 * capability gate like the built-in tool limits in 0009, not an instruction —
 * no prompt can talk its way past it.
 *
 * Why deny instead of blocking until the owner answers: approval arrives out
 * of band (web Review inbox, Telegram buttons) and can take hours, while a
 * blocked call would hold an SDK session and a slot from the bounded
 * concurrency pool the whole time. `ask_agent` already has to release its slot
 * to avoid deadlocking on a 10-minute child task; a human is unbounded, and a
 * scheduled 3am run has nobody to ask at all. Denying keeps the run finite:
 * the agent proposes, the run ends in 'review', and the executor picks the
 * work up after approval.
 */

/** Told to the model when it calls a gated tool. Its only chance to adapt. */
function denialReason(call: GatedCall): string {
  return (
    `${call.tool} on the MCP server "${call.server.name}" requires the project owner's ` +
    `approval and cannot be called directly. Do not retry it.\n\n` +
    `To make this call, use the fleet propose_tool_call tool with ` +
    `server="${call.server.name}", tool="${call.tool}", the same arguments, and a ` +
    `preview describing in plain language what the call will do. The owner approves or ` +
    `rejects it and a deterministic executor makes the call afterwards — you will not ` +
    `see its result, and proposing ends this run.\n\n` +
    `So finish everything else first. If other work in this task does not depend on ` +
    `this call, do that work now and propose this last.`
  );
}

/**
 * Builds the `hooks` option for one agent session, or undefined when the agent
 * has no gated servers — an agent that gates nothing gets exactly the SDK
 * options it got before 0010.
 *
 * `onDeny` is called for each refused call so the caller can record it in
 * run_logs; it must not throw.
 */
export function buildApprovalHooks(
  configs: McpServerConfig[],
  onDeny?: (call: GatedCall) => void,
): Pick<AgentSdkOptions, "hooks"> {
  if (!hasGatedServers(configs)) return {};

  return {
    hooks: {
      PreToolUse: [
        {
          // No `matcher`: it takes permission-rule syntax, and one callback
          // that inspects tool_name itself is both simpler to reason about
          // and impossible to slip past with a pattern that doesn't match.
          hooks: [
            async (input) => {
              if (input.hook_event_name !== "PreToolUse") return { continue: true };
              const call = resolveGatedCall(configs, input.tool_name);
              if (!call) return { continue: true };

              logger.info(
                "approval",
                `denied ${input.tool_name} in-session — needs approval, told the agent to propose it`,
              );
              try {
                onDeny?.(call);
              } catch (err) {
                logger.warn("approval", `onDeny callback failed for ${input.tool_name}`, err);
              }

              return {
                hookSpecificOutput: {
                  hookEventName: "PreToolUse",
                  permissionDecision: "deny",
                  permissionDecisionReason: denialReason(call),
                },
              };
            },
          ],
        },
      ],
    },
  };
}
