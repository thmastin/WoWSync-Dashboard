import type { CharacterFacts, InventoryAggregateEntry, InventoryFacts, StorageLocation } from "./types.ts";

export const ITEM_SEARCH_RESULT_CAP = 50;

export type ItemStorageFilter = "" | "bags" | "bank";
/** URL/UI: bound | unbound | "" (all). Export uses bound "yes"/"no". */
export type ItemBoundFilter = "" | "bound" | "unbound";

export interface ItemSearchFilters {
  q: string;
  storage: ItemStorageFilter;
  bound: ItemBoundFilter;
}

export interface ItemSearchRow {
  itemKey: string;
  itemName: string;
  identityKey: string;
  characterName: string;
  realm: string;
  storage: StorageLocation;
  qty: number;
  /** Raw export binding when present ("yes" / "no" today). */
  bound?: string;
  /** Unix seconds for the storage observation when known. */
  observedAt?: number;
  /** Section observation caveat for this row's storage (never invents UNKNOWN rows). */
  storageState: "OBSERVED" | "LAST_SEEN" | "UNKNOWN";
}

export interface ItemSearchResult {
  rows: ItemSearchRow[];
  totalMatches: number;
  truncated: boolean;
  hiddenCount: number;
}

function observedAtFor(character: CharacterFacts | undefined, storage: StorageLocation): number | undefined {
  if (!character) return undefined;
  if (storage === "bank") return character.bankObservedAt ?? character.lastObservedAt;
  return character.lastObservedAt;
}

function storageStateFor(
  character: CharacterFacts | undefined,
  storage: StorageLocation,
): "OBSERVED" | "LAST_SEEN" | "UNKNOWN" {
  if (!character) return "UNKNOWN";
  const state = storage === "bank" ? character.bankStatus : character.bagsStatus;
  if (state === "LAST_SEEN" || state === "UNKNOWN" || state === "OBSERVED") return state;
  return "UNKNOWN";
}

/** Normalize export bound strings into yes / no / unknown. */
export function classifyBound(bound: string | undefined): "bound" | "unbound" | "unknown" {
  if (bound === undefined || !bound.trim()) return "unknown";
  const b = bound.trim().toLowerCase();
  if (b === "yes" || b === "bound" || b === "bop" || b === "soulbound") return "bound";
  if (b === "no" || b === "unbound" || b === "boe" || b === "none") return "unbound";
  return "unknown";
}

/** Flatten inventory aggregates into per-location rows, joining realm/age from characters. */
export function flattenInventoryRows(
  inventory: InventoryFacts,
  characters: readonly CharacterFacts[],
): ItemSearchRow[] {
  const byKey = new Map(characters.map((c) => [c.identityKey, c]));
  const rows: ItemSearchRow[] = [];
  for (const item of inventory.items) {
    const itemName = item.name?.trim() ? item.name : "?";
    for (const loc of item.locations) {
      const character = byKey.get(loc.identityKey);
      rows.push({
        itemKey: item.itemKey,
        itemName,
        identityKey: loc.identityKey,
        characterName: loc.name,
        realm: character?.realm ?? "",
        storage: loc.storage,
        qty: loc.qty,
        bound: loc.bound,
        observedAt: observedAtFor(character, loc.storage),
        storageState: storageStateFor(character, loc.storage),
      });
    }
  }
  return rows;
}

export function filterItemRows(rows: readonly ItemSearchRow[], filters: ItemSearchFilters | string): ItemSearchRow[] {
  const f: ItemSearchFilters =
    typeof filters === "string" ? { q: filters, storage: "", bound: "" } : filters;
  const q = f.q.trim().toLowerCase();
  if (q.length === 0) return [];
  return rows.filter((row) => {
    if (!row.itemName.toLowerCase().includes(q)) return false;
    if (f.storage === "bags" || f.storage === "bank") {
      if (row.storage !== f.storage) return false;
    }
    if (f.bound === "bound" || f.bound === "unbound") {
      if (classifyBound(row.bound) !== f.bound) return false;
    }
    return true;
  });
}

export function sortItemRows(rows: readonly ItemSearchRow[]): ItemSearchRow[] {
  return [...rows].sort((a, b) => {
    const byName = a.itemName.localeCompare(b.itemName, undefined, { sensitivity: "base" });
    if (byName !== 0) return byName;
    const byChar = a.characterName.localeCompare(b.characterName, undefined, { sensitivity: "base" });
    if (byChar !== 0) return byChar;
    const byStorage = a.storage.localeCompare(b.storage);
    if (byStorage !== 0) return byStorage;
    return a.realm.localeCompare(b.realm, undefined, { sensitivity: "base" });
  });
}

export function searchItemRows(
  inventory: InventoryFacts,
  characters: readonly CharacterFacts[],
  filters: ItemSearchFilters | string,
  cap = ITEM_SEARCH_RESULT_CAP,
): ItemSearchResult {
  const f: ItemSearchFilters =
    typeof filters === "string" ? { q: filters, storage: "", bound: "" } : filters;
  const matched = sortItemRows(filterItemRows(flattenInventoryRows(inventory, characters), f));
  const totalMatches = matched.length;
  const rows = matched.slice(0, cap);
  const hiddenCount = Math.max(0, totalMatches - rows.length);
  return { rows, totalMatches, truncated: hiddenCount > 0, hiddenCount };
}

/** Keep for callers that still want aggregate-shaped matches (Economy pointer / tests). */
export function filterInventoryAggregates(
  items: readonly InventoryAggregateEntry[],
  query: string,
): InventoryAggregateEntry[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return [];
  return items.filter((item) => (item.name ?? "").toLowerCase().includes(q));
}