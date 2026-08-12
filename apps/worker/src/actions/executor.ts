import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import {
  gmailIntegrationConfigSchema,
  slackIntegrationConfigSchema,
  type GmailActionPayload,
  type IntegrationRow,
  type PendingActionRow,
  type SlackActionPayload,
} from "@agent-fleet/shared";
import { logger } from "../lib/logger.js";

const LOOP_INTERVAL_MS = 5_000;
const MAX_ACTIONS_PER_PASS = 20;
const PREVIEW_MAX_CHARS = 500;
const ERROR_MAX_CHARS = 2_000;

/** Sends a message to the project owner's linked Telegram chat. */
export type TelegramNotifier = (projectId: string, text: string) => Promise<void>;

/**
 * Deterministic executor for approved pending_actions — plain code, no LLM.
 *
 * Loops every 5s (plus a Realtime wake on pending_actions UPDATEs), picks
 * rows with status 'approved' and sends them via the project's integration
 * credentials, then marks them 'executed' or 'failed'.
 *
 * Claim safety: this platform runs a SINGLE worker process, and this class
 * processes approved actions strictly sequentially inside one loop (the
 * `processing` flag prevents overlapping passes). Under that assumption no
 * two sends of the same action can race, so no intermediate "executing"
 * status/claim step is needed. If multiple worker processes are ever
 * deployed, add an atomic claim (e.g. an 'executing' status flipped with a
 * conditional update) before sending.
 */
export class ActionExecutor {
  private timer: NodeJS.Timeout | undefined;
  private channel: RealtimeChannel | undefined;
  private processing = false;
  private stopped = false;
  private telegramNotifier: TelegramNotifier | undefined;

  constructor(private readonly supabase: SupabaseClient) {}

  setTelegramNotifier(notifier: TelegramNotifier): void {
    this.telegramNotifier = notifier;
  }

  start(): void {
    this.stopped = false;
    this.subscribeRealtime();
    this.timer = setInterval(() => void this.processApproved(), LOOP_INTERVAL_MS);
    void this.processApproved();
    logger.info("actions", `started (checking approved actions every ${LOOP_INTERVAL_MS / 1000}s + realtime wake)`);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.channel) {
      try {
        await this.supabase.removeChannel(this.channel);
      } catch (err) {
        logger.warn("actions", "failed to remove realtime channel", err);
      }
      this.channel = undefined;
    }
  }

  private subscribeRealtime(): void {
    try {
      this.channel = this.supabase
        .channel("worker-pending-action-updates")
        .on(
          "postgres_changes",
          { event: "UPDATE", schema: "public", table: "pending_actions" },
          () => {
            void this.processApproved();
          },
        )
        .subscribe((status) => {
          logger.info("actions", `realtime subscription status: ${status}`);
        });
    } catch (err) {
      logger.error("actions", "realtime subscription failed (polling still active)", err);
    }
  }

  private async processApproved(): Promise<void> {
    if (this.processing || this.stopped) return;
    this.processing = true;
    try {
      const { data, error } = await this.supabase
        .from("pending_actions")
        .select("*")
        .eq("status", "approved")
        .order("created_at", { ascending: true })
        .limit(MAX_ACTIONS_PER_PASS);
      if (error) {
        logger.error("actions", `failed to load approved actions: ${error.message}`);
        return;
      }
      for (const action of (data ?? []) as PendingActionRow[]) {
        if (this.stopped) break;
        await this.executeAction(action);
      }
    } catch (err) {
      logger.error("actions", "processing pass crashed", err);
    } finally {
      this.processing = false;
    }
  }

  private async executeAction(action: PendingActionRow): Promise<void> {
    logger.info("actions", `executing action ${action.id} (${action.action_type})`);
    try {
      await this.send(action);
      const { error } = await this.supabase
        .from("pending_actions")
        .update({ status: "executed", executed_at: new Date().toISOString() })
        .eq("id", action.id)
        .eq("status", "approved");
      if (error) logger.error("actions", `failed to mark action ${action.id} executed: ${error.message}`);
      logger.info("actions", `action ${action.id} executed`);
      await this.recordOutcome(action, true, null);
    } catch (err) {
      const message = (err instanceof Error ? err.message : String(err)).slice(0, ERROR_MAX_CHARS);
      logger.error("actions", `action ${action.id} failed: ${message}`);
      const { error } = await this.supabase
        .from("pending_actions")
        .update({ status: "failed", error: message })
        .eq("id", action.id)
        .eq("status", "approved");
      if (error) logger.error("actions", `failed to mark action ${action.id} failed: ${error.message}`);
      await this.recordOutcome(action, false, message);
    }
  }

  /** Routes to the correct integration + sender. Throws with a clear error. */
  private async send(action: PendingActionRow): Promise<void> {
    const integrationType = action.action_type.startsWith("slack") ? "slack" : "gmail";
    const { data, error } = await this.supabase
      .from("integrations")
      .select("*")
      .eq("project_id", action.project_id)
      .eq("type", integrationType)
      .maybeSingle();
    if (error) throw new Error(`Failed to load ${integrationType} integration: ${error.message}`);
    const integration = data as IntegrationRow | null;
    if (!integration) {
      throw new Error(
        `No ${integrationType} integration is configured for this project. ` +
          `Add one in the project's integration settings before approving ${integrationType} actions.`,
      );
    }

    if (integrationType === "slack") {
      await this.sendSlack(integration, action.payload as SlackActionPayload);
    } else {
      await this.sendGmail(integration, action.payload as GmailActionPayload);
    }
  }

  // ------------------------------------------------------------------ slack

  private async sendSlack(integration: IntegrationRow, payload: SlackActionPayload): Promise<void> {
    const parsed = slackIntegrationConfigSchema.safeParse(integration.config);
    if (!parsed.success) {
      throw new Error(
        "Slack integration config is invalid — it must contain a non-empty 'userToken'. Reconfigure it in the project's integration settings.",
      );
    }
    if (!payload || typeof payload.channel !== "string" || typeof payload.text !== "string") {
      throw new Error("Slack action payload is malformed (expected { channel, text, thread_ts? }).");
    }

    const response = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        authorization: `Bearer ${parsed.data.userToken}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        channel: payload.channel,
        text: payload.text,
        ...(payload.thread_ts ? { thread_ts: payload.thread_ts } : {}),
      }),
    });
    const body = (await response.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
    if (!response.ok || !body?.ok) {
      throw new Error(`Slack API error: ${body?.error ?? `HTTP ${response.status}`}`);
    }
  }

  // ------------------------------------------------------------------ gmail

  private async sendGmail(integration: IntegrationRow, payload: GmailActionPayload): Promise<void> {
    const parsed = gmailIntegrationConfigSchema.safeParse(integration.config);
    if (!parsed.success) {
      throw new Error(
        "Gmail integration config is invalid — it must contain 'clientId', 'clientSecret', 'refreshToken' and 'emailAddress'. Reconfigure it in the project's integration settings.",
      );
    }
    if (!payload || typeof payload.to !== "string" || typeof payload.subject !== "string" || typeof payload.body !== "string") {
      throw new Error("Gmail action payload is malformed (expected { to, subject, body, cc?, thread_id?, in_reply_to_message_id? }).");
    }
    const config = parsed.data;

    // 1. Refresh the access token.
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        refresh_token: config.refreshToken,
        grant_type: "refresh_token",
      }),
    });
    const tokenBody = (await tokenResponse.json().catch(() => null)) as
      | { access_token?: string; error?: string; error_description?: string }
      | null;
    if (!tokenResponse.ok || !tokenBody?.access_token) {
      throw new Error(
        `Gmail access token refresh failed: ${tokenBody?.error_description ?? tokenBody?.error ?? `HTTP ${tokenResponse.status}`}`,
      );
    }

    // 2. Build and send the RFC 2822 message.
    const raw = Buffer.from(buildMimeMessage(payload, config.emailAddress), "utf8").toString("base64url");
    const sendResponse = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokenBody.access_token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        raw,
        ...(payload.thread_id ? { threadId: payload.thread_id } : {}),
      }),
    });
    if (!sendResponse.ok) {
      const errorText = (await sendResponse.text().catch(() => "")).slice(0, 500);
      throw new Error(`Gmail send failed (HTTP ${sendResponse.status}): ${errorText || "no response body"}`);
    }
  }

  // ---------------------------------------------------------------- outcome

  /** Project chat message + Telegram note for both success and failure. */
  private async recordOutcome(action: PendingActionRow, ok: boolean, errorText: string | null): Promise<void> {
    const preview = truncate(action.preview, PREVIEW_MAX_CHARS);
    const content = ok
      ? `✅ Sent: ${preview}`
      : `❌ Failed to send: ${preview} — ${errorText ?? "unknown error"}`;

    try {
      const { error } = await this.supabase.from("messages").insert({
        project_id: action.project_id,
        task_id: action.task_id,
        sender: "manager",
        channel: "web",
        content,
      });
      if (error) logger.error("actions", `failed to insert outcome message for action ${action.id}: ${error.message}`);
    } catch (err) {
      logger.error("actions", `failed to insert outcome message for action ${action.id}`, err);
    }

    if (this.telegramNotifier) {
      try {
        await this.telegramNotifier(action.project_id, content);
      } catch (err) {
        logger.error("actions", `telegram outcome notification failed for action ${action.id}`, err);
      }
    }
  }
}

// ---------------------------------------------------------------------- mime

/**
 * Builds an RFC 2822 message. The body is base64-encoded (safe for any UTF-8
 * content); non-ASCII subjects use RFC 2047 encoded-words.
 */
function buildMimeMessage(payload: GmailActionPayload, from: string): string {
  const headers: string[] = [`From: ${from}`, `To: ${payload.to}`];
  if (payload.cc) headers.push(`Cc: ${payload.cc}`);
  headers.push(`Subject: ${encodeHeaderValue(payload.subject)}`);
  if (payload.in_reply_to_message_id) {
    const messageId = ensureAngleBrackets(payload.in_reply_to_message_id);
    headers.push(`In-Reply-To: ${messageId}`);
    headers.push(`References: ${messageId}`);
  }
  headers.push("MIME-Version: 1.0");
  headers.push('Content-Type: text/plain; charset="UTF-8"');
  headers.push("Content-Transfer-Encoding: base64");

  const body = Buffer.from(payload.body, "utf8")
    .toString("base64")
    .replace(/(.{76})/g, "$1\r\n"); // RFC 2045 line-length limit

  return `${headers.join("\r\n")}\r\n\r\n${body}`;
}

/** RFC 2047 encoded-word for non-ASCII header values (e.g. Subject). */
function encodeHeaderValue(value: string): string {
  // Printable ASCII passes through untouched.
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function ensureAngleBrackets(messageId: string): string {
  const trimmed = messageId.trim();
  return trimmed.startsWith("<") ? trimmed : `<${trimmed}>`;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}
