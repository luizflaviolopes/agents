"use client";

import * as React from "react";
import type { Agent } from "@agent-fleet/shared";
import { api } from "@/lib/api-client";
import { usePolling } from "@/lib/use-polling";
import { formatCompactNumber, formatUsd } from "@/lib/format";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

export type CostPeriod = "1d" | "7d" | "30d" | "all";

/** Response shape of GET /api/projects/[id]/costs. */
export interface ProjectCosts {
  totals: {
    costUsd: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    runs: number;
    /** Runs on the worker's Claude Code subscription — quota, not dollars. */
    unbilledRuns: number;
  };
  byAgent: Array<{
    agentId: string | null;
    agentName: string;
    model: Agent["model"] | null;
    costUsd: number;
    inputTokens: number;
    outputTokens: number;
    runs: number;
    unbilledRuns: number;
  }>;
}

const PERIODS: Array<{ value: CostPeriod; label: string }> = [
  { value: "1d", label: "Today" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "all", label: "All" },
];

/**
 * Cost summary for the project's task runs: period selector, headline total,
 * and a per-agent breakdown. Polls the costs API every 30s.
 */
export function CostsCard({ projectId }: { projectId: string }) {
  const [period, setPeriod] = React.useState<CostPeriod>("30d");

  const { data, loading } = usePolling<ProjectCosts>(
    React.useCallback(
      () => api<ProjectCosts>(`/api/projects/${projectId}/costs?period=${period}`),
      [projectId, period],
    ),
    30000,
    [projectId, period],
  );

  return (
    <Card className="mb-5">
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="text-sm">Costs</CardTitle>
        <Tabs value={period} onValueChange={(v) => setPeriod(v as CostPeriod)}>
          <TabsList className="h-8">
            {PERIODS.map((p) => (
              <TabsTrigger key={p.value} value={p.value} className="px-2.5 text-xs">
                {p.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </CardHeader>
      <CardContent>
        {loading || !data ? (
          <div className="space-y-2">
            <Skeleton className="h-8 w-40" />
            <Skeleton className="h-20" />
          </div>
        ) : (
          <>
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-semibold tabular-nums">
                {formatUsd(data.totals.costUsd)}
              </span>
              <span className="text-sm text-muted-foreground">
                {data.totals.runs} run{data.totals.runs === 1 ? "" : "s"}
                {" · "}
                {formatCompactNumber(data.totals.inputTokens)} in /{" "}
                {formatCompactNumber(data.totals.outputTokens)} out
              </span>
            </div>

            {/* Subscription runs (0013) do real work this total cannot price. */}
            {data.totals.unbilledRuns > 0 && (
              <p className="mt-1 text-xs text-muted-foreground">
                Excludes {data.totals.unbilledRuns} run
                {data.totals.unbilledRuns === 1 ? "" : "s"} on the Claude Code
                subscription — billed against its quota, not per token.
              </p>
            )}

            {data.byAgent.length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">
                No runs in this period.
              </p>
            ) : (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[22rem] text-xs">
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th className="py-1.5 pr-2 font-medium">Agent</th>
                    <th className="py-1.5 pr-2 text-right font-medium">Runs</th>
                    <th className="py-1.5 pr-2 text-right font-medium">In</th>
                    <th className="py-1.5 pr-2 text-right font-medium">Out</th>
                    <th className="py-1.5 text-right font-medium">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byAgent.map((row) => (
                    <tr
                      key={row.agentId ?? "deleted"}
                      className="border-b border-border/50 last:border-0"
                    >
                      <td className="max-w-0 py-1.5 pr-2">
                        <div className="truncate font-medium">{row.agentName}</div>
                        {row.model && (
                          <div className="truncate font-mono text-[10px] text-muted-foreground">
                            {row.model}
                          </div>
                        )}
                      </td>
                      <td className="py-1.5 pr-2 text-right tabular-nums text-muted-foreground">
                        {row.runs}
                      </td>
                      <td className="py-1.5 pr-2 text-right tabular-nums text-muted-foreground">
                        {formatCompactNumber(row.inputTokens)}
                      </td>
                      <td className="py-1.5 pr-2 text-right tabular-nums text-muted-foreground">
                        {formatCompactNumber(row.outputTokens)}
                      </td>
                      <td className="py-1.5 text-right font-medium tabular-nums">
                        {row.unbilledRuns === row.runs ? (
                          <span
                            className="font-normal text-muted-foreground"
                            title="Ran on the worker's Claude Code subscription — billed against its quota, not per token."
                          >
                            subscription
                          </span>
                        ) : (
                          <>
                            {formatUsd(row.costUsd)}
                            {row.unbilledRuns > 0 && (
                              <span
                                className="ml-1 font-normal text-muted-foreground"
                                title={`${row.unbilledRuns} of these runs used the Claude Code subscription and are not priced here.`}
                              >
                                +{row.unbilledRuns} sub
                              </span>
                            )}
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
