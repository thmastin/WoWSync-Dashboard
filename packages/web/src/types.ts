// Mirrors the JSON shapes returned by @wowsync-dashboard/server. Kept as a
// standalone copy (rather than importing the core package) so the browser
// bundle never has to reason about the server-only SQLite storage code.

export type VersionOrUnknown = "classic-era" | "tbc-anniversary" | "retail" | "unknown-version";

export interface VersionSummary {
  version: VersionOrUnknown;
  characterCount: number;
  totalMoneyCopper: number;
  charactersWithKnownGold: number;
  totalPlayedSeconds: number;
  charactersWithKnownPlaytime: number;
  lastUpdatedAt?: number;
}

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

export interface SnapshotDiff {
  fromGeneratedAt?: number;
  toGeneratedAt?: number;
  level: NumericDelta;
  moneyCopper: NumericDelta;
  playedSeconds: NumericDelta;
  levelPlayedSeconds: NumericDelta;
  professions: ProfessionDelta[];
  bagsItems: ItemDelta[];
  bankItems: ItemDelta[];
  equipment: EquipmentDelta[];
}

export interface RecentChange {
  characterId: number;
  identityKey: string;
  characterName: string;
  version: VersionOrUnknown;
  snapshotId: number;
  importedAt: number;
  diff: SnapshotDiff;
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
    categories: {
      category: string;
      status: SectionStatus;
      name?: string;
      trainerType?: string;
      coverage?: string;
      filters?: string;
      moneyAtVisitCopper?: number;
      services: {
        spellID?: string;
        ability?: string;
        rank?: string;
        statusAtVisit?: string;
        requiredLevel?: string;
        costCopper?: number;
        requirementsAtVisit?: string;
      }[];
    }[];
  };
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
}

export interface ImportResult {
  character: StoredCharacterSummary;
  snapshot: StoredSnapshot;
  previousSnapshot?: StoredSnapshot;
  diff?: SnapshotDiff;
  isFirstSnapshot: boolean;
}
