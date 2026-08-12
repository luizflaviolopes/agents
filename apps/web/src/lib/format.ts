/** "2m ago" style relative timestamp. */
export function timeAgo(iso: string | null): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

/** Duration between two timestamps, e.g. "1m 24s". Falls back to "…" while running. */
export function formatDuration(
  startIso: string | null,
  endIso: string | null,
): string {
  if (!startIso) return "";
  const end = endIso ? new Date(endIso).getTime() : Date.now();
  const seconds = Math.max(0, Math.floor((end - new Date(startIso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Compact count for token totals, e.g. 950, 12.3K, 1.2M. */
export function formatCompactNumber(value: number): string {
  return new Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

/** USD amount with 2 decimals; tiny non-zero amounts render as "<$0.01". */
export function formatUsd(value: number): string {
  if (value > 0 && value < 0.005) return "<$0.01";
  return `$${value.toFixed(2)}`;
}

/** USD amount with 4 decimals — for per-run costs. */
export function formatUsdPrecise(value: number): string {
  return `$${value.toFixed(4)}`;
}

/** Slugify a workspace name into a safe folder name. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

/** Derive a repo folder name from a git URL: last path segment minus ".git". */
export function repoFolderFromUrl(url: string): string {
  try {
    const cleaned = url.replace(/\/+$/, "").replace(/\.git$/, "");
    const segment = cleaned.split("/").pop() ?? "";
    return segment.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 64);
  } catch {
    return "";
  }
}
