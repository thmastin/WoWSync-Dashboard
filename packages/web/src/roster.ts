import { classifyAgeBand, type AgeBand } from "@wowsync-dashboard/core/needsAttention.ts";
import type { CharacterFacts } from "./types.ts";

/** N4 sync-age bands (same as Needs Attention). Legacy: stale → aging|old, unknown → never. */
export type RosterAgeFilter = "" | AgeBand | "stale" | "unknown";
export type RosterSortKey = "name" | "level" | "gold" | "synced" | "class" | "realm" | "bags" | "bank";

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
  const ascendingExplicit = raw.startsWith("+");
  const keyToken = descending || ascendingExplicit ? raw.slice(1) : raw;
  const allowed: RosterSortKey[] = ["name", "level", "gold", "synced", "class", "realm", "bags", "bank"];
  if (!allowed.includes(keyToken as RosterSortKey)) return { key: "name", descending: false };
  const key = keyToken as RosterSortKey;
  // Bare "synced" means newest-first (desc). Explicit "+synced" is oldest-first.
  if (key === "synced" && !descending && !ascendingExplicit) {
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

/** Known bank before unknown; OBSERVED before LAST_SEEN. Unknown sorts last (never coerced to 0). */
function bankRank(status: CharacterFacts["bankStatus"] | undefined): number | undefined {
  if (status === undefined || status === "UNKNOWN") return undefined;
  if (status === "OBSERVED") return 0;
  if (status === "LAST_SEEN") return 1;
  return 2;
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
      case "bags": {
        cmp = compareNullableNumber(a.bagsFreeSlots, b.bagsFreeSlots);
        if (cmp === 0) cmp = compareNullableNumber(a.bagsTotalSlots, b.bagsTotalSlots);
        break;
      }
      case "bank":
        cmp = compareNullableNumber(bankRank(a.bankStatus), bankRank(b.bankStatus));
        break;
      case "name":
      default:
        cmp = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
        break;
    }
    if (cmp === 0) cmp = a.identityKey.localeCompare(b.identityKey);

    // Nulls-last for nullable columns: unknown stays after known in BOTH directions
    // (never coerce unknown to 0, and never let descending pull unknowns to the top).
    const aMissing = isSortMissing(a, key);
    const bMissing = isSortMissing(b, key);
    if (aMissing !== bMissing) return aMissing ? 1 : -1;

    return descending ? -cmp : cmp;
  });
  return copy;
}

function isSortMissing(c: CharacterFacts, key: RosterSortKey): boolean {
  switch (key) {
    case "level":
      return c.level === undefined;
    case "gold":
      return c.goldCopper === undefined;
    case "synced":
      return c.lastObservedAt === undefined;
    case "bags":
      return c.bagsFreeSlots === undefined && c.bagsTotalSlots === undefined;
    case "bank":
      return c.bankStatus === undefined || c.bankStatus === "UNKNOWN";
    default:
      return false;
  }
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
    // First activation: synced defaults to newest-first (desc); others ascending.
    return key === "synced" ? "synced" : key;
  }
  if (key === "synced") {
    // Bare "synced" means desc; ascending is "+synced" (see parseSort).
    return parsed.descending ? "+synced" : "synced";
  }
  return parsed.descending ? key : `-${key}`;
}
/** Show free/total when known; never display unknown as 0. */
export function formatBagSlots(free?: number, total?: number): string {
  if (free === undefined && total === undefined) return "?";
  const freeText = free === undefined ? "?" : String(free);
  const totalText = total === undefined ? "?" : String(total);
  return freeText + "/" + totalText;
}
