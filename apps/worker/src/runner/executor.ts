import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createSdkMcpServer,
  query,
  tool,
  type McpServerConfig as SdkMcpServerConfig,
  type Options as AgentSdkOptions,
  type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  DEFAULT_MODEL,
  PENDING_ACTION_TYPES,
  type Agent,
  type AgentKnowledgeRow,
  type McpServerConfig,
  type PendingActionRow,
  type PendingActionType,
  type Task,
  type TaskRun,
  type TaskStatus,
} from "@agent-fleet/shared";
import { logger, RunLogWriter } from "../lib/logger.js";
import type { Semaphore } from "../lib/semaphore.js";
import type { WorkspaceManager } from "../workspaces/manager.js";

const TOOL_RESULT_MAX_CHARS = 4_000;
const RESULT_SUMMARY_MAX_CHARS = 1_500;
const MAX_TURNS = 100;
const ASK_AGENT_POLL_MS = 3_000;
const ASK_AGENT_TIMEOUT_MS = 10 * 60_000;

/**
 * Usage totals extracted from the SDK result message, written to the
 * task_runs cost columns (migration 0004). Null when no result arrived.
 */
interface RunUsage {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cost_usd: number;
}

/** Sends a completion notice over Telegram to the project owner's linked chat. */
export type TelegramNotifier = (projectId: string, text: string) => Promise<void>;

/** Notifies the project owner (Telegram inline buttons) about a new pending action. */
export type PendingActionNotifier = (
  action: PendingActionRow,
  projectName: string,
  agentName: string,
) => Promise<void>;

/**
 * Executes a claimed task with the Claude Agent SDK, streaming every SDK
 * message into run_logs and recording the outcome on task_runs + tasks.
 * Never throws — every failure path ends with the task marked 'failed'.
 */
export class TaskExecutor {
  private telegramNotifier: TelegramNotifier | undefined;
  private pendingActionNotifier: PendingActionNotifier | undefined;

  constructor(
    private readonly supabase: SupabaseClient,
    private readonly workspaces: WorkspaceManager,
    private readonly workspacesRoot: string,
    /**
     * Concurrency pool shared with the TaskPoller. The ask_agent tool
     * releases this task's slot while waiting on a child task and re-acquires
     * it before resuming (see buildFleetServer).
     */
    private readonly slots: Semaphore,
  ) {}

  /** Hook registered by the Telegram bot (if configured). */
  setTelegramNotifier(notifier: TelegramNotifier): void {
    this.telegramNotifier = notifier;
  }

  /** Hook registered by the Telegram bot for pending-action approvals. */
  setPendingActionNotifier(notifier: PendingActionNotifier): void {
    this.pendingActionNotifier = notifier;
  }

  async executeTask(task: Task): Promise<void> {
    logger.info("executor", `executing task ${task.id}: "${task.title}"`);

    // 1. Load the agent.
    const agent = await this.loadAgent(task.agent_id);
    if (!agent) {
      await this.finishTask(task, null, "failed", `Task has no valid agent (agent_id: ${task.agent_id ?? "null"})`);
      return;
    }

    // Insert the task_runs row.
    const run = await this.insertRun(task, agent);
    if (!run) {
      await this.finishTask(task, agent, "failed", "Failed to create task_runs row");
      return;
    }
    const runLog = new RunLogWriter(this.supabase, run.id);

    // Per-run counter: >=1 proposed pending action ⇒ final status 'review'.
    const runState = { pendingActionsCreated: 0 };

    try {
      // 2. Resolve the working directory.
      const cwd = await this.resolveCwd(task, agent);

      // 3. Build MCP servers: the agent's own + the in-process 'fleet' server
      //    (propose_action / ask_agent), attached to every task run. A user
      //    server named 'fleet' would be shadowed.
      const mcpServers: Record<string, SdkMcpServerConfig> = {
        ...buildMcpServers(agent.mcp_servers ?? []),
        fleet: this.buildFleetServer(task, agent, runLog, runState),
      };

      // 4. Run the Claude Agent SDK.
      const knowledge = await this.loadKnowledge(agent.id);
      const systemPrompt = buildSystemPrompt(agent, task, knowledge);
      const prompt = task.description.trim().length > 0
        ? `${task.title}\n\n${task.description}`
        : task.title;

      const options: AgentSdkOptions = {
        systemPrompt,
        model: agent.model || DEFAULT_MODEL,
        cwd,
        mcpServers,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        settingSources: [],
        persistSession: false,
        maxTurns: MAX_TURNS,
        stderr: (data: string) => {
          const line = data.trim();
          if (line) logger.debug("agent-sdk", `[task ${task.id}] ${line.slice(0, 500)}`);
        },
      };

      await runLog.write("status", {
        status: "starting",
        agent_id: agent.id,
        agent_name: agent.name,
        model: options.model,
        cwd,
        mcp_servers: Object.keys(mcpServers),
      });

      // 5. Stream SDK messages into run_logs and capture the final result
      //    (plus token/cost usage from the result message, when one arrived).
      const { resultText, failure, usage } = await this.streamQuery(prompt, options, runLog);

      // 6. Record the outcome. A run that proposed pending actions lands in
      //    'review' (the user still has to approve/reject the sends).
      if (failure) {
        await this.markRun(run.id, "failed", failure, usage);
        await this.finishTask(task, agent, "failed", failure);
      } else {
        await this.markRun(run.id, "succeeded", null, usage);
        const finalStatus: TaskStatus = runState.pendingActionsCreated > 0 ? "review" : "done";
        await this.finishTask(task, agent, finalStatus, resultText ?? "");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("executor", `task ${task.id} crashed: ${message}`, err);
      await runLog.write("error", { message }, "error");
      await this.markRun(run.id, "failed", message, null);
      await this.finishTask(task, agent, "failed", message);
    }
  }

  /** Iterates the SDK message stream, persisting each event to run_logs. */
  private async streamQuery(
    prompt: string,
    options: AgentSdkOptions,
    runLog: RunLogWriter,
  ): Promise<{ resultText: string | null; failure: string | null; usage: RunUsage | null }> {
    let resultText: string | null = null;
    let failure: string | null = null;
    let sawResult = false;
    let usage: RunUsage | null = null;
    const toolNamesById = new Map<string, string>();

    for await (const message of query({ prompt, options })) {
      switch (message.type) {
        case "system": {
          if (message.subtype === "init") {
            await runLog.write("system", {
              subtype: "init",
              model: message.model,
              cwd: message.cwd,
              tools: message.tools,
              mcp_servers: message.mcp_servers,
              permission_mode: message.permissionMode,
            });
          }
          break;
        }
        case "assistant": {
          for (const block of message.message.content) {
            if (block.type === "text") {
              if (block.text.trim().length > 0) {
                await runLog.write("assistant_text", { text: block.text });
              }
            } else if (block.type === "tool_use") {
              toolNamesById.set(block.id, block.name);
              await runLog.write("tool_use", { tool: block.name, input: block.input });
            }
          }
          break;
        }
        case "user": {
          const content = message.message.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (
                block &&
                typeof block === "object" &&
                "type" in block &&
                block.type === "tool_result"
              ) {
                const output = stringifyToolResult(block.content).slice(0, TOOL_RESULT_MAX_CHARS);
                await runLog.write(
                  "tool_result",
                  {
                    tool: toolNamesById.get(block.tool_use_id) ?? "unknown",
                    output,
                    is_error: block.is_error === true,
                  },
                  block.is_error === true ? "warn" : "info",
                );
              }
            }
          }
          break;
        }
        case "result": {
          sawResult = true;
          // Both result subtypes carry usage/cost data — capture it either way.
          usage = extractRunUsage(message, options.model ?? DEFAULT_MODEL);
          if (message.subtype === "success") {
            resultText = message.result;
          } else {
            const errors = message.errors?.length ? message.errors.join("; ") : message.subtype;
            failure = `Agent run ended with ${message.subtype}: ${errors}`;
            await runLog.write("error", { subtype: message.subtype, errors: message.errors }, "error");
          }
          await runLog.write("status", {
            status: "finished",
            subtype: message.subtype,
            num_turns: message.num_turns,
            duration_ms: message.duration_ms,
            model: usage.model,
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
            cache_read_tokens: usage.cache_read_tokens,
            cache_creation_tokens: usage.cache_creation_tokens,
            total_cost_usd: usage.cost_usd,
          });
          break;
        }
        default:
          break;
      }
    }

    if (!sawResult && failure === null && resultText === null) {
      failure = "Agent SDK stream ended without a result message";
    }
    return { resultText, failure, usage };
  }

  /**
   * In-process MCP server ('fleet') attached to every task run:
   * - propose_action — queue an approval-gated outbound Slack/Gmail action.
   * - ask_agent — delegate a question to another agent as a child task and
   *   wait for its result.
   */
  private buildFleetServer(
    task: Task,
    agent: Agent,
    runLog: RunLogWriter,
    runState: { pendingActionsCreated: number },
  ) {
    const supabase = this.supabase;

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
            project_id: task.project_id,
            task_id: task.id,
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

        runState.pendingActionsCreated += 1;
        logger.info("executor", `task ${task.id}: pending action ${action.id} (${action.action_type}) proposed`);
        await runLog.write("status", {
          status: "pending_action_created",
          pending_action_id: action.id,
          action_type: action.action_type,
          preview: truncate(action.preview, 500),
        });

        if (this.pendingActionNotifier) {
          try {
            const projectName = await this.loadProjectName(task.project_id);
            await this.pendingActionNotifier(action, projectName, agent.name);
          } catch (err) {
            logger.error("executor", `telegram notification for pending action ${action.id} failed`, err);
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
        "self-contained — the other agent sees nothing else from this task.",
      {
        agent_name: z.string().min(1).describe("Name of the target agent (case-insensitive)"),
        request: z.string().min(1).describe("The full, self-contained request for the other agent"),
      },
      async (args) => {
        // Depth cap: tasks created by ask_agent cannot ask further agents.
        if (task.source === "agent") {
          return textResult(
            "Error: ask_agent is not available in this task — it was itself created via ask_agent " +
              "(maximum delegation depth is 1). Answer with what you have.",
          );
        }

        const target = await this.findAgentByName(task.project_id, args.agent_name);
        if (!target) {
          return textResult(`Error: no active agent named "${args.agent_name}" found in this project.`);
        }
        if (target.id === agent.id) {
          return textResult("Error: an agent cannot ask itself. Pick a different agent or proceed on your own.");
        }

        const { data, error } = await supabase
          .from("tasks")
          .insert({
            project_id: task.project_id,
            agent_id: target.id,
            source: "agent",
            parent_task_id: task.id,
            title: `Question from ${agent.name}: ${args.request.slice(0, 80)}`,
            description: args.request,
            status: "queued",
          })
          .select("id")
          .single();
        if (error) return textResult(`Error creating the child task: ${error.message}`);
        const childId = (data as { id: string }).id;

        logger.info("executor", `task ${task.id}: ask_agent created child task ${childId} for agent ${target.name}`);
        await runLog.write("status", {
          status: "ask_agent_started",
          child_task_id: childId,
          target_agent_id: target.id,
          target_agent_name: target.name,
        });

        // CRITICAL: release this task's concurrency slot while waiting so the
        // child task (and other work) can claim it — with a bounded pool, two
        // parents waiting on children would otherwise deadlock. The slot is
        // re-acquired before this tool returns and the parent run resumes.
        this.slots.release();
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
              logger.warn("executor", `ask_agent poll for child task ${childId} failed: ${pollError.message}`);
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
          await this.slots.acquire();
        }

        await runLog.write("status", {
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

    return createSdkMcpServer({
      name: "fleet",
      version: "1.0.0",
      tools: [proposeAction, askAgent],
    });
  }

  /** Case-insensitive exact-name lookup of an active agent in a project. */
  private async findAgentByName(projectId: string, name: string): Promise<Agent | null> {
    try {
      const { data, error } = await this.supabase
        .from("agents")
        .select("*")
        .eq("project_id", projectId)
        .eq("is_active", true);
      if (error) {
        logger.error("executor", `failed to list agents for project ${projectId}: ${error.message}`);
        return null;
      }
      const needle = name.trim().toLowerCase();
      return ((data ?? []) as Agent[]).find((a) => a.name.trim().toLowerCase() === needle) ?? null;
    } catch (err) {
      logger.error("executor", `failed to list agents for project ${projectId}`, err);
      return null;
    }
  }

  private async loadProjectName(projectId: string): Promise<string> {
    try {
      const { data, error } = await this.supabase
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

  /** Loads the agent's knowledge/voice docs for system-prompt injection. */
  private async loadKnowledge(agentId: string): Promise<AgentKnowledgeRow[]> {
    try {
      const { data, error } = await this.supabase
        .from("agent_knowledge")
        .select("*")
        .eq("agent_id", agentId)
        .order("created_at", { ascending: true });
      if (error) {
        logger.error("executor", `failed to load knowledge for agent ${agentId}: ${error.message}`);
        return [];
      }
      return (data ?? []) as AgentKnowledgeRow[];
    } catch (err) {
      logger.error("executor", `failed to load knowledge for agent ${agentId}`, err);
      return [];
    }
  }

  /** Workspace dir when the agent has one; otherwise an isolated scratch dir. */
  private async resolveCwd(task: Task, agent: Agent): Promise<string> {
    if (agent.workspace_id) {
      const dir = await this.workspaces.ensureWorkspace({ id: agent.workspace_id });
      await this.workspaces.syncRepos(agent.workspace_id);
      return dir;
    }
    const scratch = path.join(this.workspacesRoot, "_scratch", task.id);
    await mkdir(scratch, { recursive: true });
    return scratch;
  }

  private async loadAgent(agentId: string | null): Promise<Agent | null> {
    if (!agentId) return null;
    try {
      const { data, error } = await this.supabase
        .from("agents")
        .select("*")
        .eq("id", agentId)
        .maybeSingle();
      if (error) {
        logger.error("executor", `failed to load agent ${agentId}: ${error.message}`);
        return null;
      }
      return (data as Agent | null) ?? null;
    } catch (err) {
      logger.error("executor", `failed to load agent ${agentId}`, err);
      return null;
    }
  }

  private async insertRun(task: Task, agent: Agent): Promise<TaskRun | null> {
    try {
      const { data, error } = await this.supabase
        .from("task_runs")
        .insert({ task_id: task.id, agent_id: agent.id, status: "running" })
        .select("*")
        .single();
      if (error) {
        logger.error("executor", `failed to insert task_run for task ${task.id}: ${error.message}`);
        return null;
      }
      return data as TaskRun;
    } catch (err) {
      logger.error("executor", `failed to insert task_run for task ${task.id}`, err);
      return null;
    }
  }

  private async markRun(
    runId: string,
    status: "succeeded" | "failed",
    errorText: string | null,
    usage: RunUsage | null,
  ): Promise<void> {
    try {
      const { error } = await this.supabase
        .from("task_runs")
        .update({
          status,
          error: errorText ? errorText.slice(0, 4000) : null,
          finished_at: new Date().toISOString(),
          // Cost columns stay null when the run crashed before a result message.
          ...(usage
            ? {
                model: usage.model,
                input_tokens: usage.input_tokens,
                output_tokens: usage.output_tokens,
                cache_read_tokens: usage.cache_read_tokens,
                cache_creation_tokens: usage.cache_creation_tokens,
                cost_usd: usage.cost_usd,
              }
            : {}),
        })
        .eq("id", runId);
      if (error) logger.error("executor", `failed to mark run ${runId} ${status}: ${error.message}`);
    } catch (err) {
      logger.error("executor", `failed to mark run ${runId} ${status}`, err);
    }
  }

  /** Final task update + completion notification. */
  private async finishTask(
    task: Task,
    agent: Agent | null,
    finalStatus: Extract<TaskStatus, "done" | "failed" | "review">,
    resultText: string,
  ): Promise<void> {
    try {
      const { error } = await this.supabase
        .from("tasks")
        .update({
          status: finalStatus,
          result: resultText || null,
          finished_at: new Date().toISOString(),
        })
        .eq("id", task.id);
      if (error) logger.error("executor", `failed to update task ${task.id}: ${error.message}`);
    } catch (err) {
      logger.error("executor", `failed to update task ${task.id}`, err);
    }

    logger.info("executor", `task ${task.id} ${finalStatus}`);
    await this.notifyCompletion(task, agent, finalStatus, resultText);
  }

  /**
   * Notifies the project chat when a manager-driven task finishes, so the web
   * chat (via Realtime on messages) and Telegram both learn of completion.
   */
  private async notifyCompletion(
    task: Task,
    agent: Agent | null,
    finalStatus: Extract<TaskStatus, "done" | "failed" | "review">,
    resultText: string,
  ): Promise<void> {
    const managerDriven = task.source === "manager" || task.parent_task_id !== null;
    if (!managerDriven) return;

    const agentName = agent?.name ?? "unknown agent";
    const summary =
      finalStatus === "failed"
        ? `Task "${task.title}" (${agentName}) failed: ${truncate(resultText, RESULT_SUMMARY_MAX_CHARS)}`
        : finalStatus === "review"
          ? `Task "${task.title}" (${agentName}) completed with proposed actions awaiting your approval.\n\n${truncate(resultText, RESULT_SUMMARY_MAX_CHARS)}`
          : `Task "${task.title}" (${agentName}) completed.\n\n${truncate(resultText, RESULT_SUMMARY_MAX_CHARS)}`;

    try {
      const channel = task.source === "telegram" ? "telegram" : "web";
      const { error } = await this.supabase.from("messages").insert({
        project_id: task.project_id,
        task_id: task.id,
        sender: "manager",
        channel,
        content: summary,
      });
      if (error) logger.error("executor", `failed to insert completion message for task ${task.id}: ${error.message}`);
    } catch (err) {
      logger.error("executor", `failed to insert completion message for task ${task.id}`, err);
    }

    if (this.telegramNotifier) {
      try {
        await this.telegramNotifier(task.project_id, summary);
      } catch (err) {
        logger.error("executor", `telegram completion notification failed for task ${task.id}`, err);
      }
    }
  }
}

/**
 * Standard preamble + the agent's own instructions + injected knowledge and
 * voice-profile docs.
 */
function buildSystemPrompt(agent: Agent, task: Task, knowledge: AgentKnowledgeRow[]): string {
  const preamble =
    `You are the agent "${agent.name}" working on the task "${task.title}" in Agent Fleet, ` +
    `an autonomous multi-agent platform. Work autonomously — nobody can answer questions ` +
    `mid-task. When you are done, report a clear final summary of what you did and the outcome. ` +
    `Never send Slack messages or emails yourself: propose them with the fleet propose_action ` +
    `tool — they are only sent after the user approves them.`;
  const instructions = agent.instructions?.trim();
  let prompt = instructions ? `${preamble}\n\n${instructions}` : preamble;

  const knowledgeDocs = knowledge.filter((doc) => doc.kind === "knowledge");
  const voiceDocs = knowledge.filter((doc) => doc.kind === "voice");
  if (knowledgeDocs.length > 0) {
    prompt += `\n\n# Knowledge\n${knowledgeDocs.map(formatKnowledgeDoc).join("\n\n")}`;
  }
  if (voiceDocs.length > 0) {
    prompt +=
      `\n\n# Voice profiles\n` +
      `When drafting messages on the user's behalf, choose the profile that matches the ` +
      `recipient/context described in each profile.\n` +
      voiceDocs.map(formatKnowledgeDoc).join("\n\n");
  }
  return prompt;
}

function formatKnowledgeDoc(doc: AgentKnowledgeRow): string {
  return `## ${doc.title}\n${doc.content}`;
}

/**
 * Extracts usage totals from an SDK result message (either subtype).
 * Prefers `modelUsage` (covers subagents/sidechains/internal calls; the
 * SDK documents it as the correct field for accounting) — summed across
 * models, with `model` set to the costliest entry's key. Falls back to the
 * main-loop `usage` + `total_cost_usd` when `modelUsage` is empty.
 */
function extractRunUsage(message: SDKResultMessage, fallbackModel: string): RunUsage {
  const entries = Object.entries(message.modelUsage ?? {});
  if (entries.length > 0) {
    const totals: RunUsage = {
      model: fallbackModel,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      cost_usd: 0,
    };
    let topCost = -1;
    for (const [model, modelUsage] of entries) {
      totals.input_tokens += modelUsage.inputTokens ?? 0;
      totals.output_tokens += modelUsage.outputTokens ?? 0;
      totals.cache_read_tokens += modelUsage.cacheReadInputTokens ?? 0;
      totals.cache_creation_tokens += modelUsage.cacheCreationInputTokens ?? 0;
      totals.cost_usd += modelUsage.costUSD ?? 0;
      if ((modelUsage.costUSD ?? 0) > topCost) {
        topCost = modelUsage.costUSD ?? 0;
        totals.model = model;
      }
    }
    totals.cost_usd = roundCost(totals.cost_usd);
    return totals;
  }

  const usage = message.usage;
  return {
    model: fallbackModel,
    input_tokens: usage?.input_tokens ?? 0,
    output_tokens: usage?.output_tokens ?? 0,
    cache_read_tokens: usage?.cache_read_input_tokens ?? 0,
    cache_creation_tokens: usage?.cache_creation_input_tokens ?? 0,
    cost_usd: roundCost(message.total_cost_usd ?? 0),
  };
}

/** Round to the cost_usd column's numeric(12,6) precision. */
function roundCost(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

// ------------------------------------------------------- fleet tool helpers

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

function textResult(text: string): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text }] };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
        logger.warn("executor", `mcp server "${config.name}" is stdio but has no command — skipped`);
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
        logger.warn("executor", `mcp server "${config.name}" is ${config.type} but has no url — skipped`);
        continue;
      }
      servers[config.name] = { type: config.type, url: config.url };
    } else {
      logger.warn("executor", `mcp server "${config.name}" has unknown type — skipped`);
    }
  }
  return servers;
}

function stringifyToolResult(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (part && typeof part === "object" && "text" in part && typeof (part as { text: unknown }).text === "string") {
          return (part as { text: string }).text;
        }
        return safeJson(part);
      })
      .join("\n");
  }
  return safeJson(content);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}
