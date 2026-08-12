import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  query,
  type McpServerConfig as SdkMcpServerConfig,
  type Options as AgentSdkOptions,
} from "@anthropic-ai/claude-agent-sdk";
import {
  DEFAULT_MODEL,
  type Agent,
  type McpServerConfig,
  type Task,
  type TaskRun,
} from "@agent-fleet/shared";
import { logger, RunLogWriter } from "../lib/logger.js";
import type { WorkspaceManager } from "../workspaces/manager.js";

const TOOL_RESULT_MAX_CHARS = 4_000;
const RESULT_SUMMARY_MAX_CHARS = 1_500;
const MAX_TURNS = 100;

/** Sends a completion notice over Telegram to the project owner's linked chat. */
export type TelegramNotifier = (projectId: string, text: string) => Promise<void>;

/**
 * Executes a claimed task with the Claude Agent SDK, streaming every SDK
 * message into run_logs and recording the outcome on task_runs + tasks.
 * Never throws — every failure path ends with the task marked 'failed'.
 */
export class TaskExecutor {
  private telegramNotifier: TelegramNotifier | undefined;

  constructor(
    private readonly supabase: SupabaseClient,
    private readonly workspaces: WorkspaceManager,
    private readonly workspacesRoot: string,
  ) {}

  /** Hook registered by the Telegram bot (if configured). */
  setTelegramNotifier(notifier: TelegramNotifier): void {
    this.telegramNotifier = notifier;
  }

  async executeTask(task: Task): Promise<void> {
    logger.info("executor", `executing task ${task.id}: "${task.title}"`);

    // 1. Load the agent.
    const agent = await this.loadAgent(task.agent_id);
    if (!agent) {
      await this.finishTask(task, null, false, `Task has no valid agent (agent_id: ${task.agent_id ?? "null"})`);
      return;
    }

    // Insert the task_runs row.
    const run = await this.insertRun(task, agent);
    if (!run) {
      await this.finishTask(task, agent, false, "Failed to create task_runs row");
      return;
    }
    const runLog = new RunLogWriter(this.supabase, run.id);

    try {
      // 2. Resolve the working directory.
      const cwd = await this.resolveCwd(task, agent);

      // 3. Build MCP server config from agent.mcp_servers.
      const mcpServers = buildMcpServers(agent.mcp_servers ?? []);

      // 4. Run the Claude Agent SDK.
      const systemPrompt = buildSystemPrompt(agent, task);
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

      // 5. Stream SDK messages into run_logs and capture the final result.
      const { resultText, failure } = await this.streamQuery(prompt, options, runLog);

      // 6. Record the outcome.
      if (failure) {
        await this.markRun(run.id, "failed", failure);
        await this.finishTask(task, agent, false, failure);
      } else {
        await this.markRun(run.id, "succeeded", null);
        await this.finishTask(task, agent, true, resultText ?? "");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("executor", `task ${task.id} crashed: ${message}`, err);
      await runLog.write("error", { message }, "error");
      await this.markRun(run.id, "failed", message);
      await this.finishTask(task, agent, false, message);
    }
  }

  /** Iterates the SDK message stream, persisting each event to run_logs. */
  private async streamQuery(
    prompt: string,
    options: AgentSdkOptions,
    runLog: RunLogWriter,
  ): Promise<{ resultText: string | null; failure: string | null }> {
    let resultText: string | null = null;
    let failure: string | null = null;
    let sawResult = false;
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
          if (message.subtype === "success") {
            resultText = message.result;
            await runLog.write("status", {
              status: "finished",
              num_turns: message.num_turns,
              duration_ms: message.duration_ms,
              total_cost_usd: message.total_cost_usd,
            });
          } else {
            const errors = message.errors?.length ? message.errors.join("; ") : message.subtype;
            failure = `Agent run ended with ${message.subtype}: ${errors}`;
            await runLog.write("error", { subtype: message.subtype, errors: message.errors }, "error");
          }
          break;
        }
        default:
          break;
      }
    }

    if (!sawResult && failure === null && resultText === null) {
      failure = "Agent SDK stream ended without a result message";
    }
    return { resultText, failure };
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

  private async markRun(runId: string, status: "succeeded" | "failed", errorText: string | null): Promise<void> {
    try {
      const { error } = await this.supabase
        .from("task_runs")
        .update({
          status,
          error: errorText ? errorText.slice(0, 4000) : null,
          finished_at: new Date().toISOString(),
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
    succeeded: boolean,
    resultText: string,
  ): Promise<void> {
    try {
      const { error } = await this.supabase
        .from("tasks")
        .update({
          status: succeeded ? "done" : "failed",
          result: resultText || null,
          finished_at: new Date().toISOString(),
        })
        .eq("id", task.id);
      if (error) logger.error("executor", `failed to update task ${task.id}: ${error.message}`);
    } catch (err) {
      logger.error("executor", `failed to update task ${task.id}`, err);
    }

    logger.info("executor", `task ${task.id} ${succeeded ? "done" : "failed"}`);
    await this.notifyCompletion(task, agent, succeeded, resultText);
  }

  /**
   * Notifies the project chat when a manager-driven task finishes, so the web
   * chat (via Realtime on messages) and Telegram both learn of completion.
   */
  private async notifyCompletion(
    task: Task,
    agent: Agent | null,
    succeeded: boolean,
    resultText: string,
  ): Promise<void> {
    const managerDriven = task.source === "manager" || task.parent_task_id !== null;
    if (!managerDriven) return;

    const agentName = agent?.name ?? "unknown agent";
    const summary = succeeded
      ? `Task "${task.title}" (${agentName}) completed.\n\n${truncate(resultText, RESULT_SUMMARY_MAX_CHARS)}`
      : `Task "${task.title}" (${agentName}) failed: ${truncate(resultText, RESULT_SUMMARY_MAX_CHARS)}`;

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

/** Standard preamble + the agent's own instructions. */
function buildSystemPrompt(agent: Agent, task: Task): string {
  const preamble =
    `You are the agent "${agent.name}" working on the task "${task.title}" in Agent Fleet, ` +
    `an autonomous multi-agent platform. Work autonomously — nobody can answer questions ` +
    `mid-task. When you are done, report a clear final summary of what you did and the outcome.`;
  const instructions = agent.instructions?.trim();
  return instructions ? `${preamble}\n\n${instructions}` : preamble;
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
