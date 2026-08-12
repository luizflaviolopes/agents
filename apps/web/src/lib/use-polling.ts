"use client";

import * as React from "react";

export interface PollingResult<T> {
  /** Latest successful result; undefined until the first fetch completes. */
  data: T | undefined;
  /** Last fetch error (cleared on the next success). */
  error: Error | null;
  /** True until the first result (or first error) arrives. */
  loading: boolean;
  /** Re-run the fetcher immediately (also restarts the interval). */
  refresh: () => void;
}

/**
 * Poll a fetcher: fetch immediately, re-fetch every `intervalMs`, pause while
 * `document.hidden` (with a catch-up fetch when the tab becomes visible
 * again). This replaces the Supabase Realtime subscriptions the web app used
 * to hold — the browser can no longer talk to Postgres directly.
 *
 * The latest `fetcher` is always used, so it may close over changing state
 * without being listed in `deps`; `deps` only controls when polling restarts.
 */
export function usePolling<T>(
  fetcher: () => Promise<T>,
  intervalMs: number,
  deps: React.DependencyList = [],
  enabled = true,
): PollingResult<T> {
  const [data, setData] = React.useState<T | undefined>(undefined);
  const [error, setError] = React.useState<Error | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [tick, setTick] = React.useState(0);

  const fetcherRef = React.useRef(fetcher);
  fetcherRef.current = fetcher;

  React.useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    async function run() {
      if (typeof document !== "undefined" && document.hidden) return;
      try {
        const result = await fetcherRef.current();
        if (cancelled) return;
        setData(result);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err : new Error(String(err)));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void run();
    const timer = setInterval(() => void run(), intervalMs);
    const onVisibility = () => {
      if (!document.hidden) void run();
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, enabled, tick, ...deps]);

  const refresh = React.useCallback(() => setTick((t) => t + 1), []);

  return { data, error, loading, refresh };
}
