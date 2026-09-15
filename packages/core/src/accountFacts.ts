// AccountFacts: the deterministic layer between the database and any
// future analysis (LLM or otherwise).
//
//   SnapshotStore -> AccountFacts -> Dashboard -> (future) LLM context builder
//
// This module is pure — no I/O, no clock reads. Everything it needs
// (characters, their latest parsed snapshot, their diff against the
// previous snapshot, the version's already-filtered "meaningful" recent
// changes, and the current time) is handed in. The same input always
// produces the same output.
//
// Hard rule throughout: UNKNOWN is never turned into zero/empty. A
// character whose bank was never observed contributes nothing to
// inventory totals and is listed separately as "unknown", not counted as
// having an empty bank. A profession section that is UNKNOWN is not the
// same as "no professions" (which is what `noneMessage` represents).

import { baseItemId, type SnapshotDiff } from "./diff.ts";
import { classifyFreshness, type Freshness } from "./freshness.ts";
import type { ParsedSnapshot, SectionState, VersionOrUnknown } from "./types.ts";
import type { RecentChange, StoredCharacterSummary } from "./store.ts";

// ---------------------------------------------------------------------
// Characters
// ---------------------------------------------------------------------

export interface CharacterFacts {
  identityKey: string;
  name: string;
  realm: string;
  class?: string;
  faction?: string;
  level?: number;
  xp?: number;
  xpMax?: number;
  xpPercent?: number;
  goldCopper?: number;
  playedSeconds?: number;
  levelPlayedSeconds?: number;
  lastObservedAt?: number;
  lastImportedAt?: number;
  snapshotCount: number;
  freshness: Freshness;
  bankStatus: SectionState;
}

// ---------------------------------------------------------------------
// Gold
// ---------------------------------------------------------------------

export interface CharacterGold {
  identityKey: string;
  name: string;
  goldCopper?: number;
  deltaCopper?: number;
}

export interface GoldFacts {
  /** Sum of goldCopper across characters where it's actually known. Never assumes 0 for an unknown character. */
  totalKnownCopper: number;
  charactersWithKnownGold: number;
  charactersWithUnknownGold: number;
  byCharacter: CharacterGold[];
  /** Characters with the largest known gold change since their previous snapshot, sorted by magnitude descending. */
  largestRecentChanges: CharacterGold[];
}

// ---------------------------------------------------------------------
// Playtime
// ---------------------------------------------------------------------

export interface CharacterPlaytime {
  identityKey: string;
  name: string;
  playedSeconds?: number;
  levelPlayedSeconds?: number;
  deltaPlayedSeconds?: number;
  deltaLevelPlayedSeconds?: number;
}

export interface PlaytimeFacts {
  totalKnownPlayedSeconds: number;
  charactersWithKnownPlaytime: number;
  byCharacter: CharacterPlaytime[];
}

// ---------------------------------------------------------------------
// Progression
// ---------------------------------------------------------------------

export interface CharacterProgression {
  identityKey: string;
  name: string;
  level?: number;
  xp?: number;
  xpMax?: number;
  xpPercent?: number;
  /** Only present when 2+ snapshots exist for this character — never estimated from one snapshot. */
  levelDeltaSincePrevious?: number;
}

export interface LevelUp {
  identityKey: string;
  name: string;
  fromLevel: number;
  toLevel: number;
}

export interface ProgressionFacts {
  byCharacter: CharacterProgression[];
  recentLevelUps: LevelUp[];
  /** The character with the highest known xpPercent, i.e. closest to leveling — undefined if no character has known XP. */
  closestToNextLevel?: CharacterProgression;
}

// ---------------------------------------------------------------------
// Professions
// ---------------------------------------------------------------------

export interface CharacterProfessionEntry {
  name: string;
  skill?: number;
  maxSkill?: number;
}

export interface CharacterProfessions {
  identityKey: string;
  name: string;
  /** Status of the professions section itself — UNKNOWN means "never observed", distinct from an OBSERVED section with zero entries ("no professions identified"). */
  status: SectionState;
  professions: CharacterProfessionEntry[];
}

export interface ProfessionCoverageEntry {
  profession: string;
  characters: { identityKey: string; name: string; skill?: number; maxSkill?: number }[];
}

export interface ProfessionFacts {
  byCharacter: CharacterProfessions[];
  /** The same data regrouped by profession name, across all characters with known data. */
  coverage: ProfessionCoverageEntry[];
}

// ---------------------------------------------------------------------
// Inventory (foundation)
// ---------------------------------------------------------------------

export type StorageLocation = "bags" | "bank";

export interface InventoryLocationEntry {
  identityKey: string;
  name: string;
  storage: StorageLocation;
  qty: number;
  bound?: string;
}

export interface InventoryAggregateEntry {
  /** Base item ID when the itemRef is parseable, otherwise falls back to the item name. Never the raw full itemRef (see diff.ts baseItemId — avoids false distinctions from the level embedded in real itemRefs). */
  itemKey: string;
  name?: string;
  totalKnownQty: number;
  locations: InventoryLocationEntry[];
}

export interface InventoryFacts {
  /** Every distinct known item, aggregated across all characters' known (non-UNKNOWN) bags/bank. Sorted by name. */
  items: InventoryAggregateEntry[];
  /** Characters whose bank has never been observed — their holdings are absent from `items`, not counted as zero. */
  unknownBank: { identityKey: string; name: string }[];
  /** Same, for bags (rare, but the section can be UNKNOWN just like bank). */
  unknownBags: { identityKey: string; name: string }[];
  /** True whenever any character contributes an unknown storage location — a flag the UI should use to caveat any "total". */
  hasUnknownStorage: boolean;
}

export function searchInventory(facts: InventoryFacts, query: string): InventoryAggregateEntry[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return [];
  return facts.items.filter((item) => (item.name ?? "").toLowerCase().includes(q));
}

// ---------------------------------------------------------------------
// Recent account-level changes
// ---------------------------------------------------------------------

export interface AccountChangeSummary {
  identityKey: string;
  characterName: string;
  importedAt: number;
  fromLevel?: number;
  toLevel?: number;
  levelChanged: boolean;
  goldDeltaCopper?: number;
  playtimeDeltaSeconds?: number;
  professionChanged: boolean;
  equipmentChanged: boolean;
  inventoryChanged: boolean;
  locationChanged: boolean;
  trainerUnlocked: boolean;
}

// ---------------------------------------------------------------------
// Freshness summary
// ---------------------------------------------------------------------

export interface FreshnessSummary {
  recentCharacters: number;
  staleCharacters: number;
  unknownCharacters: number;
  byCharacter: { identityKey: string; name: string; freshness: Freshness; lastObservedAt?: number }[];
}

// ---------------------------------------------------------------------
// Top-level AccountFacts
// ---------------------------------------------------------------------

export interface AccountFacts {
  version: VersionOrUnknown;
  /** Wall-clock time these facts were computed at — the reference point freshness was classified against. Passed in, never read internally. */
  generatedAt: number;
  characterCount: number;
  characters: CharacterFacts[];
  gold: GoldFacts;
  playtime: PlaytimeFacts;
  progression: ProgressionFacts;
  professions: ProfessionFacts;
  inventory: InventoryFacts;
  recentChanges: AccountChangeSummary[];
  freshness: FreshnessSummary;
}

export interface AccountFactsInput {
  version: VersionOrUnknown;
  characters: StoredCharacterSummary[];
  /** Latest parsed snapshot per character, keyed by identityKey. */
  latestParsed: Map<string, ParsedSnapshot>;
  /** Diff against the immediately preceding snapshot, only present for characters with 2+ snapshots. */
  diffs: Map<string, SnapshotDiff>;
  /** Already-filtered "this is worth surfacing" changes (see SnapshotStore.recentChanges). */
  meaningfulChanges: RecentChange[];
}

function aggregateInventorySection(
  identityKey: string,
  name: string,
  storage: StorageLocation,
  section: ParsedSnapshot["bags"] | ParsedSnapshot["bank"],
  items: Map<string, InventoryAggregateEntry>,
): void {
  for (const item of section.items) {
    const key = baseItemId(item.itemRef) ?? `name:${item.name ?? "?"}`;
    let entry = items.get(key);
    if (!entry) {
      entry = { itemKey: key, name: item.name, totalKnownQty: 0, locations: [] };
      items.set(key, entry);
    }
    const qty = item.qty ?? 0;
    entry.totalKnownQty += qty;
    entry.locations.push({ identityKey, name, storage, qty, bound: item.bound });
  }
}

export function buildAccountFacts(input: AccountFactsInput, now: number): AccountFacts {
  const { version, characters, latestParsed, diffs, meaningfulChanges } = input;

  const characterFacts: CharacterFacts[] = characters.map((c) => {
    const parsed = latestParsed.get(c.identityKey);
    const xp = parsed?.character.xp;
    const xpMax = parsed?.character.xpMax;
    const xpPercent = xp !== undefined && xpMax !== undefined && xpMax > 0 ? (xp / xpMax) * 100 : undefined;
    const lastObservedAt = c.latestGeneratedAt ?? c.latestImportedAt;
    return {
      identityKey: c.identityKey,
      name: c.name,
      realm: c.realm,
      class: c.class,
      faction: c.faction,
      level: c.latestLevel,
      xp,
      xpMax,
      xpPercent,
      goldCopper: c.latestMoneyCopper,
      playedSeconds: c.latestPlayedSeconds,
      levelPlayedSeconds: parsed?.character.levelPlayedSeconds,
      lastObservedAt,
      lastImportedAt: c.latestImportedAt,
      snapshotCount: c.snapshotCount,
      freshness: classifyFreshness(lastObservedAt, now),
      bankStatus: parsed?.bank.status.state ?? "UNKNOWN",
    };
  });

  // --- Gold ---
  const goldByCharacter: CharacterGold[] = characters.map((c) => ({
    identityKey: c.identityKey,
    name: c.name,
    goldCopper: c.latestMoneyCopper,
    deltaCopper: diffs.get(c.identityKey)?.moneyCopper.delta,
  }));
  const knownGold = goldByCharacter.filter((g) => g.goldCopper !== undefined);
  const gold: GoldFacts = {
    totalKnownCopper: knownGold.reduce((sum, g) => sum + (g.goldCopper ?? 0), 0),
    charactersWithKnownGold: knownGold.length,
    charactersWithUnknownGold: characters.length - knownGold.length,
    byCharacter: goldByCharacter,
    largestRecentChanges: goldByCharacter
      .filter((g) => g.deltaCopper !== undefined && g.deltaCopper !== 0)
      .sort((a, b) => Math.abs(b.deltaCopper ?? 0) - Math.abs(a.deltaCopper ?? 0))
      .slice(0, 5),
  };

  // --- Playtime ---
  const playtimeByCharacter: CharacterPlaytime[] = characters.map((c) => {
    const parsed = latestParsed.get(c.identityKey);
    const diff = diffs.get(c.identityKey);
    return {
      identityKey: c.identityKey,
      name: c.name,
      playedSeconds: c.latestPlayedSeconds,
      levelPlayedSeconds: parsed?.character.levelPlayedSeconds,
      deltaPlayedSeconds: diff?.playedSeconds.delta,
      deltaLevelPlayedSeconds: diff?.levelPlayedSeconds.delta,
    };
  });
  const knownPlaytime = playtimeByCharacter.filter((p) => p.playedSeconds !== undefined);
  const playtime: PlaytimeFacts = {
    totalKnownPlayedSeconds: knownPlaytime.reduce((sum, p) => sum + (p.playedSeconds ?? 0), 0),
    charactersWithKnownPlaytime: knownPlaytime.length,
    byCharacter: playtimeByCharacter,
  };

  // --- Progression ---
  const progressionByCharacter: CharacterProgression[] = characters.map((c) => {
    const parsed = latestParsed.get(c.identityKey);
    const xp = parsed?.character.xp;
    const xpMax = parsed?.character.xpMax;
    const xpPercent = xp !== undefined && xpMax !== undefined && xpMax > 0 ? (xp / xpMax) * 100 : undefined;
    return {
      identityKey: c.identityKey,
      name: c.name,
      level: c.latestLevel,
      xp,
      xpMax,
      xpPercent,
      levelDeltaSincePrevious: diffs.get(c.identityKey)?.level.delta,
    };
  });
  const recentLevelUps: LevelUp[] = progressionByCharacter
    .filter((p) => p.levelDeltaSincePrevious !== undefined && p.levelDeltaSincePrevious > 0 && p.level !== undefined)
    .map((p) => ({
      identityKey: p.identityKey,
      name: p.name,
      fromLevel: p.level! - p.levelDeltaSincePrevious!,
      toLevel: p.level!,
    }));
  const knownXpPercent = progressionByCharacter.filter((p) => p.xpPercent !== undefined);
  const closestToNextLevel =
    knownXpPercent.length > 0
      ? knownXpPercent.reduce((best, p) => (p.xpPercent! > best.xpPercent! ? p : best))
      : undefined;
  const progression: ProgressionFacts = { byCharacter: progressionByCharacter, recentLevelUps, closestToNextLevel };

  // --- Professions ---
  const professionsByCharacter: CharacterProfessions[] = characters.map((c) => {
    const section = latestParsed.get(c.identityKey)?.professions;
    return {
      identityKey: c.identityKey,
      name: c.name,
      status: section?.status.state ?? "UNKNOWN",
      professions: (section?.entries ?? []).map((e) => ({ name: e.name, skill: e.skill, maxSkill: e.maxSkill })),
    };
  });
  const coverageMap = new Map<string, ProfessionCoverageEntry["characters"]>();
  for (const cp of professionsByCharacter) {
    for (const prof of cp.professions) {
      const list = coverageMap.get(prof.name) ?? [];
      list.push({ identityKey: cp.identityKey, name: cp.name, skill: prof.skill, maxSkill: prof.maxSkill });
      coverageMap.set(prof.name, list);
    }
  }
  const coverage: ProfessionCoverageEntry[] = [...coverageMap.entries()]
    .map(([profession, chars]) => ({ profession, characters: chars }))
    .sort((a, b) => a.profession.localeCompare(b.profession));
  const professions: ProfessionFacts = { byCharacter: professionsByCharacter, coverage };

  // --- Inventory ---
  const itemMap = new Map<string, InventoryAggregateEntry>();
  const unknownBank: InventoryFacts["unknownBank"] = [];
  const unknownBags: InventoryFacts["unknownBags"] = [];
  for (const c of characters) {
    const parsed = latestParsed.get(c.identityKey);
    if (!parsed) continue;
    if (parsed.bags.status.state === "UNKNOWN") {
      unknownBags.push({ identityKey: c.identityKey, name: c.name });
    } else {
      aggregateInventorySection(c.identityKey, c.name, "bags", parsed.bags, itemMap);
    }
    if (parsed.bank.status.state === "UNKNOWN") {
      unknownBank.push({ identityKey: c.identityKey, name: c.name });
    } else {
      aggregateInventorySection(c.identityKey, c.name, "bank", parsed.bank, itemMap);
    }
  }
  const inventory: InventoryFacts = {
    items: [...itemMap.values()].sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "")),
    unknownBank,
    unknownBags,
    hasUnknownStorage: unknownBank.length > 0 || unknownBags.length > 0,
  };

  // --- Recent account-level changes ---
  const recentChanges: AccountChangeSummary[] = meaningfulChanges.map((c) => ({
    identityKey: c.identityKey,
    characterName: c.characterName,
    importedAt: c.importedAt,
    fromLevel: c.diff.level.from,
    toLevel: c.diff.level.to,
    levelChanged: !!c.diff.level.delta,
    goldDeltaCopper: c.diff.moneyCopper.delta,
    playtimeDeltaSeconds: c.diff.playedSeconds.delta,
    professionChanged: c.diff.professions.length > 0,
    equipmentChanged: c.diff.equipment.length > 0,
    inventoryChanged: c.diff.bagsItems.length > 0 || c.diff.bankItems.length > 0,
    locationChanged: c.diff.location.changed,
    trainerUnlocked: c.diff.trainerUnlocks.length > 0,
  }));

  // --- Freshness ---
  const freshnessByCharacter = characterFacts.map((c) => ({
    identityKey: c.identityKey,
    name: c.name,
    freshness: c.freshness,
    lastObservedAt: c.lastObservedAt,
  }));
  const freshness: FreshnessSummary = {
    recentCharacters: freshnessByCharacter.filter((c) => c.freshness === "recent").length,
    staleCharacters: freshnessByCharacter.filter((c) => c.freshness === "stale").length,
    unknownCharacters: freshnessByCharacter.filter((c) => c.freshness === "unknown").length,
    byCharacter: freshnessByCharacter,
  };

  return {
    version,
    generatedAt: now,
    characterCount: characters.length,
    characters: characterFacts,
    gold,
    playtime,
    progression,
    professions,
    inventory,
    recentChanges,
    freshness,
  };
}
