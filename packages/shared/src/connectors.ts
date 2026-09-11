import type { IntegrationType, McpServerConfig } from "./db-types";

/**
 * Connector catalog — named presets that expand into an `McpServerConfig`.
 *
 * An MCP server entry is three decisions the owner has to get right by hand:
 * which package actually speaks to the service, which environment variable
 * each credential belongs in, and which of the server's tools must never be
 * reachable from an agent session. Getting any of them wrong fails in a
 * different place — a spawn error, an auth error, or a sent email nobody
 * approved — and only the third fails silently.
 *
 * A connector states all three once, as data. The owner picks "Gmail" and
 * fills in labelled fields; everything else is derived. Adding the next
 * connector is an entry in `CONNECTORS`, not another section of a runbook
 * and not another branch in the form.
 *
 * What a connector deliberately does NOT do: hold the credential an outbound
 * action is sent with. That stays in the project integration, reachable only
 * by the deterministic executor (see `McpServerConfig.integration` and
 * migration 0010). A connector is the READ side.
 */

/** Prefix the Agent SDK gives a tool from a named MCP server. */
export const SDK_TOOL_PREFIX = "mcp__";

/** The SDK's name for `tool` on `server` — `mcp__<server>__<tool>`. */
export function sdkToolName(serverName: string, tool: string): string {
  return `${SDK_TOOL_PREFIX}${serverName}__${tool}`;
}

export type ConnectorId = "gmail" | "slack";

/** One credential a connector needs from the owner. */
export interface ConnectorFieldDef {
  /** Stable key; also the map key used when round-tripping a stored config. */
  key: string;
  label: string;
  placeholder?: string;
  /** Rendered as a password input. Every real credential should set this. */
  secret: boolean;
  /** One line under the field. Say where the value comes from. */
  help?: string;
}

/**
 * A blocked capability the owner may deliberately switch on, per agent.
 *
 * `blockedTools` is the catalog's default answer, which is "no". This is the
 * override, and it is expressed as a capability rather than a tool name
 * because that is the decision the owner is actually making: "let this agent
 * post in Slack", not "un-deny mcp__slack__conversations_add_message". One
 * capability can cover several tools (adding and removing a reaction is one
 * decision) and can carry the server settings that make them exist at all.
 *
 * Off by default, always: a capability absent from an agent's
 * `mcp_servers[].capabilities` is blocked exactly as before.
 */
export interface ConnectorCapability {
  /** Stored on the agent's server entry; stable across label changes. */
  key: string;
  /** The decision, in the owner's words. */
  label: string;
  /** What it costs. Shown next to the switch — say the quiet part. */
  risk: string;
  /** Tools this lifts out of `blockedTools`. */
  tools: string[];
  /**
   * Extra stdio env the server needs before it will expose those tools at
   * all. Merged only while the capability is on, so turning it off removes
   * the setting rather than leaving a live switch behind a dead deny entry.
   */
  env?: Record<string, string>;
}

export interface ConnectorDefinition {
  id: ConnectorId;
  label: string;
  /** One line in the picker: what the agent can do with it. */
  summary: string;
  /**
   * Default `name` of the `mcp_servers` entry. The owner may rename it (two
   * mailboxes on one agent), which is why every derived name is computed
   * from the stored config rather than from this default.
   */
  defaultServerName: string;
  /**
   * Transport template — the part the owner should not have to know.
   *
   * `env` is for the server's non-credential settings: values the catalog
   * fixes because there is one correct answer, not values the owner supplies.
   * It is merged under the credentials, so a field can never be shadowed by
   * a constant.
   */
  transport:
    | { type: "stdio"; command: string; args: string[]; env?: Record<string, string> }
    | { type: "http" | "sse"; url: string };
  fields: ConnectorFieldDef[];
  /**
   * Where each field's value lands: an environment variable name for stdio,
   * a request header name for http/sse. Keyed by `ConnectorFieldDef.key`.
   */
  target: Record<string, string>;
  /**
   * Tools on this server an agent must never call, as bare tool names.
   *
   * Compiled to `mcp__<server>__<tool>` deny entries by the worker at run
   * time — NOT copied into `agents.disallowed_tools` at save time. The
   * difference matters twice: the block cannot be edited away in the
   * tool-limits box, and a tool this catalog blocks tomorrow is blocked on
   * the next run of an agent configured today.
   *
   * This is a capability limit enforced by the runtime, which is a different
   * thing from an instruction telling the agent not to. Agents that read
   * untrusted text — and an inbox is nothing but untrusted text — get asked
   * to do the blocked thing eventually.
   */
  blockedTools: string[];
  /** Why those tools are blocked. Shown next to the list in the UI. */
  blockedToolsNote: string;
  /**
   * Blocks the owner may lift per agent. Anything not listed here stays
   * blocked with no way to turn it on short of editing this file — which is
   * the right amount of friction for, say, a mailbox forwarding rule.
   */
  capabilities?: ConnectorCapability[];
  /**
   * Project integration that carries this service's send credential, when
   * outbound actions go through the approval gate. Informational here — it
   * tells the UI what else the owner still has to configure.
   */
  integration?: IntegrationType;
  /** Repo-relative setup guide, for the link under the picker. */
  docsPath: string;
}

/**
 * Gmail via `@shinzolabs/gmail-mcp`.
 *
 * Chosen because it runs headless from three plain environment variables —
 * no credential file to bake into the worker image, which is what rules out
 * the otherwise-comparable `@gongrzhe/server-gmail-autoauth-mcp`.
 *
 * The blocked list is long because this server is wide: it wraps most of the
 * Gmail API, settings included. Two families matter.
 *
 * Sending and destroying are blocked because that is the whole design — a
 * reply reaches the wire only as an approved `gmail_reply` action, sent by
 * the executor with the integration's credential, never by the agent.
 *
 * The settings tools are blocked because auto-forwarding, filters, delegates
 * and send-as are how a mailbox is quietly compromised: one injected
 * instruction in one email and every future message copies itself to someone
 * else, with nothing sent and nothing deleted for the owner to notice. A
 * `gmail.modify` token should already be refused those scopes by Google, so
 * this is the second lock rather than the first — but the scope in the
 * credential is not something this catalog can see, and a lock that only
 * works when a setting elsewhere is right is not a lock.
 */
const GMAIL: ConnectorDefinition = {
  id: "gmail",
  label: "Gmail",
  summary:
    "Read, search, thread and label your mail. Replies are proposed for your approval, never sent by the agent.",
  defaultServerName: "gmail",
  transport: { type: "stdio", command: "npx", args: ["-y", "@shinzolabs/gmail-mcp"] },
  fields: [
    {
      key: "clientId",
      label: "OAuth client ID",
      placeholder: "1234-abcd.apps.googleusercontent.com",
      secret: false,
      help: "Google Cloud → APIs & Services → Credentials → OAuth client (Desktop app).",
    },
    {
      key: "clientSecret",
      label: "OAuth client secret",
      secret: true,
      help: "Shown alongside the client ID when you create it.",
    },
    {
      key: "refreshToken",
      label: "Refresh token",
      placeholder: "1//…",
      secret: true,
      help: "One-time consent for the gmail.modify scope — see the setup guide.",
    },
  ],
  target: {
    clientId: "CLIENT_ID",
    clientSecret: "CLIENT_SECRET",
    refreshToken: "REFRESH_TOKEN",
  },
  blockedTools: [
    // Sending — the approval gate is the only outbound path.
    "send_message",
    "send_draft",
    // Destroying. Permanent delete needs a scope gmail.modify does not grant,
    // but trash does not, and a trashed thread is a reply the owner never sees.
    "delete_message",
    "batch_delete_messages",
    "delete_thread",
    "trash_message",
    "trash_thread",
    // Mailbox settings — the quiet-compromise surface.
    "update_auto_forwarding",
    "create_forwarding_address",
    "delete_forwarding_address",
    "add_delegate",
    "remove_delegate",
    "create_filter",
    "delete_filter",
    "create_send_as",
    "update_send_as",
    "patch_send_as",
    "verify_send_as",
    "delete_send_as",
    "update_vacation",
    "update_imap",
    "update_pop",
    "update_language",
    "insert_smime_info",
    "set_default_smime_info",
    "delete_smime_info",
  ],
  blockedToolsNote:
    "Sending, deleting and trashing, and every mailbox setting (forwarding, filters, delegates, send-as). Reading, threading, labelling and drafting stay available.",
  integration: "gmail",
  docsPath: "docs/COMMS-AGENTS.md",
};

/**
 * Slack via `korotovsky/slack-mcp-server`.
 *
 * Driven by a plain `xoxp-` **user** token, which is the whole point: the
 * agent reads what the owner can read, and an approved reply posts as the
 * owner — their name, their avatar, in the thread — rather than as a bot in
 * a conversation full of humans. One token covers both halves; only its
 * copy in the project integration ever sends.
 *
 * The two cache paths are fixed rather than asked for. They default to
 * relative paths, so the server would otherwise scatter its user and channel
 * caches into whatever directory the agent happens to run in — a git
 * clone, for agents that have a workspace.
 *
 * On the blocked list: this server already ships its write tools disabled,
 * each behind its own opt-in variable (`SLACK_MCP_ADD_MESSAGE_TOOL` and
 * friends), and the connector sets none of them. Blocking the tools by name
 * as well is the second lock — the first one is a default in someone else's
 * package, and defaults change.
 *
 * Blocked is the DEFAULT, not the law. Posting, reacting and marking read are
 * offered as capabilities the owner can switch on per agent: an agent that
 * handles a channel end to end is a reasonable thing to want, and the fleet
 * should not make the owner fork the catalog to get it. Each switch flips two
 * things together — the deny entry and the server variable that makes the
 * tool exist — because either alone is a setting that silently does nothing.
 *
 * What the switches cost, and why they start off: a posted message and a 👍
 * are both replies, visible to everyone in the channel, sent as the owner,
 * and neither passed the approval gate. `conversations_mark` means the agent
 * decides which messages the owner never sees. Worth having on purpose;
 * nothing you want arriving by default on an agent that reads whatever
 * anyone types into a channel.
 */
const SLACK: ConnectorDefinition = {
  id: "slack",
  label: "Slack",
  summary:
    "Read your channels, DMs, threads and unreads. Replies are proposed for your approval and post as you, not as a bot.",
  defaultServerName: "slack",
  transport: {
    type: "stdio",
    command: "npx",
    args: ["-y", "slack-mcp-server@latest", "--transport", "stdio"],
    env: {
      SLACK_MCP_USERS_CACHE: "/tmp/slack-mcp-users-cache.json",
      SLACK_MCP_CHANNELS_CACHE: "/tmp/slack-mcp-channels-cache.json",
    },
  },
  fields: [
    {
      key: "userToken",
      label: "User OAuth token",
      placeholder: "xoxp-…",
      secret: true,
      help: "api.slack.com/apps → your app → OAuth & Permissions → User OAuth Token. A user token, not a bot token — see the setup guide for the scopes.",
    },
  ],
  target: { userToken: "SLACK_MCP_XOXP_TOKEN" },
  blockedTools: [
    // Posting — the approval gate is the only outbound path.
    "conversations_add_message",
    // Reactions are messages too: public, attributed to the owner, unapproved.
    "reactions_add",
    "reactions_remove",
    // Marking read hides messages from the owner.
    "conversations_mark",
    // Workspace state that has nothing to do with triage.
    "usergroups_create",
    "usergroups_update",
    "usergroups_users_update",
    "saved_update",
    "saved_clear_completed",
  ],
  blockedToolsNote:
    "Posting messages, adding or removing reactions, marking conversations read, and editing user groups or saved items. Reading channels, DMs, threads, unreads and search stay available.",
  capabilities: [
    {
      key: "post",
      label: "Post messages directly",
      risk: "The agent posts as you without the approval gate. Update its instructions too — the comms template forbids posting. To keep a human in the loop, leave this on but set the approval policy below to ask for conversations_add_message.",
      tools: ["conversations_add_message"],
      // "true" is every channel. The server also accepts a comma-separated
      // channel allowlist here, which is the narrower setting if this agent
      // only ever answers in one place.
      env: { SLACK_MCP_ADD_MESSAGE_TOOL: "true" },
    },
    {
      key: "react",
      label: "Add and remove reactions",
      risk: "A reaction is public and attributed to you. Cheaper than a message, and it is still a reply nobody approved.",
      tools: ["reactions_add", "reactions_remove"],
      env: { SLACK_MCP_REACTION_TOOL: "true" },
    },
    {
      key: "mark",
      label: "Mark conversations read",
      risk: "The agent decides what you have already seen. Useful for a triage agent you trust; it can also hide a message from you for good.",
      tools: ["conversations_mark"],
      env: { SLACK_MCP_MARK_TOOL: "true" },
    },
  ],
  integration: "slack",
  docsPath: "docs/COMMS-AGENTS.md",
};

export const CONNECTORS: Record<ConnectorId, ConnectorDefinition> = {
  gmail: GMAIL,
  slack: SLACK,
};

/** Catalog order for pickers. */
export const CONNECTOR_IDS = [
  "slack",
  "gmail",
] as const satisfies readonly ConnectorId[];

/** The definition for `id`, or undefined for an id this build does not know. */
export function getConnector(id: string | undefined | null): ConnectorDefinition | undefined {
  if (!id) return undefined;
  return CONNECTORS[id as ConnectorId];
}

/**
 * A server entry for `def`, carrying `credentials` keyed by field key.
 *
 * Blank values are dropped rather than written as empty strings: an empty
 * `CLIENT_SECRET` in the environment is harder to diagnose than a missing
 * one, because the server gets far enough to fail somewhere else.
 */
export function buildConnectorServer(
  def: ConnectorDefinition,
  serverName: string,
  credentials: Record<string, string>,
  capabilities: string[] = [],
): McpServerConfig {
  const values: Record<string, string> = {};
  for (const field of def.fields) {
    const value = (credentials[field.key] ?? "").trim();
    if (value) values[def.target[field.key] ?? field.key] = value;
  }
  // Keys this definition actually offers, in catalog order. A key the
  // catalog has since dropped is discarded rather than stored forever.
  const enabled = enabledCapabilities(def, capabilities);
  const base = {
    name: serverName.trim() || def.defaultServerName,
    connector: def.id,
    ...(enabled.length > 0 ? { capabilities: enabled.map((c) => c.key) } : {}),
  };
  if (def.transport.type === "stdio") {
    const capabilityEnv = Object.assign({}, ...enabled.map((c) => c.env ?? {}));
    const env = { ...def.transport.env, ...capabilityEnv, ...values };
    return {
      ...base,
      type: "stdio",
      command: def.transport.command,
      args: [...def.transport.args],
      ...(Object.keys(env).length > 0 ? { env } : {}),
    };
  }
  return {
    ...base,
    type: def.transport.type,
    url: def.transport.url,
    ...(Object.keys(values).length > 0 ? { headers: values } : {}),
  };
}

/**
 * The capabilities `def` offers that `keys` switches on, in catalog order.
 *
 * Unknown keys drop out rather than throwing, for the same reason unknown
 * connector ids do: a config written by a newer deploy must not take down an
 * older worker, and the safe direction for a key this build cannot interpret
 * is to leave the tool blocked.
 */
export function enabledCapabilities(
  def: ConnectorDefinition,
  keys: string[] | null | undefined,
): ConnectorCapability[] {
  if (!keys?.length) return [];
  const wanted = new Set(keys);
  return (def.capabilities ?? []).filter((capability) => wanted.has(capability.key));
}

/** Field-keyed credentials read back out of a stored connector entry. */
export function readConnectorCredentials(
  def: ConnectorDefinition,
  config: McpServerConfig,
): Record<string, string> {
  const values = (config.type === "stdio" ? config.env : config.headers) ?? {};
  const out: Record<string, string> = {};
  for (const field of def.fields) {
    out[field.key] = values[def.target[field.key] ?? field.key] ?? "";
  }
  return out;
}

/**
 * Every `mcp__<server>__<tool>` an agent's connectors forbid.
 *
 * Computed from the agent's own server list so a renamed server still resolves,
 * and so an entry whose `connector` this build does not recognise contributes
 * nothing rather than throwing — a config written by a newer deploy must not
 * take down an older worker mid-rollout.
 *
 * Capabilities the owner switched on are subtracted here, at run time, from
 * the catalog's list — the deny list is never stored, so an agent configured
 * today still picks up whatever the catalog blocks tomorrow, minus exactly
 * the switches its owner threw.
 */
export function connectorDeniedTools(configs: McpServerConfig[] | null | undefined): string[] {
  const denied: string[] = [];
  for (const config of configs ?? []) {
    const def = getConnector(config?.connector);
    if (!def || !config.name) continue;
    const allowed = new Set(
      enabledCapabilities(def, config.capabilities).flatMap((c) => c.tools),
    );
    for (const tool of def.blockedTools) {
      if (!allowed.has(tool)) denied.push(sdkToolName(config.name, tool));
    }
  }
  return denied;
}
