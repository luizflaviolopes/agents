import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Agent, AgentAuthMode } from "@agent-fleet/shared";
import { connectorDeniedTools } from "@agent-fleet/shared";
import { logger } from "./logger.js";

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
 * Where one run's credentials come from, resolved before the run starts.
 *
 * `token` is set only when the credential has to be INJECTED — the owner's
 * saved token (0014). The other sources are already reachable by the
 * subprocess (an environment variable it inherits, a login on disk it reads),
 * so they carry no token and only name themselves for the log.
 */
export interface SubscriptionCredential {
  /** Injected as CLAUDE_CODE_OAUTH_TOKEN, or null when nothing need be added. */
  token: string | null;
  /** Human-readable source, recorded in run_logs as `auth_source`. */
  source: string;
}

/**
 * The environment for one agent subprocess: the worker's, minus its secrets,
 * minus the API credentials when the agent runs on a Claude Code subscription
 * (0013), plus the owner's saved token when that is what it runs on (0014).
 * Pass as the SDK's `env` option.
 *
 * The saved token is assigned AFTER the copy, so it outranks a
 * CLAUDE_CODE_OAUTH_TOKEN the worker itself inherited. Deliberate: the agent
 * belongs to an owner, and it is that owner's quota the run is meant to spend
 * — a machine-wide token is the fallback for when they have saved none.
 */
export function buildAgentEnv(
  authMode: AgentAuthMode = "api",
  credential: SubscriptionCredential | null = null,
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (isWorkerSecret(name, authMode)) continue;
    env[name] = value;
  }
  if (authMode === "subscription" && credential?.token) {
    env.CLAUDE_CODE_OAUTH_TOKEN = credential.token;
  }
  return env;
}

/**
 * Where a 'subscription' run would get its credentials, or null if there are
 * none to offer.
 *
 * Resolved before the run rather than discovered during it: with the API key
 * stripped and nothing behind it, the SDK fails somewhere inside the
 * subprocess with a message about authentication that says nothing about
 * auth_mode, and the task lands 'failed' for what looks like a model problem.
 *
 * Order, most specific first:
 *   1. the token the owner saved in Settings (0014) — theirs, rotatable
 *      without touching the deployment;
 *   2. CLAUDE_CODE_OAUTH_TOKEN in the worker's environment — the whole
 *      machine's, and what every pre-0014 deployment already uses;
 *   3. the Claude Code login on disk under ~/.claude.
 *
 * macOS keeps that login in the Keychain rather than on disk, so there is
 * nothing to stat there — it reports the login as present and lets the run
 * be the judge. A false positive costs one clear SDK error; a false negative
 * would block a machine that is correctly logged in.
 */
export function resolveSubscriptionCredential(
  ownerToken: string | null = null,
  source: NodeJS.ProcessEnv = process.env,
): SubscriptionCredential | null {
  if (ownerToken) {
    return { token: ownerToken, source: "the owner's saved Claude Code token" };
  }
  if (source.CLAUDE_CODE_OAUTH_TOKEN) {
    return { token: null, source: "CLAUDE_CODE_OAUTH_TOKEN" };
  }
  if (process.platform === "darwin") {
    return { token: null, source: "the Claude Code login (macOS Keychain)" };
  }
  const home = source.HOME ?? source.USERPROFILE ?? homedir();
  if (home && existsSync(join(home, ".claude", ".credentials.json"))) {
    return { token: null, source: "the Claude Code login under ~/.claude" };
  }
  return null;
}

/**
 * The credential one run will authenticate with, given the agent's auth mode
 * and the project it belongs to. Null means the run cannot be authenticated
 * and must fail with NO_SUBSCRIPTION_CREDENTIAL_ERROR before it starts.
 *
 * 'api' never returns null — an absent or invalid ANTHROPIC_API_KEY is the
 * SDK's own error to report, and it reports it clearly.
 */
export async function loadSubscriptionCredential(
  supabase: SupabaseClient,
  authMode: AgentAuthMode,
  projectId: string,
): Promise<SubscriptionCredential | null> {
  if (authMode !== "subscription") {
    return { token: null, source: "ANTHROPIC_API_KEY" };
  }
  return resolveSubscriptionCredential(await loadOwnerClaudeToken(supabase, projectId));
}

/**
 * The Claude Code token saved by whoever owns this project, or null.
 *
 * Two queries rather than one embedded select: profiles and projects both
 * reference auth.users, but there is no foreign key BETWEEN them, so PostgREST
 * has no relationship to embed across. This runs once per subscription run,
 * against two primary-key lookups.
 *
 * A failure here is logged and treated as "no saved token" rather than thrown:
 * the caller falls through to the machine's own credentials, and if there are
 * none the run fails with the message that explains what to do about it.
 */
async function loadOwnerClaudeToken(
  supabase: SupabaseClient,
  projectId: string,
): Promise<string | null> {
  try {
    const { data: project, error: projectError } = await supabase
      .from("projects")
      .select("owner_id")
      .eq("id", projectId)
      .maybeSingle();
    if (projectError || !project?.owner_id) {
      if (projectError) {
        logger.error("agent-env", `failed to load owner of project ${projectId}: ${projectError.message}`);
      }
      return null;
    }

    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("claude_code_oauth_token")
      .eq("id", project.owner_id)
      .maybeSingle();
    if (profileError) {
      logger.error("agent-env", `failed to load Claude token for owner of project ${projectId}: ${profileError.message}`);
      return null;
    }
    return (profile?.claude_code_oauth_token as string | null) ?? null;
  } catch (err) {
    logger.error("agent-env", `failed to resolve the saved Claude token for project ${projectId}`, err);
    return null;
  }
}

/** The error a 'subscription' run fails with when no credential can be found. */
export const NO_SUBSCRIPTION_CREDENTIAL_ERROR =
  "This agent is set to run on a Claude Code subscription, but there are no Claude Code " +
  "credentials to run it with: no token is saved under Settings → Claude Code subscription, " +
  "CLAUDE_CODE_OAUTH_TOKEN is unset on the worker, and there is no login under ~/.claude. " +
  "Run `claude setup-token`, paste what it prints into Settings, or switch this agent's " +
  "billing back to the Anthropic API.";

/**
 * An agent's tool limits, as SDK options: the owner's built-in allow/deny
 * lists (0009) plus whatever its connectors forbid.
 *
 * `tools` is the base set of built-in tools; an EMPTY array disables all of
 * them, so an empty allow-list has to be omitted rather than passed through —
 * "no allow-list configured" and "allow nothing" are opposite intents that
 * would otherwise collide. `disallowedTools` removes tools from the model's
 * context and is safe to pass whenever it is non-empty.
 *
 * Connector blocks are merged in here rather than written into
 * `agents.disallowed_tools` when the connector is configured, so that they
 * are not editable in the tool-limits box and so a tool the catalog blocks
 * later is blocked on the next run of an agent configured today. The
 * allow-list does not re-open them: `disallowedTools` is applied on top.
 */
export function buildToolLimits(agent: Agent): {
  tools?: string[];
  disallowedTools?: string[];
} {
  const allowed = agent.allowed_tools ?? [];
  const disallowed = [
    ...new Set([...(agent.disallowed_tools ?? []), ...connectorDeniedTools(agent.mcp_servers)]),
  ];
  return {
    ...(allowed.length > 0 ? { tools: allowed } : {}),
    ...(disallowed.length > 0 ? { disallowedTools: disallowed } : {}),
  };
}
