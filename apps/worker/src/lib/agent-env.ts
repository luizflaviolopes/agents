import type { Agent } from "@agent-fleet/shared";

/**
 * The worker's own secrets, kept out of the environment an agent's shell
 * inherits.
 *
 * Agents run with permissionMode 'bypassPermissions', so anything in the
 * worker's environment is one `printenv` away from an agent that was talked
 * into running it — and much of what agents read (ticket bodies, pull request
 * descriptions, diffs, issue comments) is written by people who are not the
 * project owner. SUPABASE_SERVICE_ROLE_KEY in particular is full database
 * access to every project on the instance.
 *
 * The SDK's `env` option REPLACES the subprocess environment rather than
 * merging into it, so this copies the whole environment and removes the
 * dangerous names — dropping PATH/HOME/SystemRoot would break the subprocess
 * (and `npx`-launched stdio MCP servers) outright.
 *
 * Per-agent credentials are unaffected: they live in agents.mcp_servers and
 * reach their server through buildMcpServers, never through this environment.
 */

/**
 * Names matching this are treated as secrets and dropped. A pattern rather
 * than a fixed list so a credential added to .env later is excluded by
 * default instead of leaking until someone remembers to update this file.
 */
const SECRET_NAME = /(TOKEN|SECRET|KEY|PASSWORD|PASSWD|CREDENTIAL|COOKIE)/i;

/**
 * Kept despite matching SECRET_NAME: the SDK subprocess authenticates with
 * these, so stripping them fails every run.
 */
const KEEP_PREFIXES = ["ANTHROPIC_", "CLAUDE_"];

/** Dropped whole, secret-looking or not — the agent has no business with them. */
const DROP_PREFIXES = ["SUPABASE_", "NEXT_PUBLIC_SUPABASE_"];

/** True when the name must not reach an agent's shell. */
function isWorkerSecret(name: string): boolean {
  const upper = name.toUpperCase();
  if (KEEP_PREFIXES.some((prefix) => upper.startsWith(prefix))) return false;
  if (DROP_PREFIXES.some((prefix) => upper.startsWith(prefix))) return true;
  return SECRET_NAME.test(upper);
}

/**
 * The environment for one agent subprocess: the worker's, minus its secrets.
 * Pass as the SDK's `env` option.
 */
export function buildAgentEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (isWorkerSecret(name)) continue;
    env[name] = value;
  }
  return env;
}

/**
 * An agent's built-in tool limits (0009), as SDK options.
 *
 * `tools` is the base set of built-in tools; an EMPTY array disables all of
 * them, so an empty allow-list has to be omitted rather than passed through —
 * "no allow-list configured" and "allow nothing" are opposite intents that
 * would otherwise collide. `disallowedTools` removes tools from the model's
 * context and is safe to pass whenever it is non-empty.
 */
export function buildToolLimits(agent: Agent): {
  tools?: string[];
  disallowedTools?: string[];
} {
  const allowed = agent.allowed_tools ?? [];
  const disallowed = agent.disallowed_tools ?? [];
  return {
    ...(allowed.length > 0 ? { tools: allowed } : {}),
    ...(disallowed.length > 0 ? { disallowedTools: disallowed } : {}),
  };
}
