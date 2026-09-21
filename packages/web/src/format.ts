// The single implementation lives in @wowsync-dashboard/core (shared with
// the LLM-facing projection, llmContext.ts) - re-exported here rather than
// duplicated, per this project's "never duplicate business logic" rule.
export { formatCopper, formatCopperDelta } from "@wowsync-dashboard/core/currency.ts";

export function formatPlaytime(seconds: number | undefined): string {
  if (seconds === undefined) return "?";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0 || days > 0) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
  return parts.join(" ");
}

export function formatRelativeTime(unixSeconds: number | undefined): string {
  if (unixSeconds === undefined) return "never";
  return formatAgeSeconds(Date.now() / 1000 - unixSeconds);
}

/** "just now" / "5m ago" / "3h ago" / "2d ago" ... for an age in seconds (deterministic: no clock is read). */
export function formatAgeSeconds(deltaSeconds: number): string {
  if (deltaSeconds < 60) return "just now";
  const minutes = Math.floor(deltaSeconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

export function formatAbsoluteTime(unixSeconds: number | undefined): string {
  if (unixSeconds === undefined) return "unknown";
  return new Date(unixSeconds * 1000).toLocaleString();
}

export function formatXpPercent(percent: number | undefined): string {
  if (percent === undefined) return "?";
  return `${percent.toFixed(1)}%`;
}

const FRESHNESS_LABELS: Record<string, string> = {
  recent: "Recent",
  stale: "Stale",
  unknown: "Unknown",
};

export function freshnessLabel(freshness: string): string {
  return FRESHNESS_LABELS[freshness] ?? freshness;
}
