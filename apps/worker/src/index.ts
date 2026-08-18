import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { logger } from "./lib/logger.js";
import { Semaphore } from "./lib/semaphore.js";
import { createServiceClient } from "./lib/supabase.js";
import { WorkspaceManager } from "./workspaces/manager.js";
import { TaskExecutor } from "./runner/executor.js";
import { TaskPoller, MAX_CONCURRENT_TASKS } from "./queue/poller.js";
import { ManagerListener } from "./manager/listener.js";
import { Scheduler } from "./scheduler/scheduler.js";
import { ActionExecutor } from "./actions/executor.js";
import { TelegramBot } from "./telegram/bot.js";

// ---------------------------------------------------------------------- env

// Load env from the repo root .env first (dotenv never overrides values that
// are already set), then fall back to a local apps/worker/.env.
const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(here, "..", "..", "..", ".env"), quiet: true });
dotenv.config({ quiet: true });

interface WorkerConfig {
  supabaseUrl: string;
  serviceRoleKey: string;
  anthropicApiKey: string;
  telegramBotToken?: string;
  /**
   * Fallback clone credential for projects with no github integration. The
   * per-project `cloneToken` is preferred — see
   * `WorkspaceManager.resolveCloneToken`.
   */
  githubToken?: string;
  workspacesRoot: string;
  /** Enqueue a coalesced librarian knowledge sweep when a run finishes (0006). */
  sweepAfterRuns: boolean;
}

function loadConfig(): WorkerConfig {
  const missing: string[] = [];
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY ?? "";

  if (!supabaseUrl) missing.push("NEXT_PUBLIC_SUPABASE_URL");
  if (!serviceRoleKey) missing.push("SUPABASE_SERVICE_ROLE_KEY");
  if (!anthropicApiKey) missing.push("ANTHROPIC_API_KEY");
  if (missing.length > 0) {
    logger.error("worker", `missing required environment variables: ${missing.join(", ")}`);
    process.exit(1);
  }

  // Post-run knowledge sweeps are on unless explicitly switched off.
  const sweepFlag = (process.env.KNOWLEDGE_SWEEP_AFTER_RUNS ?? "").trim().toLowerCase();

  return {
    supabaseUrl,
    serviceRoleKey,
    anthropicApiKey,
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || undefined,
    githubToken: process.env.GITHUB_TOKEN || undefined,
    workspacesRoot: path.resolve(process.cwd(), process.env.WORKSPACES_ROOT || "./workspaces-data"),
    sweepAfterRuns: sweepFlag !== "false" && sweepFlag !== "0",
  };
}

// --------------------------------------------------------------------- main

async function main(): Promise<void> {
  const config = loadConfig();
  logger.info("worker", `starting Agent Fleet worker (workspaces root: ${config.workspacesRoot})`);

  const supabase = createServiceClient(config.supabaseUrl, config.serviceRoleKey);

  const workspaces = new WorkspaceManager(supabase, config.workspacesRoot, config.githubToken);
  // Task slots shared between the poller and the executor's ask_agent tool
  // (which releases its slot while waiting on a child task).
  const taskSlots = new Semaphore(MAX_CONCURRENT_TASKS);
  const executor = new TaskExecutor(supabase, workspaces, config.workspacesRoot, taskSlots, config.sweepAfterRuns);
  if (!config.sweepAfterRuns) {
    logger.info("worker", "KNOWLEDGE_SWEEP_AFTER_RUNS is off — the librarian only sweeps on its schedule");
  }
  const poller = new TaskPoller(supabase, taskSlots, (task) => executor.executeTask(task));
  const managerListener = new ManagerListener(supabase, workspaces, config.workspacesRoot);
  const scheduler = new Scheduler(supabase);
  const actionExecutor = new ActionExecutor(supabase);

  let telegramBot: TelegramBot | undefined;
  if (config.telegramBotToken) {
    telegramBot = new TelegramBot(config.telegramBotToken, supabase);
    const notifier = (projectId: string, text: string) => telegramBot!.notifyProject(projectId, text);
    executor.setTelegramNotifier(notifier);
    managerListener.setTelegramNotifier(notifier);
    actionExecutor.setTelegramNotifier(notifier);
    const pendingActionNotifier = (action: Parameters<TelegramBot["notifyPendingAction"]>[0], projectName: string, agentName: string) =>
      telegramBot!.notifyPendingAction(action, projectName, agentName);
    executor.setPendingActionNotifier(pendingActionNotifier);
    managerListener.setPendingActionNotifier(pendingActionNotifier);
    telegramBot.start();
  } else {
    logger.info("worker", "TELEGRAM_BOT_TOKEN not set — Telegram bot disabled");
  }

  workspaces.startSweep();
  await poller.start();
  managerListener.start();
  scheduler.start();
  actionExecutor.start();

  logger.info("worker", "all subsystems running");

  // ------------------------------------------------------ graceful shutdown

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("worker", `received ${signal} — shutting down`);
    try {
      scheduler.stop();
      await actionExecutor.stop();
      await poller.stop();
      await managerListener.stop();
      workspaces.stopSweep();
      if (telegramBot) await telegramBot.stop();
    } catch (err) {
      logger.error("worker", "error during shutdown", err);
    }
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // The process must not crash on stray async failures.
  process.on("unhandledRejection", (reason) => {
    logger.error("worker", "unhandled promise rejection", reason);
  });
  process.on("uncaughtException", (err) => {
    logger.error("worker", "uncaught exception", err);
  });
}

void main().catch((err) => {
  logger.error("worker", "fatal startup error", err);
  process.exit(1);
});
