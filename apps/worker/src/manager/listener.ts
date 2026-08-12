import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import {
  createSdkMcpServer,
  query,
  tool,
  type Options as AgentSdkOptions,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  DEFAULT_MODEL,
  type Agent,
  type Message,
  type Project,
  type Task,
} from "@agent-fleet/shared";
import { logger } from "../lib/logger.js";

const POLL_INTERVAL_MS = 10_000;
const MANAGER_MAX_TURNS = 12;
const PROCESSED_IDS_CAP = 2_000;

/** Sends a manager reply over Telegram to the project owner's linked chat. */
export type TelegramNotifier = (projectId: string, text: string) => Promise<void>;

/**
 * Listens for user messages (Realtime INSERT + 10s polling fallback) and runs
 * a short Agent SDK session for the project's manager agent, giving it
 * task-management tools via an in-process MCP server.
 *
 * Manager interactions are NOT tasks — manager activity is logged to the
 * console only.
 */
export class ManagerListener {
  private channel: RealtimeChannel | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private lastSeenCreatedAt: string = new Date().toISOString();
  private processedIds = new Set<string>();
  private handling = Promise.resolve();
  private telegramNotifier: TelegramNotifier | undefined;
  private stopped = false;

  constructor(private readonly supabase: SupabaseClient) {}

  setTelegramNotifier(notifier: TelegramNotifier): void {
    this.telegramNotifier = notifier;
  }

  start(): void {
    this.stopped = false;
    this.subscribeRealtime();
    this.pollTimer = setInterval(() => void this.pollOnce(), POLL_INTERVAL_MS);
    logger.info("manager", `listening for user messages (realtime + ${POLL_INTERVAL_MS / 1000}s polling fallback)`);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    if (this.channel) {
      try {
        await this.supabase.removeChannel(this.channel);
      } catch (err) {
        logger.warn("manager", "failed to remove realtime channel", err);
      }
      this.channel = undefined;
    }
  }

  private subscribeRealtime(): void {
    try {
      this.channel = this.supabase
        .channel("worker-user-messages")
        .on(
          "postgres_changes",
          { event: "INSERT", schema: "public", table: "messages", filter: "sender=eq.user" },
          (payload) => {
            const message = payload.new as Message;
            this.enqueue(message);
          },
        )
        .subscribe((status) => {
          logger.info("manager", `realtime subscription status: ${status}`);
        });
    } catch (err) {
      logger.error("manager", "realtime subscription failed (polling still active)", err);
    }
  }

  /** Polling fallback: picks up user messages Realtime might have missed. */
  private async pollOnce(): Promise<void> {
    if (this.stopped) return;
    try {
      const { data, error } = await this.supabase
        .from("messages")
        .select("*")
        .eq("sender", "user")
        .gt("created_at", this.lastSeenCreatedAt)
        .order("created_at", { ascending: true })
        .limit(50);
      if (error) {
        logger.error("manager", `poll for user messages failed: ${error.message}`);
        return;
      }
      for (const message of (data ?? []) as Message[]) {
        this.enqueue(message);
      }
    } catch (err) {
      logger.error("manager", "poll for user messages crashed", err);
    }
  }

  /** Serializes message handling so manager sessions don't interleave. */
  private enqueue(message: Message): void {
    if (!message?.id || this.processedIds.has(message.id)) return;
    this.processedIds.add(message.id);
    if (this.processedIds.size > PROCESSED_IDS_CAP) {
      // Drop the oldest half; correctness is preserved by lastSeenCreatedAt.
      const keep = [...this.processedIds].slice(-PROCESSED_IDS_CAP / 2);
      this.processedIds = new Set(keep);
    }
    if (message.created_at && message.created_at > this.lastSeenCreatedAt) {
      this.lastSeenCreatedAt = message.created_at;
    }
    this.handling = this.handling
      .then(() => this.handleUserMessage(message))
      .catch((err) => {
        logger.error("manager", `handling of message ${message.id} crashed`, err);
      });
  }

  private async handleUserMessage(message: Message): Promise<void> {
    if (this.stopped) return;
    logger.info("manager", `user message ${message.id} on project ${message.project_id} (${message.channel}): ${message.content.slice(0, 120)}`);

    const project = await this.loadProject(message.project_id);
    const managerAgent = await this.loadManagerAgent(message.project_id);
    if (!managerAgent) {
      await this.sendReply(
        message,
        "This project has no active manager agent configured yet, so I can't act on your message. Add a manager agent in the web UI first.",
      );
      return;
    }

    const agents = await this.loadAgents(message.project_id);
    const openTasks = await this.loadOpenTasks(message.project_id);
    const recentMessages = await this.loadRecentMessages(message.project_id);

    let replied = false;
    const replyToUser = async (text: string): Promise<void> => {
      replied = true;
      await this.sendReply(message, text);
    };

    const managerTools = this.buildManagerTools(message, agents, replyToUser);

    const systemPrompt = buildManagerSystemPrompt(managerAgent, project, agents, openTasks, recentMessages);

    const options: AgentSdkOptions = {
      systemPrompt,
      model: managerAgent.model || DEFAULT_MODEL,
      mcpServers: { manager: managerTools },
      tools: [], // no built-in tools — the manager only coordinates
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      settingSources: [],
      persistSession: false,
      maxTurns: MANAGER_MAX_TURNS,
    };

    try {
      let resultText: string | null = null;
      for await (const sdkMessage of query({ prompt: message.content, options })) {
        if (sdkMessage.type === "result") {
          if (sdkMessage.subtype === "success") {
            resultText = sdkMessage.result;
          } else {
            logger.error("manager", `manager run for message ${message.id} ended with ${sdkMessage.subtype}`);
          }
        } else if (sdkMessage.type === "assistant") {
          for (const block of sdkMessage.message.content) {
            if (block.type === "tool_use") {
              logger.info("manager", `manager tool call: ${block.name}`);
            }
          }
        }
      }

      // The manager must always answer the user — fall back to the final text.
      if (!replied) {
        const fallback = resultText?.trim()
          ? resultText.trim()
          : "I processed your message but couldn't produce a reply. Please try again.";
        await this.sendReply(message, fallback);
      }
    } catch (err) {
      logger.error("manager", `manager session for message ${message.id} crashed`, err);
      if (!replied) {
        await this.sendReply(message, "Sorry — something went wrong while handling your message. Please try again.");
      }
    }
  }

  /** In-process MCP server exposing the manager's coordination tools. */
  private buildManagerTools(
    incoming: Message,
    agents: Agent[],
    replyToUser: (text: string) => Promise<void>,
  ) {
    const supabase = this.supabase;

    const createTask = tool(
      "create_task",
      "Create a task for a specialist agent in this project. Provide agent_id or agent_name to pick the assignee. The task is queued and executed asynchronously; the user is notified in chat when it completes.",
      {
        agent_id: z.string().optional().describe("Exact id of the agent to assign"),
        agent_name: z.string().optional().describe("Name of the agent to assign (case-insensitive)"),
        title: z.string().describe("Short imperative task title"),
        description: z.string().optional().describe("Full task description with all context the agent needs"),
        priority: z.number().int().optional().describe("Higher runs first; default 0"),
      },
      async (args) => {
        const assignee = resolveAgent(agents, args.agent_id, args.agent_name);
        if (!assignee) {
          const names = agents.map((a) => `${a.name} (${a.id})`).join(", ") || "none";
          return textResult(`Error: no matching agent. Available agents: ${names}`);
        }
        const { data, error } = await supabase
          .from("tasks")
          .insert({
            project_id: incoming.project_id,
            agent_id: assignee.id,
            source: "manager",
            title: args.title,
            description: args.description ?? "",
            priority: args.priority ?? 0,
            status: "queued",
          })
          .select("id")
          .single();
        if (error) return textResult(`Error creating task: ${error.message}`);
        logger.info("manager", `created task ${(data as { id: string }).id} for agent ${assignee.name}`);
        return textResult(
          `Task created (id ${(data as { id: string }).id}) and assigned to ${assignee.name}. It will run asynchronously.`,
        );
      },
    );

    const listAgents = tool(
      "list_agents",
      "List the agents in this project with their id, name, role and workspace.",
      {},
      async () => {
        const rows = agents.map((a) => ({
          id: a.id,
          name: a.name,
          role: a.role,
          model: a.model,
          workspace_id: a.workspace_id,
          is_active: a.is_active,
        }));
        return textResult(JSON.stringify(rows, null, 2));
      },
    );

    const listOpenTasks = tool(
      "list_open_tasks",
      "List the project's open tasks (queued, in progress or in review).",
      {},
      async () => {
        const { data, error } = await supabase
          .from("tasks")
          .select("id, title, status, priority, agent_id, created_at")
          .eq("project_id", incoming.project_id)
          .in("status", ["queued", "in_progress", "review"])
          .order("created_at", { ascending: false })
          .limit(50);
        if (error) return textResult(`Error listing tasks: ${error.message}`);
        return textResult(JSON.stringify(data ?? [], null, 2));
      },
    );

    const reply = tool(
      "reply_to_user",
      "Send a reply to the user in the project chat. Always call this exactly once at the end, summarizing what you did (answered directly and/or which tasks you created).",
      {
        text: z.string().describe("The message to send to the user"),
      },
      async (args) => {
        await replyToUser(args.text);
        return textResult("Reply sent to the user.");
      },
    );

    return createSdkMcpServer({
      name: "manager",
      version: "1.0.0",
      tools: [createTask, listAgents, listOpenTasks, reply],
    });
  }

  /** Stores the manager reply and mirrors it to Telegram when appropriate. */
  private async sendReply(incoming: Message, text: string): Promise<void> {
    try {
      const { error } = await this.supabase.from("messages").insert({
        project_id: incoming.project_id,
        sender: "manager",
        channel: incoming.channel,
        content: text,
      });
      if (error) logger.error("manager", `failed to insert manager reply: ${error.message}`);
    } catch (err) {
      logger.error("manager", "failed to insert manager reply", err);
    }

    if (incoming.channel === "telegram" && this.telegramNotifier) {
      try {
        await this.telegramNotifier(incoming.project_id, text);
      } catch (err) {
        logger.error("manager", "telegram reply delivery failed", err);
      }
    }
  }

  // ------------------------------------------------------------------ loads

  private async loadProject(projectId: string): Promise<Project | null> {
    const { data, error } = await this.supabase
      .from("projects")
      .select("*")
      .eq("id", projectId)
      .maybeSingle();
    if (error) {
      logger.error("manager", `failed to load project ${projectId}: ${error.message}`);
      return null;
    }
    return (data as Project | null) ?? null;
  }

  private async loadManagerAgent(projectId: string): Promise<Agent | null> {
    const { data, error } = await this.supabase
      .from("agents")
      .select("*")
      .eq("project_id", projectId)
      .eq("role", "manager")
      .eq("is_active", true)
      .maybeSingle();
    if (error) {
      logger.error("manager", `failed to load manager agent for project ${projectId}: ${error.message}`);
      return null;
    }
    return (data as Agent | null) ?? null;
  }

  private async loadAgents(projectId: string): Promise<Agent[]> {
    const { data, error } = await this.supabase
      .from("agents")
      .select("*")
      .eq("project_id", projectId)
      .eq("is_active", true);
    if (error) {
      logger.error("manager", `failed to load agents for project ${projectId}: ${error.message}`);
      return [];
    }
    return (data ?? []) as Agent[];
  }

  private async loadOpenTasks(projectId: string): Promise<Task[]> {
    const { data, error } = await this.supabase
      .from("tasks")
      .select("*")
      .eq("project_id", projectId)
      .in("status", ["queued", "in_progress", "review"])
      .order("created_at", { ascending: false })
      .limit(20);
    if (error) {
      logger.error("manager", `failed to load open tasks for project ${projectId}: ${error.message}`);
      return [];
    }
    return (data ?? []) as Task[];
  }

  private async loadRecentMessages(projectId: string): Promise<Message[]> {
    const { data, error } = await this.supabase
      .from("messages")
      .select("*")
      .eq("project_id", projectId)
      .order("created_at", { ascending: false })
      .limit(20);
    if (error) {
      logger.error("manager", `failed to load messages for project ${projectId}: ${error.message}`);
      return [];
    }
    return ((data ?? []) as Message[]).reverse();
  }
}

// -------------------------------------------------------------------- utils

function resolveAgent(agents: Agent[], agentId?: string, agentName?: string): Agent | null {
  if (agentId) {
    const byId = agents.find((a) => a.id === agentId);
    if (byId) return byId;
  }
  if (agentName) {
    const needle = agentName.trim().toLowerCase();
    const byName = agents.find((a) => a.name.trim().toLowerCase() === needle);
    if (byName) return byName;
  }
  return null;
}

function textResult(text: string): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text }] };
}

function buildManagerSystemPrompt(
  manager: Agent,
  project: Project | null,
  agents: Agent[],
  openTasks: Task[],
  recentMessages: Message[],
): string {
  const teamLines = agents
    .filter((a) => a.id !== manager.id)
    .map((a) => {
      const summary = a.instructions ? a.instructions.replace(/\s+/g, " ").slice(0, 200) : "(no instructions)";
      return `- ${a.name} (id: ${a.id}, role: ${a.role}, workspace: ${a.workspace_id ?? "none"}): ${summary}`;
    })
    .join("\n");

  const taskLines = openTasks
    .map((t) => `- [${t.status}] "${t.title}" (id: ${t.id}, agent: ${t.agent_id ?? "unassigned"}, priority: ${t.priority})`)
    .join("\n");

  const messageLines = recentMessages
    .map((m) => `${m.sender} (${m.channel}): ${m.content.replace(/\s+/g, " ").slice(0, 300)}`)
    .join("\n");

  const instructions = manager.instructions?.trim();

  return [
    `You are "${manager.name}", the manager agent of the project "${project?.name ?? "unknown"}" in Agent Fleet.`,
    instructions ? `\n${instructions}\n` : "",
    `You coordinate a team of specialist agents. For each user message decide:`,
    `- If you can answer directly (questions, status updates, clarifications), do so via reply_to_user.`,
    `- If work should be done by a specialist, create one or more tasks with create_task. Each task description must be self-contained — the specialist sees nothing else. Tasks run asynchronously; the user is notified in chat when they complete.`,
    `Always finish by calling reply_to_user exactly once, summarizing what you did (your answer, and/or which tasks you created and who they are assigned to). Never end without replying.`,
    ``,
    `## Team`,
    teamLines || "(no specialist agents yet)",
    ``,
    `## Open tasks`,
    taskLines || "(none)",
    ``,
    `## Recent conversation`,
    messageLines || "(none)",
  ].join("\n");
}
