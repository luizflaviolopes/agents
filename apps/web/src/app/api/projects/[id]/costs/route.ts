import { NextResponse } from "next/server";
import {
  apiHandler,
  jsonError,
  requireProjectAccess,
  requireUser,
} from "@/lib/api/auth";
import { getAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const PERIOD_DAYS = { "1d": 1, "7d": 7, "30d": 30 } as const;
type Period = keyof typeof PERIOD_DAYS | "all";

/** Generous v1 cap — aggregation happens in TS after fetching these rows. */
const MAX_ROWS = 5000;

/** The cost columns fetched per run (joined to agents for display names). */
interface CostRunRow {
  agent_id: string | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  cost_usd: number | null;
  started_at: string;
  agent: { id: string; name: string } | null;
}

interface AgentCosts {
  agentId: string | null;
  agentName: string;
  model: string | null;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  runs: number;
}

/**
 * GET /api/projects/[id]/costs?period=1d|7d|30d|all — token/cost totals for
 * the project's task runs in the period (default 30d), overall and per agent.
 */
export const GET = apiHandler(async (request: Request, { params }: Params) => {
  const { id } = await params;
  const user = await requireUser();
  await requireProjectAccess(user.id, id);

  const raw = new URL(request.url).searchParams.get("period") ?? "30d";
  if (raw !== "all" && !(raw in PERIOD_DAYS)) {
    return jsonError(400, "Invalid period — use 1d, 7d, 30d or all");
  }
  const period = raw as Period;

  const admin = getAdminClient();
  let query = admin
    .from("task_runs")
    .select(
      "agent_id, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd, started_at, task:tasks!inner(project_id), agent:agents(id, name)",
    )
    .eq("task.project_id", id)
    .order("started_at", { ascending: false })
    .limit(MAX_ROWS);
  if (period !== "all") {
    const cutoff = new Date(
      Date.now() - PERIOD_DAYS[period] * 24 * 60 * 60 * 1000,
    ).toISOString();
    query = query.gte("started_at", cutoff);
  }
  const { data, error } = await query;
  if (error) return jsonError(500, error.message);
  const rows = (data ?? []) as unknown as CostRunRow[];

  const totals = {
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    runs: 0,
  };
  const byAgentMap = new Map<string, AgentCosts>();

  for (const row of rows) {
    totals.runs += 1;
    totals.costUsd += row.cost_usd ?? 0;
    totals.inputTokens += row.input_tokens ?? 0;
    totals.outputTokens += row.output_tokens ?? 0;
    totals.cacheReadTokens += row.cache_read_tokens ?? 0;
    totals.cacheCreationTokens += row.cache_creation_tokens ?? 0;

    const key = row.agent_id ?? "deleted";
    let entry = byAgentMap.get(key);
    if (!entry) {
      entry = {
        agentId: row.agent_id,
        agentName: row.agent?.name ?? "Deleted agent",
        model: null,
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        runs: 0,
      };
      byAgentMap.set(key, entry);
    }
    entry.runs += 1;
    entry.costUsd += row.cost_usd ?? 0;
    entry.inputTokens += row.input_tokens ?? 0;
    entry.outputTokens += row.output_tokens ?? 0;
    // Rows come newest first, so the first model seen is the latest used.
    if (!entry.model && row.model) entry.model = row.model;
  }

  const round = (value: number) => Math.round(value * 1e6) / 1e6;
  totals.costUsd = round(totals.costUsd);
  const byAgent = [...byAgentMap.values()]
    .map((entry) => ({ ...entry, costUsd: round(entry.costUsd) }))
    .sort((a, b) => b.costUsd - a.costUsd);

  return NextResponse.json({ totals, byAgent });
});
