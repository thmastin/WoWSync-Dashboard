// Domain model for a parsed WOWSYNC v1 export.
//
// Unknown values are always represented as `undefined` — never as 0, "",
// or a guessed default. `EMPTY` (an observed empty slot/container/list) is
// represented explicitly and is distinct from "unknown".

export type SectionState = "OBSERVED" | "LAST_SEEN" | "UNKNOWN";

export interface SectionStatus {
  state: SectionState;
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

export interface CharacterSection {
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
}

export interface LocationSection {
  status: SectionStatus;
  zone?: string;
  subzone?: string;
  mapID?: string;
  x?: string;
  y?: string;
}

export interface EquipmentSlot {
  slot: number;
  slotName: string;
  empty: boolean;
  itemRef?: string;
  name?: string;
  itemLevel?: string;
  requiredLevel?: string;
  effectiveStats?: string;
}

export interface EquipmentSection {
  status: SectionStatus;
  slots: EquipmentSlot[];
}

export interface ContainerRecord {
  id: number;
  storage?: string;
  capacity?: number;
  free?: number;
  family?: string;
  bagRef?: string;
}

export interface InventoryItemRecord {
  itemRef?: string;
  name?: string;
  qty?: number;
  bound?: string;
  vendorEachCopper?: number;
}

export interface InventorySection {
  status: SectionStatus;
  coverage?: string;
  snapshotVisit?: number;
  purchasedBankBagSlots?: number;
  purchasedBankTabs?: number;
  containers: ContainerRecord[];
  freeSlots?: number;
  totalSlots?: number;
  itemsKnownEmpty: boolean;
  items: InventoryItemRecord[];
}

/** Retail-only account/Warband storage.  This is deliberately separate from
 * the per-character bank section: its contents must never be attributed to
 * the character that happened to export it. */
export interface AccountBankSection extends InventorySection {
  ownerScope: "ACCOUNT_WARBAND";
}

export interface ProfessionEntry {
  name: string;
  skill?: number;
  maxSkill?: number;
  skillLineID?: string;
  tier?: string;
  expansion?: string;
  category?: string;
}

export interface ProfessionsSection {
  status: SectionStatus;
  coverage?: string;
  entries: ProfessionEntry[];
  noneMessage?: string;
}

export interface SpellEntry {
  spellID?: string;
  name?: string;
  rank?: string;
}

export interface SpellsSection {
  status: SectionStatus;
  coverage?: string;
  entries: SpellEntry[];
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

export interface TrainerCategorySnapshot {
  category: string;
  status: SectionStatus;
  name?: string;
  trainerType?: string;
  coverage?: string;
  filters?: string;
  moneyAtVisitCopper?: number;
  services: TrainerService[];
}

export interface TrainerSection {
  status: SectionStatus;
  categories: TrainerCategorySnapshot[];
}

export interface ParsedSnapshot {
  /** The exact text that was parsed, preserved verbatim for audit/history. */
  raw: string;
  generatedAt?: number;
  formatLine?: string;
  character: CharacterSection;
  location: LocationSection;
  equipment: EquipmentSection;
  bags: InventorySection;
  bank: InventorySection;
  /** Optional additive Retail section; absent from all legacy exports. */
  accountBank?: AccountBankSection;
  professions: ProfessionsSection;
  spells: SpellsSection;
  trainer: TrainerSection;
}

/** WoW version spaces. Data must never be aggregated across these. */
export type WowVersion = "classic-era" | "tbc-anniversary" | "retail" | "forever";

/** A version that could not be confidently routed; quarantined rather than guessed. */
export const UNKNOWN_VERSION = "unknown-version" as const;
export type VersionOrUnknown = WowVersion | typeof UNKNOWN_VERSION;

export interface CharacterIdentity {
  version: VersionOrUnknown;
  realm: string;
  name: string;
  /** Lowercased "version::realm::name" — the stable identity key. GUID is not present in WOWSYNC v1 text exports. */
  key: string;
}
