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
/**
 * How long ask_agent blocks on its child before giving up. Override with
 * ASK_AGENT_TIMEOUT_MINUTES. Raising it is a workaround, not a fix: ask_agent
 * calls run one at a time within a session, so a fan-out of N questions costs
 * N timeouts in sequence. Use spawn_tasks for fan-out.
 */
const ASK_AGENT_TIMEOUT_MS = parsePositiveInt(process.env.ASK_AGENT_TIMEOUT_MINUTES, 10) * 60_000;
/** Ceiling on one spawn_tasks call, so a confused agent cannot flood the queue. */
const MAX_SPAWNED_TASKS = 20;

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
const ACTIVITY_MAX_ROWS = 100;
const ACTIVITY_MESSAGE_MAX_CHARS = 500;
const ACTIVITY_RESULT_MAX_CHARS = 800;
const ACTIVITY_DEFAULT_LOOKBACK_MS = 72 * 60 * 60 * 1000;

/**
 * Size ceiling for one knowledge doc. Under manifest injection a doc is no
 * longer charged to every run, but it is still read whole whenever an agent
 * needs any part of it — so a sprawling doc makes every lookup expensive and
 * buries the fact that was wanted. Hitting this ceiling is the signal to
 * consolidate, which is already part of the librarian's job.
 */
const KNOWLEDGE_DOC_MAX_CHARS = 12_000;

/** search_knowledge: documents returned when the caller does not ask for a limit. */
const SEARCH_DEFAULT_LIMIT = 8;
/** search_knowledge: characters of context returned around each match. */
const SEARCH_SNIPPET_CHARS = 300;
/** read_knowledge: ceiling on one returned document (docs are capped well below this). */
const KNOWLEDGE_READ_MAX_CHARS = 20_000;
/** Manifest: characters of the one-line preview shown per document. */
const KNOWLEDGE_PREVIEW_CHARS = 110;
/**
 * Below this much factual content in total, inline everything instead of
 * listing it. The manifest costs ~600 characters of headers and previews, and
 * a lookup costs a whole extra turn (the conversation is re-sent) — neither
 * pays for itself against a knowledge base this small.
 */
const KNOWLEDGE_MANIFEST_MIN_CHARS = 2_000;

/**
 * Preamble rule for every agent: the system prompt carries only part of the
 * project's knowledge, so the rest has to be looked up rather than assumed.
 */
export const KNOWLEDGE_SEARCH_RULE =
  "Only part of this project's knowledge is in your prompt. When you need a fact you do not have — " +
  "who someone is, a decision that was made, a convention, how the team works — look it up with the " +
  "search_knowledge tool (and read_knowledge for the full document) before guessing or reporting that " +
  "you do not know.";

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
 * - ask_agent — delegate a question to another agent as a child task, and
 *   block until it answers.
 * - spawn_tasks — fan work out to another agent WITHOUT blocking; the worker
 *   re-runs this agent with the collected results once they all finish.
 * - notify_user — direct (non-gated) notification to the project owner.
 * - reply_to_user — chat sessions only (ctx.reply set).
 * - save_knowledge / read_project_activity — librarian agents only.
 */
export function buildFleetServer(ctx: FleetSessionContext): SdkMcpServerConfig {
  const { supabase, agent, projectId } = ctx;

  /**
   * True while this session has handed its concurrency slot back for the
   * duration of a wait. Session-scoped so two waiters can never release the
   * same permit twice — see the comment at the release site in ask_agent.
   */
  let slotReleased = false;

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
      //
      // `slotReleased` guards against releasing one permit twice. The SDK
      // executes in-process MCP tool calls strictly one at a time (verified
      // against 0.3.228: three tool_use blocks in a single assistant message
      // still ran sequentially), so two waits cannot overlap today — but a
      // future SDK that parallelizes them would otherwise inflate the pool
      // permanently, and a leaked permit is silent.
      const releasedHere = ctx.slots !== null && !slotReleased;
      if (releasedHere) {
        slotReleased = true;
        ctx.slots!.release();
      }
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
        if (releasedHere) {
          await ctx.slots!.acquire();
          slotReleased = false;
        }
      }

      await ctx.runLog?.write("status", {
        status: "ask_agent_finished",
        child_task_id: childId,
        child_status: outcome?.status ?? "timeout",
      });

      if (!outcome) {
        return textResult(
          `Error: agent "${target.name}" did not finish within ${Math.round(ASK_AGENT_TIMEOUT_MS / 60_000)} minutes. ` +
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

  const spawnTasks = tool(
    "spawn_tasks",
    "Fan work out to another agent as independent background tasks. Unlike ask_agent this does NOT wait: " +
      "each request becomes its own queued task with its own fresh context, and they run in parallel. " +
      "When the last one finishes you are automatically re-run with all of their results collected, so " +
      "after calling this you should FINISH YOUR TURN — do not poll, do not guess at their answers, and " +
      "do not call spawn_tasks again in the same run. Use this whenever you have several similar units of " +
      "work (one pull request each, one repository each); use ask_agent only for a single question whose " +
      "answer you need before you can continue.",
    {
      agent_name: z.string().min(1).describe("Name of the agent to run these tasks (case-insensitive)"),
      requests: z
        .array(
          z.object({
            title: z.string().min(1).max(300).describe("Short task title, e.g. 'Review PR #412'"),
            request: z
              .string()
              .min(1)
              .describe("The full, self-contained instruction — the other agent sees nothing else"),
          }),
        )
        .min(1)
        .max(MAX_SPAWNED_TASKS)
        .describe("One entry per unit of work"),
    },
    async (args) => {
      if (!ctx.task) {
        return textResult(
          "Error: spawn_tasks is only available in task runs (a chat turn has no parent task to " +
            "collect the results into). Use ask_agent instead.",
        );
      }
      // Same one-hop rule as ask_agent, plus the aggregation task itself: a
      // 'fanin' run spawning a fresh batch under the SAME parent would queue
      // another aggregation and never converge.
      if (ctx.task.source === "agent" || ctx.task.source === "fanout" || ctx.task.source === "fanin") {
        return textResult(
          "Error: spawn_tasks is not available in this task — it was itself created by another agent " +
            "(maximum delegation depth is 1). Do this work yourself, or report what you have.",
        );
      }

      const target = await findAgentByName(supabase, projectId, args.agent_name);
      if (!target) {
        return textResult(`Error: no active agent named "${args.agent_name}" found in this project.`);
      }

      const rows = args.requests.map((entry) => ({
        project_id: projectId,
        agent_id: target.id,
        source: "fanout" as const,
        parent_task_id: ctx.task!.id,
        title: entry.title,
        description: entry.request,
        status: "queued" as const,
        // Fanned-out work inherits the caller's urgency: it IS the caller's
        // work, just executed elsewhere.
        priority: ctx.task!.priority,
      }));

      const { data, error } = await supabase.from("tasks").insert(rows).select("id");
      if (error) return textResult(`Error creating the tasks: ${error.message}`);
      const ids = ((data ?? []) as Array<{ id: string }>).map((row) => row.id);

      logger.info(
        "fleet",
        `agent ${agent.name}: spawn_tasks created ${ids.length} task(s) for agent ${target.name}`,
      );
      await ctx.runLog?.write("status", {
        status: "tasks_spawned",
        child_task_ids: ids,
        target_agent_id: target.id,
        target_agent_name: target.name,
      });

      return textResult(
        `Queued ${ids.length} task(s) for ${target.name}: ${ids.join(", ")}.\n\n` +
          `They are running in the background. Finish your turn now — when the last one completes you ` +
          `will be started again with all of their results, and that is when you write the final answer.`,
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
      // Task runs only: a chat turn has no parent task to aggregate into, and
      // the tool refuses there anyway — no reason to advertise it.
      ...(ctx.task ? [spawnTasks] : []),
      notifyUser,
      buildSearchKnowledgeTool(ctx),
      buildReadKnowledgeTool(ctx),
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
      "Matching for replace/append is by exact title (case-insensitive) within the scope target. " +
      `A single doc may not exceed ${KNOWLEDGE_DOC_MAX_CHARS} characters — consolidate rather than growing past it.`,
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
        if (args.content.length > KNOWLEDGE_DOC_MAX_CHARS) {
          return textResult(docTooLargeMessage(args.title, args.content.length));
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
      if (newContent.length > KNOWLEDGE_DOC_MAX_CHARS) {
        return textResult(docTooLargeMessage(existing.title, newContent.length));
      }

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

/** Rejection text for a write over KNOWLEDGE_DOC_MAX_CHARS — it tells the librarian what to do instead. */
function docTooLargeMessage(title: string, length: number): string {
  return (
    `Error: "${title}" would be ${length} characters, over the ${KNOWLEDGE_DOC_MAX_CHARS}-character ceiling ` +
    `for one doc. Nothing was written. An agent reads this doc whole whenever it needs any part of it, so ` +
    `it has to stay tight: consolidate it instead — drop superseded facts, merge duplicates, retire stale ` +
    `entries — and re-send the shorter revised doc with mode 'replace'.`
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

// ----------------------------------------------------- knowledge search (all)

/**
 * The rows one agent may search: the project's shared docs plus its own.
 * Librarians curate everything, so they also see the other agents' docs —
 * mirroring the write side, where only they get save_knowledge.
 *
 * Returned as a PostgREST `or()` string. Every interpolated value is a uuid,
 * so nothing here can break the filter syntax.
 */
async function knowledgeScopeFilter(ctx: FleetSessionContext): Promise<string> {
  const { supabase, agent, projectId } = ctx;
  if (agent.role !== "librarian") {
    return `project_id.eq.${projectId},agent_id.eq.${agent.id}`;
  }
  const agents = await listActiveAgents(supabase, projectId);
  const ids = agents.map((a) => a.id);
  return ids.length > 0
    ? `project_id.eq.${projectId},agent_id.in.(${ids.join(",")})`
    : `project_id.eq.${projectId}`;
}

function buildSearchKnowledgeTool(ctx: FleetSessionContext) {
  const { supabase, agent } = ctx;

  return tool(
    "search_knowledge",
    "Search this project's knowledge base — the team, decisions, conventions, current focus, and any " +
      "docs scoped to you. Your system prompt carries only part of it, so use this whenever you need a " +
      "fact you do not already have. Returns matching document titles with a snippet around the match; " +
      "call read_knowledge for a full document.",
    {
      query: z.string().min(1).describe("Words to look for, e.g. 'deploy window' or 'who reviews PRs'"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe(`Maximum documents to return (default ${SEARCH_DEFAULT_LIMIT})`),
    },
    async (args) => {
      const limit = args.limit ?? SEARCH_DEFAULT_LIMIT;
      const scope = await knowledgeScopeFilter(ctx);

      const ftsRes = await supabase
        .from("agent_knowledge")
        .select("*")
        .or(scope)
        .textSearch("search_vector", args.query, { type: "websearch", config: "simple" })
        .limit(limit);

      let docs: AgentKnowledgeRow[] = [];
      if (ftsRes.error) {
        // Most likely search_vector is missing because migration 0007 has not
        // been applied yet. Not fatal — the substring pass below still answers.
        logger.warn("fleet", `full-text knowledge search unavailable: ${ftsRes.error.message}`);
      } else {
        docs = (ftsRes.data ?? []) as AgentKnowledgeRow[];
      }

      // The index is unstemmed (config 'simple', so docs can be in any
      // language), so "deploys" does not match "deploy". Fall back to
      // substring matching over the documents this agent can see — there are
      // few enough of them that filtering here is cheaper than a second
      // stacked filter, and it covers partial words the tsquery misses.
      if (docs.length === 0) {
        const { data, error } = await supabase.from("agent_knowledge").select("*").or(scope);
        if (error) return textResult(`Error searching knowledge: ${error.message}`);
        const terms = args.query
          .toLowerCase()
          .split(/\s+/)
          .filter((t) => t.length >= 3);
        const visible = (data ?? []) as AgentKnowledgeRow[];
        docs = visible
          .filter((doc) => {
            const haystack = `${doc.title}\n${doc.content}`.toLowerCase();
            return terms.length > 0
              ? terms.some((t) => haystack.includes(t))
              : haystack.includes(args.query.trim().toLowerCase());
          })
          .slice(0, limit);
      }

      if (docs.length === 0) {
        return textResult(
          `No knowledge document matches "${args.query}". Try fewer or different words. If the fact ` +
            `genuinely is not recorded, say so rather than inventing it.`,
        );
      }

      const matches = docs.map((doc) => ({
        title: doc.title,
        scope: doc.project_id ? "project" : "agent",
        kind: doc.kind,
        chars: doc.content.length,
        snippet: snippetAround(doc.content, args.query),
      }));
      logger.debug("fleet", `agent ${agent.name}: search_knowledge "${args.query}" → ${docs.length} doc(s)`);
      return textResult(JSON.stringify({ query: args.query, matches }));
    },
  );
}

function buildReadKnowledgeTool(ctx: FleetSessionContext) {
  const { supabase } = ctx;

  return tool(
    "read_knowledge",
    "Read one knowledge document in full, by title (case-insensitive; a unique partial title also " +
      "works). Use it after search_knowledge when a snippet is not enough.",
    {
      title: z.string().min(1).describe("Document title, as returned by search_knowledge"),
    },
    async (args) => {
      const scope = await knowledgeScopeFilter(ctx);
      const { data, error } = await supabase.from("agent_knowledge").select("*").or(scope);
      if (error) return textResult(`Error loading knowledge: ${error.message}`);
      const docs = (data ?? []) as AgentKnowledgeRow[];

      const needle = args.title.trim().toLowerCase();
      const doc =
        docs.find((d) => d.title.trim().toLowerCase() === needle) ??
        docs.find((d) => d.title.toLowerCase().includes(needle)) ??
        null;
      if (!doc) {
        const titles = docs.map((d) => `"${d.title}"`).join(", ") || "(none)";
        return textResult(
          `Error: no knowledge document titled "${args.title}" is visible to you. Available: ${titles}`,
        );
      }

      const scopeLabel = doc.project_id ? "project scope" : "agent scope";
      return textResult(
        `# ${doc.title}\n(${scopeLabel}, kind '${doc.kind}', updated ${doc.updated_at})\n\n` +
          truncate(doc.content, KNOWLEDGE_READ_MAX_CHARS),
      );
    },
  );
}

/** Content around the first matching term, so a hit does not cost the whole document. */
function snippetAround(content: string, query: string): string {
  const haystack = content.toLowerCase();
  let at = -1;
  for (const term of query.toLowerCase().split(/\s+/)) {
    if (term.length < 3) continue;
    const found = haystack.indexOf(term);
    if (found >= 0 && (at < 0 || found < at)) at = found;
  }
  if (at < 0) return truncate(content, SEARCH_SNIPPET_CHARS);

  const start = Math.max(0, at - Math.floor(SEARCH_SNIPPET_CHARS / 2));
  const end = Math.min(content.length, start + SEARCH_SNIPPET_CHARS);
  const lead = start > 0 ? "…" : "";
  const tail = end < content.length ? "…" : "";
  return `${lead}${content.slice(start, end).trim()}${tail}`;
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
  const all = [...bundle.projectDocs, ...bundle.agentDocs];
  const voiceDocs = all.filter((doc) => doc.kind === "voice");
  const factualDocs = all.filter((doc) => doc.kind !== "voice");
  const parts: string[] = [];

  if (factualDocs.length > 0) {
    const totalChars = factualDocs.reduce((sum, doc) => sum + doc.content.length, 0);
    const inline =
      knowledgeInjectionMode() === "full" || totalChars < KNOWLEDGE_MANIFEST_MIN_CHARS;
    parts.push(
      inline
        ? `# Project knowledge\n${factualDocs.map(formatKnowledgeDoc).join("\n\n")}`
        : knowledgeManifest(factualDocs),
    );
  }

  // Voice profiles stay inlined in both modes: they shape *how* the agent
  // writes, and an agent mid-draft has no reason to suspect it should go
  // looking for one. Facts are different — those it knows it lacks.
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

/**
 * How factual docs reach the prompt. 'manifest' (default) lists them and lets
 * the agent fetch what it needs; 'full' inlines every document, the behavior
 * before 0007 — kept as an escape hatch and an A/B baseline (compare
 * task_runs.cost_usd between the two).
 *
 * Read at call time, not at module load: dotenv runs in index.ts, whose body
 * executes after this module has already been evaluated.
 */
function knowledgeInjectionMode(): "manifest" | "full" {
  return (process.env.KNOWLEDGE_INJECTION ?? "").trim().toLowerCase() === "full" ? "full" : "manifest";
}

/**
 * Titles, sizes and one-line previews instead of content — the whole point of
 * the manifest is that the fleet stops paying for every document on every run.
 * Previews exist so the agent can tell which document is worth a read; they
 * are explicitly not an answer.
 */
function knowledgeManifest(docs: AgentKnowledgeRow[]): string {
  const lines = docs.map((doc) => {
    const scope = doc.project_id ? "project" : "yours";
    return `- "${doc.title}" (${scope}, ${formatDocSize(doc.content.length)}) — ${previewLine(doc.content)}`;
  });
  return [
    `# Project knowledge — ${docs.length} document${docs.length === 1 ? "" : "s"}, listed but not included`,
    `Read one in full with read_knowledge("<title>"), or search across all of them with ` +
      `search_knowledge. The previews below are one line each and are never enough to answer from — ` +
      `read the document.`,
    ...lines,
  ].join("\n");
}

function formatDocSize(chars: number): string {
  return chars >= 1000 ? `${(chars / 1000).toFixed(1)}k chars` : `${chars} chars`;
}

/** First line of real content — skipping markdown headings, which just repeat the title. */
function previewLine(content: string): string {
  const lines = content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const body = lines.filter((line) => !/^#{1,6}\s/.test(line));
  const first = (body[0] ?? lines[0] ?? "(empty)").replace(/^[-*]\s+/, "");
  return truncate(first.replace(/\s+/g, " "), KNOWLEDGE_PREVIEW_CHARS);
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
 * stdio → {command, args, env}; http/sse → {type, url, headers}. The headers
 * are what authenticate remote endpoints (e.g. "Authorization: Bearer <pat>"
 * for GitHub's hosted MCP server — see docs/GITHUB-AGENT.md).
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
      servers[config.name] = {
        type: config.type,
        url: config.url,
        ...(config.headers && Object.keys(config.headers).length > 0
          ? { headers: config.headers }
          : {}),
      };
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
