export function formatCopper(copper: number | undefined): string {
  if (copper === undefined) return "?";
  const negative = copper < 0;
  const abs = Math.abs(copper);
  const gold = Math.floor(abs / 10000);
  const silver = Math.floor((abs % 10000) / 100);
  const bronze = abs % 100;
  const parts: string[] = [];
  if (gold > 0) parts.push(`${gold}g`);
  if (silver > 0 || gold > 0) parts.push(`${silver}s`);
  parts.push(`${bronze}c`);
  return (negative ? "-" : "") + parts.join(" ");
}

export function formatCopperDelta(delta: number | undefined): string {
  if (delta === undefined) return "";
  if (delta === 0) return "±0c";
  return (delta > 0 ? "+" : "") + formatCopper(delta);
}

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
  const deltaSeconds = Date.now() / 1000 - unixSeconds;
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
