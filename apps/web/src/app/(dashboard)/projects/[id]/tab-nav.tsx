"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { api } from "@/lib/api-client";
import { usePolling } from "@/lib/use-polling";
import { cn } from "@/lib/utils";

const TABS = [
  { segment: "", label: "Board" },
  { segment: "review", label: "Review" },
  { segment: "chat", label: "Chat" },
  { segment: "agents", label: "Agents" },
  { segment: "knowledge", label: "Knowledge" },
  { segment: "schedules", label: "Schedules" },
  { segment: "workspaces", label: "Workspaces" },
  { segment: "activity", label: "Activity" },
];

/**
 * Small badge with the number of actions awaiting approval. Polls every 5s
 * (cheap: one filtered GET) so the count is visible from any tab.
 */
function PendingCountBadge({ projectId }: { projectId: string }) {
  const { data: count } = usePolling<number>(
    React.useCallback(async () => {
      const { actions } = await api<{ actions: unknown[] }>(
        `/api/projects/${projectId}/pending-actions?status=pending`,
      );
      return actions.length;
    }, [projectId]),
    5000,
    [projectId],
  );

  if (!count) return null;
  return (
    <span className="ml-1.5 inline-flex min-w-4 items-center justify-center rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-amber-400">
      {count}
    </span>
  );
}

export function TabNav({ projectId }: { projectId: string }) {
  const pathname = usePathname();
  const base = `/projects/${projectId}`;

  return (
    <nav className="mt-4 flex gap-1">
      {TABS.map((tab) => {
        const href = tab.segment ? `${base}/${tab.segment}` : base;
        const active = tab.segment
          ? pathname.startsWith(href)
          : pathname === base;
        return (
          <Link
            key={tab.label}
            href={href}
            className={cn(
              "relative rounded-t-md px-3 pb-3 pt-1.5 text-sm font-medium transition-colors",
              active
                ? "text-foreground after:absolute after:inset-x-1 after:bottom-0 after:h-0.5 after:rounded-full after:bg-primary"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {tab.label}
            {tab.segment === "review" && (
              <PendingCountBadge projectId={projectId} />
            )}
          </Link>
        );
      })}
    </nav>
  );
}
