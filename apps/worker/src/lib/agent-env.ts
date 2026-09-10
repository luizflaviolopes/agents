import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Agent, AgentAuthMode } from "@agent-fleet/shared";

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

/**
 * The API credentials, dropped from a 'subscription' agent's subprocess
 * (0013).
 *
 * The SDK resolves credentials in order and an API credential wins, so
 * leaving either of these in place would silently bill the API no matter what
 * the agent is configured for — the switch has to be a removal. What remains
 * is whatever Claude Code itself stored on this machine:
 * CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`), or the login under
 * ~/.claude, which survives because the environment keeps HOME.
 */
const API_CREDENTIAL_NAMES = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];

/** Dropped whole, secret-looking or not — the agent has no business with them. */
const DROP_PREFIXES = ["SUPABASE_", "NEXT_PUBLIC_SUPABASE_"];

/** True when the name must not reach an agent's shell. */
function isWorkerSecret(name: string, authMode: AgentAuthMode): boolean {
  const upper = name.toUpperCase();
  if (authMode === "subscription" && API_CREDENTIAL_NAMES.includes(upper)) {
    return true;
  }
  if (KEEP_PREFIXES.some((prefix) => upper.startsWith(prefix))) return false;
  if (DROP_PREFIXES.some((prefix) => upper.startsWith(prefix))) return true;
  return SECRET_NAME.test(upper);
}

/**
 * The environment for one agent subprocess: the worker's, minus its secrets,
 * minus the API credentials when the agent runs on the machine's Claude Code
 * subscription (0013). Pass as the SDK's `env` option.
 */
export function buildAgentEnv(
  authMode: AgentAuthMode = "api",
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (isWorkerSecret(name, authMode)) continue;
    env[name] = value;
  }
  return env;
}

/**
 * Where a 'subscription' run would get its credentials, or null if this
 * machine has none to offer.
 *
 * Checked before the run rather than discovered during it: with the API key
 * stripped and nothing behind it, the SDK fails somewhere inside the
 * subprocess with a message about authentication that says nothing about
 * auth_mode, and the task lands 'failed' for what looks like a model problem.
 *
 * macOS keeps the login in the Keychain rather than on disk, so there is
 * nothing to stat there — it reports the login as present and lets the run
 * be the judge. A false positive costs one clear SDK error; a false negative
 * would block a machine that is correctly logged in.
 */
export function describeSubscriptionCredential(
  source: NodeJS.ProcessEnv = process.env,
): string | null {
  if (source.CLAUDE_CODE_OAUTH_TOKEN) return "CLAUDE_CODE_OAUTH_TOKEN";
  if (process.platform === "darwin") return "the Claude Code login (macOS Keychain)";
  const home = source.HOME ?? source.USERPROFILE ?? homedir();
  if (home && existsSync(join(home, ".claude", ".credentials.json"))) {
    return "the Claude Code login under ~/.claude";
  }
  return null;
}

/**
 * Whether this machine can authenticate a run in the given mode. 'api' is
 * always true — an absent or invalid ANTHROPIC_API_KEY is the SDK's own
 * error to report, and it reports it clearly.
 */
export function hasAuthCredential(
  authMode: AgentAuthMode,
  source: NodeJS.ProcessEnv = process.env,
): boolean {
  return authMode !== "subscription" || describeSubscriptionCredential(source) !== null;
}

/** The error a 'subscription' run fails with when this machine has no login. */
export const NO_SUBSCRIPTION_CREDENTIAL_ERROR =
  "This agent is set to run on the machine's Claude Code subscription, but the worker " +
  "has no Claude Code credentials: CLAUDE_CODE_OAUTH_TOKEN is unset and there is no " +
  "login under ~/.claude. Run `claude setup-token` on the worker machine and set " +
  "CLAUDE_CODE_OAUTH_TOKEN, or switch this agent's auth mode back to 'api'.";

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
