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
// Hard rule throughout: UNKNOWN is never turned into zero/empty/none. A
// character whose bank was never observed contributes nothing to
// inventory totals and is listed separately as "unknown", not counted as
// having an empty bank. A profession section that is UNKNOWN is not the
// same as "no professions" (which is what `noneMessage`/an empty entries
// list on an OBSERVED section represents) — and a profession nobody has
// is only ever "none" (not "unknown") once every relevant character's
// profession state has actually been observed.
//
// Realm scoping: Classic Era and TBC Anniversary have no cross-realm
// economy (no shared bank/currency between realms), so gold/playtime/
// professions/inventory are aggregated per-realm by default for those
// versions (`AccountFacts.realms`), never silently combined across
// realms. Retail's account-wide totals (`AccountFacts.gold` etc. at the
// top level) remain the primary view for Retail — see
// REALM_PARTITIONED_VERSIONS. The top-level version-wide totals are still
// computed for every version (a broader view is available if wanted
// later); they just aren't the recommended default for a multi-realm
// Classic/TBC account.

import { baseItemId, type ItemDelta, type SnapshotDiff } from "./diff.ts";
import { classifyFreshness, type Freshness } from "./freshness.ts";
import { professionCatalogForVersion } from "./professionCatalog.ts";
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
  /**
   * Whether this character's professions SECTION was ever observed — UNKNOWN
   * means "never observed", distinct from an OBSERVED section with zero
   * entries ("no professions identified"). Deliberately named
   * `observationStatus`, not `status`, so it can never be confused with
   * `ProfessionCoverageEntry.coverageStatus` below: the two use disjoint
   * vocabularies (OBSERVED/LAST_SEEN/UNKNOWN vs. covered/none/unknown) and
   * answer different questions ("did we ever look?" vs. "does anyone have
   * this profession, account/realm-wide?") — a same-named `status` field at
   * both levels of this document was misread by an LLM consumer in
   * practice (it read one character's `professions` array correctly, then
   * separately misreported the unrelated coverage status for the same
   * profession as if it were the same field).
   */
  observationStatus: SectionState;
  professions: CharacterProfessionEntry[];
}

/**
 * "covered": at least one character in this group has the profession.
 * "none": every character's profession state has been observed, and none of them have it.
 * "unknown": at least one character's profession state was never observed, so absence can't be established.
 */
export type ProfessionCoverageStatus = "covered" | "none" | "unknown";

export interface ProfessionCoverageEntry {
  profession: string;
  /** See the note on CharacterProfessions.observationStatus for why this isn't named `status`. */
  coverageStatus: ProfessionCoverageStatus;
  characters: { identityKey: string; name: string; skill?: number; maxSkill?: number }[];
}

export interface ProfessionFacts {
  byCharacter: CharacterProfessions[];
  /** The version's full profession catalog (see professionCatalog.ts), each marked covered/none/unknown. Sorted alphabetically. Empty catalog (unknown-version) degrades to "only what's observed" — see buildProfessionCoverage. */
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
  /** Every distinct known item, aggregated across this group's characters' known (non-UNKNOWN) bags/bank. Sorted by name. */
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

/**
 * A compact per-item inventory delta: net quantity change only (never the
 * full fromQty/toQty/raw-itemRef bloat of `ItemDelta`). `itemKey` uses the
 * same base-item-ID-or-name-fallback convention as
 * `InventoryAggregateEntry.itemKey` (see baseItemId in diff.ts) so entries
 * here can be cross-referenced against `InventoryFacts.items` by key.
 */
export interface InventoryItemChange {
  storage: StorageLocation;
  itemKey: string;
  name?: string;
  /** Net change (positive = gained, negative = lost/consumed/sold/mailed away — the account context only ever records the observed delta, never a cause). */
  deltaQty: number;
}

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
  /**
   * Compact bags+bank item deltas backing `inventoryChanged`. Present
   * (and non-empty) exactly when `inventoryChanged` is true; omitted
   * entirely otherwise — never an empty array standing in for "nothing
   * changed", consistent with this layer never fabricating a value where
   * "not populated" is the honest state. Sorted by item name, then
   * storage, for determinism.
   */
  inventoryItemChanges?: InventoryItemChange[];
  locationChanged: boolean;
  trainerUnlocked: boolean;
}

function toInventoryItemChange(storage: StorageLocation, delta: ItemDelta): InventoryItemChange {
  return {
    storage,
    itemKey: baseItemId(delta.itemRef) ?? `name:${delta.name ?? "?"}`,
    name: delta.name,
    deltaQty: delta.deltaQty,
  };
}

/**
 * Reshapes one SnapshotDiff into the flat AccountChangeSummary shape.
 * Shared by recentChanges (the version's already-filtered "meaningful"
 * list) and accountContext.ts's full per-character transition history —
 * one mapping, reused, not reimplemented for the export.
 */
export function diffToChangeSummary(
  diff: SnapshotDiff,
  meta: { identityKey: string; characterName: string; importedAt: number },
): AccountChangeSummary {
  const inventoryItemChanges = [
    ...diff.bagsItems.map((d) => toInventoryItemChange("bags", d)),
    ...diff.bankItems.map((d) => toInventoryItemChange("bank", d)),
  ].sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "") || a.storage.localeCompare(b.storage));

  return {
    identityKey: meta.identityKey,
    characterName: meta.characterName,
    importedAt: meta.importedAt,
    fromLevel: diff.level.from,
    toLevel: diff.level.to,
    levelChanged: !!diff.level.delta,
    goldDeltaCopper: diff.moneyCopper.delta,
    playtimeDeltaSeconds: diff.playedSeconds.delta,
    professionChanged: diff.professions.length > 0,
    equipmentChanged: diff.equipment.length > 0,
    inventoryChanged: inventoryItemChanges.length > 0,
    inventoryItemChanges: inventoryItemChanges.length > 0 ? inventoryItemChanges : undefined,
    locationChanged: diff.location.changed,
    trainerUnlocked: diff.trainerUnlocks.length > 0,
  };
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
// Realm grouping
// ---------------------------------------------------------------------

/**
 * Classic Era and TBC Anniversary realms are economically isolated from
 * each other (no shared bank/currency, no cross-realm mail/AH) — gold,
 * inventory, and profession coverage must never be silently combined
 * across them. Retail's Warband-era account-wide sharing makes
 * version-wide (not realm-partitioned) the right default there instead.
 * `unknown-version` is treated like Retail: we don't have a confident
 * basis for asserting realm isolation rules on a client we didn't
 * recognize.
 */
const REALM_PARTITIONED_VERSIONS = new Set<VersionOrUnknown>(["classic-era", "tbc-anniversary"]);

export interface RealmGroup {
  realm: string;
  characterCount: number;
  characters: CharacterFacts[];
  gold: GoldFacts;
  playtime: PlaytimeFacts;
  progression: ProgressionFacts;
  professions: ProfessionFacts;
  inventory: InventoryFacts;
}

// ---------------------------------------------------------------------
// Top-level AccountFacts
// ---------------------------------------------------------------------

export interface AccountFacts {
  version: VersionOrUnknown;
  /** Wall-clock time these facts were computed at — the reference point freshness was classified against. Passed in, never read internally. */
  generatedAt: number;
  /** Which grouping is the safe/recommended default for this version's UI: realm-partitioned (Classic Era/TBC Anniversary) or account-wide (Retail/unknown-version). */
  aggregationScope: "realm" | "account-wide";
  characterCount: number;
  characters: CharacterFacts[];
  /** Version-wide totals (all realms combined). Always computed — a broader view stays available even when `aggregationScope` is "realm" — but for a multi-realm Classic/TBC account, prefer `realms` for anything gold/inventory-related. */
  gold: GoldFacts;
  playtime: PlaytimeFacts;
  progression: ProgressionFacts;
  professions: ProfessionFacts;
  inventory: InventoryFacts;
  recentChanges: AccountChangeSummary[];
  freshness: FreshnessSummary;
  /** Populated (one entry per distinct realm) for realm-partitioned versions; empty for account-wide versions. */
  realms: RealmGroup[];
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

function buildCharacterFacts(
  characters: StoredCharacterSummary[],
  latestParsed: Map<string, ParsedSnapshot>,
  now: number,
): CharacterFacts[] {
  return characters.map((c) => {
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
}

function buildGoldFacts(characters: StoredCharacterSummary[], diffs: Map<string, SnapshotDiff>): GoldFacts {
  const byCharacter: CharacterGold[] = characters.map((c) => ({
    identityKey: c.identityKey,
    name: c.name,
    goldCopper: c.latestMoneyCopper,
    deltaCopper: diffs.get(c.identityKey)?.moneyCopper.delta,
  }));
  const known = byCharacter.filter((g) => g.goldCopper !== undefined);
  return {
    totalKnownCopper: known.reduce((sum, g) => sum + (g.goldCopper ?? 0), 0),
    charactersWithKnownGold: known.length,
    charactersWithUnknownGold: characters.length - known.length,
    byCharacter,
    largestRecentChanges: byCharacter
      .filter((g) => g.deltaCopper !== undefined && g.deltaCopper !== 0)
      .sort((a, b) => Math.abs(b.deltaCopper ?? 0) - Math.abs(a.deltaCopper ?? 0))
      .slice(0, 5),
  };
}

function buildPlaytimeFacts(
  characters: StoredCharacterSummary[],
  latestParsed: Map<string, ParsedSnapshot>,
  diffs: Map<string, SnapshotDiff>,
): PlaytimeFacts {
  const byCharacter: CharacterPlaytime[] = characters.map((c) => {
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
  const known = byCharacter.filter((p) => p.playedSeconds !== undefined);
  return {
    totalKnownPlayedSeconds: known.reduce((sum, p) => sum + (p.playedSeconds ?? 0), 0),
    charactersWithKnownPlaytime: known.length,
    byCharacter,
  };
}

function buildProgressionFacts(
  characters: StoredCharacterSummary[],
  latestParsed: Map<string, ParsedSnapshot>,
  diffs: Map<string, SnapshotDiff>,
): ProgressionFacts {
  const byCharacter: CharacterProgression[] = characters.map((c) => {
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
  const recentLevelUps: LevelUp[] = byCharacter
    .filter((p) => p.levelDeltaSincePrevious !== undefined && p.levelDeltaSincePrevious > 0 && p.level !== undefined)
    .map((p) => ({
      identityKey: p.identityKey,
      name: p.name,
      fromLevel: p.level! - p.levelDeltaSincePrevious!,
      toLevel: p.level!,
    }));
  const knownXpPercent = byCharacter.filter((p) => p.xpPercent !== undefined);
  const closestToNextLevel =
    knownXpPercent.length > 0
      ? knownXpPercent.reduce((best, p) => (p.xpPercent! > best.xpPercent! ? p : best))
      : undefined;
  return { byCharacter, recentLevelUps, closestToNextLevel };
}

function buildProfessionsByCharacter(
  characters: StoredCharacterSummary[],
  latestParsed: Map<string, ParsedSnapshot>,
): CharacterProfessions[] {
  return characters.map((c) => {
    const section = latestParsed.get(c.identityKey)?.professions;
    return {
      identityKey: c.identityKey,
      name: c.name,
      observationStatus: section?.status.state ?? "UNKNOWN",
      professions: (section?.entries ?? []).map((e) => ({ name: e.name, skill: e.skill, maxSkill: e.maxSkill })),
    };
  });
}

/**
 * Builds catalog-aware coverage: every profession in `catalog` is marked
 * covered/none/unknown per the rules documented on ProfessionCoverageStatus.
 * Any observed profession NOT in the catalog (unexpected/uncatalogued
 * name) is still appended as "covered" — never silently dropped.
 */
function buildProfessionCoverage(catalog: string[], byCharacter: CharacterProfessions[]): ProfessionCoverageEntry[] {
  const anyUnknown = byCharacter.some((c) => c.observationStatus === "UNKNOWN");
  const byProfession = new Map<string, ProfessionCoverageEntry["characters"]>();
  for (const cp of byCharacter) {
    for (const prof of cp.professions) {
      const list = byProfession.get(prof.name) ?? [];
      list.push({ identityKey: cp.identityKey, name: cp.name, skill: prof.skill, maxSkill: prof.maxSkill });
      byProfession.set(prof.name, list);
    }
  }
  const catalogSet = new Set(catalog);
  const entries: ProfessionCoverageEntry[] = catalog.map((profession) => {
    const characters = byProfession.get(profession) ?? [];
    if (characters.length > 0) return { profession, coverageStatus: "covered", characters };
    return { profession, coverageStatus: anyUnknown ? "unknown" : "none", characters: [] };
  });
  // Observed professions outside the catalog (e.g. an unrecognized name) are never dropped.
  for (const [profession, characters] of byProfession) {
    if (!catalogSet.has(profession)) entries.push({ profession, coverageStatus: "covered", characters });
  }
  return entries.sort((a, b) => a.profession.localeCompare(b.profession));
}

function buildProfessionFacts(
  version: VersionOrUnknown,
  characters: StoredCharacterSummary[],
  latestParsed: Map<string, ParsedSnapshot>,
): ProfessionFacts {
  const byCharacter = buildProfessionsByCharacter(characters, latestParsed);
  const coverage = buildProfessionCoverage(professionCatalogForVersion(version), byCharacter);
  return { byCharacter, coverage };
}

function buildInventoryFacts(
  characters: StoredCharacterSummary[],
  latestParsed: Map<string, ParsedSnapshot>,
): InventoryFacts {
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
  return {
    items: [...itemMap.values()].sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "")),
    unknownBank,
    unknownBags,
    hasUnknownStorage: unknownBank.length > 0 || unknownBags.length > 0,
  };
}

function buildRealmGroup(
  realm: string,
  version: VersionOrUnknown,
  characters: StoredCharacterSummary[],
  latestParsed: Map<string, ParsedSnapshot>,
  diffs: Map<string, SnapshotDiff>,
  now: number,
): RealmGroup {
  return {
    realm,
    characterCount: characters.length,
    characters: buildCharacterFacts(characters, latestParsed, now),
    gold: buildGoldFacts(characters, diffs),
    playtime: buildPlaytimeFacts(characters, latestParsed, diffs),
    progression: buildProgressionFacts(characters, latestParsed, diffs),
    professions: buildProfessionFacts(version, characters, latestParsed),
    inventory: buildInventoryFacts(characters, latestParsed),
  };
}

export function buildAccountFacts(input: AccountFactsInput, now: number): AccountFacts {
  const { version, characters, latestParsed, diffs, meaningfulChanges } = input;

  const characterFacts = buildCharacterFacts(characters, latestParsed, now);
  const gold = buildGoldFacts(characters, diffs);
  const playtime = buildPlaytimeFacts(characters, latestParsed, diffs);
  const progression = buildProgressionFacts(characters, latestParsed, diffs);
  const professions = buildProfessionFacts(version, characters, latestParsed);
  const inventory = buildInventoryFacts(characters, latestParsed);

  const recentChanges: AccountChangeSummary[] = meaningfulChanges.map((c) => diffToChangeSummary(c.diff, c));

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

  const aggregationScope: AccountFacts["aggregationScope"] = REALM_PARTITIONED_VERSIONS.has(version)
    ? "realm"
    : "account-wide";

  let realms: RealmGroup[] = [];
  if (aggregationScope === "realm") {
    const byRealm = new Map<string, StoredCharacterSummary[]>();
    for (const c of characters) {
      const list = byRealm.get(c.realm) ?? [];
      list.push(c);
      byRealm.set(c.realm, list);
    }
    realms = [...byRealm.entries()]
      .map(([realm, realmCharacters]) => buildRealmGroup(realm, version, realmCharacters, latestParsed, diffs, now))
      .sort((a, b) => a.realm.localeCompare(b.realm));
  }

  return {
    version,
    generatedAt: now,
    aggregationScope,
    characterCount: characters.length,
    characters: characterFacts,
    gold,
    playtime,
    progression,
    professions,
    inventory,
    recentChanges,
    freshness,
    realms,
  };
}
