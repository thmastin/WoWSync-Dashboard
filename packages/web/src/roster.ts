import { classifyAgeBand, type AgeBand } from "@wowsync-dashboard/core/needsAttention.ts";
import type { CharacterFacts } from "./types.ts";

/** N4 sync-age bands (same as Needs Attention). Legacy: stale → aging|old, unknown → never. */
export type RosterAgeFilter = "" | AgeBand | "stale" | "unknown";
export type RosterSortKey = "name" | "level" | "gold" | "synced" | "class" | "realm";

export interface RosterFilters {
  q: string;
  classFilter: string;
  age: RosterAgeFilter | string;
  /** e.g. "name", "-level", "synced" (newest first), "-synced" (oldest first). */
  sort: string;
  /** When true, only characters whose bank was never observed. */
  bankMissing: boolean;
  /** AccountFacts.generatedAt — required for age-band filtering. */
  now: number;
}

export const ROSTER_AGE_OPTIONS: { value: AgeBand | ""; label: string }[] = [
  { value: "", label: "All" },
  { value: "recent", label: "Within 3 days" },
  { value: "aging", label: "3–14 days" },
  { value: "old", label: "Older than 14 days" },
  { value: "never", label: "Never synced" },
];

export function parseSort(sort: string): { key: RosterSortKey; descending: boolean } {
  const raw = (sort || "name").trim();
  const descending = raw.startsWith("-");
  const key = (descending ? raw.slice(1) : raw) as RosterSortKey;
  const allowed: RosterSortKey[] = ["name", "level", "gold", "synced", "class", "realm"];
  if (!allowed.includes(key)) return { key: "name", descending: false };
  if (key === "synced" && !raw.startsWith("-") && !raw.startsWith("+")) {
    return { key, descending: true };
  }
  return { key, descending };
}

function matchesQuery(c: CharacterFacts, q: string): boolean {
  if (!q.trim()) return true;
  const needle = q.trim().toLowerCase();
  return [c.name, c.realm, c.class ?? "", c.faction ?? ""].some((s) => s.toLowerCase().includes(needle));
}

function matchesAge(c: CharacterFacts, age: string, now: number): boolean {
  if (!age) return true;
  const band = classifyAgeBand(c.lastObservedAt, now);
  if (age === "stale") return band === "aging" || band === "old";
  if (age === "unknown") return band === "never";
  return band === age;
}

export function filterRoster(characters: readonly CharacterFacts[], filters: RosterFilters): CharacterFacts[] {
  return characters.filter((c) => {
    if (!matchesQuery(c, filters.q)) return false;
    if (filters.classFilter && (c.class ?? "") !== filters.classFilter) return false;
    if (!matchesAge(c, filters.age, filters.now)) return false;
    if (filters.bankMissing && c.bankStatus !== "UNKNOWN") return false;
    return true;
  });
}

function compareNullableNumber(a: number | undefined, b: number | undefined): number {
  if (a === undefined && b === undefined) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  return a - b;
}

function compareNullableString(a: string | undefined, b: string | undefined): number {
  return (a ?? "").localeCompare(b ?? "", undefined, { sensitivity: "base" });
}

export function sortRoster(characters: readonly CharacterFacts[], sort: string): CharacterFacts[] {
  const { key, descending } = parseSort(sort);
  const copy = [...characters];
  copy.sort((a, b) => {
    let cmp = 0;
    switch (key) {
      case "level":
        cmp = compareNullableNumber(a.level, b.level);
        break;
      case "gold":
        cmp = compareNullableNumber(a.goldCopper, b.goldCopper);
        break;
      case "synced": {
        const aMissing = a.lastObservedAt === undefined;
        const bMissing = b.lastObservedAt === undefined;
        if (aMissing && bMissing) cmp = 0;
        else if (aMissing) cmp = 1;
        else if (bMissing) cmp = -1;
        else cmp = a.lastObservedAt! - b.lastObservedAt!;
        break;
      }
      case "class":
        cmp = compareNullableString(a.class, b.class);
        break;
      case "realm":
        cmp = compareNullableString(a.realm, b.realm);
        break;
      case "name":
      default:
        cmp = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
        break;
    }
    if (cmp === 0) cmp = a.identityKey.localeCompare(b.identityKey);
    if (key === "synced") {
      const aMissing = a.lastObservedAt === undefined;
      const bMissing = b.lastObservedAt === undefined;
      if (aMissing !== bMissing) return aMissing ? 1 : -1;
    }
    return descending ? -cmp : cmp;
  });
  return copy;
}

export function filterAndSortRoster(characters: readonly CharacterFacts[], filters: RosterFilters): CharacterFacts[] {
  return sortRoster(filterRoster(characters, filters), filters.sort);
}

export function rosterClassOptions(characters: readonly CharacterFacts[]): string[] {
  const set = new Set<string>();
  for (const c of characters) if (c.class) set.add(c.class);
  return [...set].sort((a, b) => a.localeCompare(b));
}

export function toggleSort(current: string, key: RosterSortKey): string {
  const parsed = parseSort(current);
  if (parsed.key !== key) {
    return key === "synced" ? "synced" : key;
  }
  return parsed.descending ? key : `-${key}`;
}