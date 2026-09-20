// Mirrors the JSON shapes returned by @wowsync-dashboard/server. Kept as a
// standalone copy (rather than importing the core package) so the browser
// bundle never has to reason about the server-only SQLite storage code.

export type VersionOrUnknown = "classic-era" | "tbc-anniversary" | "retail" | "forever" | "unknown-version";

export interface StoredCharacterSummary {
  id: number;
  version: VersionOrUnknown;
  realm: string;
  name: string;
  identityKey: string;
  class?: string;
  faction?: string;
  latestLevel?: number;
  latestMoneyCopper?: number;
  latestPlayedSeconds?: number;
  latestGeneratedAt?: number;
  latestImportedAt?: number;
  snapshotCount: number;
}

/** What DELETE /api/characters/:identityKey reports it removed. */
export interface DeleteCharacterResult {
  identityKey: string;
  version: VersionOrUnknown;
  realm: string;
  name: string;
  snapshotsDeleted: number;
}

export interface NumericDelta {
  from?: number;
  to?: number;
  delta?: number;
}

export interface ProfessionDelta {
  name: string;
  skill: NumericDelta;
  maxSkill: NumericDelta;
}

export interface ItemDelta {
  itemRef?: string;
  name?: string;
  fromQty: number;
  toQty: number;
  deltaQty: number;
}

export interface EquipmentDelta {
  slot: number;
  slotName: string;
  from?: string;
  to?: string;
}

export interface LocationDelta {
  fromZone?: string;
  toZone?: string;
  fromSubzone?: string;
  toSubzone?: string;
  changed: boolean;
}

export interface TrainerUnlock {
  category: string;
  ability?: string;
  rank?: string;
}

export interface SnapshotDiff {
  fromGeneratedAt?: number;
  toGeneratedAt?: number;
  level: NumericDelta;
  xp: NumericDelta;
  xpMax: NumericDelta;
  moneyCopper: NumericDelta;
  playedSeconds: NumericDelta;
  levelPlayedSeconds: NumericDelta;
  location: LocationDelta;
  professions: ProfessionDelta[];
  bagsItems: ItemDelta[];
  bankItems: ItemDelta[];
  equipment: EquipmentDelta[];
  trainerUnlocks: TrainerUnlock[];
}

export interface SectionStatus {
  state: "OBSERVED" | "LAST_SEEN" | "UNKNOWN";
  completeness?: string;
  observedAt?: number;
  categories?: number;
  pending?: boolean;
  coverageNote?: string;
  refreshIssue?: string;
  reason?: string;
  lastVisit?: number;
  visitedNPC?: string;
  visitedZone?: string;
  visitStatus?: string;
}

export interface ParsedSnapshot {
  raw: string;
  generatedAt?: number;
  character: {
    status: SectionStatus;
    name?: string;
    realm?: string;
    class?: string;
    level?: number;
    faction?: string;
    moneyCopper?: number;
    playedSeconds?: number;
    levelPlayedSeconds?: number;
    xp?: number;
    xpMax?: number;
    clientVersion?: string;
    clientBuild?: string;
    clientFamily?: string;
    interface?: string;
  };
  location: { status: SectionStatus; zone?: string; subzone?: string; mapID?: string; x?: string; y?: string };
  equipment: {
    status: SectionStatus;
    slots: { slot: number; slotName: string; empty: boolean; itemRef?: string; name?: string }[];
  };
  bags: InventorySection;
  bank: InventorySection;
  professions: {
    status: SectionStatus;
    coverage?: string;
    entries: { name: string; skill?: number; maxSkill?: number; category?: string }[];
    noneMessage?: string;
  };
  spells: { status: SectionStatus; coverage?: string; entries: { spellID?: string; name?: string; rank?: string }[] };
  trainer: {
    status: SectionStatus;
    categories: TrainerCategory[];
  };
}

export interface TrainerService {
  spellID?: string;
  ability?: string;
  rank?: string;
  statusAtVisit?: string;
  requiredLevel?: string;
  costCopper?: number;
  requirementsAtVisit?: string;
}

export interface TrainerCategory {
  category: string;
  status: SectionStatus;
  name?: string;
  trainerType?: string;
  coverage?: string;
  filters?: string;
  moneyAtVisitCopper?: number;
  services: TrainerService[];
  /** Computed server-side (packages/core/src/trainerSummary.ts) from `services` above — never authoritative on its own. */
  summary?: TrainerCategorySummary;
}

export interface SummarizedAbility {
  ability?: string;
  rank?: string;
  requiredLevel?: number;
  costCopper?: number;
  requirementsAtVisit?: string;
}

export interface RequiredLevelGroup {
  requiredLevel: number;
  abilities: SummarizedAbility[];
  totalCostCopper?: number;
  costPartial: boolean;
}

export interface NextTraining {
  requiredLevel: number;
  abilityCount: number;
  totalCostCopper?: number;
  costPartial: boolean;
}

export interface TrainerCategorySummary {
  category: string;
  available: SummarizedAbility[];
  known: SummarizedAbility[];
  upcomingByLevel: RequiredLevelGroup[];
  unknownUnlockLevel: SummarizedAbility[];
  nextTraining?: NextTraining;
  totalServices: number;
}

export interface InventorySection {
  status: SectionStatus;
  coverage?: string;
  freeSlots?: number;
  totalSlots?: number;
  itemsKnownEmpty: boolean;
  items: { itemRef?: string; name?: string; qty?: number; bound?: string; vendorEachCopper?: number }[];
}

export interface StoredSnapshot {
  id: number;
  characterId: number;
  generatedAt?: number;
  importedAt: number;
  parsed: ParsedSnapshot;
  /** Only present on the snapshots-list endpoint: abilities that newly became trainable since the immediately preceding snapshot. */
  trainerUnlocksSincePrevious?: TrainerUnlock[];
}

export interface ImportResult {
  character: StoredCharacterSummary;
  /** For a duplicate, the EXISTING snapshot - nothing new was stored. */
  snapshot: StoredSnapshot;
  /** The chronologically preceding (older) snapshot, if any. */
  previousSnapshot?: StoredSnapshot;
  /** Forward-in-time diff from previousSnapshot; absent when there is nothing older to compare (never a placeholder). */
  diff?: SnapshotDiff;
  /** The character had no snapshots at all before this import. */
  isFirstSnapshot: boolean;
  /** This exact export was already stored; nothing was inserted or changed. */
  isDuplicate: boolean;
  /** This snapshot is now the character's current (newest-observed) state. False when an older export was imported after a newer one. */
  isLatest: boolean;
}

// --- AccountFacts (Milestone 3) ---

export type Freshness = "recent" | "stale" | "unknown";

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
  bankStatus: SectionStatus["state"];
}

export interface CharacterGold {
  identityKey: string;
  name: string;
  goldCopper?: number;
  deltaCopper?: number;
}

export interface GoldFacts {
  /** Meaningful only alongside charactersWithKnownGold: with 0 known characters this is a sum over nothing (unknown), NOT zero gold. */
  totalKnownCopper: number;
  charactersWithKnownGold: number;
  charactersWithUnknownGold: number;
  /** Known-gold contributors last observed more than the fixed freshness window ago (still counted in the total). */
  staleCharactersWithKnownGold: number;
  /** Observation time (unix seconds) of the oldest known-gold contribution; absent when none is known. */
  oldestKnownGoldObservedAt?: number;
  byCharacter: CharacterGold[];
  largestRecentChanges: CharacterGold[];
}

export interface CharacterPlaytime {
  identityKey: string;
  name: string;
  playedSeconds?: number;
  levelPlayedSeconds?: number;
  deltaPlayedSeconds?: number;
  deltaLevelPlayedSeconds?: number;
}

export interface PlaytimeFacts {
  /** Meaningful only alongside charactersWithKnownPlaytime (see GoldFacts.totalKnownCopper). */
  totalKnownPlayedSeconds: number;
  charactersWithKnownPlaytime: number;
  staleCharactersWithKnownPlaytime: number;
  oldestKnownPlaytimeObservedAt?: number;
  byCharacter: CharacterPlaytime[];
}

export interface CharacterProgression {
  identityKey: string;
  name: string;
  level?: number;
  xp?: number;
  xpMax?: number;
  xpPercent?: number;
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
  closestToNextLevel?: CharacterProgression;
}

export interface CharacterProfessionEntry {
  name: string;
  skill?: number;
  maxSkill?: number;
}

export interface CharacterProfessions {
  identityKey: string;
  name: string;
  /** Was this character's professions section ever observed — not to be confused with ProfessionCoverageEntry.coverageStatus below (different vocabulary, different question). */
  observationStatus: SectionStatus["state"];
  professions: CharacterProfessionEntry[];
}

export type ProfessionCoverageStatus = "covered" | "none" | "unknown";

export interface ProfessionCoverageEntry {
  profession: string;
  coverageStatus: ProfessionCoverageStatus;
  characters: { identityKey: string; name: string; skill?: number; maxSkill?: number }[];
}

export interface ProfessionFacts {
  byCharacter: CharacterProfessions[];
  coverage: ProfessionCoverageEntry[];
}

export type StorageLocation = "bags" | "bank";

export interface InventoryLocationEntry {
  identityKey: string;
  name: string;
  storage: StorageLocation;
  qty: number;
  bound?: string;
}

export interface InventoryAggregateEntry {
  itemKey: string;
  name?: string;
  totalKnownQty: number;
  locations: InventoryLocationEntry[];
}

export interface InventoryFacts {
  items: InventoryAggregateEntry[];
  unknownBank: { identityKey: string; name: string }[];
  unknownBags: { identityKey: string; name: string }[];
  hasUnknownStorage: boolean;
}

export interface InventoryItemChange {
  storage: StorageLocation;
  itemKey: string;
  name?: string;
  deltaQty: number;
}

export interface AccountChangeSummary {
  identityKey: string;
  characterName: string;
  importedAt: number;
  /** When the later snapshot's game state existed (export Generated time, else import time). Use this to say how old a change is. */
  observedAt?: number;
  fromLevel?: number;
  toLevel?: number;
  levelChanged: boolean;
  goldDeltaCopper?: number;
  playtimeDeltaSeconds?: number;
  professionChanged: boolean;
  equipmentChanged: boolean;
  inventoryChanged: boolean;
  inventoryItemChanges?: InventoryItemChange[];
  locationChanged: boolean;
  trainerUnlocked: boolean;
}

export interface FreshnessSummary {
  recentCharacters: number;
  staleCharacters: number;
  unknownCharacters: number;
  byCharacter: { identityKey: string; name: string; freshness: Freshness; lastObservedAt?: number }[];
}

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

export interface AccountFacts {
  version: VersionOrUnknown;
  generatedAt: number;
  aggregationScope: "realm" | "account-wide";
  characterCount: number;
  characters: CharacterFacts[];
  gold: GoldFacts;
  playtime: PlaytimeFacts;
  progression: ProgressionFacts;
  professions: ProfessionFacts;
  inventory: InventoryFacts;
  recentChanges: AccountChangeSummary[];
  freshness: FreshnessSummary;
  realms: RealmGroup[];
}

// --- AccountContext ("Export Dashboard Context" developer tool) ---
// Deliberately a loose/partial mirror: the web app only ever reads a
// handful of summary fields from this (for the developer modal's preview)
// and otherwise treats it as an opaque JSON document to copy/download
// verbatim - it never re-derives facts from it.

export interface AccountContextVersionSummary {
  version: string;
  aggregationScope: "realm" | "account-wide";
  characters: { name: string; realm: string }[];
}

export interface AccountContext {
  schemaVersion: string;
  generatedAt: number;
  versions: Record<string, AccountContextVersionSummary>;
}

// --- "Ask My Account" (LLM POC) ---

export interface AskAccountUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface AskAccountResponse {
  answer: string;
  model: string;
  contextGeneratedAt: number;
  contextSummary: { characterCount: number; versions: string[] };
  usage?: AskAccountUsage;
}
