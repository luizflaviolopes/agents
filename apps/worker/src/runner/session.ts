import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createSdkMcpServer,
  tool,
  type McpServerConfig as SdkMcpServerConfig,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  PENDING_ACTION_TYPES,
  type Agent,
  type AgentKnowledgeRow,
  type McpServerConfig,
  type MessageChannel,
  type PendingActionRow,
  type PendingActionType,
  type Task,
  type TaskStatus,
} from "@agent-fleet/shared";
import { logger, type RunLogWriter } from "../lib/logger.js";
import type { Semaphore } from "../lib/semaphore.js";

const ASK_AGENT_POLL_MS = 3_000;
const ASK_AGENT_TIMEOUT_MS = 10 * 60_000;
const ACTIVITY_MAX_ROWS = 100;
const ACTIVITY_MESSAGE_MAX_CHARS = 500;
const ACTIVITY_RESULT_MAX_CHARS = 800;
const ACTIVITY_DEFAULT_LOOKBACK_MS = 72 * 60 * 60 * 1000;

/** Sends a text to the project owner's linked Telegram chat. */
export type TelegramNotifier = (projectId: string, text: string) => Promise<void>;

/** Notifies the project owner (Telegram inline buttons) about a new pending action. */
export type PendingActionNotifier = (
  action: PendingActionRow,
  projectName: string,
  agentName: string,
) => Promise<void>;

/**
 * Everything the in-process 'fleet' MCP server needs to serve one agent
 * session. Task runs and direct chat sessions both build one of these —
 * the nullable fields are what differ:
 * - task/runId/runLog/slots are set in task runs, null in chat sessions.
 * - reply is set in chat sessions (adds the reply_to_user tool), absent in
 *   task runs.
 */
export interface FleetSessionContext {
  supabase: SupabaseClient;
  agent: Agent;
  projectId: string;
  /** The task being executed; null in chat sessions. */
  task: Task | null;
  /** task_runs id (knowledge provenance); null in chat sessions. */
  runId: string | null;
  /** Run-log sink; null in chat sessions (console logging only). */
  runLog: RunLogWriter | null;
  /**
   * Shared concurrency pool: ask_agent releases the caller's slot while
   * waiting on the child task and re-acquires it before resuming. Null in
   * chat sessions (they hold no slot).
   */
  slots: Semaphore | null;
  /** Incremented per proposed pending action (task runs use it for 'review'). */
  runState: { pendingActionsCreated: number };
  telegramNotifier?: TelegramNotifier;
  pendingActionNotifier?: PendingActionNotifier;
  /** Present in chat sessions: adds reply_to_user targeting this channel. */
  reply?: {
    channel: MessageChannel;
    send: (text: string) => Promise<void>;
  };
}

/**
 * Builds the in-process 'fleet' MCP server for one agent session:
 * - propose_action — queue an approval-gated outbound Slack/Gmail action.
 * - ask_agent — delegate a question to another agent as a child task.
 * - notify_user — direct (non-gated) notification to the project owner.
 * - reply_to_user — chat sessions only (ctx.reply set).
 * - save_knowledge / read_project_activity — librarian agents only.
 */
export function buildFleetServer(ctx: FleetSessionContext): SdkMcpServerConfig {
  const { supabase, agent, projectId } = ctx;

  const proposeAction = tool(
    "propose_action",
    "Propose an outbound action (Slack message/reply or Gmail send/reply) on the user's behalf. " +
      "The action is NOT sent now — it is queued for the user to approve or reject; a deterministic " +
      "executor sends it only after approval. Provide a human-readable preview and the exact payload. " +
      "Payload for slack_reply/slack_message: { channel, text, thread_ts? } (thread_ts required for slack_reply). " +
      "Payload for gmail_reply/gmail_send: { to, subject, body, cc?, thread_id?, in_reply_to_message_id? } " +
      "(gmail_reply requires thread_id and/or in_reply_to_message_id).",
    {
      action_type: z.enum(PENDING_ACTION_TYPES).describe("The kind of outbound action"),
      preview: z.string().min(1).describe("Human-readable summary shown to the user for approval"),
      payload: z.record(z.unknown()).describe("Exact payload the executor will send (see tool description)"),
    },
    async (args) => {
      const validated = validateActionPayload(args.action_type, args.payload);
      if (!validated.ok) return textResult(`Error: ${validated.error}`);

      const { data, error } = await supabase
        .from("pending_actions")
        .insert({
          project_id: projectId,
          task_id: ctx.task?.id ?? null,
          agent_id: agent.id,
          action_type: args.action_type,
          preview: args.preview,
          payload: validated.value,
          status: "pending",
        })
        .select("*")
        .single();
      if (error) return textResult(`Error creating pending action: ${error.message}`);
      const action = data as PendingActionRow;

      ctx.runState.pendingActionsCreated += 1;
      logger.info("fleet", `agent ${agent.name}: pending action ${action.id} (${action.action_type}) proposed`);
      await ctx.runLog?.write("status", {
        status: "pending_action_created",
        pending_action_id: action.id,
        action_type: action.action_type,
        preview: truncate(action.preview, 500),
      });

      if (ctx.pendingActionNotifier) {
        try {
          const projectName = await loadProjectName(supabase, projectId);
          await ctx.pendingActionNotifier(action, projectName, agent.name);
        } catch (err) {
          logger.error("fleet", `telegram notification for pending action ${action.id} failed`, err);
        }
      }

      return textResult(
        `Pending action ${action.id} created and queued for user approval. ` +
          `It will only be sent if the user approves it — do not try to send it any other way.`,
      );
    },
  );

  const askAgent = tool(
    "ask_agent",
    "Ask another agent in this project to handle a request. Creates a child task for that agent, " +
      "waits for it to finish (up to 10 minutes) and returns its result. The request must be " +
      "self-contained — the other agent sees nothing else from this session.",
    {
      agent_name: z.string().min(1).describe("Name of the target agent (case-insensitive)"),
      request: z.string().min(1).describe("The full, self-contained request for the other agent"),
    },
    async (args) => {
      // Depth cap: tasks created by ask_agent cannot ask further agents.
      if (ctx.task?.source === "agent") {
        return textResult(
          "Error: ask_agent is not available in this task — it was itself created via ask_agent " +
            "(maximum delegation depth is 1). Answer with what you have.",
        );
      }

      const target = await findAgentByName(supabase, projectId, args.agent_name);
      if (!target) {
        return textResult(`Error: no active agent named "${args.agent_name}" found in this project.`);
      }
      if (target.id === agent.id) {
        return textResult("Error: an agent cannot ask itself. Pick a different agent or proceed on your own.");
      }

      const { data, error } = await supabase
        .from("tasks")
        .insert({
          project_id: projectId,
          agent_id: target.id,
          source: "agent",
          parent_task_id: ctx.task?.id ?? null,
          title: `Question from ${agent.name}: ${args.request.slice(0, 80)}`,
          description: args.request,
          status: "queued",
        })
        .select("id")
        .single();
      if (error) return textResult(`Error creating the child task: ${error.message}`);
      const childId = (data as { id: string }).id;

      logger.info("fleet", `agent ${agent.name}: ask_agent created child task ${childId} for agent ${target.name}`);
      await ctx.runLog?.write("status", {
        status: "ask_agent_started",
        child_task_id: childId,
        target_agent_id: target.id,
        target_agent_name: target.name,
      });

      // CRITICAL (task runs): release this task's concurrency slot while
      // waiting so the child task (and other work) can claim it — with a
      // bounded pool, two parents waiting on children would otherwise
      // deadlock. The slot is re-acquired before this tool returns. Chat
      // sessions hold no slot (ctx.slots is null).
      ctx.slots?.release();
      let outcome: { status: TaskStatus; result: string | null } | null = null;
      try {
        const deadline = Date.now() + ASK_AGENT_TIMEOUT_MS;
        while (Date.now() < deadline) {
          await sleep(ASK_AGENT_POLL_MS);
          const { data: row, error: pollError } = await supabase
            .from("tasks")
            .select("status, result")
            .eq("id", childId)
            .maybeSingle();
          if (pollError) {
            logger.warn("fleet", `ask_agent poll for child task ${childId} failed: ${pollError.message}`);
            continue;
          }
          const child = row as { status: TaskStatus; result: string | null } | null;
          if (!child) {
            outcome = { status: "cancelled", result: "the child task row no longer exists" };
            break;
          }
          // 'review' is terminal for the run too (result saved, sends
          // awaiting user approval).
          if (
            child.status === "done" ||
            child.status === "failed" ||
            child.status === "cancelled" ||
            child.status === "review"
          ) {
            outcome = child;
            break;
          }
        }
      } finally {
        if (ctx.slots) await ctx.slots.acquire();
      }

      await ctx.runLog?.write("status", {
        status: "ask_agent_finished",
        child_task_id: childId,
        child_status: outcome?.status ?? "timeout",
      });

      if (!outcome) {
        return textResult(
          `Error: agent "${target.name}" did not finish within 10 minutes. ` +
            `Task ${childId} may still complete later; continue without its answer.`,
        );
      }
      if (outcome.status === "done" || outcome.status === "review") {
        const suffix =
          outcome.status === "review"
            ? "\n\n(Note: that agent also proposed outbound actions which await user approval.)"
            : "";
        return textResult((outcome.result?.trim() || "(the agent finished but returned no result text)") + suffix);
      }
      return textResult(
        `Error: the task for agent "${target.name}" ended with status '${outcome.status}': ${outcome.result ?? "no details"}`,
      );
    },
  );

  const notifyUser = tool(
    "notify_user",
    "Send a notification to the project owner. It appears in the web chat (in your thread) and is " +
      "mirrored to the owner's Telegram if linked. Use it for progress updates, important findings, or " +
      "anything the owner should see right away. Not approval-gated — it only reaches the project owner; " +
      "external messages (Slack/Gmail) still require propose_action.",
    {
      text: z.string().min(1).describe("The notification text for the project owner"),
    },
    async (args) => {
      const { error } = await supabase.from("messages").insert({
        project_id: projectId,
        task_id: ctx.task?.id ?? null,
        agent_id: agent.id,
        sender: "agent",
        channel: "web",
        content: args.text,
      });
      if (error) return textResult(`Error storing the notification: ${error.message}`);

      await ctx.runLog?.write("status", {
        status: "user_notified",
        text: truncate(args.text, 500),
      });

      if (ctx.telegramNotifier) {
        try {
          await ctx.telegramNotifier(projectId, `[${agent.name}] ${args.text}`);
        } catch (err) {
          logger.error("fleet", `telegram mirror for notify_user failed (agent ${agent.name})`, err);
        }
      }
      return textResult("Notification delivered to the project owner.");
    },
  );

  const send = ctx.reply?.send;
  const replyToUser = send
    ? tool(
        "reply_to_user",
        "Send your reply to the user in this chat thread. Always call this exactly once at the end of " +
          "your turn with your full answer. Never end without replying.",
        {
          text: z.string().min(1).describe("The reply to send to the user"),
        },
        async (args) => {
          await send(args.text);
          return textResult("Reply sent to the user.");
        },
      )
    : null;

  return createSdkMcpServer({
    name: "fleet",
    version: "1.0.0",
    tools: [
      proposeAction,
      askAgent,
      notifyUser,
      ...(replyToUser ? [replyToUser] : []),
      ...(agent.role === "librarian"
        ? [buildSaveKnowledgeTool(ctx), buildReadProjectActivityTool(ctx)]
        : []),
    ],
  });
}

// ------------------------------------------------------------ librarian tools

function buildSaveKnowledgeTool(ctx: FleetSessionContext) {
  const { supabase, agent, projectId } = ctx;

  return tool(
    "save_knowledge",
    "Create or update a knowledge document. scope 'project' = shared with every agent of this project; " +
      "scope 'agent' (requires agent_name) = private to that agent. mode 'create' makes a new doc, " +
      "'replace' overwrites the content of the doc with the same title, 'append' adds to it. " +
      "Matching for replace/append is by exact title (case-insensitive) within the scope target.",
    {
      scope: z.enum(["project", "agent"]).describe("'project' = shared doc; 'agent' = a specific agent's doc"),
      agent_name: z.string().optional().describe("Target agent name (required when scope is 'agent')"),
      title: z.string().min(1).max(300).describe("Document title (the match key for replace/append)"),
      content: z.string().min(1).describe("The document content (or the text to append)"),
      mode: z.enum(["create", "replace", "append"]).describe("create a new doc, or replace/append the existing one"),
    },
    async (args) => {
      // Resolve the scope target.
      let targetAgentId: string | null = null;
      if (args.scope === "agent") {
        if (!args.agent_name?.trim()) {
          return textResult("Error: agent_name is required when scope is 'agent'.");
        }
        const agents = await listActiveAgents(supabase, projectId);
        const needle = args.agent_name.trim().toLowerCase();
        const target = agents.find((a) => a.name.trim().toLowerCase() === needle) ?? null;
        if (!target) {
          const names = agents.map((a) => a.name).join(", ") || "(none)";
          return textResult(`Error: no agent named "${args.agent_name}" in this project. Valid names: ${names}`);
        }
        targetAgentId = target.id;
      }

      // Load the docs of the scope target and match by title (case-insensitive).
      let docsQuery = supabase.from("agent_knowledge").select("*");
      docsQuery =
        args.scope === "project"
          ? docsQuery.eq("project_id", projectId)
          : docsQuery.eq("agent_id", targetAgentId);
      const { data: docsData, error: docsError } = await docsQuery;
      if (docsError) return textResult(`Error loading existing docs: ${docsError.message}`);
      const docs = (docsData ?? []) as AgentKnowledgeRow[];
      const titleNeedle = args.title.trim().toLowerCase();
      const existing = docs.find((d) => d.title.trim().toLowerCase() === titleNeedle) ?? null;

      const scopeLabel = args.scope === "project" ? "project scope" : `agent "${args.agent_name}"`;

      if (args.mode === "create") {
        if (existing) {
          return textResult(
            `Error: a doc titled "${existing.title}" already exists in ${scopeLabel} — use mode 'replace' or 'append' instead.`,
          );
        }
        const { error } = await supabase.from("agent_knowledge").insert({
          agent_id: targetAgentId,
          project_id: args.scope === "project" ? projectId : null,
          kind: "knowledge",
          title: args.title,
          content: args.content,
          created_by_agent_id: agent.id,
          updated_by_agent_id: agent.id,
          source_run_id: ctx.runId,
        });
        if (error) return textResult(`Error creating the doc: ${error.message}`);
        logger.info("fleet", `librarian ${agent.name}: created knowledge doc "${args.title}" (${scopeLabel})`);
        return textResult(`Created knowledge doc "${args.title}" in ${scopeLabel}.`);
      }

      // replace / append
      if (!existing) {
        const titles = docs.map((d) => `"${d.title}"`).join(", ") || "(none)";
        return textResult(
          `Error: no doc titled "${args.title}" in ${scopeLabel} — use mode 'create'. Existing titles there: ${titles}`,
        );
      }
      // Voice docs may only be edited for scope 'agent' (they are agent-scoped
      // by design; the kind is never changed by this tool).
      if (existing.kind === "voice" && args.scope !== "agent") {
        return textResult(`Error: "${existing.title}" is a voice profile — voice docs can only be edited with scope 'agent'.`);
      }

      const newContent =
        args.mode === "replace"
          ? args.content
          : existing.content.trim().length > 0
            ? `${existing.content}\n\n${args.content}`
            : args.content;

      const { error } = await supabase
        .from("agent_knowledge")
        .update({
          content: newContent,
          updated_by_agent_id: agent.id,
          source_run_id: ctx.runId,
          updated_at: new Date().toISOString(),
        })
        .eq("id", existing.id);
      if (error) return textResult(`Error updating the doc: ${error.message}`);
      const verb = args.mode === "replace" ? "Replaced the content of" : "Appended to";
      logger.info("fleet", `librarian ${agent.name}: ${args.mode}d knowledge doc "${existing.title}" (${scopeLabel})`);
      return textResult(`${verb} "${existing.title}" in ${scopeLabel} (kind '${existing.kind}' unchanged).`);
    },
  );
}

function buildReadProjectActivityTool(ctx: FleetSessionContext) {
  const { supabase, agent, projectId } = ctx;

  return tool(
    "read_project_activity",
    "Read recent project activity: chat messages across all threads (user and agents) plus tasks that " +
      "finished (done/failed/review) with their results. Defaults to everything since your stored " +
      "activity cursor (or the last 72 hours). Returns compact JSON.",
    {
      since: z.string().optional().describe("ISO timestamp to read from (defaults to your activity cursor)"),
    },
    async (args) => {
      let since = args.since?.trim() || agent.activity_cursor || null;
      if (since && Number.isNaN(Date.parse(since))) {
        return textResult(`Error: "${since}" is not a parseable timestamp — pass an ISO 8601 value.`);
      }
      if (!since) {
        since = new Date(Date.now() - ACTIVITY_DEFAULT_LOOKBACK_MS).toISOString();
      }

      const agents = await listActiveAgents(supabase, projectId);
      const agentNames = new Map(agents.map((a) => [a.id, a.name]));

      const [messagesRes, tasksRes] = await Promise.all([
        supabase
          .from("messages")
          .select("created_at, agent_id, sender, content")
          .eq("project_id", projectId)
          .gt("created_at", since)
          .order("created_at", { ascending: true })
          .limit(ACTIVITY_MAX_ROWS),
        supabase
          .from("tasks")
          .select("finished_at, agent_id, title, status, result")
          .eq("project_id", projectId)
          .in("status", ["done", "failed", "review"])
          .gt("finished_at", since)
          .order("finished_at", { ascending: true })
          .limit(ACTIVITY_MAX_ROWS),
      ]);
      if (messagesRes.error) return textResult(`Error loading messages: ${messagesRes.error.message}`);
      if (tasksRes.error) return textResult(`Error loading tasks: ${tasksRes.error.message}`);

      const messages = (messagesRes.data ?? []).map((row) => {
        const m = row as { created_at: string; agent_id: string | null; sender: string; content: string };
        return {
          at: m.created_at,
          thread: m.agent_id ? (agentNames.get(m.agent_id) ?? m.agent_id) : "manager",
          sender: m.sender,
          text: truncate(m.content, ACTIVITY_MESSAGE_MAX_CHARS),
        };
      });
      const tasks = (tasksRes.data ?? []).map((row) => {
        const t = row as {
          finished_at: string | null;
          agent_id: string | null;
          title: string;
          status: string;
          result: string | null;
        };
        return {
          at: t.finished_at,
          agent: t.agent_id ? (agentNames.get(t.agent_id) ?? t.agent_id) : "unassigned",
          title: t.title,
          status: t.status,
          result: truncate(t.result ?? "", ACTIVITY_RESULT_MAX_CHARS),
        };
      });

      return textResult(JSON.stringify({ since, messages, tasks }));
    },
  );
}

// ----------------------------------------------------------------- knowledge

/**
 * Knowledge docs for system-prompt injection (migration 0005): the
 * project-scoped docs shared by every agent of the project + the agent's own
 * agent-scoped docs.
 */
export interface KnowledgeBundle {
  projectDocs: AgentKnowledgeRow[];
  agentDocs: AgentKnowledgeRow[];
}

export async function loadKnowledgeBundle(
  supabase: SupabaseClient,
  agent: Agent,
): Promise<KnowledgeBundle> {
  const [projectRes, agentRes] = await Promise.all([
    supabase
      .from("agent_knowledge")
      .select("*")
      .eq("project_id", agent.project_id)
      .order("created_at", { ascending: true }),
    supabase
      .from("agent_knowledge")
      .select("*")
      .eq("agent_id", agent.id)
      .order("created_at", { ascending: true }),
  ]);
  if (projectRes.error) {
    logger.error("fleet", `failed to load project knowledge for project ${agent.project_id}: ${projectRes.error.message}`);
  }
  if (agentRes.error) {
    logger.error("fleet", `failed to load knowledge for agent ${agent.id}: ${agentRes.error.message}`);
  }
  return {
    projectDocs: (projectRes.data ?? []) as AgentKnowledgeRow[],
    agentDocs: (agentRes.data ?? []) as AgentKnowledgeRow[],
  };
}

/**
 * Renders the knowledge sections appended to an agent's system prompt:
 * "# Project knowledge" (project-scoped docs), "# Knowledge" (own docs of
 * kind 'knowledge'), "# Voice profiles" (own docs of kind 'voice').
 */
export function knowledgeSections(bundle: KnowledgeBundle): string {
  const parts: string[] = [];
  if (bundle.projectDocs.length > 0) {
    parts.push(`# Project knowledge\n${bundle.projectDocs.map(formatKnowledgeDoc).join("\n\n")}`);
  }
  const knowledgeDocs = bundle.agentDocs.filter((doc) => doc.kind === "knowledge");
  const voiceDocs = bundle.agentDocs.filter((doc) => doc.kind === "voice");
  if (knowledgeDocs.length > 0) {
    parts.push(`# Knowledge\n${knowledgeDocs.map(formatKnowledgeDoc).join("\n\n")}`);
  }
  if (voiceDocs.length > 0) {
    parts.push(
      `# Voice profiles\n` +
        `When drafting messages on the user's behalf, choose the profile that matches the ` +
        `recipient/context described in each profile.\n` +
        voiceDocs.map(formatKnowledgeDoc).join("\n\n"),
    );
  }
  return parts.join("\n\n");
}

function formatKnowledgeDoc(doc: AgentKnowledgeRow): string {
  return `## ${doc.title}\n${doc.content}`;
}

/** The project's active librarian agent, or null. */
export async function findLibrarian(
  supabase: SupabaseClient,
  projectId: string,
): Promise<Agent | null> {
  try {
    const { data, error } = await supabase
      .from("agents")
      .select("*")
      .eq("project_id", projectId)
      .eq("role", "librarian")
      .eq("is_active", true)
      .maybeSingle();
    if (error) {
      logger.error("fleet", `failed to load librarian for project ${projectId}: ${error.message}`);
      return null;
    }
    return (data as Agent | null) ?? null;
  } catch (err) {
    logger.error("fleet", `failed to load librarian for project ${projectId}`, err);
    return null;
  }
}

/**
 * Preamble rule added for every agent of a project that has a librarian
 * (except the librarian itself): durable facts get forwarded for preservation.
 */
export function librarianForwardingRule(agent: Agent, librarian: Agent | null): string {
  if (!librarian || librarian.id === agent.id) return "";
  return (
    `When you learn a durable fact about the project (a person joining or leaving, a decision, ` +
    `a convention, a preference), forward it to the librarian agent '${librarian.name}' via the ` +
    `ask_agent tool so it is preserved.`
  );
}

// ----------------------------------------------------------------- utilities

/** Case-insensitive exact-name lookup of an active agent in a project. */
export async function findAgentByName(
  supabase: SupabaseClient,
  projectId: string,
  name: string,
): Promise<Agent | null> {
  const agents = await listActiveAgents(supabase, projectId);
  const needle = name.trim().toLowerCase();
  return agents.find((a) => a.name.trim().toLowerCase() === needle) ?? null;
}

async function listActiveAgents(supabase: SupabaseClient, projectId: string): Promise<Agent[]> {
  try {
    const { data, error } = await supabase
      .from("agents")
      .select("*")
      .eq("project_id", projectId)
      .eq("is_active", true);
    if (error) {
      logger.error("fleet", `failed to list agents for project ${projectId}: ${error.message}`);
      return [];
    }
    return (data ?? []) as Agent[];
  } catch (err) {
    logger.error("fleet", `failed to list agents for project ${projectId}`, err);
    return [];
  }
}

export async function loadProjectName(supabase: SupabaseClient, projectId: string): Promise<string> {
  try {
    const { data, error } = await supabase
      .from("projects")
      .select("name")
      .eq("id", projectId)
      .maybeSingle();
    if (error || !data) return "unknown project";
    return (data as { name: string }).name;
  } catch {
    return "unknown project";
  }
}

/**
 * Maps agents.mcp_servers (DB jsonb) to the Agent SDK's mcpServers option:
 * stdio → {command, args, env}; http/sse → {type, url}.
 */
export function buildMcpServers(
  configs: McpServerConfig[],
): Record<string, SdkMcpServerConfig> {
  const servers: Record<string, SdkMcpServerConfig> = {};
  for (const config of configs) {
    if (!config || typeof config !== "object" || !config.name) continue;
    if (config.type === "stdio") {
      if (!config.command) {
        logger.warn("fleet", `mcp server "${config.name}" is stdio but has no command — skipped`);
        continue;
      }
      servers[config.name] = {
        type: "stdio",
        command: config.command,
        args: config.args ?? [],
        ...(config.env ? { env: config.env } : {}),
      };
    } else if (config.type === "http" || config.type === "sse") {
      if (!config.url) {
        logger.warn("fleet", `mcp server "${config.name}" is ${config.type} but has no url — skipped`);
        continue;
      }
      servers[config.name] = { type: config.type, url: config.url };
    } else {
      logger.warn("fleet", `mcp server "${config.name}" has unknown type — skipped`);
    }
  }
  return servers;
}

// --------------------------------------------------- propose_action payloads

const slackPayloadSchema = z.object({
  channel: z.string().min(1),
  text: z.string().min(1),
  thread_ts: z.string().min(1).optional(),
});

const gmailPayloadSchema = z.object({
  to: z.string().min(1),
  cc: z.string().min(1).optional(),
  subject: z.string().min(1),
  body: z.string().min(1),
  thread_id: z.string().min(1).optional(),
  in_reply_to_message_id: z.string().min(1).optional(),
});

/** Validates a propose_action payload against the shape its type requires. */
function validateActionPayload(
  actionType: PendingActionType,
  payload: unknown,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const formatIssues = (error: z.ZodError): string =>
    error.issues.map((issue) => `${issue.path.join(".") || "payload"}: ${issue.message}`).join("; ");

  if (actionType === "slack_reply" || actionType === "slack_message") {
    const parsed = slackPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      return { ok: false, error: `Invalid ${actionType} payload — ${formatIssues(parsed.error)}` };
    }
    if (actionType === "slack_reply" && !parsed.data.thread_ts) {
      return {
        ok: false,
        error: "slack_reply payload requires thread_ts (the thread to reply in). Use slack_message for a new message.",
      };
    }
    return { ok: true, value: parsed.data };
  }

  const parsed = gmailPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return { ok: false, error: `Invalid ${actionType} payload — ${formatIssues(parsed.error)}` };
  }
  if (actionType === "gmail_reply" && !parsed.data.thread_id && !parsed.data.in_reply_to_message_id) {
    return {
      ok: false,
      error: "gmail_reply payload requires thread_id and/or in_reply_to_message_id. Use gmail_send for a fresh email.",
    };
  }
  return { ok: true, value: parsed.data };
}

export function textResult(text: string): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text }] };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}
