import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  query,
  type McpServerConfig as SdkMcpServerConfig,
  type Options as AgentSdkOptions,
  type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  DEFAULT_MODEL,
  type Agent,
  type Task,
  type TaskRun,
  type TaskStatus,
} from "@agent-fleet/shared";
import { logger, RunLogWriter } from "../lib/logger.js";
import type { Semaphore } from "../lib/semaphore.js";
import type { WorkspaceManager } from "../workspaces/manager.js";
import {
  buildFleetServer,
  buildMcpServers,
  findLibrarian,
  KNOWLEDGE_SEARCH_RULE,
  knowledgeSections,
  librarianForwardingRule,
  loadKnowledgeBundle,
  truncate,
  type KnowledgeBundle,
  type PendingActionNotifier,
  type TelegramNotifier,
} from "./session.js";

export type { PendingActionNotifier, TelegramNotifier } from "./session.js";

const TOOL_RESULT_MAX_CHARS = 4_000;
const RESULT_SUMMARY_MAX_CHARS = 1_500;
const MAX_TURNS = 100;

/** Task fields for a triggered sweep — see "Post-run knowledge sweeps" in ARCHITECTURE.md. */
const SWEEP_TASK_TITLE = "Knowledge sweep";
const SWEEP_TASK_DESCRIPTION =
  "Run your sweep: call read_project_activity, extract durable facts with provenance, merge them " +
  "into the canonical docs, and do your consolidation pass. Report facts recorded / consolidated / " +
  "ignored, per your instructions.";
/** Sweeps yield to real work — claim_next_task orders by priority desc. */
const SWEEP_PRIORITY = -10;

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
     * it before resuming (see buildFleetServer in session.ts).
     */
    private readonly slots: Semaphore,
    /**
     * Whether a finished run enqueues a knowledge sweep
     * (KNOWLEDGE_SWEEP_AFTER_RUNS). When false, the librarian only sweeps on
     * its schedule — the pre-0006 behavior.
     */
    private readonly sweepAfterRuns: boolean = true,
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
      //    (propose_action / ask_agent / notify_user, librarian tools for
      //    librarian agents), attached to every task run. A user server named
      //    'fleet' would be shadowed.
      const mcpServers: Record<string, SdkMcpServerConfig> = {
        ...buildMcpServers(agent.mcp_servers ?? []),
        fleet: buildFleetServer({
          supabase: this.supabase,
          agent,
          projectId: task.project_id,
          task,
          runId: run.id,
          runLog,
          slots: this.slots,
          runState,
          telegramNotifier: this.telegramNotifier,
          pendingActionNotifier: this.pendingActionNotifier,
        }),
      };

      // 4. Run the Claude Agent SDK.
      const knowledge = await loadKnowledgeBundle(this.supabase, agent);
      const librarian = agent.role === "librarian" ? null : await findLibrarian(this.supabase, task.project_id);
      const systemPrompt = buildSystemPrompt(agent, task, knowledge, librarianForwardingRule(agent, librarian));
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
        // A successful librarian TASK run advances the activity cursor to the
        // run's start time (its read_project_activity high-water mark). Chat
        // sessions never advance it.
        if (agent.role === "librarian") {
          await this.advanceActivityCursor(agent, run.started_at);
          await this.chainSweepIfUnswept(task, agent, run.started_at);
        } else {
          await this.triggerKnowledgeSweep(task, agent);
        }
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

  /** Librarian high-water mark: activity_cursor = the successful run's start time. */
  private async advanceActivityCursor(agent: Agent, runStartedAt: string): Promise<void> {
    try {
      const { error } = await this.supabase
        .from("agents")
        .update({ activity_cursor: runStartedAt })
        .eq("id", agent.id);
      if (error) {
        logger.error("executor", `failed to advance activity_cursor for librarian ${agent.id}: ${error.message}`);
        return;
      }
      logger.info("executor", `librarian ${agent.name}: activity_cursor advanced to ${runStartedAt}`);
    } catch (err) {
      logger.error("executor", `failed to advance activity_cursor for librarian ${agent.id}`, err);
    }
  }

  // ------------------------------------------------ post-run knowledge sweeps

  /**
   * Enqueues a knowledge sweep after a successful NON-librarian run, so facts
   * from the run reach the docs in minutes instead of waiting for the daily
   * schedule. Coalesced by enqueueSweep — a burst of runs produces one sweep,
   * not one per run. Never called for librarian runs (that would loop); their
   * continuation path is chainSweepIfUnswept.
   *
   * Failures are logged, never thrown: a sweep that cannot be queued must not
   * affect the task that just succeeded.
   */
  private async triggerKnowledgeSweep(task: Task, agent: Agent): Promise<void> {
    if (!this.sweepAfterRuns) return;
    try {
      const librarian = await findLibrarian(this.supabase, task.project_id);
      if (!librarian) return; // project has no librarian — nothing curates knowledge
      await this.enqueueSweep(task.project_id, librarian, `"${task.title}" finished (${agent.name})`);
    } catch (err) {
      logger.error("executor", `failed to trigger a knowledge sweep for project ${task.project_id}`, err);
    }
  }

  /**
   * Follow-up sweep after a librarian run. Two facts make this the right place
   * for it: the cursor now sits at this run's start time, so anything that
   * finished *during* the run is unswept; and triggers that fired while it ran
   * deliberately did not enqueue (that is what keeps sweeps from overlapping
   * and racing on the same docs). So the run that just finished is responsible
   * for queueing the next one when it left work behind.
   *
   * Excludes the librarian's own tasks, so a sweep can never re-trigger itself.
   */
  private async chainSweepIfUnswept(task: Task, librarian: Agent, runStartedAt: string): Promise<void> {
    if (!this.sweepAfterRuns) return;
    try {
      const { data, error } = await this.supabase
        .from("tasks")
        .select("id")
        .eq("project_id", task.project_id)
        .in("status", ["done", "review"])
        .neq("agent_id", librarian.id)
        .gt("finished_at", runStartedAt)
        .limit(1);
      if (error) {
        logger.error(
          "executor",
          `failed to check for unswept activity in project ${task.project_id}: ${error.message}`,
        );
        return;
      }
      if ((data ?? []).length === 0) return;
      await this.enqueueSweep(task.project_id, librarian, "activity finished while the previous sweep ran");
    } catch (err) {
      logger.error("executor", `failed to chain a knowledge sweep for project ${task.project_id}`, err);
    }
  }

  /**
   * Inserts one sweep task for the project's librarian — unless a librarian
   * task is already **queued** (it has not read its activity window yet, so it
   * will cover this run too) or already **in progress** (letting a second sweep
   * start alongside it would race: save_knowledge is a read-then-write with no
   * version check, so the later write silently clobbers the earlier one. That
   * run's chainSweepIfUnswept queues the follow-up instead).
   *
   * The check is not atomic across workers; the partial unique index
   * `one_queued_sweep_per_project` (migration 0006) settles the race — the
   * loser gets 23505 and treats it as "already queued".
   */
  private async enqueueSweep(projectId: string, librarian: Agent, reason: string): Promise<void> {
    const { data, error } = await this.supabase
      .from("tasks")
      .select("id, status")
      .eq("project_id", projectId)
      .eq("agent_id", librarian.id)
      .in("status", ["queued", "in_progress"])
      .limit(1);
    if (error) {
      logger.error("executor", `failed to check open librarian tasks in project ${projectId}: ${error.message}`);
      return;
    }
    const open = (data ?? [])[0] as { id: string; status: string } | undefined;
    if (open) {
      logger.debug(
        "executor",
        `knowledge sweep not queued for project ${projectId}: librarian task ${open.id} is ${open.status}`,
      );
      return;
    }

    const { error: insertError } = await this.supabase.from("tasks").insert({
      project_id: projectId,
      agent_id: librarian.id,
      source: "trigger",
      title: SWEEP_TASK_TITLE,
      description: SWEEP_TASK_DESCRIPTION,
      priority: SWEEP_PRIORITY,
    });
    if (insertError) {
      if (insertError.code === "23505") {
        logger.debug("executor", `knowledge sweep already queued for project ${projectId} (lost the insert race)`);
        return;
      }
      logger.error("executor", `failed to queue a knowledge sweep for project ${projectId}: ${insertError.message}`);
      return;
    }
    logger.info("executor", `knowledge sweep queued for project ${projectId}: ${reason}`);
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
 * Standard preamble + the librarian-forwarding rule + the agent's own
 * instructions + injected knowledge sections (project docs, own docs, voice
 * profiles — see knowledgeSections).
 */
function buildSystemPrompt(
  agent: Agent,
  task: Task,
  knowledge: KnowledgeBundle,
  librarianRule: string,
): string {
  let preamble =
    `You are the agent "${agent.name}" working on the task "${task.title}" in Agent Fleet, ` +
    `an autonomous multi-agent platform. Work autonomously — nobody can answer questions ` +
    `mid-task. When you are done, report a clear final summary of what you did and the outcome. ` +
    `Never send Slack messages or emails yourself: propose them with the fleet propose_action ` +
    `tool — they are only sent after the user approves them. You can send the project owner a ` +
    `direct heads-up at any time with the notify_user tool.`;
  preamble += ` ${KNOWLEDGE_SEARCH_RULE}`;
  if (librarianRule) preamble += ` ${librarianRule}`;

  const instructions = agent.instructions?.trim();
  let prompt = instructions ? `${preamble}\n\n${instructions}` : preamble;

  const sections = knowledgeSections(knowledge);
  if (sections) prompt += `\n\n${sections}`;
  return prompt;
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
