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
  /** Account/Warband storage is separate from the exporting character's bank. */
  accountBank?: InventorySection & { ownerScope: "ACCOUNT_WARBAND" };
  /** Guild storage is separate from the exporting character's bank and from the Warband bank. */
  guildBank?: GuildBankSection;
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

/** One Guild Bank tab as reported by the addon. `state` is the addon's own string (OBSERVED / INACCESSIBLE / UNKNOWN today); unfamiliar values are preserved, not guessed. */
export interface GuildBankTab {
  id?: number;
  name?: string;
  viewable?: boolean;
  state?: string;
  note?: string;
}

/** Retail guild-scoped shared storage. `guildClubId` is text on purpose (identifiers can exceed 2^53). */
export type GuildBankSection = InventorySection & {
  ownerScope: "GUILD";
  guildClubId?: string;
  guildName?: string;
  tabs: GuildBankTab[];
};

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

// --- Shared storage (Warband + Guild Bank) -----------------------------------------------------------------
// Mirrors packages/core/src/sharedStorageApi.ts (GET /api/shared-storage and the owner-delete routes).
// Everything here is DERIVED from OBSERVED journal facts; a view is ONE real observation with its own time
// and coverage. An UNKNOWN scalar is an absent key, never 0. It is NOT part of AccountFacts, totals, search or AI context.

export type CarrierState = "OBSERVED" | "LAST_SEEN";

/** Who owns a shared storage. Not a character. The Warband's "installation-local" scope is NOT a Battle.net account id. */
export type SharedOwnerIdentity =
  | { kind: "warband"; ownerKey: string; accountScope: "installation-local" }
  | { kind: "guild"; ownerKey: string; guildClubId: string; guildName?: string };

export interface SharedSourceView {
  characterName: string;
  characterRealm: string;
  characterIdentityKey: string;
  carrierState: CarrierState;
  exportObservedAt: number;
  snapshotVisit?: number;
  visitedNpc?: string;
  visitedZone?: string;
}

export interface SharedProvenanceView {
  totalSources: number;
  totalCharacters: number;
  /** Most recent carrying exports, newest first, capped by the server. */
  sources: SharedSourceView[];
  truncated: boolean;
}

export interface SharedContent {
  guildName?: string;
  purchasedTabs?: number;
  tabs: GuildBankTab[];
  containers: { id: number; storage?: string; capacity?: number; free?: number; family?: string; bagRef?: string }[];
  freeSlots?: number;
  totalSlots?: number;
  itemsKnownEmpty: boolean;
  /** Aggregated across the scanned tabs: an item row does not say which tab held it. */
  items: { itemRef?: string; name?: string; qty?: number; bound?: string; vendorEachCopper?: number }[];
}

export interface SharedObservationView {
  claimedObservedAt: number;
  effectiveObservedAt: number;
  claimedAfterCarrier: boolean;
  ageSeconds: number;
  freshness: "recent" | "stale" | "unknown";
  completeness: "complete" | "partial";
  informative: boolean;
  contentHash: string;
  liveAtExport: boolean;
  carrierStates: CarrierState[];
  coverage: { observedTabs: number[]; inaccessibleTabs: number[]; unconfirmedTabs: number[]; unidentifiedTabs: number; observedContainerIds: number[] };
  content: SharedContent;
  provenance: SharedProvenanceView;
}

export interface SharedOwnerView {
  owner: SharedOwnerIdentity;
  basis: "DERIVED";
  current: SharedObservationView | null;
  latestPartial: SharedObservationView | null;
  broaderCoverageEarlier: SharedObservationView | null;
  conflict: { effectiveObservedAt: number; others: SharedObservationView[] } | null;
  observationCount: { total: number; complete: number; partial: number; informationless: number };
}

export interface SharedStorageResponse {
  schema: "shared-storage-1";
  asOf: number;
  warband: SharedOwnerView | null;
  guilds: SharedOwnerView[];
}

export interface DeleteSharedStorageOwnerResponse {
  deleted: { owner: SharedOwnerIdentity; existed: true; observationsDeleted: number; sourcesDeleted: number };
}

/** The body of a shared-storage integrity failure (HTTP 500, code SHARED_STORAGE_INTEGRITY), available as `ApiError.details`. */
export interface SharedStorageIntegrityErrorBody {
  error: string;
  code: "SHARED_STORAGE_INTEGRITY";
  damagedOwners: Array<{ ownerKey: string; kind?: "warband" | "guild"; guildClubId?: string }>;
}
