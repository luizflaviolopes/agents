import { Bot, InlineKeyboard } from "grammy";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { PendingActionRow, Profile, Project } from "@agent-fleet/shared";
import { logger } from "../lib/logger.js";

const ACTION_PREVIEW_MAX_CHARS = 1_000;

/**
 * grammY bot (long polling).
 *
 * Commands:
 * - /start          — explains account linking
 * - /link <code>    — links the Telegram chat to a profile via telegram_link_code
 * - /projects       — lists the linked user's projects (numbered)
 * - /use <n|name>   — selects the active project for this chat (in-memory)
 *
 * Any other text is stored as a user message (channel 'telegram') on the
 * active project, which the ManagerListener then picks up.
 */
export class TelegramBot {
  private readonly bot: Bot;
  /** chat id → active project id (in-memory; users re-select after restart). */
  private readonly activeProject = new Map<string, string>();
  /** chat id → last listed projects, so "/use 2" resolves by number. */
  private readonly lastProjectList = new Map<string, Project[]>();

  constructor(
    token: string,
    private readonly supabase: SupabaseClient,
  ) {
    this.bot = new Bot(token);
    this.registerHandlers();
    this.bot.catch((err) => {
      logger.error("telegram", "bot error", err.error);
    });
  }

  start(): void {
    // bot.start() long-polls until stop(); run it in the background.
    void this.bot
      .start({
        onStart: (me) => logger.info("telegram", `bot started as @${me.username}`),
      })
      .catch((err) => logger.error("telegram", "long polling stopped unexpectedly", err));
  }

  async stop(): Promise<void> {
    try {
      await this.bot.stop();
    } catch (err) {
      logger.warn("telegram", "error while stopping bot", err);
    }
  }

  /** Sends a message to a specific chat. Never throws. */
  async sendToChat(chatId: string, text: string): Promise<void> {
    try {
      await this.bot.api.sendMessage(chatId, text);
    } catch (err) {
      logger.error("telegram", `failed to send message to chat ${chatId}`, err);
    }
  }

  /**
   * Sends a message to the project owner's linked Telegram chat, if any.
   * Used by the manager reply flow and task completion notifications.
   */
  async notifyProject(projectId: string, text: string): Promise<void> {
    try {
      const { data: project, error: projectError } = await this.supabase
        .from("projects")
        .select("owner_id")
        .eq("id", projectId)
        .maybeSingle();
      if (projectError || !project) return;

      const { data: profile, error: profileError } = await this.supabase
        .from("profiles")
        .select("telegram_chat_id")
        .eq("id", (project as { owner_id: string }).owner_id)
        .maybeSingle();
      if (profileError || !profile) return;

      const chatId = (profile as { telegram_chat_id: string | null }).telegram_chat_id;
      if (chatId) await this.sendToChat(chatId, text);
    } catch (err) {
      logger.error("telegram", `notifyProject failed for project ${projectId}`, err);
    }
  }

  /**
   * Sends the project owner an approval request for a newly proposed pending
   * action, with inline Approve/Reject buttons. Never throws.
   */
  async notifyPendingAction(
    action: PendingActionRow,
    projectName: string,
    agentName?: string,
  ): Promise<void> {
    try {
      const chatId = await this.ownerChatId(action.project_id);
      if (!chatId) return;

      const preview =
        action.preview.length > ACTION_PREVIEW_MAX_CHARS
          ? `${action.preview.slice(0, ACTION_PREVIEW_MAX_CHARS)}…`
          : action.preview;
      const text =
        `🔔 Approval needed — ${action.action_type}\n` +
        `Project: ${projectName}\n` +
        `Agent: ${agentName ?? "unknown"}\n\n` +
        preview;
      const keyboard = new InlineKeyboard()
        .text("✅ Approve", `pa:approve:${action.id}`)
        .text("❌ Reject", `pa:reject:${action.id}`);

      await this.bot.api.sendMessage(chatId, text, { reply_markup: keyboard });
    } catch (err) {
      logger.error("telegram", `notifyPendingAction failed for action ${action.id}`, err);
    }
  }

  /** Resolves the project owner's linked chat id, or null. */
  private async ownerChatId(projectId: string): Promise<string | null> {
    const { data: project, error: projectError } = await this.supabase
      .from("projects")
      .select("owner_id")
      .eq("id", projectId)
      .maybeSingle();
    if (projectError || !project) return null;

    const { data: profile, error: profileError } = await this.supabase
      .from("profiles")
      .select("telegram_chat_id")
      .eq("id", (project as { owner_id: string }).owner_id)
      .maybeSingle();
    if (profileError || !profile) return null;

    return (profile as { telegram_chat_id: string | null }).telegram_chat_id;
  }

  // ------------------------------------------------------------- handlers

  private registerHandlers(): void {
    this.bot.command("start", async (ctx) => {
      await ctx.reply(
        "Welcome to Agent Fleet!\n\n" +
          "To link this chat to your account, open the web app, generate a link code " +
          "in your profile settings, then send:\n\n/link <code>\n\n" +
          "After linking: /projects to list your projects, /use <n or name> to pick one, " +
          "then just type messages to talk to that project's manager agent.",
      );
    });

    this.bot.command("link", async (ctx) => {
      const code = String(ctx.match ?? "").trim();
      if (!code) {
        await ctx.reply("Usage: /link <code> — generate the code in the web app first.");
        return;
      }
      const chatId = String(ctx.chat.id);
      try {
        const { data, error } = await this.supabase
          .from("profiles")
          .select("*")
          .eq("telegram_link_code", code)
          .maybeSingle();
        if (error) throw new Error(error.message);
        const profile = data as Profile | null;
        if (!profile) {
          await ctx.reply("Invalid or expired link code. Generate a new one in the web app.");
          return;
        }
        const { error: updateError } = await this.supabase
          .from("profiles")
          .update({ telegram_chat_id: chatId, telegram_link_code: null })
          .eq("id", profile.id);
        if (updateError) throw new Error(updateError.message);
        await ctx.reply(
          `Linked! This chat is now connected to ${profile.display_name ?? "your account"}. ` +
            "Use /projects to list your projects.",
        );
        logger.info("telegram", `chat ${chatId} linked to profile ${profile.id}`);
      } catch (err) {
        logger.error("telegram", "/link failed", err);
        await ctx.reply("Something went wrong while linking. Please try again.");
      }
    });

    this.bot.command("projects", async (ctx) => {
      const chatId = String(ctx.chat.id);
      try {
        const projects = await this.listProjectsForChat(chatId);
        if (projects === null) {
          await ctx.reply("This chat is not linked yet. Use /link <code> first.");
          return;
        }
        if (projects.length === 0) {
          await ctx.reply("You have no projects yet. Create one in the web app.");
          return;
        }
        this.lastProjectList.set(chatId, projects);
        const lines = projects.map((p, i) => `${i + 1}. ${p.name}`);
        await ctx.reply(`Your projects:\n${lines.join("\n")}\n\nSelect one with /use <number or name>.`);
      } catch (err) {
        logger.error("telegram", "/projects failed", err);
        await ctx.reply("Something went wrong while listing projects. Please try again.");
      }
    });

    this.bot.command("use", async (ctx) => {
      const arg = String(ctx.match ?? "").trim();
      const chatId = String(ctx.chat.id);
      if (!arg) {
        await ctx.reply("Usage: /use <number or name> — see /projects for the list.");
        return;
      }
      try {
        let projects = this.lastProjectList.get(chatId);
        if (!projects) {
          projects = (await this.listProjectsForChat(chatId)) ?? undefined;
          if (projects) this.lastProjectList.set(chatId, projects);
        }
        if (!projects) {
          await ctx.reply("This chat is not linked yet. Use /link <code> first.");
          return;
        }

        let selected: Project | undefined;
        const index = Number.parseInt(arg, 10);
        if (Number.isInteger(index) && index >= 1 && index <= projects.length) {
          selected = projects[index - 1];
        } else {
          const needle = arg.toLowerCase();
          selected = projects.find((p) => p.name.toLowerCase() === needle) ??
            projects.find((p) => p.name.toLowerCase().startsWith(needle));
        }
        if (!selected) {
          await ctx.reply(`No project matching "${arg}". Use /projects to see the list.`);
          return;
        }
        this.activeProject.set(chatId, selected.id);
        await ctx.reply(`Active project: ${selected.name}. Just type a message to talk to its manager.`);
      } catch (err) {
        logger.error("telegram", "/use failed", err);
        await ctx.reply("Something went wrong. Please try again.");
      }
    });

    // Approve/Reject buttons on pending-action notifications.
    this.bot.callbackQuery(/^pa:(approve|reject):(.+)$/, async (ctx) => {
      const match = ctx.match as RegExpMatchArray;
      const decision = match[1] === "approve" ? "approved" : "rejected";
      const actionId = match[2];
      try {
        // Only flip actions that are still pending; a second click (or a web
        // decision that already happened) leaves the row untouched.
        const { data, error } = await this.supabase
          .from("pending_actions")
          .update({ status: decision, decided_at: new Date().toISOString() })
          .eq("id", actionId)
          .eq("status", "pending")
          .select("id");
        if (error) throw new Error(error.message);

        if (!data || data.length === 0) {
          await ctx.answerCallbackQuery({ text: "Already decided" });
          return;
        }

        await ctx.answerCallbackQuery({
          text: decision === "approved" ? "Approved — sending" : "Rejected",
        });
        logger.info("telegram", `pending action ${actionId} ${decision} via inline button`);

        const original = ctx.callbackQuery.message?.text;
        if (original) {
          try {
            await ctx.editMessageText(
              `${original}\n\n${decision === "approved" ? "✅ Approved" : "❌ Rejected"}`,
            );
          } catch (err) {
            logger.warn("telegram", `failed to edit approval message for action ${actionId}`, err);
          }
        }
      } catch (err) {
        logger.error("telegram", `pending action decision failed for ${actionId}`, err);
        try {
          await ctx.answerCallbackQuery({ text: "Something went wrong — try again" });
        } catch {
          // answering can itself fail if the query expired; nothing to do
        }
      }
    });

    this.bot.on("message:text", async (ctx) => {
      const text = ctx.message.text.trim();
      if (!text || text.startsWith("/")) {
        if (text.startsWith("/")) await ctx.reply("Unknown command. Try /start, /link, /projects or /use.");
        return;
      }
      const chatId = String(ctx.chat.id);
      try {
        const projectId = this.activeProject.get(chatId);
        if (!projectId) {
          await ctx.reply("No active project. Use /projects to list yours, then /use <n or name>.");
          return;
        }
        const { error } = await this.supabase.from("messages").insert({
          project_id: projectId,
          sender: "user",
          channel: "telegram",
          content: text,
        });
        if (error) throw new Error(error.message);
        logger.info("telegram", `stored user message from chat ${chatId} on project ${projectId}`);
      } catch (err) {
        logger.error("telegram", "failed to store incoming message", err);
        await ctx.reply("Sorry — I couldn't deliver that message. Please try again.");
      }
    });
  }

  /** Returns the linked user's projects, or null when the chat is not linked. */
  private async listProjectsForChat(chatId: string): Promise<Project[] | null> {
    const { data: profile, error: profileError } = await this.supabase
      .from("profiles")
      .select("id")
      .eq("telegram_chat_id", chatId)
      .maybeSingle();
    if (profileError) throw new Error(profileError.message);
    if (!profile) return null;

    const { data, error } = await this.supabase
      .from("projects")
      .select("*")
      .eq("owner_id", (profile as { id: string }).id)
      .order("created_at", { ascending: true });
    if (error) throw new Error(error.message);
    return (data ?? []) as Project[];
  }
}
