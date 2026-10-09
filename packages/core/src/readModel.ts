// Focused, provider-neutral, read-only domain queries. This layer calls the
// SnapshotStore directly; it is intentionally not an HTTP wrapper and has no
// provider, filesystem, SQL, or mutation primitive in its public API.
import { buildSharedStorageResponse, type SharedStorageResponse } from "./sharedStorageApi.ts";
import { allocationForItem, projectAccountOwnedEvidenceMap, type AllocationResult } from "./allocation.ts";
import { buildAllocationReview, filterUnallocatedByQuery, itemNameForItem, type DispositionCounts, type UnallocatedInventoryEntry, type UnallocatedItemStringIdentityCounts, type UnresolvedStorageScope } from "./allocationReview.ts";
import { gateAllocationForProjectReservations } from "./projectReservationGate.ts";
import type { AccountChangeSummary, AccountFacts, CharacterFacts, ProfessionFacts } from "./accountFacts.ts";
import { buildAccountCurrencies, type AccountCurrencies, type CharacterCurrencies } from "./wowCurrencies.ts";
import type { CapturedCharacterState, EquipmentSection, GearCandidatesSection, ProfessionsSection, SectionState, VersionOrUnknown } from "./types.ts";
import type { InventorySection, SpellEntry, TrainerService, TrainerCategorySnapshot } from "./types.ts";
import type { SnapshotReadStore, StoredCharacterSummary, StoredSnapshot, VersionSummary } from "./store.ts";
import { WOW_VERSIONS } from "./version.ts";
import { itemIdFromItemRef, type ItemMetadataView } from "./itemMetadata.ts";
import type { SharedObservationView, SharedOwnerView } from "./sharedStorageApi.ts";
import type { StorageLocation, InventoryAggregateEntry } from "./accountFacts.ts";
import { classifyFreshness } from "./freshness.ts";
import { evaluateErpProject, type ErpProjectView } from "./erpProjects.ts";
import { snapshotObservedAt } from "./chronology.ts";
import { diffSnapshots, type ItemDelta, type ProfessionDelta, type EquipmentDelta } from "./diff.ts";
import { assessRetailCandidate } from "./retailGearAllocation.ts";
import { buildForeverGearObservation } from "./foreverGearObservation.ts";
import { assessForeverEligibility, assessForeverSuitability, calibrateForeverStatDelta, classifyForeverRecordedUpgrade, compareForeverStatTables, evaluateForeverSlotCompatibility, type ForeverGearAssessmentEvaluation, type ForeverSlotEvidence, type ForeverStatTable } from "./foreverGearEvaluation.ts";
import { assessForeverBinding, combineForeverEligibility, evaluateForeverArmorProficiency, evaluateForeverExplicitClassRestriction, evaluateForeverRecipientFit, evaluateForeverWeaponProficiency } from "./foreverGearRules.ts";

export type ReadState = "OBSERVED" | "DERIVED" | "LAST_SEEN" | "UNKNOWN";
export interface ReadProvenance {
  state: ReadState;
  version: VersionOrUnknown;
  identityKey?: string;
  observedAt?: number;
  importedAt?: number;
  snapshotId?: number;
  freshness?: "recent" | "stale" | "unknown";
  source?: string;
  derivedFrom?: string[];
  reason?: string;
  warning?: string;
}
export interface ReadValue<T> { data?: T; provenance: ReadProvenance }
export type CharacterResolution<T> =
  | { status: "FOUND"; value: T }
  | { status: "NOT_FOUND"; version: VersionOrUnknown; name: string; realm?: string }
  | { status: "AMBIGUOUS"; version: VersionOrUnknown; name: string; candidates: Array<Pick<StoredCharacterSummary, "identityKey" | "realm" | "name">> };

export interface CharacterQuery { version: VersionOrUnknown; name: string; realm?: string }
export interface CharacterSnapshotQuery extends CharacterQuery { snapshotId?: number }
export interface CharacterSpellsQuery extends CharacterSnapshotQuery { query?: string; offset?: number; limit?: number }
export interface CharacterTrainerQuery extends CharacterSnapshotQuery { category?: string; query?: string; status?: "known" | "available" | "unavailable" | "other"; offset?: number; limit?: number }
export interface AccountChangesQuery { version: VersionOrUnknown; realm?: string; offset?: number; limit?: number }

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function foreverItemField(evidence: unknown, name: string): { state?: unknown; value?: unknown } | undefined {
  if (!evidence || typeof evidence !== "object") return undefined;
  const fields = (evidence as { validatedFields?: unknown }).validatedFields;
  if (!fields || typeof fields !== "object") return undefined;
  const value = (fields as Record<string, unknown>)[name];
  return value && typeof value === "object" ? value as { state?: unknown; value?: unknown } : undefined;
}

function foreverItemContractIsValidated(evidence: unknown): boolean {
  if (!evidence || typeof evidence !== "object") return false;
  const fields = (evidence as { validatedFields?: unknown }).validatedFields;
  return !!fields && typeof fields === "object" && (fields as { contractState?: unknown }).contractState === "OBSERVED";
}

function foreverStatsEvidenceIsUsable(evidence: unknown, now: number): boolean {
  if (!evidence || typeof evidence !== "object") return false;
  const record = evidence as { validatedFields?: { contractState?: unknown }; itemStats?: unknown };
  if (!foreverItemContractIsValidated(evidence) || !record.itemStats || typeof record.itemStats !== "object") return false;
  const stats = record.itemStats as { api?: unknown; callState?: unknown; complete?: unknown; observedAt?: unknown };
  return stats.api === "C_Item.GetItemStats" && stats.callState === "OBSERVED_VALUE" && stats.complete === true
    && typeof stats.observedAt === "number" && classifyFreshness(stats.observedAt, now) === "recent";
}

function foreverNumericStats(evidence: unknown, now: number): Array<{ key: string; value: number }> {
  if (!foreverStatsEvidenceIsUsable(evidence, now)) return [];
  if (!evidence || typeof evidence !== "object") return [];
  const stats = (evidence as { itemStats?: unknown }).itemStats;
  if (!stats || typeof stats !== "object") return [];
  const entries = (stats as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const row = entry as { key?: unknown; observation?: { state?: unknown; value?: unknown } };
    return typeof row.key === "string" && row.observation?.state === "OBSERVED" && typeof row.observation.value === "number" ? [{ key: row.key, value: row.observation.value }] : [];
  });
}

function foreverStatTable(evidence: unknown, now: number): ForeverStatTable | undefined {
  if (!evidence || typeof evidence !== "object") return undefined;
  const stats = (evidence as { itemStats?: unknown }).itemStats;
  if (!stats || typeof stats !== "object") return undefined;
  const record = stats as { state?: unknown; api?: unknown; complete?: unknown; observedAt?: unknown; entries?: unknown };
  if (record.api !== "C_Item.GetItemStats" || record.state !== "OBSERVED_TABLE" || record.complete !== true
    || typeof record.observedAt !== "number" || classifyFreshness(record.observedAt, now) !== "recent" || !Array.isArray(record.entries)) return undefined;
  return { state: "OBSERVED_TABLE", complete: true, entries: record.entries.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const row = entry as { key?: unknown; observation?: { state?: unknown; value?: unknown } };
    return typeof row.key === "string" ? [{ key: row.key, state: typeof row.observation?.state === "string" ? row.observation.state : "UNKNOWN", value: row.observation?.value }] : [];
  }) };
}

function foreverItemEvidenceIsRecent(evidence: unknown, now: number): boolean {
  if (!evidence || typeof evidence !== "object") return false;
  const itemInfo = (evidence as { itemInfo?: unknown }).itemInfo;
  if (!itemInfo || typeof itemInfo !== "object") return false;
  const observedAt = (itemInfo as { observedAt?: unknown }).observedAt;
  return typeof observedAt === "number" && classifyFreshness(observedAt, now) === "recent";
}
export interface AccountCurrenciesQuery { version: VersionOrUnknown; realm?: string; currencyID?: number; query?: string; offset?: number; limit?: number; characterOffset?: number; characterLimit?: number }
export interface HistoryQuery extends CharacterQuery { offset?: number; limit?: number }
/**
 * Deliberately compact history record. Raw export text remains an import
 * concern and is not exposed through this consumer-facing read surface.
 */
export interface CharacterSnapshotHistoryRecord {
  snapshotId: number;
  generatedAt?: number;
  observedAt: number;
  importedAt: number;
  freshness: "recent" | "stale" | "unknown";
  level?: number;
  moneyCopper?: number;
  playedSeconds?: number;
  xp?: number;
  xpMax?: number;
  zone?: string;
  subzone?: string;
  equipmentState: SectionState;
  bagsState: SectionState;
  bankState: SectionState;
  professionsState: SectionState;
  currencyState: "OBSERVED" | "LAST_SEEN" | "UNKNOWN";
}
export interface CharacterChangesQuery extends CharacterQuery { fromSnapshotId?: number; toSnapshotId?: number }
export type ChangeComparisonState = "COMPARED" | "PARTIAL" | "UNKNOWN" | "LAST_SEEN" | "NOT_COMPARABLE";
export interface ChangeList<T> { items: T[]; returnedCount: number; totalCount: number; truncated: boolean }
export interface SectionChangeList<T> { state: ChangeComparisonState; fromState: SectionState; toState: SectionState; reason?: string; changes: ChangeList<T> }
export interface NumericChange { state: ChangeComparisonState; fromState: SectionState; toState: SectionState; from?: number; to?: number; delta?: number; reason?: string }
export interface CharacterChangesRead {
  identity: { version: VersionOrUnknown; identityKey: string; name: string; realm: string };
  comparisonState: "COMPARED" | "INSUFFICIENT_HISTORY";
  fromSnapshot?: { snapshotId: number; observedAt: number; importedAt: number; freshness: "recent" | "stale" | "unknown" };
  toSnapshot?: { snapshotId: number; observedAt: number; importedAt: number; freshness: "recent" | "stale" | "unknown" };
  reason?: string;
  changes?: {
    progression: { level: NumericChange; xp: NumericChange; xpMax: NumericChange; location: { state: ChangeComparisonState; fromState: SectionState; toState: SectionState; fromZone?: string; toZone?: string; fromSubzone?: string; toSubzone?: string; changed?: boolean; reason?: string } };
    economy: { goldCopper: NumericChange; playedSeconds: NumericChange; levelPlayedSeconds: NumericChange };
    equipment: SectionChangeList<EquipmentDelta>;
    bags: { state: ChangeComparisonState; fromState: SectionState; toState: SectionState; freeSlots: NumericChange; totalSlots: NumericChange; itemChanges: ChangeList<ItemDelta>; reason?: string };
    bank: { state: ChangeComparisonState; fromState: SectionState; toState: SectionState; freeSlots: NumericChange; totalSlots: NumericChange; itemChanges: ChangeList<ItemDelta>; reason?: string };
    professions: SectionChangeList<ProfessionDelta>;
    currencies: SectionChangeList<{ currencyID: number; name: string | null; scope: "ACCOUNT" | "CHARACTER" | "UNKNOWN"; fromQuantity: number; toQuantity: number; delta: number }>;
  };
}

export interface BoundedPage<T> { items: T[]; offset: number; limit: number; totalCount: number; truncated: boolean }
export interface CharacterSpellsRead {
  identity: { version: VersionOrUnknown; identityKey: string; name: string; realm: string };
  snapshot?: { snapshotId: number; generatedAt?: number; observedAt: number; importedAt: number; freshness: "recent" | "stale" | "unknown" };
  sectionState: SectionState;
  coverage?: string;
  spells?: BoundedPage<SpellEntry>;
  reason?: string;
}
export interface CharacterTrainerRead {
  identity: { version: VersionOrUnknown; identityKey: string; name: string; realm: string };
  snapshot?: { snapshotId: number; generatedAt?: number; observedAt: number; importedAt: number; freshness: "recent" | "stale" | "unknown" };
  sectionState: SectionState;
  categories: Array<{ category: string; state: SectionState; observedAt?: number; freshness: "recent" | "stale" | "unknown"; trainerName?: string; trainerType?: string; coverage?: string; filters?: string; serviceCount: number; statusCounts: { known: number; available: number; unavailable: number; other: number } }>;
  services: Array<{ category: string; categoryState: SectionState; observedAt?: number; freshness: "recent" | "stale" | "unknown"; spellID?: string; ability?: string; rank?: string; statusAtVisit?: string; requiredLevel?: string; costCopper?: number; requirementsAtVisit?: string }>;
  categoryCount: number;
  categoriesTruncated: boolean;
  offset: number;
  limit: number;
  totalCount: number;
  truncated: boolean;
  reason?: string;
}
export interface AccountCurrencyDetail {
  currencyID: number; name: string | null; scope: "ACCOUNT" | "CHARACTER" | "UNKNOWN";
  account: AccountCurrencies["currencies"][number]["account"];
  totals: AccountCurrencies["currencies"][number]["totals"];
  characters: Array<AccountCurrencies["currencies"][number]["characters"][number]>;
  characterOffset: number; characterLimit: number; characterTotalCount: number; charactersTruncated: boolean;
}
export interface AccountCurrenciesRead {
  version: VersionOrUnknown; aggregationScope: "account-wide" | "realm"; realm?: string;
  coverage: { totalCharacters: number; observedCharacters: number; lastSeenCharacters: number; unknownCharacters: number };
  currencies: BoundedPage<AccountCurrencyDetail>;
}
export interface AccountChangeRead extends AccountChangeSummary { realm: string; freshness: "recent" | "stale" | "unknown" }
export type InventorySearchLocation = InventoryAggregateEntry["locations"][number] & { state: "OBSERVED" | "LAST_SEEN"; observedAt?: number; importedAt: number; snapshotId: number; freshness: "recent" | "stale" | "unknown" };
export interface ItemWithMetadata { item: Omit<InventoryAggregateEntry, "locations"> & { locations: InventorySearchLocation[] }; metadataState: "KNOWN" | "UNKNOWN"; metadata?: ItemMetadataView }
export interface ItemSearchQuery { version: VersionOrUnknown; query: string; storage?: StorageLocation; offset?: number; limit?: number }
export interface CharacterStorageQuery extends CharacterQuery { storage: StorageLocation; offset?: number; limit?: number }
export interface CharacterStorageContents {
  storage: StorageLocation;
  sectionState: ReadState;
  itemsKnownEmpty: boolean;
  items?: InventorySection["items"];
  containers?: InventorySection["containers"];
  freeSlots?: number;
  totalSlots?: number;
  metadata: Array<{ itemRef?: string; state: "KNOWN" | "UNKNOWN"; value?: ItemMetadataView }>;
  returnedCount: number;
  totalCount: number;
  truncated: boolean;
}
export interface AccountOverviewRead {
  version: VersionOrUnknown;
  aggregationScope: AccountFacts["aggregationScope"];
  characterCount: number;
  realmsReturned: number;
  realmsTotal: number;
  realmsTruncated: boolean;
  freshness: Omit<AccountFacts["freshness"], "byCharacter">;
  gold: Omit<AccountFacts["gold"], "totalKnownCopper" | "byCharacter" | "largestRecentChanges"> & { totalKnownCopper?: number; returnedCharacters: number; totalCharacters: number; charactersTruncated: boolean } | Array<{ realm: string; gold: Omit<AccountFacts["gold"], "totalKnownCopper" | "byCharacter" | "largestRecentChanges"> & { totalKnownCopper?: number; returnedCharacters: number; totalCharacters: number; charactersTruncated: boolean } }>;
  playtime: Omit<AccountFacts["playtime"], "totalKnownPlayedSeconds" | "byCharacter"> & { totalKnownPlayedSeconds?: number; byCharacter: AccountFacts["playtime"]["byCharacter"]; returnedCharacters: number; totalCharacters: number; charactersTruncated: boolean } | Array<{ realm: string; playtime: Omit<AccountFacts["playtime"], "totalKnownPlayedSeconds" | "byCharacter"> & { totalKnownPlayedSeconds?: number; byCharacter: AccountFacts["playtime"]["byCharacter"]; returnedCharacters: number; totalCharacters: number; charactersTruncated: boolean } }>;
  progression: Omit<AccountFacts["progression"], "byCharacter" | "recentLevelUps"> & { byCharacter: AccountFacts["progression"]["byCharacter"]; recentLevelUps: AccountFacts["progression"]["recentLevelUps"]; returnedCharacters: number; totalCharacters: number; charactersTruncated: boolean };
  recentChanges: { items: AccountFacts["recentChanges"]; returnedCount: number; totalCount: number; truncated: boolean };
  professions: { coverage: AccountFacts["professions"]["coverage"]; returnedCount: number; totalCount: number; truncated: boolean };
  storageCoverage: { charactersWithObservedBags: number; charactersWithLastSeenBags: number; charactersWithUnknownBags: number; charactersWithObservedBank: number; charactersWithLastSeenBank: number; charactersWithUnknownBank: number; sharedStorage: { warband: { state: "DERIVED" | "UNKNOWN"; ownerKey?: string; completeness?: "complete" | "partial"; observedAt?: number; freshness?: string; warning: string }; guilds: { coverageState: "PARTIAL" | "UNKNOWN"; owners: Array<{ state: "DERIVED" | "UNKNOWN"; ownerKey: string; guildClubId: string; guildName?: string; completeness?: "complete" | "partial"; observedAt?: number; freshness?: string; inaccessibleTabs?: number; unconfirmedTabs?: number }>; returnedCount: number; totalCount: number; truncated: boolean } } };
  currencies: { coverage: { observedCharacters: number; lastSeenCharacters: number; unknownCharacters: number }; scope: "account-wide"; items: Array<{ currencyID: number; name: string | null; scope: "ACCOUNT" | "CHARACTER" | "UNKNOWN"; quantity?: number | null; state?: string; knownCharacters?: number; unknownCharacters?: number; notListedCharacters?: number; listedWithoutQuantity?: number }>; returnedCount: number; totalCount: number; truncated: boolean } | { scope: "realm"; byRealm: Array<{ realm: string; coverage: { observedCharacters: number; lastSeenCharacters: number; unknownCharacters: number }; items: Array<{ currencyID: number; name: string | null; scope: "ACCOUNT" | "CHARACTER" | "UNKNOWN"; quantity?: number; knownCharacters: number; unknownCharacters: number; notListedCharacters: number; listedWithoutQuantity: number }>; returnedCount: number; totalCount: number; truncated: boolean }> };
}
export interface GearCandidateEvidenceRead {
  version: "retail";
  selection: "latest stored candidate evidence per character";
  note: "Evidence is snapshot-scoped and may be historical; rows are not merged into account inventory.";
  characters: Array<{
    identity: { version: "retail"; identityKey: string; name: string; realm: string };
    captured: boolean;
    reason?: string;
    snapshot?: { snapshotId: number; generatedAt?: number; observedAt: number; importedAt: number; freshness: "recent" | "stale" | "unknown"; candidateObservedAt: number; candidateFreshness: "recent" | "stale" | "unknown" };
    sidecar?: Omit<GearCandidatesSection, "rows"> & { rows: GearCandidatesSection["rows"] };
  }>;
  offset: number; limit: number; totalCount: number; truncated: boolean;
}
type RetailRecipientClass = "MAGE" | "PRIEST" | "WARLOCK" | "DEMONHUNTER" | "DRUID" | "MONK" | "ROGUE" | "EVOKER" | "HUNTER" | "SHAMAN" | "DEATHKNIGHT" | "PALADIN" | "WARRIOR";
type RetailArmorFamily = "Cloth" | "Leather" | "Mail" | "Plate";
interface GearCandidateArmorCheck {
  state: "NOT_APPLICABLE" | "PASS" | "RULED_OUT" | "UNKNOWN";
  candidateFamily?: RetailArmorFamily;
  recipientNativeFamily?: RetailArmorFamily;
  reason: string;
}
type RetailWeaponFamily = "ONE_HANDED_AXE" | "TWO_HANDED_AXE" | "BOW" | "GUN" | "ONE_HANDED_MACE" | "TWO_HANDED_MACE" | "POLEARM" | "ONE_HANDED_SWORD" | "TWO_HANDED_SWORD" | "WARGLAIVE" | "STAFF" | "FIST_WEAPON" | "DAGGER" | "CROSSBOW" | "WAND";
interface GearCandidateWeaponProficiencyCheck {
  state: "NOT_APPLICABLE" | "PASS" | "RULED_OUT" | "UNKNOWN";
  candidateFamily?: RetailWeaponFamily;
  reason: string;
}

const RETAIL_WEAPON_CLASS_ID = 2;
const RETAIL_WEAPON_FAMILY_BY_SUBCLASS: Readonly<Record<number, RetailWeaponFamily>> = {
  0: "ONE_HANDED_AXE", 1: "TWO_HANDED_AXE", 2: "BOW", 3: "GUN", 4: "ONE_HANDED_MACE",
  5: "TWO_HANDED_MACE", 6: "POLEARM", 7: "ONE_HANDED_SWORD", 8: "TWO_HANDED_SWORD", 9: "WARGLAIVE",
  10: "STAFF", 13: "FIST_WEAPON", 15: "DAGGER", 18: "CROSSBOW", 19: "WAND",
};
const RETAIL_WEAPON_PROFICIENCIES: Readonly<Record<RetailRecipientClass, ReadonlySet<RetailWeaponFamily>>> = {
  DEATHKNIGHT: new Set(["ONE_HANDED_AXE", "TWO_HANDED_AXE", "ONE_HANDED_MACE", "TWO_HANDED_MACE", "POLEARM", "ONE_HANDED_SWORD", "TWO_HANDED_SWORD"]),
  DEMONHUNTER: new Set(["ONE_HANDED_AXE", "ONE_HANDED_SWORD", "FIST_WEAPON", "DAGGER", "WARGLAIVE"]),
  DRUID: new Set(["ONE_HANDED_MACE", "TWO_HANDED_MACE", "POLEARM", "STAFF", "FIST_WEAPON", "DAGGER"]),
  EVOKER: new Set(["ONE_HANDED_AXE", "TWO_HANDED_AXE", "ONE_HANDED_MACE", "TWO_HANDED_MACE", "ONE_HANDED_SWORD", "TWO_HANDED_SWORD", "STAFF", "FIST_WEAPON", "DAGGER"]),
  HUNTER: new Set(["TWO_HANDED_AXE", "BOW", "GUN", "POLEARM", "TWO_HANDED_SWORD", "STAFF", "CROSSBOW"]),
  MAGE: new Set(["ONE_HANDED_SWORD", "STAFF", "DAGGER", "WAND"]),
  MONK: new Set(["ONE_HANDED_AXE", "ONE_HANDED_MACE", "POLEARM", "ONE_HANDED_SWORD", "STAFF", "FIST_WEAPON"]),
  PALADIN: new Set(["ONE_HANDED_AXE", "TWO_HANDED_AXE", "ONE_HANDED_MACE", "TWO_HANDED_MACE", "POLEARM", "ONE_HANDED_SWORD", "TWO_HANDED_SWORD"]),
  PRIEST: new Set(["ONE_HANDED_MACE", "STAFF", "DAGGER", "WAND"]),
  ROGUE: new Set(["ONE_HANDED_AXE", "ONE_HANDED_MACE", "ONE_HANDED_SWORD", "FIST_WEAPON", "DAGGER"]),
  SHAMAN: new Set(["ONE_HANDED_AXE", "TWO_HANDED_AXE", "ONE_HANDED_MACE", "TWO_HANDED_MACE", "STAFF", "FIST_WEAPON", "DAGGER"]),
  WARLOCK: new Set(["ONE_HANDED_SWORD", "STAFF", "DAGGER", "WAND"]),
  WARRIOR: new Set(["ONE_HANDED_AXE", "TWO_HANDED_AXE", "BOW", "GUN", "ONE_HANDED_MACE", "TWO_HANDED_MACE", "POLEARM", "ONE_HANDED_SWORD", "TWO_HANDED_SWORD", "STAFF", "FIST_WEAPON", "DAGGER", "CROSSBOW"]),
};
const RETAIL_TWO_HANDED_WEAPON_FAMILIES: ReadonlySet<RetailWeaponFamily> = new Set(["TWO_HANDED_AXE", "TWO_HANDED_MACE", "POLEARM", "TWO_HANDED_SWORD", "STAFF"]);
const RETAIL_ONE_HANDED_WEAPON_FAMILIES: ReadonlySet<RetailWeaponFamily> = new Set(["ONE_HANDED_AXE", "ONE_HANDED_MACE", "ONE_HANDED_SWORD", "WARGLAIVE", "FIST_WEAPON", "DAGGER"]);
const RETAIL_EQUIP_LOCATION_BY_TYPE: Readonly<Record<number, string>> = {
  13: "INVTYPE_WEAPON", 17: "INVTYPE_2HWEAPON", 21: "INVTYPE_WEAPONMAINHAND", 22: "INVTYPE_WEAPONOFFHAND", 15: "INVTYPE_RANGED", 26: "INVTYPE_RANGEDRIGHT",
};
const RETAIL_WEAPON_LOCATION_ALIASES: Readonly<Record<string, string>> = {
  INVTYPE_WEAPON: "WEAPON", INVTYPE_WEAPONMAINHAND: "WEAPON", INVTYPE_WEAPONOFFHAND: "WEAPON",
  INVTYPE_2HWEAPON: "2HWEAPON", INVTYPE_RANGED: "RANGED", INVTYPE_RANGEDRIGHT: "RANGED",
};

function evaluateWeaponProficiencyCheck(candidate: GearCandidatesSection["rows"][number], recipientClass: RetailRecipientClass | undefined): GearCandidateWeaponProficiencyCheck {
  const unknown = (reason: string, candidateFamily?: RetailWeaponFamily): GearCandidateWeaponProficiencyCheck => ({ state: "UNKNOWN", ...(candidateFamily ? { candidateFamily } : {}), reason });
  if (candidate.classID.state === "KNOWN" && candidate.classID.value !== RETAIL_WEAPON_CLASS_ID) {
    return { state: "NOT_APPLICABLE", reason: "Candidate item class is known not to be Weapon; class-level weapon proficiency screening does not apply." };
  }
  if (candidate.classID.state !== "KNOWN") return unknown("Candidate classID is UNKNOWN; weapon applicability is not inferred from equipType or baseEquipLocation.");
  if (candidate.subclassID.state !== "KNOWN") return unknown("Candidate Weapon subclassID is UNKNOWN; weapon family cannot be determined.");
  const candidateFamily = RETAIL_WEAPON_FAMILY_BY_SUBCLASS[candidate.subclassID.value];
  if (candidateFamily === undefined) return unknown(`Candidate Weapon subclassID ${candidate.subclassID.value} is unsupported or legacy; current Retail proficiency was not guessed.`);

  const typeLocationRaw = candidate.equipType.state === "KNOWN" ? RETAIL_EQUIP_LOCATION_BY_TYPE[candidate.equipType.value] : undefined;
  const typeLocation = typeLocationRaw === undefined ? undefined : RETAIL_WEAPON_LOCATION_ALIASES[typeLocationRaw];
  const baseLocation = candidate.baseEquipLocation.state === "KNOWN" ? RETAIL_WEAPON_LOCATION_ALIASES[candidate.baseEquipLocation.value.trim().toUpperCase()] : undefined;
  const knownNonWeaponType = candidate.equipType.state === "KNOWN" && typeLocation === undefined && (RETAIL_BODY_SLOT_BY_INVENTORY_TYPE[candidate.equipType.value] !== undefined || RETAIL_NON_BODY_LOCATION_BY_INVENTORY_TYPE[candidate.equipType.value] !== undefined);
  const normalizedBaseEquipLocation = candidate.baseEquipLocation.state === "KNOWN" ? candidate.baseEquipLocation.value.trim().toUpperCase() : undefined;
  const knownNonWeaponBaseLocation = normalizedBaseEquipLocation !== undefined && RETAIL_WEAPON_LOCATION_ALIASES[normalizedBaseEquipLocation] === undefined && (RETAIL_BODY_SLOT_BY_BASE_EQUIP_LOCATION[normalizedBaseEquipLocation] !== undefined || RETAIL_NON_BODY_BASE_LOCATION_BY_NAME[normalizedBaseEquipLocation] !== undefined);
  if (knownNonWeaponType || knownNonWeaponBaseLocation) {
    return unknown("Known equipType or baseEquipLocation identifies a non-weapon slot, contradicting the captured Weapon item class.", candidateFamily);
  }
  if ((candidate.equipType.state === "KNOWN" && typeLocation !== undefined) && (candidate.baseEquipLocation.state === "KNOWN" && baseLocation !== undefined) && typeLocation !== baseLocation) {
    return unknown("Known equipType and baseEquipLocation contradict each other; weapon family result was withheld.", candidateFamily);
  }
  const location = typeLocation ?? baseLocation;
  if (location === "2HWEAPON" && RETAIL_ONE_HANDED_WEAPON_FAMILIES.has(candidateFamily)) {
    return unknown("Known two-handed location contradicts the captured one-handed weapon subclass.", candidateFamily);
  }
  if (location === "WEAPON" && RETAIL_TWO_HANDED_WEAPON_FAMILIES.has(candidateFamily)) {
    return unknown("Known ordinary weapon location contradicts the captured two-handed weapon subclass.", candidateFamily);
  }
  if (location === "RANGED" && RETAIL_TWO_HANDED_WEAPON_FAMILIES.has(candidateFamily)) {
    return unknown("Known ranged location contradicts the captured two-handed weapon subclass.", candidateFamily);
  }
  if (candidate.candidateState !== "EQUIPPABLE") return unknown("Candidate state is UNKNOWN; class-level weapon proficiency was not asserted for an unresolved candidate.", candidateFamily);
  if (recipientClass === undefined) return unknown("Recipient class is not usable OBSERVED evidence for the weapon proficiency check.", candidateFamily);
  if (recipientClass === "HUNTER" && (candidateFamily === "ONE_HANDED_AXE" || candidateFamily === "ONE_HANDED_SWORD" || candidateFamily === "DAGGER")) {
    return unknown(`Retail ${candidateFamily.replaceAll("_", " ").toLowerCase()} access is specialization-dependent for Hunters; recipient specialization is not checked by this screen.`, candidateFamily);
  }
  if (RETAIL_WEAPON_PROFICIENCIES[recipientClass].has(candidateFamily)) {
    return { state: "PASS", candidateFamily, reason: `Recipient class has current Retail class-level proficiency/access for ${candidateFamily.replaceAll("_", " ").toLowerCase()}. This does not establish specialization suitability, ability compatibility, or full CanEquip.` };
  }
  return { state: "RULED_OUT", candidateFamily, reason: `Current Retail class-level weapon proficiency mismatch: recipient class does not have checked access for ${candidateFamily.replaceAll("_", " ").toLowerCase()}. This is not a full CanEquip determination.` };
}

const RETAIL_ARMOR_FAMILY_BY_CLASS: Readonly<Record<RetailRecipientClass, RetailArmorFamily>> = {
  MAGE: "Cloth", PRIEST: "Cloth", WARLOCK: "Cloth",
  DEMONHUNTER: "Leather", DRUID: "Leather", MONK: "Leather", ROGUE: "Leather",
  EVOKER: "Mail", HUNTER: "Mail", SHAMAN: "Mail",
  DEATHKNIGHT: "Plate", PALADIN: "Plate", WARRIOR: "Plate",
};
const RETAIL_CLASS_BY_NORMALIZED_NAME: Readonly<Record<string, RetailRecipientClass>> = {
  MAGE: "MAGE", PRIEST: "PRIEST", WARLOCK: "WARLOCK",
  DEMONHUNTER: "DEMONHUNTER", DRUID: "DRUID", MONK: "MONK", ROGUE: "ROGUE",
  EVOKER: "EVOKER", HUNTER: "HUNTER", SHAMAN: "SHAMAN",
  DEATHKNIGHT: "DEATHKNIGHT", PALADIN: "PALADIN", WARRIOR: "WARRIOR",
};
const RETAIL_ARMOR_CLASS_ID = 4;
const RETAIL_ARMOR_FAMILY_BY_SUBCLASS: Readonly<Record<number, RetailArmorFamily>> = {
  1: "Cloth", 2: "Leather", 3: "Mail", 4: "Plate",
};
type RetailBodySlot = "HEAD" | "SHOULDER" | "CHEST" | "WAIST" | "LEGS" | "FEET" | "WRIST" | "HAND";
const RETAIL_EQUIP_TYPE = {
  HEAD: 1, NECK: 2, SHOULDER: 3, BODY: 4, CHEST: 5, WAIST: 6, LEGS: 7, FEET: 8, WRIST: 9, HAND: 10,
  FINGER: 11, TRINKET: 12, WEAPON: 13, SHIELD: 14, RANGED: 15, CLOAK: 16, TWO_HAND_WEAPON: 17,
  BAG: 18, TABARD: 19, ROBE: 20, WEAPON_MAIN_HAND: 21, WEAPON_OFF_HAND: 22, HOLDABLE: 23, AMMO: 24,
  THROWN: 25, RANGED_RIGHT: 26, QUIVER: 27, RELIC: 28, PROFESSION_TOOL: 29, PROFESSION_GEAR: 30,
} as const;
const RETAIL_BODY_SLOT_BY_INVENTORY_TYPE: Readonly<Record<number, RetailBodySlot>> = {
  [RETAIL_EQUIP_TYPE.HEAD]: "HEAD", [RETAIL_EQUIP_TYPE.SHOULDER]: "SHOULDER", [RETAIL_EQUIP_TYPE.CHEST]: "CHEST",
  [RETAIL_EQUIP_TYPE.WAIST]: "WAIST", [RETAIL_EQUIP_TYPE.LEGS]: "LEGS", [RETAIL_EQUIP_TYPE.FEET]: "FEET",
  [RETAIL_EQUIP_TYPE.WRIST]: "WRIST", [RETAIL_EQUIP_TYPE.HAND]: "HAND", [RETAIL_EQUIP_TYPE.ROBE]: "CHEST",
};
const RETAIL_BODY_SLOT_BY_BASE_EQUIP_LOCATION: Readonly<Record<string, RetailBodySlot>> = {
  INVTYPE_HEAD: "HEAD", INVTYPE_SHOULDER: "SHOULDER", INVTYPE_CHEST: "CHEST", INVTYPE_ROBE: "CHEST",
  INVTYPE_WAIST: "WAIST", INVTYPE_LEGS: "LEGS", INVTYPE_FEET: "FEET", INVTYPE_WRIST: "WRIST", INVTYPE_HAND: "HAND",
};
const RETAIL_NON_BODY_LOCATION_BY_INVENTORY_TYPE: Readonly<Record<number, string>> = {
  [RETAIL_EQUIP_TYPE.NECK]: "NECK", [RETAIL_EQUIP_TYPE.BODY]: "BODY", [RETAIL_EQUIP_TYPE.FINGER]: "FINGER",
  [RETAIL_EQUIP_TYPE.TRINKET]: "TRINKET", [RETAIL_EQUIP_TYPE.WEAPON]: "WEAPON", [RETAIL_EQUIP_TYPE.SHIELD]: "SHIELD",
  [RETAIL_EQUIP_TYPE.RANGED]: "RANGED", [RETAIL_EQUIP_TYPE.CLOAK]: "CLOAK", [RETAIL_EQUIP_TYPE.TWO_HAND_WEAPON]: "2HWEAPON",
  [RETAIL_EQUIP_TYPE.BAG]: "BAG", [RETAIL_EQUIP_TYPE.TABARD]: "TABARD", [RETAIL_EQUIP_TYPE.WEAPON_MAIN_HAND]: "WEAPONMAINHAND",
  [RETAIL_EQUIP_TYPE.WEAPON_OFF_HAND]: "WEAPONOFFHAND", [RETAIL_EQUIP_TYPE.HOLDABLE]: "HOLDABLE", [RETAIL_EQUIP_TYPE.AMMO]: "AMMO",
  [RETAIL_EQUIP_TYPE.THROWN]: "THROWN", [RETAIL_EQUIP_TYPE.RANGED_RIGHT]: "RANGEDRIGHT", [RETAIL_EQUIP_TYPE.QUIVER]: "QUIVER",
  [RETAIL_EQUIP_TYPE.RELIC]: "RELIC", [RETAIL_EQUIP_TYPE.PROFESSION_TOOL]: "PROFESSION_TOOL", [RETAIL_EQUIP_TYPE.PROFESSION_GEAR]: "PROFESSION_GEAR",
};
const RETAIL_NON_BODY_BASE_LOCATION_BY_NAME: Readonly<Record<string, string>> = Object.fromEntries(
  Object.values(RETAIL_NON_BODY_LOCATION_BY_INVENTORY_TYPE).map((location) => [`INVTYPE_${location}`, location]),
);

function normalizeRetailRecipientClass(raw: string | undefined): RetailRecipientClass | undefined {
  if (!raw) return undefined;
  // The WoW class token and canonical English display name differ only by spaces here.
  return RETAIL_CLASS_BY_NORMALIZED_NAME[raw.trim().replaceAll(" ", "").toUpperCase()];
}

function evaluateNativeArmorCheck(candidate: GearCandidatesSection["rows"][number], recipientClass: RetailRecipientClass | undefined): GearCandidateArmorCheck {
  const unknown = (reason: string, candidateFamily?: RetailArmorFamily): GearCandidateArmorCheck => ({ state: "UNKNOWN", ...(candidateFamily ? { candidateFamily } : {}), reason });
  const notApplicable = (reason: string): GearCandidateArmorCheck => ({ state: "NOT_APPLICABLE", reason });

  if (candidate.classID.state === "KNOWN" && candidate.classID.value !== RETAIL_ARMOR_CLASS_ID) {
    return notApplicable("Candidate item class is not Armor; native armor-family screening does not apply.");
  }
  if (candidate.classID.state === "KNOWN" && candidate.classID.value === RETAIL_ARMOR_CLASS_ID && candidate.subclassID.state === "KNOWN" && RETAIL_ARMOR_FAMILY_BY_SUBCLASS[candidate.subclassID.value] === undefined) {
    return notApplicable("Candidate armor subclass is outside Cloth, Leather, Mail, and Plate; native armor-family screening does not apply.");
  }

  const type = candidate.equipType.state === "KNOWN" ? candidate.equipType.value : undefined;
  const location = candidate.baseEquipLocation.state === "KNOWN" ? candidate.baseEquipLocation.value.toUpperCase() : undefined;
  const typeBodySlot = type === undefined ? undefined : RETAIL_BODY_SLOT_BY_INVENTORY_TYPE[type];
  const locationBodySlot = location === undefined ? undefined : RETAIL_BODY_SLOT_BY_BASE_EQUIP_LOCATION[location];
  const typeNonBodyLocation = type === undefined ? undefined : RETAIL_NON_BODY_LOCATION_BY_INVENTORY_TYPE[type];
  const locationNonBodyLocation = location === undefined ? undefined : RETAIL_NON_BODY_BASE_LOCATION_BY_NAME[location];
  const typeCategory = typeBodySlot !== undefined ? `BODY:${typeBodySlot}` : typeNonBodyLocation !== undefined ? `OTHER:${typeNonBodyLocation}` : undefined;
  const locationCategory = locationBodySlot !== undefined ? `BODY:${locationBodySlot}` : locationNonBodyLocation !== undefined ? `OTHER:${locationNonBodyLocation}` : undefined;
  const typeUnrecognized = type !== undefined && typeCategory === undefined;
  const locationUnrecognized = location !== undefined && locationCategory === undefined;

  if (typeUnrecognized || locationUnrecognized) {
    return unknown("Candidate equipType or baseEquipLocation is an unrecognized slot value; armor applicability was not guessed.");
  }
  if (typeCategory !== undefined && locationCategory !== undefined && typeCategory !== locationCategory) {
    return unknown("Candidate equipType and baseEquipLocation contradict each other; armor slot was not guessed.");
  }
  if (typeNonBodyLocation !== undefined || locationNonBodyLocation !== undefined) {
    return notApplicable("Candidate is identified as non-body equipment; native armor-family screening does not apply.");
  }
  if (typeBodySlot === undefined || locationBodySlot === undefined) {
    return unknown("Candidate equipType and baseEquipLocation do not both identify a coherent ordinary body armor slot.");
  }

  if (candidate.classID.state !== "KNOWN" || candidate.subclassID.state !== "KNOWN") {
    return unknown("Candidate classID or subclassID is UNKNOWN for an ordinary body armor slot.");
  }
  const candidateFamily = RETAIL_ARMOR_FAMILY_BY_SUBCLASS[candidate.subclassID.value];
  if (candidate.classID.value !== RETAIL_ARMOR_CLASS_ID || candidateFamily === undefined) {
    return notApplicable("Candidate is not identified as Cloth, Leather, Mail, or Plate body armor.");
  }
  if (recipientClass === undefined) {
    return unknown("Recipient class is not usable OBSERVED evidence for the native armor-family check.", candidateFamily);
  }
  const recipientNativeFamily = RETAIL_ARMOR_FAMILY_BY_CLASS[recipientClass];
  if (candidateFamily !== recipientNativeFamily) {
    return { state: "RULED_OUT", candidateFamily, recipientNativeFamily, reason: `Native armor-family mismatch: candidate is ${candidateFamily} body armor, while the recipient's native armor family is ${recipientNativeFamily}. This plausibility-screen result does not establish whether the Retail client technically permits equipping it.` };
  }
  return { state: "PASS", candidateFamily, recipientNativeFamily, reason: `Candidate ${candidateFamily} body armor matches the recipient's native ${recipientNativeFamily} armor family.` };
}

export interface GearCandidateRecipientScreenRead {
  version: "retail";
  exporter: GearCandidateEvidenceRead["characters"][number]["identity"];
  recipient: GearCandidateEvidenceRead["characters"][number]["identity"];
  accountMembership: "NOT_ESTABLISHED_BY_DASHBOARD_IDENTITY";
  accountMembershipCaveat: "Dashboard-known Retail identity does not establish that exporter and recipient belong to the same Battle.net account.";
  candidateEvidence: {
    captured: boolean;
    reason?: string;
    exporterOnlyEvidenceNote: "currentCharacterCanUse describes only the exporting character and is not used to screen the selected recipient.";
    bindingEvidenceNote: "Binding predicates are raw independent evidence and are not used to infer transferability.";
    snapshot?: { snapshotId: number; generatedAt?: number; observedAt: number; importedAt: number; freshness: "recent" | "stale" | "unknown"; candidateObservedAt: number; candidateFreshness: "recent" | "stale" | "unknown" };
    completeness?: GearCandidatesSection["completeness"];
    rows?: Array<{
      /** One-based occurrence within this captured section only; it is not a durable candidate identity. */
      rowOrdinal: number;
      candidateState: GearCandidatesSection["rows"][number]["candidateState"];
      observationState: GearCandidatesSection["rows"][number]["observationState"];
      result: "RULED_OUT" | "NOT_RULED_OUT_BY_CHECKED_RULES" | "UNKNOWN";
      reason: string;
      armorCheck: GearCandidateArmorCheck;
      weaponProficiencyCheck: GearCandidateWeaponProficiencyCheck;
      requiredLevel: GearCandidatesSection["rows"][number]["requiredLevel"];
      candidate: GearCandidatesSection["rows"][number];
    }>;
    offset?: number;
    limit?: number;
    totalCount?: number;
    truncated?: boolean;
  };
  recipientLevel: {
    evidence: { state: "KNOWN"; value: number; sectionState: SectionState } | { state: "UNKNOWN"; value?: number; sectionState: SectionState; reason: string };
    snapshot?: { snapshotId: number; generatedAt?: number; observedAt: number; importedAt: number; freshness: "recent" | "stale" | "unknown" };
  };
  recipientClass: {
    evidence:
      | { state: "KNOWN"; value: string; normalizedClass: RetailRecipientClass; sectionState: "OBSERVED" }
      | { state: "UNKNOWN"; value?: string; sectionState: SectionState; reason: string };
    snapshot?: { snapshotId: number; generatedAt?: number; observedAt: number; importedAt: number; freshness: "recent" | "stale" | "unknown" };
  };
  uncheckedRestrictions: string;
  paging?: { offset: number; limit: number; totalCount: number; truncated: boolean };
}
export type GearCandidateRecipientScreenResolution =
  | { status: "UNSUPPORTED_VERSION"; version: VersionOrUnknown }
  | { status: "EXPORTER_NOT_FOUND"; version: "retail"; name: string; realm: string }
  | { status: "EXPORTER_AMBIGUOUS"; version: "retail"; name: string; realm: string; candidates: Array<Pick<StoredCharacterSummary, "identityKey" | "realm" | "name">> }
  | { status: "RECIPIENT_NOT_FOUND"; version: "retail"; name: string; realm: string }
  | { status: "RECIPIENT_AMBIGUOUS"; version: "retail"; name: string; realm: string; candidates: Array<Pick<StoredCharacterSummary, "identityKey" | "realm" | "name">> }
  | { status: "FOUND"; value: ReadValue<GearCandidateRecipientScreenRead> };
export interface CharacterCurrentState {
  identity: { version: VersionOrUnknown; identityKey: string; name: string; realm: string; class?: string; faction?: string; level?: number };
  provenance: ReadProvenance;
  gold: { copper?: number; provenance: ReadProvenance };
  playtime: { playedSeconds?: number; levelPlayedSeconds?: number; provenance: ReadProvenance };
  location: { zone?: string; subzone?: string; mapID?: string; x?: string; y?: string; provenance: ReadProvenance };
  progression: { xp?: number; xpMax?: number; xpPercent?: number };
  equipment: { state: ReadState; equippedSlots?: number; knownItemLevelSlots?: number; averageItemLevel?: number; provenance: ReadProvenance };
  bags: { state: ReadState; freeSlots?: number; totalSlots?: number; itemStackCount?: number; provenance: ReadProvenance };
  bank: { state: ReadState; freeSlots?: number; totalSlots?: number; itemStackCount?: number; provenance: ReadProvenance };
  professions: { state: ReadState; entries?: Array<{ name: string; skill?: number; maxSkill?: number; tier?: string; expansion?: string }>; totalCount?: number; truncated?: boolean; provenance: ReadProvenance };
  currencies: { state: ReadState; entries?: Array<{ currencyID: number; name: string | null; quantity: number | null; isAccountWide: boolean | null }>; totalCount?: number; truncated?: boolean; provenance: ReadProvenance };
}
export interface SharedStorageReadQuery { version: VersionOrUnknown; kind: "warband" | "guild"; guildClubId?: string; query?: string; offset?: number; limit?: number; ownerOffset?: number; ownerLimit?: number }
export type PagedSharedObservation = Omit<SharedObservationView, "content"> & { content: Omit<SharedObservationView["content"], "items"> & { items: SharedObservationView["content"]["items"]; totalCount: number; offset: number; limit: number; truncated: boolean } };
export interface SharedStorageReadOwner {
  owner: SharedOwnerView["owner"];
  basis: "DERIVED";
  observationCount: SharedOwnerView["observationCount"];
  hasConflict: boolean;
  conflictObservedAt?: number;
  current: PagedSharedObservation | null;
  latestPartial: PagedSharedObservation | null;
  broaderCoverageEarlier: PagedSharedObservation | null;
}
export interface SharedStorageReadPage { asOf: number; owners: SharedStorageReadOwner[]; ownerOffset: number; ownerLimit: number; totalOwners: number; ownersTruncated: boolean }

export interface AllocationReviewQuery {
  version: VersionOrUnknown;
  demandedOffset?: number;
  demandedLimit?: number;
  unallocatedOffset?: number;
  unallocatedLimit?: number;
  /**
   * Optional unallocated search (Dashboard Allocation tab): case-insensitive observed-name substring, or an exact
   * base item id. Applied BEFORE unallocated paging, so `unallocated.totalCount` counts matches. It never filters
   * `demanded`, and the whole-list fields (`unallocatedItemStringIdentityCounts`, `dispositionCounts`,
   * `unresolvedStorage`) keep describing the whole account. Empty/absent: no filtering.
   */
  q?: string;
}
export type UnallocatedInventoryRead = UnallocatedInventoryEntry & { metadataState: "KNOWN" | "UNKNOWN"; metadata?: ItemMetadataView };
/** Azeroth ERP Slice 2 account-wide review. `demanded` and `unallocated` are independently paged; `dispositionCounts` covers every demanded item, not only the page. */
export interface AccountAllocationReview {
  version: "retail";
  /** Whole account-owned storage scopes whose contents are UNKNOWN; they leave every item's quantities a floor. */
  unresolvedStorage: UnresolvedStorageScope[];
  hasUnresolvedStorage: boolean;
  /** Account-owned item rows with no parseable base item id; reported, never silently dropped, but not attributable to an item. */
  unidentifiedItemRowCount: number;
  dispositionCounts: DispositionCounts;
  /** Slice 3: identity-class counts over EVERY unallocated entry, not only the page. */
  unallocatedItemStringIdentityCounts: UnallocatedItemStringIdentityCounts;
  demanded: BoundedPage<AllocationResult>;
  unallocated: BoundedPage<UnallocatedInventoryRead>;
  /**
   * Presentation sidecar for the demanded PAGE: base item id -> the name observed in account-owned evidence
   * (`itemNameForItem`, the same projection the review reads). Attached after paging like unallocated metadata.
   * An item with no observed name has no key (unknown, never an empty string). Deliberately NOT part of any
   * AllocationResult, so each demanded entry still deep-equals getItemAllocation for the same item.
   */
  itemNames: Record<number, string>;
}

function pageBounds(offset = 0, limit = 50): { offset: number; limit: number } {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("offset must be a non-negative integer");
  if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError("limit must be a positive integer");
  return { offset, limit: Math.min(limit, 100) };
}
function changeList<T>(items: readonly T[], limit: number): ChangeList<T> {
  const selected = items.slice(0, limit);
  return { items: [...selected], returnedCount: selected.length, totalCount: items.length, truncated: selected.length < items.length };
}
function sectionComparison(from: SectionState, to: SectionState): { state: ChangeComparisonState; reason?: string } {
  if (from === "LAST_SEEN" || to === "LAST_SEEN") return { state: "LAST_SEEN", reason: "At least one section is a historical LAST_SEEN observation; changes are not inferred." };
  if (from === "UNKNOWN" || to === "UNKNOWN") return { state: "UNKNOWN", reason: "At least one compared section is UNKNOWN; absence is not treated as removal." };
  return { state: "COMPARED" };
}
function numericChange(from: number | undefined, to: number | undefined, fromState: SectionState, toState: SectionState): NumericChange {
  const comparable = sectionComparison(fromState, toState);
  if (comparable.state !== "COMPARED") return { state: comparable.state, fromState, toState, ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}), reason: comparable.reason };
  if (from === undefined || to === undefined) return { state: "UNKNOWN", fromState, toState, ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}), reason: "A value is missing from one snapshot; it is not treated as zero." };
  return { state: "COMPARED", fromState, toState, from, to, delta: to - from };
}
function inventoryComparison<T extends InventorySection>(from: T, to: T): { state: ChangeComparisonState; reason?: string } {
  const base = sectionComparison(from.status.state, to.status.state);
  if (base.state !== "COMPARED") return base;
  if (from.status.completeness?.toLowerCase() !== "complete" || to.status.completeness?.toLowerCase() !== "complete") return { state: "NOT_COMPARABLE", reason: "Both inventory observations must have complete coverage before additions or removals can be inferred." };
  if (from.items.some((item) => item.qty === undefined) || to.items.some((item) => item.qty === undefined)) return { state: "NOT_COMPARABLE", reason: "At least one item quantity is unknown; no inventory quantity changes are inferred." };
  return { state: "COMPARED" };
}
function fullSectionComparison(from: SectionState, to: SectionState, fromCompleteness?: string, toCompleteness?: string): { state: ChangeComparisonState; reason?: string } {
  const base = sectionComparison(from, to);
  if (base.state !== "COMPARED") return base;
  if (fromCompleteness?.toLowerCase() !== "complete" || toCompleteness?.toLowerCase() !== "complete") return { state: "NOT_COMPARABLE", reason: "Both section observations must report complete coverage before additions or removals can be inferred." };
  return { state: "COMPARED" };
}
function metadataByItemRef(store: SnapshotReadStore, version: VersionOrUnknown, refs: readonly (string | undefined)[]) {
  const ids = [...new Set(refs.map((ref) => itemIdFromItemRef(ref)).filter((id): id is number => id !== undefined))];
  return new Map(store.getItemMetadata(version, ids).map((metadata) => [metadata.baseItemId, metadata]));
}
function metadataFor(ref: string | undefined, map: Map<number, ItemMetadataView>) {
  const id = itemIdFromItemRef(ref);
  const value = id === undefined ? undefined : map.get(id);
  return { itemRef: ref, state: value ? "KNOWN" as const : "UNKNOWN" as const, ...(value ? { value } : {}) };
}
function pageSharedObservation(observation: SharedObservationView | null, query: SharedStorageReadQuery, offset: number, limit: number): PagedSharedObservation | null {
  if (!observation) return null;
  const needle = query.query?.trim().toLocaleLowerCase();
  const all = observation.content.items.filter((item) => !needle || `${item.name ?? ""} ${item.itemRef ?? ""}`.toLocaleLowerCase().includes(needle));
  const items = all.slice(offset, offset + limit);
  return { ...observation, content: { ...observation.content, items, totalCount: all.length, offset, limit, truncated: offset + items.length < all.length } };
}

function statusToReadState(status: SectionState): ReadState { return status; }
function requireVersion(version: unknown): asserts version is VersionOrUnknown {
  if (!(READ_MODEL_VERSIONS as readonly unknown[]).includes(version)) throw new TypeError("A recognized WoW version is required; the read model never defaults to Retail.");
}

export class DashboardReadModel {
  private readonly store: SnapshotReadStore;
  private readonly now: () => number;
  constructor(store: SnapshotReadStore, now: () => number = () => Math.floor(Date.now() / 1000)) {
    this.store = store;
    this.now = now;
  }

  listVersions(): VersionSummary[] { return this.store.listVersions(); }
  listCharacters(query: { version: VersionOrUnknown; realm?: string }): StoredCharacterSummary[] {
    requireVersion(query.version);
    return this.store.listCharacters(query.version).filter((character) => !query.realm || character.realm === query.realm);
  }

  /** Durable planning intent plus a fresh evidence projection from each explicitly named character only. */
  getErpProjects(query: { version: VersionOrUnknown }): ErpProjectView[] {
    requireVersion(query.version);
    const projects = this.store.listErpProjects(query.version);
    const currencies = this.store.listVersionCurrencies(query.version);
    const candidateSources = this.store.listCharacters(query.version);
    const needsSharedStorage = query.version === "retail" && projects.some((project) => project.needs.some((need) => need.sourceOwnerKey !== undefined));
    const sharedStorage = needsSharedStorage ? this.store.projectSharedStorage() : undefined;
    return projects.map((project) => {
      const historyEventCount = this.store.countErpProjectHistory(project.stableId);
      const history = this.store.listErpProjectHistory(project.stableId, 50);
      return {
        ...evaluateErpProject(project, (identityKey) => this.store.listSnapshots(identityKey), projects, this.now(), currencies, sharedStorage, candidateSources),
        history, historyEventCount, historyTruncated: historyEventCount > history.length,
      };
    });
  }

  /** Snapshot-scoped Retail candidate evidence; this is not an inventory, allocation, or gear-policy projection. */
  getGearCandidateEvidence(query: { version: VersionOrUnknown; offset?: number; limit?: number }): ReadValue<GearCandidateEvidenceRead> {
    requireVersion(query.version);
    if (query.version !== "retail") return { provenance: { state: "UNKNOWN", version: query.version, reason: "Gear Candidates ContractVersion 1 is Retail-only." } };
    const characters: GearCandidateEvidenceRead["characters"] = this.store.listCharacters("retail").map((character) => {
      const snapshots = this.store.listSnapshots(character.identityKey);
      const snapshot = snapshots.find((entry) => entry.parsed.gearCandidates !== undefined);
      if (!snapshot) return {
        identity: { version: "retail", identityKey: character.identityKey, name: character.name, realm: character.realm },
        captured: false,
        reason: "No stored snapshot for this character contains [GEAR CANDIDATES].",
      };
      const observedAt = snapshotObservedAt(snapshot.generatedAt, snapshot.importedAt);
      const candidateObservedAt = snapshot.parsed.gearCandidates!.observedAt ?? observedAt;
      return {
        identity: { version: "retail", identityKey: character.identityKey, name: character.name, realm: character.realm },
        captured: true,
        snapshot: { snapshotId: snapshot.id, ...(snapshot.generatedAt !== undefined ? { generatedAt: snapshot.generatedAt } : {}), observedAt, importedAt: snapshot.importedAt, freshness: classifyFreshness(observedAt, this.now()), candidateObservedAt, candidateFreshness: classifyFreshness(candidateObservedAt, this.now()) },
        sidecar: snapshot.parsed.gearCandidates!,
      };
    });
    const page = pageBounds(query.offset ?? 0, query.limit ?? 50);
    const items = characters.slice(page.offset, page.offset + page.limit);
    const latestObservedAt = characters.reduce<number | undefined>((max, item) => item.snapshot ? Math.max(max ?? 0, item.snapshot.observedAt) : max, undefined);
    return {
      data: { version: "retail", selection: "latest stored candidate evidence per character", note: "Evidence is snapshot-scoped and may be historical; rows are not merged into account inventory.", characters: items, offset: page.offset, limit: page.limit, totalCount: characters.length, truncated: page.offset + items.length < characters.length },
      provenance: { state: "DERIVED", version: "retail", ...(latestObservedAt !== undefined ? { observedAt: latestObservedAt, freshness: classifyFreshness(latestObservedAt, this.now()) } : {}), source: "latest stored snapshot containing the Retail [GEAR CANDIDATES] sidecar per character", derivedFrom: characters.flatMap((item) => item.snapshot ? [String(item.snapshot.snapshotId)] : []), warning: "Latest stored candidate evidence is not necessarily current inventory; candidate rows are not merged across characters." },
    };
  }

  /** Analyze one snapshot-scoped candidate row using deterministic Retail rules. */
  analyzeRetailGearCandidate(query: { version: VersionOrUnknown; exporterIdentityKey: string; snapshotId: number; rowOrdinal: number }) {
    requireVersion(query.version);
    if (query.version !== "retail") return { status: "UNKNOWN" as const, reason: "Gear allocation rules are Retail-only." };
    if (!Number.isSafeInteger(query.snapshotId) || query.snapshotId <= 0 || !Number.isSafeInteger(query.rowOrdinal) || query.rowOrdinal <= 0) return { status: "INVALID_REFERENCE" as const, reason: "A positive source snapshot ID and one-based row ordinal are required." };
    const exporter = this.store.listCharacters("retail").find((c) => c.identityKey === query.exporterIdentityKey);
    if (!exporter) return { status: "EXPORTER_NOT_FOUND" as const };
    const snapshot = this.store.listSnapshots(exporter.identityKey).find((s) => s.id === query.snapshotId);
    const section = snapshot?.parsed.gearCandidates;
    if (!section) return { status: "CANDIDATE_EVIDENCE_NOT_FOUND" as const, reason: "The selected source snapshot does not contain Retail [GEAR CANDIDATES] evidence." };
    const candidate = section.rows[query.rowOrdinal - 1];
    if (!candidate) return { status: "CANDIDATE_ROW_NOT_FOUND" as const };
    const characters = this.store.listCharacters("retail").map((c) => {
      const latest = this.store.listSnapshots(c.identityKey)[0];
      const state = latest?.parsed.character;
      return { identityKey: c.identityKey, name: c.name, realm: c.realm, class: state?.class, level: state?.level, characterState: state?.status.state ?? "UNKNOWN", latestSnapshotId: latest?.id, observations: this.store.listEquipmentObservations(c.identityKey) };
    });
    return { status: "FOUND" as const, value: assessRetailCandidate({ candidate, exporterSnapshotId: snapshot.id, rowOrdinal: query.rowOrdinal, candidateObservedAt: section.observedAt, characters }) };
  }

  /** Retail required-level and native armor-family plausibility screen; passing is not an equipability or suitability claim. */
  getGearCandidateRecipientScreen(query: { version: VersionOrUnknown; exporterName: string; exporterRealm: string; recipientName: string; recipientRealm: string; offset?: number; limit?: number }): GearCandidateRecipientScreenResolution {
    requireVersion(query.version);
    if (query.version !== "retail") return { status: "UNSUPPORTED_VERSION", version: query.version };
    const page = pageBounds(query.offset ?? 0, query.limit ?? 50);

    const resolveExact = (name: string, realm: string) => this.store.listCharacters("retail").filter((character) =>
      character.name.toLocaleLowerCase() === name.toLocaleLowerCase() && character.realm.toLocaleLowerCase() === realm.toLocaleLowerCase());
    const exporterMatches = resolveExact(query.exporterName, query.exporterRealm);
    if (exporterMatches.length === 0) return { status: "EXPORTER_NOT_FOUND", version: "retail", name: query.exporterName, realm: query.exporterRealm };
    if (exporterMatches.length > 1) return { status: "EXPORTER_AMBIGUOUS", version: "retail", name: query.exporterName, realm: query.exporterRealm, candidates: exporterMatches.map(({ identityKey, name, realm }) => ({ identityKey, name, realm })) };
    const recipientMatches = resolveExact(query.recipientName, query.recipientRealm);
    if (recipientMatches.length === 0) return { status: "RECIPIENT_NOT_FOUND", version: "retail", name: query.recipientName, realm: query.recipientRealm };
    if (recipientMatches.length > 1) return { status: "RECIPIENT_AMBIGUOUS", version: "retail", name: query.recipientName, realm: query.recipientRealm, candidates: recipientMatches.map(({ identityKey, name, realm }) => ({ identityKey, name, realm })) };

    const exporter = exporterMatches[0]!;
    const recipient = recipientMatches[0]!;
    const exporterIdentity = { version: "retail" as const, identityKey: exporter.identityKey, name: exporter.name, realm: exporter.realm };
    const recipientIdentity = { version: "retail" as const, identityKey: recipient.identityKey, name: recipient.name, realm: recipient.realm };
    const exporterSnapshots = this.store.listSnapshots(exporter.identityKey);
    const candidateSnapshot = exporterSnapshots.find((snapshot) => snapshot.parsed.gearCandidates !== undefined);
    const recipientSnapshot = this.store.listSnapshots(recipient.identityKey)[0];
    const recipientCharacter = recipientSnapshot?.parsed.character;
    const recipientObservedAt = recipientSnapshot ? snapshotObservedAt(recipientSnapshot.generatedAt, recipientSnapshot.importedAt) : undefined;
    const recipientSectionState = recipientCharacter?.status.state ?? "UNKNOWN";
    const recipientLevelUsable = recipientSectionState === "OBSERVED" && recipientCharacter?.level !== undefined;
    const normalizedRecipientClass = recipientSectionState === "OBSERVED" ? normalizeRetailRecipientClass(recipientCharacter?.class) : undefined;
    const recipientLevel: GearCandidateRecipientScreenRead["recipientLevel"] = {
      evidence: recipientLevelUsable
        ? { state: "KNOWN", value: recipientCharacter!.level!, sectionState: recipientSectionState }
        : { state: "UNKNOWN", ...(recipientCharacter?.level !== undefined ? { value: recipientCharacter.level } : {}), sectionState: recipientSectionState,
          reason: recipientSectionState !== "OBSERVED" ? `Recipient character level provenance is ${recipientSectionState}; only OBSERVED level evidence is used for this screen.` : "Recipient level is not known in the latest stored snapshot." },
      ...(recipientSnapshot && recipientObservedAt !== undefined ? { snapshot: { snapshotId: recipientSnapshot.id, ...(recipientSnapshot.generatedAt !== undefined ? { generatedAt: recipientSnapshot.generatedAt } : {}), observedAt: recipientObservedAt, importedAt: recipientSnapshot.importedAt, freshness: classifyFreshness(recipientObservedAt, this.now()) } } : {}),
    };
    const recipientClass: GearCandidateRecipientScreenRead["recipientClass"] = {
      evidence: normalizedRecipientClass !== undefined
        ? { state: "KNOWN", value: recipientCharacter!.class!, normalizedClass: normalizedRecipientClass, sectionState: "OBSERVED" }
        : { state: "UNKNOWN", ...(recipientCharacter?.class !== undefined ? { value: recipientCharacter.class } : {}), sectionState: recipientSectionState,
          reason: recipientSectionState !== "OBSERVED"
            ? `Recipient class provenance is ${recipientSectionState}; only OBSERVED recognized Retail class evidence is used for this screen.`
            : recipientCharacter?.class === undefined
              ? "Recipient class is not known in the latest stored snapshot."
              : `Recipient class value is not a recognized Retail class: ${recipientCharacter.class}.` },
      ...(recipientSnapshot && recipientObservedAt !== undefined ? { snapshot: { snapshotId: recipientSnapshot.id, ...(recipientSnapshot.generatedAt !== undefined ? { generatedAt: recipientSnapshot.generatedAt } : {}), observedAt: recipientObservedAt, importedAt: recipientSnapshot.importedAt, freshness: classifyFreshness(recipientObservedAt, this.now()) } } : {}),
    };

    let candidateEvidence: GearCandidateRecipientScreenRead["candidateEvidence"];
    let derivedFrom: string[] = [];
    if (!candidateSnapshot?.parsed.gearCandidates) {
      candidateEvidence = { captured: false, exporterOnlyEvidenceNote: "currentCharacterCanUse describes only the exporting character and is not used to screen the selected recipient.", bindingEvidenceNote: "Binding predicates are raw independent evidence and are not used to infer transferability.", reason: "No stored exporter snapshot contains [GEAR CANDIDATES]; candidate evidence is unavailable, not an empty candidate list." };
    } else {
      const section = candidateSnapshot.parsed.gearCandidates;
      const exporterObservedAt = snapshotObservedAt(candidateSnapshot.generatedAt, candidateSnapshot.importedAt);
      const candidateObservedAt = section.observedAt ?? exporterObservedAt;
      const allRows = section.rows.map((candidate, index) => {
        let levelCheck: { state: "RULED_OUT" | "PASS" | "UNKNOWN"; reason: string };
        if (candidate.requiredLevel.state !== "KNOWN") {
          levelCheck = { state: "UNKNOWN", reason: "Candidate required level is UNKNOWN, so the required-level check cannot be evaluated." };
        } else if (recipientLevel.evidence.state !== "KNOWN") {
          levelCheck = { state: "UNKNOWN", reason: `Recipient level is not usable for comparison (${recipientLevel.evidence.reason}).` };
        } else if (!recipientLevelUsable) {
          levelCheck = { state: "UNKNOWN", reason: "Recipient level provenance is insufficient for comparison." };
        } else if (recipientLevel.evidence.value < candidate.requiredLevel.value) {
          levelCheck = { state: "RULED_OUT", reason: `Captured candidate required level ${candidate.requiredLevel.value} exceeds recipient observed level ${recipientLevel.evidence.value}.` };
        } else {
          levelCheck = { state: "PASS", reason: `Captured candidate required level ${candidate.requiredLevel.value} does not exceed recipient observed level ${recipientLevel.evidence.value}.` };
        }
        const armorCheck = evaluateNativeArmorCheck(candidate, normalizedRecipientClass);
        const weaponProficiencyCheck = evaluateWeaponProficiencyCheck(candidate, normalizedRecipientClass);
        const result: "RULED_OUT" | "NOT_RULED_OUT_BY_CHECKED_RULES" | "UNKNOWN" =
          levelCheck.state === "RULED_OUT" || armorCheck.state === "RULED_OUT" || weaponProficiencyCheck.state === "RULED_OUT" ? "RULED_OUT" :
            levelCheck.state === "UNKNOWN" || armorCheck.state === "UNKNOWN" || weaponProficiencyCheck.state === "UNKNOWN" ? "UNKNOWN" : "NOT_RULED_OUT_BY_CHECKED_RULES";
        const reason = `Required-level check: ${levelCheck.reason} Armor-family check: ${armorCheck.reason} Weapon-proficiency check: ${weaponProficiencyCheck.reason}`;
        return { rowOrdinal: index + 1, candidateState: candidate.candidateState, observationState: candidate.observationState, result, reason, armorCheck, weaponProficiencyCheck, requiredLevel: candidate.requiredLevel, candidate };
      });
      const rows = allRows.slice(page.offset, page.offset + page.limit);
      candidateEvidence = {
        captured: true,
        exporterOnlyEvidenceNote: "currentCharacterCanUse describes only the exporting character and is not used to screen the selected recipient.",
        bindingEvidenceNote: "Binding predicates are raw independent evidence and are not used to infer transferability.",
        snapshot: { snapshotId: candidateSnapshot.id, ...(candidateSnapshot.generatedAt !== undefined ? { generatedAt: candidateSnapshot.generatedAt } : {}), observedAt: exporterObservedAt, importedAt: candidateSnapshot.importedAt, freshness: classifyFreshness(exporterObservedAt, this.now()), candidateObservedAt, candidateFreshness: classifyFreshness(candidateObservedAt, this.now()) },
        completeness: section.completeness,
        rows,
        offset: page.offset,
        limit: page.limit,
        totalCount: allRows.length,
        truncated: page.offset + rows.length < allRows.length,
      };
      derivedFrom = [String(candidateSnapshot.id), ...(recipientSnapshot ? [String(recipientSnapshot.id)] : [])];
    }

    const observationTimes = [candidateEvidence.snapshot?.observedAt, recipientLevel.snapshot?.observedAt].filter((value): value is number => value !== undefined);
    const latestObservedAt = observationTimes.length > 0 ? Math.max(...observationTimes) : undefined;
    const value: GearCandidateRecipientScreenRead = {
      version: "retail",
      exporter: exporterIdentity,
      recipient: recipientIdentity,
      accountMembership: "NOT_ESTABLISHED_BY_DASHBOARD_IDENTITY",
      accountMembershipCaveat: "Dashboard-known Retail identity does not establish that exporter and recipient belong to the same Battle.net account.",
      candidateEvidence,
      recipientLevel,
      recipientClass,
      uncheckedRestrictions: "The screen checks required level, Retail native armor-family plausibility for ordinary body armor, and Retail recipient class-level weapon proficiency/access for supported modern weapon families. Native-family mismatch is a plausibility-screen result, not proof the Retail client technically forbids equipping a lower armor family. A weapon proficiency mismatch reports only a mismatch under the checked class-level rule. Positive results do not establish CanEquip. Weapon PASS does not establish specialization suitability, ability compatibility, weapon pairing, primary-stat suitability, or upgrade value. Item-specific allowed-class, race, faction, profession, unique/equip, and other restrictions were not evaluated. This result does not establish recipient suitability, upgrade value, transferability, demand, allocation, surplus, or disposition.",
      ...(candidateEvidence.captured ? { paging: { offset: candidateEvidence.offset!, limit: candidateEvidence.limit!, totalCount: candidateEvidence.totalCount!, truncated: candidateEvidence.truncated! } } : {}),
    };
    return { status: "FOUND", value: { data: value, provenance: {
      state: "DERIVED", version: "retail", identityKey: exporter.identityKey,
      ...(latestObservedAt !== undefined ? { observedAt: latestObservedAt, freshness: classifyFreshness(latestObservedAt, this.now()) } : {}),
      ...(candidateEvidence.snapshot ? { importedAt: candidateEvidence.snapshot.importedAt, snapshotId: candidateEvidence.snapshot.snapshotId } : {}),
      source: "latest stored Retail candidate-bearing exporter snapshot and latest stored recipient character snapshot",
      ...(derivedFrom.length > 0 ? { derivedFrom } : recipientSnapshot ? { derivedFrom: [String(recipientSnapshot.id)] } : {}),
      warning: "This screen checks required level, Retail native armor-family plausibility for ordinary body armor, and recipient class-level weapon proficiency/access for supported modern weapon families. Weapon proficiency is not full CanEquip or specialization suitability; positive results only mean not ruled out by checked rules. Latest stored evidence may be historical and Battle.net account membership is not established.",
    } } };
  }

  getCharacterSummary(query: CharacterQuery): CharacterResolution<ReadValue<CharacterFacts>> {
    return this.resolve(query, (character, snapshot) => {
      const fact = this.store.buildAccountFacts(query.version, this.now()).characters.find((entry) => entry.identityKey === character.identityKey);
      if (!fact || !snapshot) return { data: undefined, provenance: { state: "UNKNOWN", version: query.version, identityKey: character.identityKey, reason: "No snapshot fact is available for this character." } };
      return { data: fact, provenance: { state: "OBSERVED", version: query.version, identityKey: character.identityKey, observedAt: snapshot.generatedAt ?? snapshot.importedAt, importedAt: snapshot.importedAt, snapshotId: snapshot.id, freshness: fact.freshness, source: "WOWSYNC v1 snapshot" } };
    });
  }

  /** Bounded account/economy view composed from the canonical AccountFacts, currency and shared-storage domains. */
  getAccountOverview(query: { version: VersionOrUnknown }): ReadValue<AccountOverviewRead> {
    requireVersion(query.version);
    const facts = this.store.buildAccountFacts(query.version, this.now());
    const currencies = this.store.listVersionCurrencies(query.version);
    const currencyItems = currencies.currencies.map((entry) => entry.scope === "ACCOUNT"
      ? { currencyID: entry.currencyID, name: entry.name, scope: entry.scope, quantity: entry.account?.quantity, state: entry.account?.state }
      : entry.scope === "CHARACTER"
        ? { currencyID: entry.currencyID, name: entry.name, scope: entry.scope, ...(entry.totals?.totalKnownQuantity !== undefined ? { quantity: entry.totals.totalKnownQuantity } : {}), knownCharacters: entry.totals?.charactersWithKnownQuantity ?? 0, unknownCharacters: entry.totals?.charactersUnknown ?? 0 }
        : { currencyID: entry.currencyID, name: entry.name, scope: entry.scope, knownCharacters: 0, unknownCharacters: entry.characters.length });
    const realmCurrencySummaries = facts.realms.map((realm) => {
      const items = currencies.currencies.flatMap<{ currencyID: number; name: string | null; scope: "ACCOUNT" | "CHARACTER" | "UNKNOWN"; quantity?: number; knownCharacters: number; unknownCharacters: number; notListedCharacters: number; listedWithoutQuantity: number }>((entry) => {
        const rows = entry.characters.filter((row) => row.realm === realm.realm);
        const known = rows.flatMap((row) => row.currency?.quantity === null || row.currency?.quantity === undefined ? [] : [row.currency.quantity]);
        const unknownCharacters = rows.filter((row) => row.state === "UNKNOWN" || (row.currency !== null && row.currency.quantity === null)).length;
        const notListedCharacters = rows.filter((row) => row.state !== "UNKNOWN" && row.currency === null).length;
        const listedWithoutQuantity = rows.filter((row) => row.currency !== null && row.currency.quantity === null).length;
        if (entry.scope === "ACCOUNT") {
          const amount = entry.account?.quantity;
          return [{ currencyID: entry.currencyID, name: entry.name, scope: entry.scope, ...(amount !== null && amount !== undefined ? { quantity: amount } : {}), knownCharacters: amount !== null && amount !== undefined ? 1 : 0, unknownCharacters: amount !== null && amount !== undefined ? 0 : rows.length, notListedCharacters: 0, listedWithoutQuantity: 0 }];
        }
        if (entry.scope === "UNKNOWN") return [{ currencyID: entry.currencyID, name: entry.name, scope: entry.scope, knownCharacters: 0, unknownCharacters: rows.length, notListedCharacters: 0, listedWithoutQuantity: 0 }];
        return [{ currencyID: entry.currencyID, name: entry.name, scope: entry.scope, ...(known.length ? { quantity: known.reduce((sum, quantity) => sum + quantity, 0) } : {}), knownCharacters: known.length, unknownCharacters, notListedCharacters, listedWithoutQuantity }];
      }).filter((item) => item.knownCharacters > 0 || item.unknownCharacters > 0);
      const realmCurrencyCoverage = currencies.characters.filter((character) => character.realm === realm.realm);
      return { realm: realm.realm, coverage: { observedCharacters: realmCurrencyCoverage.filter((character) => character.state === "OBSERVED").length, lastSeenCharacters: realmCurrencyCoverage.filter((character) => character.state === "LAST_SEEN").length, unknownCharacters: realmCurrencyCoverage.filter((character) => character.state === "UNKNOWN").length }, items: items.slice(0, 20), returnedCount: Math.min(items.length, 20), totalCount: items.length, truncated: items.length > 20 };
    });
    const shared = query.version === "retail" ? this.getSharedStorage({ version: query.version }).data : undefined;
    const owners = [
      ...(shared?.warband ? [shared.warband] : []),
      ...(shared?.guilds ?? []),
    ];
    const warband = owners.find((owner) => owner.owner.kind === "warband");
    const guildOwners = owners.filter((owner) => owner.owner.kind === "guild");
    const realmLimit = 20;
    const sharedStorage = {
      warband: query.version !== "retail" || !warband ? { state: "UNKNOWN" as const, warning: "No Warband observation is available; absence does not establish empty storage." } : {
        state: warband.current ? "DERIVED" as const : "UNKNOWN" as const,
        ownerKey: warband.owner.ownerKey,
        ...(warband.current ? { completeness: warband.current.completeness, observedAt: warband.current.effectiveObservedAt, freshness: warband.current.freshness } : {}),
        warning: "Warband storage belongs to the account-level Warband scope and is excluded from character gold/economy totals; observations are not guaranteed live.",
      },
      guilds: { coverageState: query.version === "retail" && guildOwners.length ? "PARTIAL" as const : "UNKNOWN" as const, owners: guildOwners.slice(0, 20).map((owner) => ({ state: owner.current ? "DERIVED" as const : "UNKNOWN" as const, ownerKey: owner.owner.ownerKey, guildClubId: owner.owner.kind === "guild" ? owner.owner.guildClubId : "", ...(owner.owner.kind === "guild" && owner.owner.guildName ? { guildName: owner.owner.guildName } : {}), ...(owner.current ? { completeness: owner.current.completeness, observedAt: owner.current.effectiveObservedAt, freshness: owner.current.freshness, inaccessibleTabs: owner.current.coverage.inaccessibleTabs.length, unconfirmedTabs: owner.current.coverage.unconfirmedTabs.length } : {}) })), returnedCount: Math.min(guildOwners.length, 20), totalCount: guildOwners.length, truncated: guildOwners.length > 20 },
    };
    const coverage = (state: string) => facts.characters.filter((character) => character.bagsStatus === state).length;
    const bankCoverage = (state: string) => facts.characters.filter((character) => character.bankStatus === state).length;
    const professions = facts.professions.coverage;
    const currencyLimit = 20;
    const professionLimit = 25;
    const characterLimit = 25;
    const boundedGold = (gold: AccountFacts["gold"]) => ({ ...(gold.charactersWithKnownGold > 0 ? { totalKnownCopper: gold.totalKnownCopper } : {}), charactersWithKnownGold: gold.charactersWithKnownGold, charactersWithUnknownGold: gold.charactersWithUnknownGold, staleCharactersWithKnownGold: gold.staleCharactersWithKnownGold, ...(gold.oldestKnownGoldObservedAt !== undefined ? { oldestKnownGoldObservedAt: gold.oldestKnownGoldObservedAt } : {}), byCharacter: gold.byCharacter.slice(0, characterLimit), largestRecentChanges: gold.largestRecentChanges.slice(0, 10), returnedCharacters: Math.min(gold.byCharacter.length, characterLimit), totalCharacters: gold.byCharacter.length, charactersTruncated: gold.byCharacter.length > characterLimit });
    const boundedPlaytime = (playtime: AccountFacts["playtime"]) => ({ ...(playtime.charactersWithKnownPlaytime > 0 ? { totalKnownPlayedSeconds: playtime.totalKnownPlayedSeconds } : {}), charactersWithKnownPlaytime: playtime.charactersWithKnownPlaytime, staleCharactersWithKnownPlaytime: playtime.staleCharactersWithKnownPlaytime, ...(playtime.oldestKnownPlaytimeObservedAt !== undefined ? { oldestKnownPlaytimeObservedAt: playtime.oldestKnownPlaytimeObservedAt } : {}), byCharacter: playtime.byCharacter.slice(0, characterLimit), returnedCharacters: Math.min(playtime.byCharacter.length, characterLimit), totalCharacters: playtime.byCharacter.length, charactersTruncated: playtime.byCharacter.length > characterLimit });
    return {
      data: {
        version: query.version,
        aggregationScope: facts.aggregationScope,
        characterCount: facts.characterCount,
        realmsReturned: Math.min(facts.realms.length, realmLimit), realmsTotal: facts.realms.length, realmsTruncated: facts.realms.length > realmLimit,
        freshness: { recentCharacters: facts.freshness.recentCharacters, staleCharacters: facts.freshness.staleCharacters, unknownCharacters: facts.freshness.unknownCharacters },
        gold: facts.aggregationScope === "realm" ? facts.realms.slice(0, realmLimit).map((realm) => ({ realm: realm.realm, gold: boundedGold(realm.gold) })) : boundedGold(facts.gold),
        playtime: facts.aggregationScope === "realm" ? facts.realms.slice(0, realmLimit).map((realm) => ({ realm: realm.realm, playtime: boundedPlaytime(realm.playtime) })) : boundedPlaytime(facts.playtime),
        progression: { ...facts.progression, byCharacter: facts.progression.byCharacter.slice(0, characterLimit), recentLevelUps: facts.progression.recentLevelUps.slice(0, 10), returnedCharacters: Math.min(facts.progression.byCharacter.length, characterLimit), totalCharacters: facts.progression.byCharacter.length, charactersTruncated: facts.progression.byCharacter.length > characterLimit },
        recentChanges: { items: facts.recentChanges.slice(0, 10), returnedCount: Math.min(facts.recentChanges.length, 10), totalCount: facts.recentChanges.length, truncated: facts.recentChanges.length > 10 },
        professions: { coverage: professions.slice(0, professionLimit), returnedCount: Math.min(professions.length, professionLimit), totalCount: professions.length, truncated: professions.length > professionLimit },
        storageCoverage: {
          charactersWithObservedBags: coverage("OBSERVED"), charactersWithLastSeenBags: coverage("LAST_SEEN"), charactersWithUnknownBags: coverage("UNKNOWN"),
          charactersWithObservedBank: bankCoverage("OBSERVED"), charactersWithLastSeenBank: bankCoverage("LAST_SEEN"), charactersWithUnknownBank: bankCoverage("UNKNOWN"), sharedStorage,
        },
        currencies: facts.aggregationScope === "realm"
          ? { scope: "realm", byRealm: realmCurrencySummaries.slice(0, realmLimit) }
          : { scope: "account-wide", coverage: { observedCharacters: currencies.characters.filter((character) => character.state === "OBSERVED").length, lastSeenCharacters: currencies.characters.filter((character) => character.state === "LAST_SEEN").length, unknownCharacters: currencies.characters.filter((character) => character.state === "UNKNOWN").length }, items: currencyItems.slice(0, currencyLimit), returnedCount: Math.min(currencyItems.length, currencyLimit), totalCount: currencyItems.length, truncated: currencyItems.length > currencyLimit },
      },
      provenance: { state: "DERIVED", version: query.version, source: "AccountFacts, structured version currencies, and shared-storage journal", derivedFrom: facts.characters.slice(0, 25).map((character) => character.identityKey), warning: `Gold and playtime totals sum known last-observed character values. UNKNOWN contributors remain excluded; guild and Warband assets are never counted in personal character totals. Derived from ${facts.characters.length} characters.` },
    };
  }

  /** Detailed currency evidence. Realm-partitioned/unknown clients require one explicit realm. */
  getAccountCurrencies(query: AccountCurrenciesQuery): ReadValue<AccountCurrenciesRead> {
    requireVersion(query.version);
    if (query.currencyID !== undefined && (!Number.isSafeInteger(query.currencyID) || query.currencyID < 1)) throw new TypeError("currencyID must be a positive integer");
    const facts = this.store.buildAccountFacts(query.version, this.now());
    const realmScoped = query.version !== "retail";
    if (realmScoped && !query.realm) throw new TypeError("realm is required for currencies in realm-partitioned or unrecognized WoW versions");
    if (!realmScoped && query.realm) throw new TypeError("realm filtering is not supported for Retail account currency reads");
    const characters = this.store.listCharacters(query.version).filter((character) => !realmScoped || character.realm === query.realm);
    if (realmScoped && characters.length === 0) throw new TypeError(`No characters exist in realm "${query.realm}" for version "${query.version}"`);
    const currencies = realmScoped
      ? buildAccountCurrencies(query.version, characters.map((character) => this.store.getCharacterCurrencies(character.identityKey)!).filter(Boolean))
      : this.store.listVersionCurrencies(query.version);
    const needle = query.query?.trim().toLocaleLowerCase();
    const matched = currencies.currencies.filter((currency) => (query.currencyID === undefined || currency.currencyID === query.currencyID) && (!needle || `${currency.name ?? ""} ${currency.header ?? ""} ${currency.subHeader ?? ""}`.toLocaleLowerCase().includes(needle)));
    const page = pageBounds(query.offset ?? 0, query.limit ?? 20);
    const characterPage = pageBounds(query.characterOffset ?? 0, query.characterLimit ?? 25);
    const entries: AccountCurrencyDetail[] = matched.slice(page.offset, page.offset + page.limit).map((currency) => {
      const selectedCharacters = currency.characters.slice(characterPage.offset, characterPage.offset + characterPage.limit);
      return {
        currencyID: currency.currencyID, name: currency.name, scope: currency.scope, account: currency.account, totals: currency.totals,
        characters: selectedCharacters, characterOffset: characterPage.offset, characterLimit: characterPage.limit,
        characterTotalCount: currency.characters.length, charactersTruncated: characterPage.offset + selectedCharacters.length < currency.characters.length,
      };
    });
    const scopeCharacters = currencies.characters;
    return {
      data: {
        version: query.version, aggregationScope: realmScoped ? "realm" : "account-wide", ...(query.realm ? { realm: query.realm } : {}),
        coverage: { totalCharacters: scopeCharacters.length, observedCharacters: scopeCharacters.filter((character) => character.state === "OBSERVED").length, lastSeenCharacters: scopeCharacters.filter((character) => character.state === "LAST_SEEN").length, unknownCharacters: scopeCharacters.filter((character) => character.state === "UNKNOWN").length },
        currencies: { items: entries, offset: page.offset, limit: page.limit, totalCount: matched.length, truncated: page.offset + entries.length < matched.length },
      },
      provenance: { state: "DERIVED", version: query.version, source: "buildAccountCurrencies over version-scoped structured currency observations", derivedFrom: scopeCharacters.slice(0, 100).map((character) => character.identityKey), warning: realmScoped ? "This currency projection is limited to one requested realm; balances from other realm economies are excluded." : "Account-wide currency balances are represented once; character-scoped totals include known values only and preserve per-character coverage." },
    };
  }

  /** Paged account-level meaningful changes, reusing AccountFacts ordering and derivation. */
  getAccountChanges(query: AccountChangesQuery): ReadValue<BoundedPage<AccountChangeRead> & { version: VersionOrUnknown; scopeNote?: string }> {
    requireVersion(query.version);
    const facts = this.store.buildAccountFacts(query.version, this.now());
    const realmByIdentity = new Map(facts.characters.map((character) => [character.identityKey, character.realm]));
    const all = facts.recentChanges.filter((change) => !query.realm || realmByIdentity.get(change.identityKey) === query.realm).map((change) => ({ ...change, realm: realmByIdentity.get(change.identityKey) ?? "?", freshness: classifyFreshness(change.observedAt ?? change.importedAt, this.now()) }));
    const page = pageBounds(query.offset ?? 0, query.limit ?? 20);
    const items = all.slice(page.offset, page.offset + page.limit);
    return { data: { version: query.version, ...(query.version !== "retail" ? { scopeNote: "Entries retain their character and realm identities; no cross-realm balances are combined." } : {}), items, offset: page.offset, limit: page.limit, totalCount: all.length, truncated: page.offset + items.length < all.length }, provenance: { state: "DERIVED", version: query.version, source: "AccountFacts.recentChanges meaningful consecutive snapshot changes", ...(items[0]?.observedAt !== undefined ? { observedAt: items[0].observedAt } : {}), warning: "These compact AccountFacts summaries show captured meaningful transitions, not a cause. Use get_character_changes for section comparability and UNKNOWN/LAST_SEEN detail." } };
  }

  /** Compact current snapshot state. Section provenance stays independent so historical/unknown sections remain explicit. */
  getCharacterState(query: CharacterQuery): CharacterResolution<ReadValue<CharacterCurrentState>> {
    return this.resolve(query, (character, snapshot) => {
      if (!snapshot) return { provenance: { state: "UNKNOWN", version: query.version, identityKey: character.identityKey, reason: "No snapshot exists for this character." } };
      const parsed = snapshot.parsed;
      const fact = this.store.buildAccountFacts(query.version, this.now()).characters.find((item) => item.identityKey === character.identityKey);
      const sectionProvenance = (state: ReadState, observedAt?: number, reason?: string): ReadProvenance => ({ state, version: query.version, identityKey: character.identityKey, ...(observedAt !== undefined ? { observedAt } : {}), importedAt: snapshot.importedAt, snapshotId: snapshot.id, freshness: classifyFreshness(observedAt ?? snapshot.generatedAt ?? snapshot.importedAt, this.now()), source: "WOWSYNC v1 snapshot", ...(reason ? { reason } : {}), ...(state === "LAST_SEEN" ? { warning: "Historical observation; not current." } : {}) });
      const equipmentState = parsed.equipment.status.state;
      const itemLevels = equipmentState === "UNKNOWN" ? [] : parsed.equipment.slots.filter((slot) => !slot.empty && slot.itemLevel !== undefined).map((slot) => Number(slot.itemLevel)).filter(Number.isFinite);
      const professions = parsed.professions;
      const currencyResult = this.store.getCharacterCurrencies(character.identityKey);
      const currencyState = currencyResult?.state ?? "UNKNOWN";
      const currencyEntries = currencyResult?.currencies ?? null;
      const boundedProfessions = professions.status.state === "UNKNOWN" ? undefined : professions.entries.slice(0, 10).map(({ name, skill, maxSkill, tier, expansion }) => ({ name, skill, maxSkill, tier, expansion }));
      const boundedCurrencies = currencyState === "UNKNOWN" || currencyEntries === null ? undefined : currencyEntries.slice(0, 20).map((entry) => ({ currencyID: entry.currencyID, name: entry.name, quantity: entry.quantity, isAccountWide: entry.isAccountWide }));
      const observedAt = snapshot.generatedAt ?? snapshot.importedAt;
      return { data: {
        identity: { version: query.version, identityKey: character.identityKey, name: character.name, realm: character.realm, ...(parsed.character.class ? { class: parsed.character.class } : {}), ...(parsed.character.faction ? { faction: parsed.character.faction } : {}), ...(parsed.character.level !== undefined ? { level: parsed.character.level } : {}) },
        provenance: sectionProvenance("OBSERVED", observedAt),
        gold: { ...(parsed.character.moneyCopper !== undefined ? { copper: parsed.character.moneyCopper } : {}), provenance: sectionProvenance(parsed.character.moneyCopper !== undefined ? "OBSERVED" : "UNKNOWN", parsed.character.moneyCopper !== undefined ? observedAt : undefined, parsed.character.moneyCopper === undefined ? "Gold was not captured in the latest snapshot." : undefined) },
        playtime: { ...(parsed.character.playedSeconds !== undefined ? { playedSeconds: parsed.character.playedSeconds } : {}), ...(parsed.character.levelPlayedSeconds !== undefined ? { levelPlayedSeconds: parsed.character.levelPlayedSeconds } : {}), provenance: sectionProvenance(parsed.character.playedSeconds !== undefined ? "OBSERVED" : "UNKNOWN", parsed.character.playedSeconds !== undefined ? observedAt : undefined, parsed.character.playedSeconds === undefined ? "Playtime was not captured in the latest snapshot." : undefined) },
        location: { ...(parsed.location.zone ? { zone: parsed.location.zone } : {}), ...(parsed.location.subzone ? { subzone: parsed.location.subzone } : {}), ...(parsed.location.mapID ? { mapID: parsed.location.mapID } : {}), ...(parsed.location.x ? { x: parsed.location.x } : {}), ...(parsed.location.y ? { y: parsed.location.y } : {}), provenance: sectionProvenance(parsed.location.status.state, parsed.location.status.observedAt ?? observedAt, parsed.location.status.reason) },
        progression: { ...(parsed.character.xp !== undefined ? { xp: parsed.character.xp } : {}), ...(parsed.character.xpMax !== undefined ? { xpMax: parsed.character.xpMax } : {}), ...(fact?.xpPercent !== undefined ? { xpPercent: fact.xpPercent } : {}) },
        equipment: { state: equipmentState, ...(equipmentState !== "UNKNOWN" ? { equippedSlots: parsed.equipment.slots.filter((slot) => !slot.empty).length, knownItemLevelSlots: itemLevels.length, ...(itemLevels.length ? { averageItemLevel: Math.round(itemLevels.reduce((a, b) => a + b, 0) / itemLevels.length * 100) / 100 } : {}) } : {}), provenance: sectionProvenance(equipmentState, parsed.equipment.status.observedAt ?? observedAt, parsed.equipment.status.reason) },
        bags: { state: parsed.bags.status.state, ...(parsed.bags.status.state !== "UNKNOWN" ? { freeSlots: parsed.bags.freeSlots, totalSlots: parsed.bags.totalSlots, itemStackCount: parsed.bags.items.length } : {}), provenance: sectionProvenance(parsed.bags.status.state, parsed.bags.status.observedAt ?? observedAt, parsed.bags.status.reason) },
        bank: { state: parsed.bank.status.state, ...(parsed.bank.status.state !== "UNKNOWN" ? { freeSlots: parsed.bank.freeSlots, totalSlots: parsed.bank.totalSlots, itemStackCount: parsed.bank.items.length } : {}), provenance: sectionProvenance(parsed.bank.status.state, parsed.bank.status.observedAt ?? observedAt, parsed.bank.status.reason) },
        professions: { state: professions.status.state, ...(boundedProfessions ? { entries: boundedProfessions, totalCount: professions.entries.length, truncated: professions.entries.length > 10 } : {}), provenance: sectionProvenance(professions.status.state, professions.status.observedAt ?? observedAt, professions.status.reason) },
        currencies: { state: currencyState, ...(boundedCurrencies ? { entries: boundedCurrencies, totalCount: currencyEntries!.length, truncated: currencyEntries!.length > 20 } : {}), provenance: sectionProvenance(currencyState, currencyResult?.observedAt ?? undefined, currencyResult?.state === "UNKNOWN" ? "Currency list was not captured." : currencyResult?.lastSeenReason ?? undefined) },
      }, provenance: sectionProvenance("OBSERVED", observedAt) };
    });
  }

  getCharacterEquipment(query: CharacterQuery): CharacterResolution<ReadValue<EquipmentSection>> {
    return this.resolveSection(query, "equipment");
  }

  getForeverGearObservation(query: CharacterQuery): CharacterResolution<ReadValue<ReturnType<typeof buildForeverGearObservation>>> {
    requireVersion(query.version);
    if (query.version !== "forever") return { status: "FOUND", value: { provenance: { state: "UNKNOWN", version: query.version, reason: "Forever gear observations are isolated to the Forever 70291 profile." } } };
    return this.resolve(query, (character, snapshot) => {
      if (!snapshot) return { provenance: { state: "UNKNOWN", version: "forever", identityKey: character.identityKey, reason: "No Forever snapshot exists for this character." } };
      const profile = snapshot.parsed.character;
      if (profile.clientFamily !== "Forever" || profile.clientVersion !== "1.60.1" || profile.clientBuild !== "70291" || profile.interface !== "16001") {
        return { provenance: { state: "UNKNOWN", version: "forever", identityKey: character.identityKey, snapshotId: snapshot.id, source: "WOWSYNC v1 character profile", reason: "This observation view requires the validated Forever 1.60.1 build 70291 / interface 16001 profile." } };
      }
      const snapshots = this.store.listSnapshots(character.identityKey);
      const sourceGuids = snapshots.map((entry) => entry.parsed.foreverGearObservation?.sourceCharacterGuid);
      if (sourceGuids.some((guid) => !guid) || snapshots.some((entry) => entry.parsed.foreverGearObservation?.sourceCharacterGuidConflict) || new Set(sourceGuids).size > 1) return { provenance: { state: "UNKNOWN", version: "forever", identityKey: character.identityKey, snapshotId: snapshot.id, reason: "The Dashboard version/realm/name history contains missing or conflicting WoWSyncDB character GUIDs; the observation cannot safely be resolved to one source character." } };
      const data = buildForeverGearObservation({
        identity: { version: "forever", identityKey: character.identityKey, name: character.name, ...(character.surname ? { surname: character.surname } : {}), ...(character.surnameSource ? { surnameSource: character.surnameSource } : {}), realm: character.realm },
        snapshotId: snapshot.id, generatedAt: snapshot.generatedAt, importedAt: snapshot.importedAt,
        equipment: snapshot.parsed.equipment, bags: snapshot.parsed.bags, bank: snapshot.parsed.bank,
        structured: snapshot.parsed.foreverGearObservation,
        now: this.now(),
      });
      const observedAt = snapshot.parsed.foreverGearObservation?.generatedAt ?? snapshot.generatedAt ?? snapshot.importedAt;
      return { data, provenance: { state: "DERIVED", version: "forever", identityKey: character.identityKey, observedAt, importedAt: snapshot.importedAt, snapshotId: snapshot.id, freshness: classifyFreshness(observedAt, this.now()), source: snapshot.parsed.foreverGearObservation ? "Forever 70291 WoWSyncDB structured sections plus WOWSYNC v1 export" : "WOWSYNC v1 export; structured WoWSyncDB section timestamps unavailable", reason: snapshot.parsed.foreverGearObservation ? undefined : "Structured Forever section sidecar was not available for this imported snapshot." } };
    });
  }

  /**
   * Evidence-first cross-character Forever evaluation. Candidate rows retain
   * their observed carrier; Dashboard import-context membership is never
   * promoted into account ownership or transfer access.
   */
  getForeverGearAllocation(query: CharacterQuery): CharacterResolution<ReadValue<{
    version: "forever";
    ruleset: "forever-70291-allocation-screen-v2";
    scope: { accountMembership: "UNKNOWN"; reason: string };
    recipient: { identityKey: string; name: string; surname?: string; realm: string; snapshotId?: number; observedAt?: number; freshness: "recent" | "stale" | "unknown"; class?: { value: string; provenance: "OBSERVED" | "LAST_SEEN"; observedAt?: number; source: string }; level?: { value: number; provenance: "OBSERVED" | "LAST_SEEN"; observedAt?: number; source: string }; observedSkillLines: Array<{ name: string; rank?: number; maxRank?: number; rawCategoryID?: number; observedAt?: number; provenance: "OBSERVED" | "LAST_SEEN" | "UNKNOWN" }>; equipment: ReturnType<typeof buildForeverGearObservation>["equipment"] };
    candidateSources: Array<{ source: { identityKey: string; name: string; surname?: string; realm: string }; observationState: string; observedAt?: number; freshness?: string; carried: { state: string; observedAt?: number; freshness?: string; itemCount?: number }; bank: { state: string; observedAt?: number; freshness?: string; reason?: string }; candidates: ReturnType<typeof buildForeverGearObservation>["evaluationCandidates"]["items"]; unclassifiedItems: ReturnType<typeof buildForeverGearObservation>["evaluationCandidates"]["unclassifiedItems"] }>;
    assessments: Array<ForeverGearAssessmentEvaluation & { candidate: ReturnType<typeof buildForeverGearObservation>["evaluationCandidates"]["items"][number]; source: { identityKey: string; name: string; surname?: string; realm: string }; recipient: { identityKey: string; name: string; surname?: string; realm: string }; eligibilityAssessment: ReturnType<typeof combineForeverEligibility> }>;
    recipientEvaluations: Array<{ source: { identityKey: string; name: string; surname?: string; realm: string }; itemRef?: string; recipients: Array<{ identityKey: string; name: string; surname?: string; realm: string; eligibility: string; armorProficiency: string; slotCompatibility: string; upgradeStatus: string; transferability: string; fit: "EXCLUDED" | "LOCAL_REVIEW" | "POTENTIAL_GEAR_FIT" | "UNRANKED"; reasons: string[] }> }>;
    allocationPlan: Array<{ disposition: "EQUIP_CANDIDATE" | "KEEP" | "POSSIBLE_OTHER_CHARACTER" | "NOT_AN_UPGRADE_ON_OBSERVED_METRICS" | "INSUFFICIENT_EVIDENCE"; item: { name?: string; itemRef?: string; itemIdentity?: string }; source: { identityKey: string; name: string; surname?: string; realm: string; location: "CARRIED_INVENTORY" | "EQUIPPED" | "UNKNOWN"; provenance: "OBSERVED" | "LAST_SEEN" | "UNKNOWN"; observedAt?: number; freshness: string }; recipient: { identityKey: string; name: string; surname?: string; realm: string }; comparison?: { upgradeStatus: string; confidence: string; rawComparisons: ForeverGearAssessmentEvaluation["rawStatComparisons"] }; evidence: { provenance: "DERIVED" | "HYPOTHESIS" | "UNKNOWN"; eligibility: string; suitability: string; transferability: string; confidence: "LIMITED" | "UNKNOWN"; reasons: string[]; whatWouldChange: string[] } }>;
    exclusions: Array<{ character: { identityKey: string; name: string; surname?: string; realm: string }; state: string; reason: string }>;
    conclusion: "LOCAL_REVIEW_CANDIDATE_AVAILABLE" | "INSUFFICIENT_EVIDENCE";
    reason: string;
  }>> {
    if (query.version !== "forever") return { status: "FOUND", value: { provenance: { state: "UNKNOWN", version: query.version, reason: "Forever allocation is isolated to Forever 1.60.1 build 70291 / interface 16001; no other version rules are applied." } } };
    const resolved = this.getForeverGearObservation(query);
    if (resolved.status !== "FOUND") return resolved;
    if (!resolved.value.data) return { status: "FOUND", value: { provenance: { ...resolved.value.provenance, state: "UNKNOWN", reason: resolved.value.provenance.reason ?? "The recipient has no safely resolved Forever 70291 observation; allocation cannot be evaluated." } } };
    const recipientData = resolved.value.data;
    const recipientCharacter = this.store.listCharacters("forever").find((c) => c.identityKey === recipientData.identity.identityKey);
    if (!recipientCharacter) return { status: "NOT_FOUND", version: "forever", name: query.name, ...(query.realm ? { realm: query.realm } : {}) };
    const recipientSnapshot = this.store.listSnapshots(recipientCharacter.identityKey)[0];
    const profile = recipientSnapshot?.parsed.character;
    const recipientObservedAt = recipientSnapshot?.generatedAt ?? recipientSnapshot?.importedAt;
    const recipientFreshness = recipientObservedAt === undefined ? "unknown" as const : classifyFreshness(recipientObservedAt, this.now());
    const profileState = profile?.status.state === "LAST_SEEN" ? "LAST_SEEN" as const : "OBSERVED" as const;
    const itemEvidenceRecord = recipientSnapshot?.parsed.foreverGearObservation?.itemEvidence as Record<string, unknown> | undefined;
    const itemEvidenceData = itemEvidenceRecord?.data as Record<string, unknown> | undefined;
    const skillLinesObservedAt = typeof itemEvidenceData?.skillLinesObservedAt === "number" ? itemEvidenceData.skillLinesObservedAt : undefined;
    const skillEvidenceFreshness = skillLinesObservedAt === undefined ? "unknown" : classifyFreshness(skillLinesObservedAt, this.now());
    const observedSkillLines = (Array.isArray(itemEvidenceData?.skillLines) ? itemEvidenceData.skillLines : [])
      .map((row) => row as Record<string, unknown>)
      .filter((row) => row.isHeader !== true && typeof row.name === "string")
      .map((row) => ({ name: row.name as string, ...(typeof row.rank === "number" ? { rank: row.rank } : {}), ...(typeof row.maxRank === "number" ? { maxRank: row.maxRank } : {}), ...(typeof row.skillLineCategoryID === "number" ? { rawCategoryID: row.skillLineCategoryID } : {}), ...(skillLinesObservedAt !== undefined ? { observedAt: skillLinesObservedAt } : {}), provenance: itemEvidenceRecord?.lastAttemptStale === true || skillEvidenceFreshness === "stale" ? "LAST_SEEN" as const : skillEvidenceFreshness === "recent" ? "OBSERVED" as const : "UNKNOWN" as const }));
    const recipient = {
      identityKey: recipientCharacter.identityKey, name: recipientCharacter.name,
      ...(recipientCharacter.surname ? { surname: recipientCharacter.surname } : {}), realm: recipientCharacter.realm,
      ...(recipientSnapshot ? { snapshotId: recipientSnapshot.id } : {}),
      ...(recipientObservedAt !== undefined ? { observedAt: recipientObservedAt } : {}),
      freshness: recipientFreshness,
      ...(profile && profile.status.state !== "UNKNOWN" && profile.class ? { class: { value: profile.class, provenance: profileState, ...(profile.status.observedAt !== undefined ? { observedAt: profile.status.observedAt } : {}), source: "WOWSYNC v1 CHARACTER field" } } : {}),
      ...(profile && profile.status.state !== "UNKNOWN" && profile.level !== undefined ? { level: { value: profile.level, provenance: profileState, ...(profile.status.observedAt !== undefined ? { observedAt: profile.status.observedAt } : {}), source: "WOWSYNC v1 CHARACTER field" } } : {}),
      observedSkillLines,
      equipment: recipientData.equipment,
    };
    const candidateSources: Array<{ source: { identityKey: string; name: string; surname?: string; realm: string }; observationState: string; observedAt?: number; freshness?: string; carried: { state: string; observedAt?: number; freshness?: string; itemCount?: number }; bank: { state: string; observedAt?: number; freshness?: string; reason?: string }; candidates: ReturnType<typeof buildForeverGearObservation>["evaluationCandidates"]["items"]; unclassifiedItems: ReturnType<typeof buildForeverGearObservation>["evaluationCandidates"]["unclassifiedItems"] }> = [];
    const exclusions: Array<{ character: { identityKey: string; name: string; surname?: string; realm: string }; state: string; reason: string }> = [];
    for (const sourceCharacter of this.store.listCharacters("forever")) {
      const observation = this.getForeverGearObservation({ version: "forever", name: sourceCharacter.name, realm: sourceCharacter.realm });
      if (observation.status !== "FOUND" || !observation.value.data) {
        exclusions.push({ character: { identityKey: sourceCharacter.identityKey, name: sourceCharacter.name, ...(sourceCharacter.surname ? { surname: sourceCharacter.surname } : {}), realm: sourceCharacter.realm }, state: observation.status, reason: observation.status === "FOUND" ? observation.value.provenance.reason ?? "Observation data unavailable." : "Source identity or 70291 evidence could not be safely resolved." });
        continue;
      }
      candidateSources.push({ source: { identityKey: sourceCharacter.identityKey, name: sourceCharacter.name, ...(sourceCharacter.surname ? { surname: sourceCharacter.surname } : {}), realm: sourceCharacter.realm }, observationState: observation.value.data.evaluationCandidates.state,
        ...(observation.value.data.evaluationCandidates.observedAt !== undefined ? { observedAt: observation.value.data.evaluationCandidates.observedAt, freshness: observation.value.data.evaluationCandidates.freshness } : {}),
        carried: { state: observation.value.data.carried.state, ...(observation.value.data.carried.observedAt !== undefined ? { observedAt: observation.value.data.carried.observedAt, freshness: observation.value.data.carried.freshness } : {}), ...(observation.value.data.carried.items !== undefined ? { itemCount: observation.value.data.carried.items.length } : {}) },
        bank: { state: observation.value.data.bank.state, ...(observation.value.data.bank.observedAt !== undefined ? { observedAt: observation.value.data.bank.observedAt, freshness: observation.value.data.bank.freshness } : {}), ...(observation.value.data.bank.reason ? { reason: observation.value.data.bank.reason } : {}) },
        candidates: observation.value.data.evaluationCandidates.items, unclassifiedItems: observation.value.data.evaluationCandidates.unclassifiedItems });
    }
    const recipientItemEvidence = recipientSnapshot?.parsed.foreverGearObservation?.itemEvidence as Record<string, unknown> | undefined;
    const recipientItemData = recipientItemEvidence?.data as Record<string, unknown> | undefined;
    const recipientSpecialization = recipientItemData?.specialization as Record<string, unknown> | undefined;
    const activeInfo = asRecord(recipientSpecialization?.activeInfo);
    const activeInfoReturns = Array.isArray(activeInfo?.returns) ? activeInfo.returns : [];
    const activeSpecializationIDRaw = asRecord(asRecord(activeInfoReturns[0])?.observation);
    const activeSpecializationIDValue = activeSpecializationIDRaw?.state === "OBSERVED" && activeSpecializationIDRaw.type === "number" && typeof activeSpecializationIDRaw.value === "number" ? activeSpecializationIDRaw.value : undefined;
    const activeIndexCall = asRecord(recipientSpecialization?.activeIndex);
    const activeIndexReturns = Array.isArray(activeIndexCall?.returns) ? activeIndexCall.returns : [];
    const activeIndexValue = asRecord(asRecord(activeIndexReturns[0])?.observation);
    const recipientSpecializationCurrent = recipientItemEvidence?.lastAttemptStale !== true
      && activeIndexCall?.api === "C_SpecializationInfo.GetSpecialization"
      && activeInfo?.api === "C_SpecializationInfo.GetSpecializationInfo" && activeInfo?.state === "OBSERVED_VALUE"
      && activeIndexValue?.state === "OBSERVED" && activeIndexValue.type === "number" && typeof activeIndexValue.value === "number" && activeIndexValue.value > 0
      && typeof recipientSpecialization?.capturedAt === "number" && classifyFreshness(recipientSpecialization.capturedAt, this.now()) === "recent"
      && typeof activeSpecializationIDValue === "number";
    const activeSpecializationID = recipientSpecializationCurrent ? activeSpecializationIDValue : undefined;
    const recipientEquipmentComplete = recipientSnapshot?.parsed.foreverGearObservation?.equipment?.completeness === "complete"
      && recipient.equipment.state === "OBSERVED" && recipient.equipment.freshness === "recent";
    const recipientSlotEvidence: ForeverSlotEvidence[] = recipient.equipment.items.map((item) => {
      const itemEvidence = (item as unknown as { itemApiEvidence?: unknown }).itemApiEvidence;
      const field = foreverItemField(itemEvidence, "equipLocation");
      return { slot: item.slot, ...(item.itemRef ? { itemRef: item.itemRef } : {}), ...(field?.state === "OBSERVED" && typeof field.value === "string" ? { equipLocation: field.value } : {}), provenance: item.provenance };
    });
    const assessments = candidateSources.flatMap((source) => source.candidates.map((candidate) => {
      const classField = foreverItemField(candidate.itemApiEvidence, "itemClass");
      const subclassField = foreverItemField(candidate.itemApiEvidence, "itemSubclass");
      const equipField = foreverItemField(candidate.itemApiEvidence, "equipLocation");
      const requiredLevelField = foreverItemField(candidate.itemApiEvidence, "requiredLevel");
      const candidateMetadataRecent = foreverItemEvidenceIsRecent(candidate.itemApiEvidence, this.now())
        && foreverItemContractIsValidated(candidate.itemApiEvidence);
      const itemClass = classField?.state === "OBSERVED" && typeof classField.value === "string" ? classField.value : undefined;
      const itemSubclass = subclassField?.state === "OBSERVED" && typeof subclassField.value === "string" ? subclassField.value : undefined;
      const equipLocation = equipField?.state === "OBSERVED" && typeof equipField.value === "string" ? equipField.value : undefined;
      const requiredLevel = candidateMetadataRecent && requiredLevelField?.state === "OBSERVED" && typeof requiredLevelField.value === "number" ? requiredLevelField.value : undefined;
      const recipientLevel = recipient.freshness === "recent" && recipient.level?.provenance === "OBSERVED" ? recipient.level.value : undefined;
      const recipientCandidate = recipientData.evaluationCandidates.items.find((row) => row.itemRef === candidate.itemRef);
      const recipientEquipability = (recipientCandidate?.itemApiEvidence as Record<string, unknown> | undefined)?.playerEquipability as Record<string, unknown> | undefined;
      const sourceEquipability = (candidate.itemApiEvidence as Record<string, unknown> | undefined)?.playerEquipability as Record<string, unknown> | undefined;
      const sourceCanUse = (candidate.itemApiEvidence as Record<string, unknown> | undefined)?.playerCanUseItem as Record<string, unknown> | undefined;
      const recipientCanUse = (recipientCandidate?.itemApiEvidence as Record<string, unknown> | undefined)?.playerCanUseItem as Record<string, unknown> | undefined;
      const sameCharacter = source.source.identityKey === recipient.identityKey;
      const equipability = sameCharacter ? sourceEquipability : recipientEquipability;
      const equipabilityCurrent = equipability?.api === "C_Item.IsEquippableItem" && equipability?.itemString === candidate.itemRef
        && equipability?.state === "OBSERVED_VALUE" && typeof equipability?.value === "boolean"
        && typeof equipability?.observedAt === "number" && classifyFreshness(equipability.observedAt, this.now()) === "recent";
      const eligibility = assessForeverEligibility({ sameCharacter: equipabilityCurrent, apiEquippable: equipabilityCurrent ? equipability?.value as boolean : undefined, apiObservedRecent: equipabilityCurrent, requiredLevel, recipientLevel });
      const canUseEvidence = sameCharacter ? sourceCanUse : recipientCanUse;
      const candidateBaseItemID = Number(candidate.itemRef?.match(/^item:(\d+)/)?.[1]);
      const canUseCurrent = canUseEvidence?.state === "OBSERVED" && canUseEvidence?.api === "C_PlayerInfo.CanUseItem"
        && canUseEvidence?.identityScope === "BASE_ITEM_ID" && canUseEvidence?.itemString === candidate.itemRef
        && canUseEvidence?.itemID === candidateBaseItemID && typeof canUseEvidence?.observedAt === "number"
        && classifyFreshness(canUseEvidence.observedAt, this.now()) === "recent"
        && !candidate.provenance.includes("LAST_SEEN")
        && foreverItemEvidenceIsRecent(canUseEvidence === sourceCanUse ? candidate.itemApiEvidence : recipientCandidate?.itemApiEvidence, this.now());
      const playerCanUseSignal = canUseCurrent ? canUseEvidence?.value === true ? "TRUE" as const : canUseEvidence?.value === false ? "FALSE" as const : "UNKNOWN" as const : "UNKNOWN" as const;
      const slotCompatibility = evaluateForeverSlotCompatibility({ equipLocation, equipment: recipientSlotEvidence, equipmentComplete: recipientEquipmentComplete });
      const matchingSlots = new Set(slotCompatibility.possibleSlots);
      const candidateStats = foreverStatTable(candidate.itemApiEvidence, this.now());
      const recipientEquipmentCurrent = recipient.equipment.state === "OBSERVED" && recipient.equipment.freshness === "recent";
      const rawStatComparisons = recipientEquipmentCurrent && !candidate.provenance.includes("LAST_SEEN") && candidateStats
        ? recipient.equipment.items.flatMap((equipped) => {
          if (!equipped.itemRef || !matchingSlots.has(equipped.slot) || equipped.provenance !== "OBSERVED") return [];
          const equippedEvidence = (equipped as unknown as { itemApiEvidence?: unknown }).itemApiEvidence;
          const equippedStats = foreverStatTable(equippedEvidence, this.now());
          const comparison = compareForeverStatTables(candidateStats, equippedStats, equipped.slot, equipped.itemRef, itemClass);
          return comparison ? [comparison] : [];
        }) : [];
      const deltaRows = Array.isArray((candidate.itemApiEvidence as Record<string, unknown> | undefined)?.statDeltaComparisons)
        ? (candidate.itemApiEvidence as { statDeltaComparisons: Array<Record<string, unknown>> }).statDeltaComparisons : [];
      const statDeltaCalibrations = rawStatComparisons.flatMap((comparison) => {
        const row = deltaRows.find((entry) => entry.candidateItemString === candidate.itemRef && entry.equippedItemString === comparison.equippedItemRef);
        if (!row || !Array.isArray(row.entries)) return [];
        const table: ForeverStatTable = { state: "OBSERVED_TABLE", complete: row.complete === true, entries: row.entries.flatMap((entry) => {
          if (!entry || typeof entry !== "object") return [];
          const e = entry as { key?: unknown; observation?: { state?: unknown; value?: unknown } };
          return typeof e.key === "string" ? [{ key: e.key, state: typeof e.observation?.state === "string" ? e.observation.state : "UNKNOWN", value: e.observation?.value }] : [];
        }) };
        const equipped = recipient.equipment.items.find((item) => item.itemRef === comparison.equippedItemRef);
        const equippedEvidence = equipped && (equipped as unknown as { itemApiEvidence?: unknown }).itemApiEvidence;
        return [calibrateForeverStatDelta({ candidate: candidateStats, equipped: foreverStatTable(equippedEvidence, this.now()), delta: table })];
      });
      const upgrade = recipientEquipmentComplete
        ? classifyForeverRecordedUpgrade(rawStatComparisons, slotCompatibility)
        : { status: "UNKNOWN" as const, confidence: "UNKNOWN" as const, reason: rawStatComparisons.length > 0
          ? "Exact observed same-slot raw stat comparisons are available, but the equipment scan is partial; an overall upgrade conclusion is withheld."
          : "The equipment scan is partial, so neither all compatible slots nor an overall upgrade can be established." };
      const itemSpecInfo = (candidate.itemApiEvidence as Record<string, unknown> | undefined)?.itemSpecInfo as Record<string, unknown> | undefined;
      const itemSpecializationIDs = Array.isArray(itemSpecInfo?.specializationIDs) ? itemSpecInfo.specializationIDs.filter((value): value is number => typeof value === "number") : undefined;
      const suitabilityEvidence = assessForeverSuitability({ activeSpecializationID, itemSpecializationIDs, specializationEvidenceCurrent: recipientSpecializationCurrent && itemSpecInfo?.state === "OBSERVED_TABLE" && itemSpecInfo?.freshness === "recent" });
      const bindingEvidence = (candidate.itemApiEvidence as Record<string, unknown> | undefined)?.bindingEvidence as Record<string, unknown> | undefined;
      const bindingFreshness = bindingEvidence?.freshness === "recent" && bindingEvidence?.semanticInterpretation === "FOREVER_70291_LIVE_VALIDATED";
      const rawBindingCall = (key: string) => {
        const call = bindingEvidence?.[key] as Record<string, unknown> | undefined;
        const expectedAPI = key === "isItemBindToAccount" ? "C_Item.IsItemBindToAccount" : "C_Item.IsItemBindToAccountUntilEquip";
        const input = call?.input as Record<string, unknown> | undefined;
        if (call?.api !== expectedAPI || input?.itemString !== candidate.itemRef) return undefined;
        const returns = Array.isArray(call?.returns) ? call.returns : [];
        const first = returns[0] as Record<string, unknown> | undefined;
        const observation = first?.observation as Record<string, unknown> | undefined;
        return call?.state === "OBSERVED_VALUE" && observation?.state === "OBSERVED" && observation.type === "boolean" && typeof observation.value === "boolean" ? observation.value : undefined;
      };
      const bindTypeEntry = bindingEvidence?.itemInfoBindType as Record<string, unknown> | undefined;
      const bindTypeObservation = bindTypeEntry?.observation as Record<string, unknown> | undefined;
      const bindType = bindTypeObservation?.state === "OBSERVED" && bindTypeObservation.type === "number" && typeof bindTypeObservation.value === "number" ? bindTypeObservation.value : undefined;
      const bindingAssessment = assessForeverBinding({ currentBound: typeof candidate.bound === "boolean" && source.carried.state === "OBSERVED" && source.carried.freshness === "recent" ? candidate.bound : undefined,
        accountBound: rawBindingCall("isItemBindToAccount"), accountBoundUntilEquip: rawBindingCall("isItemBindToAccountUntilEquip"), bindType,
        freshness: bindingEvidence?.freshness === "recent" && source.carried.freshness === "recent" ? "recent" : bindingEvidence?.freshness === "stale" ? "stale" : "unknown",
        apiSemanticsValidated: bindingFreshness });
      const classRestriction = evaluateForeverExplicitClassRestriction({ restrictionState: "UNKNOWN", recipientClass: recipient.class?.provenance === "OBSERVED" && recipient.freshness === "recent" ? recipient.class.value : undefined });
      const armorProficiency = evaluateForeverArmorProficiency({ itemClass, itemSubclass, recipientClass: recipient.class?.provenance === "OBSERVED" && recipient.freshness === "recent" ? recipient.class.value : undefined, recipientLevel });
      const weaponCheck = itemClass !== "Weapon" ? { state: "NOT_APPLICABLE" as const, confidence: "UNKNOWN" as const, reason: "The observed item class is not Weapon." }
        : evaluateForeverWeaponProficiency({ itemSubclass, observedSkillLines: recipient.observedSkillLines.map((skill) => ({ name: skill.name, rank: skill.rank, provenance: skill.provenance })), skillSemantics: "CLASSIC_DERIVED_HYPOTHESIS" });
      const weaponProficiency = { ...weaponCheck, observedSkillLines: recipient.observedSkillLines.map((skill) => skill.name) };
      const eligibilityAssessment = combineForeverEligibility({ requiredLevel: eligibility.requiredLevel,
        explicitClassRestriction: classRestriction.state, armorProficiency, weaponProficiency,
        slotCompatibility: slotCompatibility.state, playerSpecificEquipCheck: playerCanUseSignal === "UNKNOWN" ? eligibility.playerApiSignal : playerCanUseSignal });
      const sourceLocationCurrent = source.carried.state === "OBSERVED" && source.carried.freshness === "recent"
        && !candidate.provenance.includes("LAST_SEEN");
      const localPotential = sameCharacter && sourceLocationCurrent && eligibility.playerApiSignal === "TRUE"
        && (upgrade.status === "POSSIBLE_RECORDED_STAT_UPGRADE" || upgrade.status === "POSSIBLE_EMPTY_SLOT_FILL")
        && slotCompatibility.conflicts.length === 0;
      const missingEvidence = [
        ...(eligibility.playerApiSignal === "UNKNOWN" ? ["A current C_Item.IsEquippableItem observation for this exact variant on the recipient"] : []),
        ...(classRestriction.state === "UNKNOWN" ? ["Verified Forever class/item restriction evidence is unavailable (not present in the captured item API tuple)"] : []),
        ...(armorProficiency.state !== "UNKNOWN" && armorProficiency.confidence !== "LIVE_VALIDATED" ? ["Current armor result is a Classic-derived screening hypothesis, not confirmed Forever eligibility"] : []),
        ...(armorProficiency.state === "UNKNOWN" ? ["Observed item armor type or fresh recipient class/level"] : []),
        ...(weaponProficiency.state === "UNKNOWN" || weaponProficiency.confidence !== "LIVE_VALIDATED" ? ["Live validation of weapon-skill semantics and item subtype mapping"] : []),
        ...(eligibility.requiredLevel === "UNKNOWN" ? ["Fresh recipient level or live-corroborated item required level"] : []),
        ...(slotCompatibility.state === "UNKNOWN" ? ["Known Forever equip-location token and equipment-slot mapping"] : []),
        ...(upgrade.status === "UNKNOWN" || upgrade.status === "RECORDED_STAT_TRADEOFF" ? ["Build-specific stat weights, complete effects, and/or a resolved stat trade-off"] : []),
        ...(suitabilityEvidence.state === "UNKNOWN" ? ["Fresh active specialization and exact-item specialization tags"] : []),
        ...(bindingAssessment.state === "UNKNOWN" ? ["Validated soulbound/account-bound semantics, recipient account scope, and an observed transfer route"] : []),
        ...(source.source.identityKey !== recipient.identityKey && source.carried.state !== "OBSERVED" ? ["A fresh observed source location"] : []),
        ...(source.source.identityKey !== recipient.identityKey ? ["Verified account membership before assigning cross-character allocation priority"] : []),
      ];
      return {
        candidate, source: source.source, recipient: { identityKey: recipient.identityKey, name: recipient.name, realm: recipient.realm },
        eligibility: eligibility.state, playerApiSignal: eligibility.playerApiSignal, playerCanUseSignal,
        eligibilityChecks: {
          requiredLevel: { state: eligibility.requiredLevel, ...(requiredLevel !== undefined ? { itemRequiredLevel: requiredLevel } : {}), ...(recipientLevel !== undefined ? { recipientLevel } : {}), reason: eligibility.reason },
          classRestriction,
          armorProficiency,
          weaponProficiency,
          slotCompatibility,
        },
        eligibilityAssessment, bindingAssessment,
        suitability: suitabilityEvidence.state, suitabilityEvidence,
        upgradeStatus: upgrade.status, upgradeConfidence: upgrade.confidence, rawStatComparisons, statDeltaCalibrations,
        transferability: source.source.identityKey === recipient.identityKey ? "UNKNOWN" as const : bindingAssessment.transferability === "BLOCKED_TO_OTHER_CHARACTER" ? "BLOCKED_BOUND_TO_SOURCE" as const : bindingAssessment.transferability,
        transferabilityReason: source.source.identityKey === recipient.identityKey ? "No cross-character transfer is needed for the source character's own carried item." : bindingAssessment.reason,
        allocationPriority: localPotential ? "LOCAL_REVIEW_CANDIDATE" as const : bindingAssessment.transferability === "BLOCKED_TO_OTHER_CHARACTER" && source.source.identityKey !== recipient.identityKey ? "BLOCKED_BY_BINDING" as const : source.source.identityKey !== recipient.identityKey ? "UNRANKED_UNKNOWN_SCOPE" as const : "UNRANKED" as const,
        decision: localPotential ? "REVIEW_LOCAL_CANDIDATE" as const : "NO_RECOMMENDATION" as const,
        missingEvidence,
        reason: localPotential ? "The exact item is currently carried by this character, IsEquippableItem returned true for that player/item, and either a structurally compatible slot is empty or a complete recorded stat vector dominates a compatible item. This is only a review candidate: class/proficiency eligibility, build fit, and complete upgrade status remain unestablished." : "Dimensions are evaluated separately. A structural slot match or raw-stat result does not by itself establish eligibility, suitability, a complete upgrade, transfer access, or allocation priority.",
      };
    }));
    // Evaluate each observed source candidate against every Dashboard-known
    // Forever character. Cross-character results are screening/fit evidence;
    // the exporter set is not treated as a shared WoW account or transfer route.
    const foreverRoster = this.store.listCharacters("forever").flatMap((character) => {
      const resolvedObservation = this.getForeverGearObservation({ version: "forever", name: character.name, realm: character.realm });
      if (resolvedObservation.status !== "FOUND" || !resolvedObservation.value.data) return [];
      const snapshot = this.store.listSnapshots(character.identityKey)[0];
      const profile = snapshot?.parsed.character;
      const at = profile?.status.observedAt ?? snapshot?.generatedAt ?? snapshot?.importedAt;
      const recent = at !== undefined && classifyFreshness(at, this.now()) === "recent" && profile?.status.state === "OBSERVED";
      const itemEvidence = snapshot?.parsed.foreverGearObservation?.itemEvidence as Record<string, unknown> | undefined;
      const evidenceData = itemEvidence?.data as Record<string, unknown> | undefined;
      const skillLinesObservedAt = typeof evidenceData?.skillLinesObservedAt === "number" ? evidenceData.skillLinesObservedAt : undefined;
      const skillAt = skillLinesObservedAt === undefined ? "unknown" : classifyFreshness(skillLinesObservedAt, this.now());
      const skills = (Array.isArray(evidenceData?.skillLines) ? evidenceData.skillLines : []).flatMap((value) => {
        const row = asRecord(value);
        return row && row.isHeader !== true && typeof row.name === "string"
          ? [{ name: row.name, rank: typeof row.rank === "number" ? row.rank : undefined, provenance: itemEvidence?.lastAttemptStale === true || skillAt === "stale" ? "LAST_SEEN" : skillAt === "recent" ? "OBSERVED" : "UNKNOWN" }]
          : [];
      });
      const complete = snapshot?.parsed.foreverGearObservation?.equipment?.completeness === "complete"
        && resolvedObservation.value.data.equipment.state === "OBSERVED" && resolvedObservation.value.data.equipment.freshness === "recent";
      return [{ character, snapshot, profile, recent, skills, equipment: resolvedObservation.value.data.equipment, complete }];
    });
    const recipientEvaluations = assessments.map((assessment) => {
      const candidate = assessment.candidate;
      const cls = foreverItemField(candidate.itemApiEvidence, "itemClass");
      const subtype = foreverItemField(candidate.itemApiEvidence, "itemSubclass");
      const location = foreverItemField(candidate.itemApiEvidence, "equipLocation");
      const required = foreverItemField(candidate.itemApiEvidence, "requiredLevel");
      const candidateMetadataRecent = foreverItemEvidenceIsRecent(candidate.itemApiEvidence, this.now()) && foreverItemContractIsValidated(candidate.itemApiEvidence);
      const itemClass = candidateMetadataRecent && cls?.state === "OBSERVED" && typeof cls.value === "string" ? cls.value : undefined;
      const itemSubclass = candidateMetadataRecent && subtype?.state === "OBSERVED" && typeof subtype.value === "string" ? subtype.value : undefined;
      const equipLocation = candidateMetadataRecent && location?.state === "OBSERVED" && typeof location.value === "string" ? location.value : undefined;
      const requiredLevel = candidateMetadataRecent && required?.state === "OBSERVED" && typeof required.value === "number" ? required.value : undefined;
      const candidateStats = foreverStatTable(candidate.itemApiEvidence, this.now());
      return { source: assessment.source, itemRef: candidate.itemRef, recipients: foreverRoster.map((entry) => {
        const recipientLevel = entry.recent && typeof entry.profile?.level === "number" ? entry.profile.level : undefined;
        const levelCheck = requiredLevel === undefined || recipientLevel === undefined ? "UNKNOWN" as const : requiredLevel <= recipientLevel ? "MET" as const : "NOT_MET" as const;
        const armor = evaluateForeverArmorProficiency({ itemClass, itemSubclass, recipientClass: entry.recent ? entry.profile?.class : undefined, recipientLevel });
        const slotEvidence: ForeverSlotEvidence[] = entry.equipment.items.map((item) => {
          const field = foreverItemField((item as unknown as { itemApiEvidence?: unknown }).itemApiEvidence, "equipLocation");
          return { slot: item.slot, ...(item.itemRef ? { itemRef: item.itemRef } : {}), ...(field?.state === "OBSERVED" && typeof field.value === "string" ? { equipLocation: field.value } : {}), provenance: item.provenance };
        });
        const slot = evaluateForeverSlotCompatibility({ equipLocation, equipment: slotEvidence, equipmentComplete: entry.complete });
        const equipmentCurrent = entry.equipment.state === "OBSERVED" && entry.equipment.freshness === "recent";
        const comparisons = candidateStats && equipmentCurrent ? entry.equipment.items.flatMap((item) => {
          if (!item.itemRef || !slot.possibleSlots.includes(item.slot) || item.provenance !== "OBSERVED") return [];
          const evidence = (item as unknown as { itemApiEvidence?: unknown }).itemApiEvidence;
          const comparison = compareForeverStatTables(candidateStats, foreverStatTable(evidence, this.now()), item.slot, item.itemRef, itemClass);
          return comparison ? [comparison] : [];
        }) : [];
        const upgrade = entry.complete
          ? classifyForeverRecordedUpgrade(comparisons, slot)
          : { status: "UNKNOWN" as const, confidence: "UNKNOWN" as const, reason: comparisons.length > 0
            ? "Exact observed same-slot raw stat comparisons are available, but the recipient equipment scan is partial; overall upgrade status remains unknown."
            : "Recipient equipment evidence is partial; no overall upgrade conclusion is made." };
        const local = assessment.source.identityKey === entry.character.identityKey;
        const eligibility = combineForeverEligibility({ requiredLevel: levelCheck, explicitClassRestriction: "UNKNOWN", armorProficiency: armor,
          weaponProficiency: itemClass === "Weapon"
            ? evaluateForeverWeaponProficiency({ itemSubclass, observedSkillLines: entry.skills, skillSemantics: "CLASSIC_DERIVED_HYPOTHESIS" })
            : itemClass ? { state: "NOT_APPLICABLE", confidence: "UNKNOWN", reason: "Observed item is not a weapon." } : { state: "UNKNOWN", confidence: "UNKNOWN", reason: "Candidate class is stale or unknown." },
          slotCompatibility: slot.state });
        const fit = evaluateForeverRecipientFit({ identityKey: entry.character.identityKey, eligibility, level: levelCheck, slotCompatibility: slot.state,
          upgrade: upgrade.status, sourceLocation: local ? "LOCAL_CARRIED" : "OTHER_CHARACTER", transferability: "UNKNOWN" });
        return { identityKey: entry.character.identityKey, name: entry.character.name, ...(entry.character.surname ? { surname: entry.character.surname } : {}), realm: entry.character.realm,
          eligibility: eligibility.state, armorProficiency: `${armor.state} (${armor.confidence})`, slotCompatibility: slot.state,
          upgradeStatus: upgrade.status, transferability: fit.transferability, fit: fit.state, reasons: fit.reasons };
      }) };
    });
    // Product-facing projection of the current evidence screens. Each row
    // retains the exact candidate and its recipient screen; no second rules
    // engine or account ownership inference is introduced here.
    const allocationPlan: Array<{
      disposition: "EQUIP_CANDIDATE" | "KEEP" | "POSSIBLE_OTHER_CHARACTER" | "NOT_AN_UPGRADE_ON_OBSERVED_METRICS" | "INSUFFICIENT_EVIDENCE";
      item: { name?: string; itemRef?: string; itemIdentity?: string };
      source: { identityKey: string; name: string; realm: string; location: "CARRIED_INVENTORY" | "EQUIPPED" | "UNKNOWN"; provenance: "OBSERVED" | "LAST_SEEN" | "UNKNOWN"; observedAt?: number; freshness: string };
      recipient: { identityKey: string; name: string; realm: string };
      comparison?: { upgradeStatus: string; confidence: string; rawComparisons: ForeverGearAssessmentEvaluation["rawStatComparisons"] };
      evidence: { provenance: "DERIVED" | "HYPOTHESIS" | "UNKNOWN"; eligibility: string; suitability: string; transferability: string; confidence: "LIMITED" | "UNKNOWN"; reasons: string[]; whatWouldChange: string[] };
    }> = [];
    const planKeys = new Set<string>();
    for (const assessment of assessments) {
      const roster = recipientEvaluations.find((entry) => entry.source.identityKey === assessment.source.identityKey && entry.itemRef === assessment.candidate.itemRef);
      const sourceRecord = candidateSources.find((entry) => entry.source.identityKey === assessment.source.identityKey);
      const sourceAt = sourceRecord?.carried.observedAt;
      const sourceFreshness = sourceRecord?.carried.freshness ?? "unknown";
      const sourceLocationCurrent = sourceRecord?.carried.state === "OBSERVED" && sourceFreshness === "recent" && !assessment.candidate.provenance.includes("LAST_SEEN");
      for (const row of roster?.recipients ?? []) {
        const local = row.identityKey === assessment.source.identityKey;
        const targetAssessment = assessment.recipient.identityKey === row.identityKey;
        const localDecision = local && targetAssessment && assessment.decision === "REVIEW_LOCAL_CANDIDATE";
        const noGain = targetAssessment && ["NO_RECORDED_STAT_GAIN", "RECORDED_STAT_SIDEGRADE"].includes(assessment.upgradeStatus);
        const disposition = localDecision ? "EQUIP_CANDIDATE" as const
          : !local && row.fit === "POTENTIAL_GEAR_FIT" ? "POSSIBLE_OTHER_CHARACTER" as const
            : noGain ? "NOT_AN_UPGRADE_ON_OBSERVED_METRICS" as const : "INSUFFICIENT_EVIDENCE" as const;
        const reason = localDecision
          ? "This exact carried item passed the existing limited local review screen. Inspect it as an equip candidate; eligibility and a complete upgrade are not confirmed."
          : disposition === "POSSIBLE_OTHER_CHARACTER"
            ? "Observed slot or recorded-stat evidence warrants review for this Forever character; roster membership, full eligibility, and transfer access remain unresolved."
            : noGain
              ? "The candidate did not improve the currently recorded metrics. Keep the observed equipped item as the comparison baseline; hidden effects and build weights are not evaluated."
              : "The available observations do not support a stronger equip, retain, or recipient conclusion.";
        const whatWouldChange = [...new Set([
          ...assessment.missingEvidence,
          ...(row.fit === "UNRANKED" || row.fit === "POTENTIAL_GEAR_FIT" ? ["A fresh complete equipment capture and exact-item stats for this recipient"] : []),
          ...(!local ? ["Verified account membership and a permitted transfer route for this exact item"] : []),
          ...(sourceFreshness !== "recent" ? ["A fresh carried-inventory observation from the source character"] : []),
        ])];
        const key = `${disposition}|${assessment.source.identityKey}|${assessment.candidate.itemRef ?? "unknown"}|${row.identityKey}|${targetAssessment ? assessment.rawStatComparisons.map((comparison) => comparison.equippedItemRef).join(",") : ""}`;
        if (!planKeys.has(key)) {
          planKeys.add(key);
          allocationPlan.push({ disposition,
            item: { ...(assessment.candidate.name ? { name: assessment.candidate.name } : {}), ...(assessment.candidate.itemRef ? { itemRef: assessment.candidate.itemRef } : {}), ...(assessment.candidate.itemIdentity ? { itemIdentity: assessment.candidate.itemIdentity } : {}) },
            source: { ...assessment.source, location: sourceLocationCurrent ? "CARRIED_INVENTORY" : "UNKNOWN", provenance: sourceLocationCurrent ? "OBSERVED" : assessment.candidate.provenance.includes("LAST_SEEN") ? "LAST_SEEN" : "UNKNOWN", ...(sourceAt !== undefined ? { observedAt: sourceAt } : {}), freshness: sourceFreshness },
            recipient: { identityKey: row.identityKey, name: row.name, ...(row.surname ? { surname: row.surname } : {}), realm: row.realm },
            ...(targetAssessment ? { comparison: { upgradeStatus: assessment.upgradeStatus, confidence: assessment.upgradeConfidence, rawComparisons: assessment.rawStatComparisons } } : {}),
            evidence: { provenance: disposition === "POSSIBLE_OTHER_CHARACTER" ? "HYPOTHESIS" : disposition === "INSUFFICIENT_EVIDENCE" ? "UNKNOWN" : "DERIVED", eligibility: targetAssessment ? assessment.eligibilityAssessment.state : row.eligibility, suitability: targetAssessment ? assessment.suitability : "UNKNOWN", transferability: local ? "No transfer needed for source character" : row.transferability,
              confidence: localDecision || noGain || disposition === "POSSIBLE_OTHER_CHARACTER" ? "LIMITED" : "UNKNOWN", reasons: [reason, ...row.reasons], whatWouldChange },
          });
        }
        // Keep an observed equipped item as the comparison baseline only when
        // a current exact-stat comparison shows this candidate did not beat it.
        if (local && noGain) for (const comparison of assessment.rawStatComparisons.filter((entry) => entry.classification === "EQUIPPED_DOMINATES_RECORDED_STATS" || entry.classification === "RECORDED_STAT_TIE")) {
          const keepKey = `KEEP|${row.identityKey}|${comparison.equippedItemRef}|${assessment.candidate.itemRef}`;
          if (planKeys.has(keepKey)) continue;
          planKeys.add(keepKey);
          const equipped = recipient.equipment.items.find((item) => item.itemRef === comparison.equippedItemRef);
          allocationPlan.push({ disposition: "KEEP", item: { ...(equipped?.name ? { name: equipped.name } : {}), itemRef: comparison.equippedItemRef },
            source: { identityKey: row.identityKey, name: row.name, ...(row.surname ? { surname: row.surname } : {}), realm: row.realm, location: "EQUIPPED", provenance: recipient.equipment.freshness === "recent" ? "OBSERVED" : "UNKNOWN", ...(recipient.equipment.observedAt !== undefined ? { observedAt: recipient.equipment.observedAt } : {}), freshness: recipient.equipment.freshness ?? "unknown" },
            recipient: { identityKey: row.identityKey, name: row.name, ...(row.surname ? { surname: row.surname } : {}), realm: row.realm },
            comparison: { upgradeStatus: assessment.upgradeStatus, confidence: assessment.upgradeConfidence, rawComparisons: [comparison] },
            evidence: { provenance: "DERIVED", eligibility: "already observed equipped", suitability: "UNKNOWN", transferability: "not applicable", confidence: "LIMITED", reasons: [reason, comparison.reason], whatWouldChange } });
        }
      }
    }
    for (const source of candidateSources) for (const item of source.unclassifiedItems) {
      const sourceLocationCurrent = source.carried.state === "OBSERVED" && source.carried.freshness === "recent" && item.provenance !== "LAST_SEEN";
      for (const entry of foreverRoster) {
        const local = entry.character.identityKey === source.source.identityKey;
        const unknownRowKey = item.itemIdentity === "OBSERVED" && item.itemRef
          ? item.itemRef
          : `partial:${item.container ?? "?"}:${item.slot ?? "?"}:${item.itemRef ?? "unknown"}`;
        const key = `UNCLASSIFIED|${source.source.identityKey}|${unknownRowKey}|${entry.character.identityKey}`;
        if (planKeys.has(key)) continue;
        planKeys.add(key);
        allocationPlan.push({ disposition: "INSUFFICIENT_EVIDENCE",
          item: { ...(item.name ? { name: item.name } : {}), ...(item.itemRef ? { itemRef: item.itemRef } : {}), ...(item.itemIdentity ? { itemIdentity: item.itemIdentity } : {}) },
          source: { ...source.source, location: sourceLocationCurrent ? "CARRIED_INVENTORY" : "UNKNOWN", provenance: sourceLocationCurrent ? "OBSERVED" : item.provenance === "LAST_SEEN" ? "LAST_SEEN" : "UNKNOWN", ...(source.carried.observedAt !== undefined ? { observedAt: source.carried.observedAt } : {}), freshness: source.carried.freshness ?? "unknown" },
          recipient: { identityKey: entry.character.identityKey, name: entry.character.name, ...(entry.character.surname ? { surname: entry.character.surname } : {}), realm: entry.character.realm },
          evidence: { provenance: "UNKNOWN", eligibility: "UNKNOWN", suitability: "UNKNOWN", transferability: local ? "No transfer needed unless ownership or storage changes" : "UNKNOWN", confidence: "UNKNOWN",
            reasons: [item.reason, "No item-stat or equipment comparison is made until the exact item's equipment status is established."],
            whatWouldChange: ["Fresh, exact-variant GetItemInfoInstant and IsEquippableItem evidence for this item", "Exact-item stats and a current complete equipment capture for the intended recipient", ...(!local ? ["Verified account membership and a permitted transfer route"] : []), ...(sourceLocationCurrent ? [] : ["A fresh carried-inventory capture from the source character"])] },
        });
      }
    }
    const observedAt = resolved.value.provenance.observedAt;
    return { status: "FOUND", value: {
      data: { version: "forever", ruleset: "forever-70291-allocation-screen-v2", scope: { accountMembership: "UNKNOWN", reason: "Characters are drawn from the Dashboard Forever import context; exports do not include a validated WoW account ID. Candidate presence on another character is not ownership sharing or transfer access." }, recipient,
        candidateSources, assessments, recipientEvaluations, allocationPlan, exclusions,
        conclusion: assessments.some((assessment) => assessment.decision === "REVIEW_LOCAL_CANDIDATE") ? "LOCAL_REVIEW_CANDIDATE_AVAILABLE" : "INSUFFICIENT_EVIDENCE",
        reason: assessments.some((assessment) => assessment.decision === "REVIEW_LOCAL_CANDIDATE")
          ? "At least one source-local item has a current positive player API result and a limited structural or raw-stat signal. This review candidate is not a confirmed eligibility result, upgrade, or cross-character allocation."
          : assessments.length === 0 ? "No currently observed potential-equipment rows are available to assess; missing candidate data does not prove there is no useful equipment." : "Potential-equipment rows were found, but the evidence does not support a source-local equip candidate or cross-character recommendation." },
      provenance: { state: "DERIVED", version: "forever", identityKey: recipient.identityKey, ...(observedAt !== undefined ? { observedAt, freshness: classifyFreshness(observedAt, this.now()) } : {}), snapshotId: recipientSnapshot?.id, source: "Forever 70291 observations from the Dashboard import context", reason: "No Retail rules are used; unresolved evidence remains UNKNOWN." },
    } };
  }

  getCharacterProfessions(query: CharacterQuery): CharacterResolution<ReadValue<ProfessionsSection>> {
    return this.resolve(query, (character, snapshot) => {
      if (!snapshot) return { provenance: { state: "UNKNOWN", version: query.version, identityKey: character.identityKey, reason: "No snapshot exists for this character." } };
      const value = snapshot.parsed.professions;
      const captured = snapshot.parsed.characterState?.professionSpecializations;
      const recipes = snapshot.parsed.characterState?.professionRecipes;
      const recipeKnowledge = query.version === "retail" ? recipes ?? { status: { state: "UNKNOWN" as const, reason: "No successful Retail profession recipe observation has been imported." }, completeness: "unknown" as const } : undefined;
      const state = value.status.state === "UNKNOWN" && (captured || recipeKnowledge) ? statusToReadState(captured?.status.state ?? recipeKnowledge!.status.state) : statusToReadState(value.status.state);
      const data = { ...value, ...(captured ? { specialization: captured } : {}), ...(recipeKnowledge ? { recipeKnowledge } : {}) } as ProfessionsSection;
      return { ...(state === "UNKNOWN" ? {} : { data }), provenance: { state, version: query.version, identityKey: character.identityKey, observedAt: value.status.state !== "UNKNOWN" ? value.status.observedAt ?? snapshot.generatedAt ?? snapshot.importedAt : recipes?.observedAt ?? captured?.observedAt ?? snapshot.generatedAt ?? snapshot.importedAt, importedAt: snapshot.importedAt, snapshotId: snapshot.id, source: "WOWSYNC v1 professions plus structured specialization and recipe sidecars", ...(state === "UNKNOWN" ? { reason: value.status.reason ?? "This section was not captured." } : {}), ...(state === "LAST_SEEN" ? { warning: "This section is historical and not a current observation." } : {}) } };
    });
  }

  getCharacterCurrencies(query: CharacterQuery): CharacterResolution<ReadValue<CharacterCurrencies>> {
    return this.resolve(query, (character) => {
      const currencies = this.store.getCharacterCurrencies(character.identityKey);
      if (!currencies || currencies.state === "UNKNOWN") return { provenance: { state: "UNKNOWN", version: query.version, identityKey: character.identityKey, reason: "WoWSync has not captured a currency list for this character." } };
      return { data: currencies, provenance: { state: currencies.state, version: query.version, identityKey: character.identityKey, observedAt: currencies.observedAt ?? undefined, snapshotId: currencies.snapshotId ?? undefined, source: "WoWSync structured currencies", ...(currencies.state === "LAST_SEEN" ? { warning: currencies.lastSeenReason ?? "Historical currency observation." } : {}) } };
    });
  }

  /** Bounded current or explicitly selected spellbook observation. */
  getCharacterSpells(query: CharacterSpellsQuery): CharacterResolution<ReadValue<CharacterSpellsRead>> {
    return this.resolveSelectedSnapshot(query, (character, snapshot) => {
      const identity = { version: query.version, identityKey: character.identityKey, name: character.name, realm: character.realm };
      if (!snapshot) return { data: { identity, sectionState: "UNKNOWN", reason: "No stored snapshot exists for this character." }, provenance: { state: "UNKNOWN", version: query.version, identityKey: character.identityKey, reason: "No stored snapshot exists for this character." } };
      const section = snapshot.parsed.spells;
      const status = section.status.state;
      const observedAt = section.status.observedAt ?? snapshotObservedAt(snapshot.generatedAt, snapshot.importedAt);
      const freshness = classifyFreshness(observedAt, this.now());
      const needle = query.query?.trim().toLocaleLowerCase();
      const matches = status === "UNKNOWN" ? [] : section.entries.filter((spell) => !needle || `${spell.spellID ?? ""} ${spell.name ?? ""} ${spell.rank ?? ""}`.toLocaleLowerCase().includes(needle));
      const page = pageBounds(query.offset ?? 0, query.limit ?? 50);
      const entries = matches.slice(page.offset, page.offset + page.limit);
      return {
        data: { identity, snapshot: { snapshotId: snapshot.id, generatedAt: snapshot.generatedAt ?? undefined, observedAt, importedAt: snapshot.importedAt, freshness }, sectionState: status, ...(section.coverage ? { coverage: section.coverage } : {}), ...(status === "UNKNOWN" ? { reason: section.status.reason ?? "Known-spell capture is UNKNOWN in this snapshot." } : { spells: { items: entries, offset: page.offset, limit: page.limit, totalCount: matches.length, truncated: page.offset + entries.length < matches.length } }) },
        provenance: { state: status, version: query.version, identityKey: character.identityKey, observedAt, importedAt: snapshot.importedAt, snapshotId: snapshot.id, freshness, source: "WOWSYNC v1 known-spells section", ...(status === "UNKNOWN" ? { reason: section.status.reason ?? "Known-spell capture is UNKNOWN." } : {}), ...(status === "LAST_SEEN" ? { warning: "Historical spellbook observation; not current." } : {}) },
      };
    });
  }

  /** Bounded captured trainer-visit evidence; captured status strings remain verbatim and are not upgraded into learned/trainable claims. */
  getCharacterTrainer(query: CharacterTrainerQuery): CharacterResolution<ReadValue<CharacterTrainerRead>> {
    return this.resolveSelectedSnapshot(query, (character, snapshot) => {
      const identity = { version: query.version, identityKey: character.identityKey, name: character.name, realm: character.realm };
      if (!snapshot) return { data: { identity, sectionState: "UNKNOWN", categories: [], services: [], offset: 0, limit: query.limit ?? 50, totalCount: 0, truncated: false, categoryCount: 0, categoriesTruncated: false, reason: "No stored snapshot exists for this character." }, provenance: { state: "UNKNOWN", version: query.version, identityKey: character.identityKey, reason: "No stored snapshot exists for this character." } };
      const section = snapshot.parsed.trainer;
      const status = section.status.state;
      const selectedCategories = [...section.categories].filter((category) => !query.category || category.category.toLocaleLowerCase() === query.category.trim().toLocaleLowerCase()).sort((a, b) => a.category.localeCompare(b.category));
      const categoryRead = selectedCategories.map((category) => {
        const observedAt = category.status.observedAt ?? section.status.observedAt ?? snapshotObservedAt(snapshot.generatedAt, snapshot.importedAt);
        const counts = { known: 0, available: 0, unavailable: 0, other: 0 };
        for (const service of category.services) {
          const state = service.statusAtVisit?.toLowerCase();
          if (state === "known" || state === "available" || state === "unavailable") counts[state]++;
          else counts.other++;
        }
        return { category, observedAt, freshness: classifyFreshness(observedAt, this.now()), counts };
      });
      const needle = query.query?.trim().toLocaleLowerCase();
      const services = categoryRead.flatMap(({ category, observedAt, freshness }) => category.services
        .filter((service) => {
          const state = service.statusAtVisit?.toLowerCase();
          if (query.status && (query.status === "other" ? state === "known" || state === "available" || state === "unavailable" : state !== query.status)) return false;
          return !needle || `${service.spellID ?? ""} ${service.ability ?? ""} ${service.rank ?? ""} ${service.requirementsAtVisit ?? ""}`.toLocaleLowerCase().includes(needle);
        })
        .map((service) => ({ category: category.category, categoryState: category.status.state, observedAt, freshness, spellID: service.spellID, ability: service.ability, rank: service.rank, statusAtVisit: service.statusAtVisit, requiredLevel: service.requiredLevel, costCopper: service.costCopper, requirementsAtVisit: service.requirementsAtVisit })));
      const page = pageBounds(query.offset ?? 0, query.limit ?? 50);
      const pageServices = services.slice(page.offset, page.offset + page.limit);
      const categories = categoryRead.slice(0, 50).map(({ category, observedAt, freshness, counts }) => ({ category: category.category, state: category.status.state, observedAt, freshness, trainerName: category.name, trainerType: category.trainerType, coverage: category.coverage, filters: category.filters, serviceCount: category.services.length, statusCounts: counts }));
      const observedAt = section.status.observedAt ?? snapshotObservedAt(snapshot.generatedAt, snapshot.importedAt);
      return {
        data: { identity, snapshot: { snapshotId: snapshot.id, generatedAt: snapshot.generatedAt ?? undefined, observedAt: snapshotObservedAt(snapshot.generatedAt, snapshot.importedAt), importedAt: snapshot.importedAt, freshness: classifyFreshness(snapshotObservedAt(snapshot.generatedAt, snapshot.importedAt), this.now()) }, sectionState: status, categories, categoryCount: categoryRead.length, categoriesTruncated: categoryRead.length > categories.length, services: pageServices, offset: page.offset, limit: page.limit, totalCount: services.length, truncated: page.offset + pageServices.length < services.length, ...(status === "UNKNOWN" ? { reason: section.status.reason ?? "Trainer visits have not been observed in this snapshot." } : {}) },
        provenance: { state: status, version: query.version, identityKey: character.identityKey, observedAt, importedAt: snapshot.importedAt, snapshotId: snapshot.id, freshness: classifyFreshness(observedAt, this.now()), source: "WOWSYNC v1 captured trainer visit observations", ...(status === "UNKNOWN" ? { reason: section.status.reason ?? "Trainer visits have not been observed." } : {}), ...(status === "LAST_SEEN" || categoryRead.some(({ category }) => category.status.state === "LAST_SEEN") ? { warning: "One or more trainer categories are historical observations; they are not current." } : {}) },
      };
    });
  }

  getCharacterSnapshotHistory(query: HistoryQuery): CharacterResolution<ReadValue<BoundedPage<CharacterSnapshotHistoryRecord>>> {
    return this.resolve(query, (character) => {
      const bounds = pageBounds(query.offset ?? 0, query.limit ?? 20);
      const allSnapshots = this.store.listSnapshots(character.identityKey);
      if (allSnapshots.length === 0) return { provenance: { state: "UNKNOWN", version: query.version, identityKey: character.identityKey, reason: "No stored snapshots exist for this character." } };
      const snapshots = allSnapshots.slice(bounds.offset, bounds.offset + bounds.limit);
      const newest = allSnapshots[0];
      const history = snapshots.map((snapshot) => ({
        snapshotId: snapshot.id,
        generatedAt: snapshot.generatedAt,
        observedAt: snapshotObservedAt(snapshot.generatedAt, snapshot.importedAt),
        importedAt: snapshot.importedAt,
        freshness: classifyFreshness(snapshotObservedAt(snapshot.generatedAt, snapshot.importedAt), this.now()),
        level: snapshot.parsed.character.level,
        moneyCopper: snapshot.parsed.character.moneyCopper,
        playedSeconds: snapshot.parsed.character.playedSeconds,
        xp: snapshot.parsed.character.xp,
        xpMax: snapshot.parsed.character.xpMax,
        zone: snapshot.parsed.location.zone,
        subzone: snapshot.parsed.location.subzone,
        equipmentState: snapshot.parsed.equipment.status.state,
        bagsState: snapshot.parsed.bags.status.state,
        bankState: snapshot.parsed.bank.status.state,
        professionsState: snapshot.parsed.professions.status.state,
        currencyState: this.store.getCharacterCurrenciesForSnapshot(character.identityKey, snapshot.id)?.state ?? "UNKNOWN" as const,
      }));
      return { data: { items: history, offset: bounds.offset, limit: bounds.limit, totalCount: allSnapshots.length, truncated: bounds.offset + history.length < allSnapshots.length }, provenance: { state: "DERIVED", version: query.version, identityKey: character.identityKey, observedAt: snapshotObservedAt(newest.generatedAt, newest.importedAt), importedAt: newest.importedAt, snapshotId: newest.id, freshness: classifyFreshness(snapshotObservedAt(newest.generatedAt, newest.importedAt), this.now()), source: "bounded compact character snapshot timeline" } };
    });
  }

  /** Compare the latest/previous snapshots, or two explicitly selected snapshots belonging to this character. */
  getCharacterChanges(query: CharacterChangesQuery): CharacterResolution<ReadValue<CharacterChangesRead>> {
    if ((query.fromSnapshotId === undefined) !== (query.toSnapshotId === undefined)) throw new TypeError("fromSnapshotId and toSnapshotId must be supplied together.");
    return this.resolve(query, (character) => {
      const snapshots = this.store.listSnapshots(character.identityKey);
      let from: StoredSnapshot | undefined;
      let to: StoredSnapshot | undefined;
      if (query.fromSnapshotId !== undefined && query.toSnapshotId !== undefined) {
        from = snapshots.find((snapshot) => snapshot.id === query.fromSnapshotId);
        to = snapshots.find((snapshot) => snapshot.id === query.toSnapshotId);
        if (!from || !to) throw new TypeError("Both snapshot IDs must belong to the resolved character in the requested WoW version.");
      } else {
        to = snapshots[0];
        from = snapshots[1];
      }
      const identity = { version: query.version, identityKey: character.identityKey, name: character.name, realm: character.realm };
      if (!from || !to) return { data: { identity, comparisonState: "INSUFFICIENT_HISTORY", reason: "At least two snapshots are required to compare character changes." }, provenance: { state: "UNKNOWN", version: query.version, identityKey: character.identityKey, ...(to ? { observedAt: snapshotObservedAt(to.generatedAt, to.importedAt), importedAt: to.importedAt, snapshotId: to.id, freshness: classifyFreshness(snapshotObservedAt(to.generatedAt, to.importedAt), this.now()) } : {}), reason: "This character does not have two selectable snapshots." } };

      const fromAt = snapshotObservedAt(from.generatedAt, from.importedAt);
      const toAt = snapshotObservedAt(to.generatedAt, to.importedAt);
      const diff = diffSnapshots(from.parsed, to.parsed);
      const timestamp = (snapshot: StoredSnapshot) => {
        const observedAt = snapshotObservedAt(snapshot.generatedAt, snapshot.importedAt);
        return { snapshotId: snapshot.id, observedAt, importedAt: snapshot.importedAt, freshness: classifyFreshness(observedAt, this.now()) };
      };
      const itemChanges = (storage: "bags" | "bank") => {
        const before = from!.parsed[storage];
        const after = to!.parsed[storage];
        const comparison = inventoryComparison(before, after);
        const changes = comparison.state === "COMPARED" ? diff[storage === "bags" ? "bagsItems" : "bankItems"] : [];
        return { state: comparison.state, fromState: before.status.state, toState: after.status.state, freeSlots: numericChange(before.freeSlots, after.freeSlots, before.status.state, after.status.state), totalSlots: numericChange(before.totalSlots, after.totalSlots, before.status.state, after.status.state), itemChanges: changeList(changes, 25), ...(comparison.reason ? { reason: comparison.reason } : {}) };
      };
      const equipmentComparison = fullSectionComparison(from.parsed.equipment.status.state, to.parsed.equipment.status.state, from.parsed.equipment.status.completeness, to.parsed.equipment.status.completeness);
      const equipmentChanges = equipmentComparison.state === "COMPARED" ? diff.equipment : [];
      const professionComparison = fullSectionComparison(from.parsed.professions.status.state, to.parsed.professions.status.state, from.parsed.professions.status.completeness, to.parsed.professions.status.completeness);
      const professionChanges = professionComparison.state === "COMPARED" ? diff.professions : [];
      const locationComparison = sectionComparison(from.parsed.location.status.state, to.parsed.location.status.state);
      const currenciesFrom = this.store.getCharacterCurrenciesForSnapshot(character.identityKey, from.id);
      const currenciesTo = this.store.getCharacterCurrenciesForSnapshot(character.identityKey, to.id);
      const currencyFromState: SectionState = currenciesFrom?.state ?? "UNKNOWN";
      const currencyToState: SectionState = currenciesTo?.state ?? "UNKNOWN";
      const currencyBase = sectionComparison(currencyFromState, currencyToState);
      let currencyState = currencyBase.state;
      let currencyReason = currencyBase.reason;
      const currencyChanges: Array<{ currencyID: number; name: string | null; scope: "ACCOUNT" | "CHARACTER" | "UNKNOWN"; fromQuantity: number; toQuantity: number; delta: number }> = [];
      if (currencyState === "COMPARED" && currenciesFrom?.currencies && currenciesTo?.currencies) {
        const fromMap = new Map(currenciesFrom.currencies.map((entry) => [entry.currencyID, entry]));
        const toMap = new Map(currenciesTo.currencies.map((entry) => [entry.currencyID, entry]));
        const commonIds = [...fromMap.keys()].filter((id) => toMap.has(id));
        const unmatched = fromMap.size !== toMap.size || [...fromMap.keys()].some((id) => !toMap.has(id));
      const ownershipChanged = commonIds.some((id) => fromMap.get(id)?.isAccountWide !== toMap.get(id)?.isAccountWide);
      const missingQuantity = commonIds.some((id) => fromMap.get(id)?.quantity === null || toMap.get(id)?.quantity === null);
        for (const id of commonIds) {
          const before = fromMap.get(id)!;
          const after = toMap.get(id)!;
          if (before.quantity === null || after.quantity === null || before.quantity === after.quantity || before.isAccountWide !== after.isAccountWide) continue;
          currencyChanges.push({ currencyID: id, name: after.name ?? before.name, scope: before.isAccountWide === true ? "ACCOUNT" : before.isAccountWide === false ? "CHARACTER" : "UNKNOWN", fromQuantity: before.quantity, toQuantity: after.quantity, delta: after.quantity - before.quantity });
        }
        currencyChanges.sort((a, b) => a.currencyID - b.currencyID);
        if (unmatched || missingQuantity || ownershipChanged) {
          currencyState = "PARTIAL";
          currencyReason = "Only currency IDs present in both observed lists with known quantities and unchanged ownership scope are compared; missing/listed status is not treated as zero or removal.";
        }
      }
      const changes: CharacterChangesRead["changes"] = {
        progression: {
          level: numericChange(from.parsed.character.level, to.parsed.character.level, from.parsed.character.status.state, to.parsed.character.status.state),
          xp: numericChange(from.parsed.character.xp, to.parsed.character.xp, from.parsed.character.status.state, to.parsed.character.status.state),
          xpMax: numericChange(from.parsed.character.xpMax, to.parsed.character.xpMax, from.parsed.character.status.state, to.parsed.character.status.state),
          location: { state: locationComparison.state, fromState: from.parsed.location.status.state, toState: to.parsed.location.status.state, ...(locationComparison.state === "COMPARED" ? { fromZone: from.parsed.location.zone, toZone: to.parsed.location.zone, fromSubzone: from.parsed.location.subzone, toSubzone: to.parsed.location.subzone, changed: diff.location.changed } : {}), ...(locationComparison.reason ? { reason: locationComparison.reason } : {}) },
        },
        economy: {
          goldCopper: numericChange(from.parsed.character.moneyCopper, to.parsed.character.moneyCopper, from.parsed.character.status.state, to.parsed.character.status.state),
          playedSeconds: numericChange(from.parsed.character.playedSeconds, to.parsed.character.playedSeconds, from.parsed.character.status.state, to.parsed.character.status.state),
          levelPlayedSeconds: numericChange(from.parsed.character.levelPlayedSeconds, to.parsed.character.levelPlayedSeconds, from.parsed.character.status.state, to.parsed.character.status.state),
        },
        equipment: { state: equipmentComparison.state, fromState: from.parsed.equipment.status.state, toState: to.parsed.equipment.status.state, changes: changeList(equipmentChanges, 20), ...(equipmentComparison.reason ? { reason: equipmentComparison.reason } : {}) },
        bags: itemChanges("bags"),
        bank: itemChanges("bank"),
        professions: { state: professionComparison.state, fromState: from.parsed.professions.status.state, toState: to.parsed.professions.status.state, changes: changeList(professionChanges, 20), ...(professionComparison.reason ? { reason: professionComparison.reason } : {}) },
        currencies: { state: currencyState, fromState: currencyFromState, toState: currencyToState, changes: changeList(currencyChanges, 20), ...(currencyReason ? { reason: currencyReason } : {}) },
      };
      return { data: { identity, comparisonState: "COMPARED", fromSnapshot: timestamp(from), toSnapshot: timestamp(to), changes }, provenance: { state: "DERIVED", version: query.version, identityKey: character.identityKey, observedAt: toAt, importedAt: to.importedAt, snapshotId: to.id, freshness: classifyFreshness(toAt, this.now()), source: "diffSnapshots semantic comparison of two character snapshots", derivedFrom: [String(from.id), String(to.id)], warning: "Only comparable captured observations produce deltas. Shared Warband and guild journal observations are independent and are not included." } };
    });
  }

  /** Account-level observed character bags/banks, using AccountFacts aggregation and strict version scoping. */
  searchItems(query: ItemSearchQuery): ReadValue<BoundedPage<ItemWithMetadata> & { unknownBags: Array<AccountFacts["inventory"]["unknownBags"][number] & { reason?: string; snapshotId?: number }>; unknownBagsTotal: number; unknownBank: Array<AccountFacts["inventory"]["unknownBank"][number] & { reason?: string; snapshotId?: number }>; unknownBankTotal: number }> {
    requireVersion(query.version);
    const text = query.query.trim().toLocaleLowerCase();
    if (!text) throw new TypeError("A non-empty item query is required");
    const { offset, limit } = pageBounds(query.offset, query.limit);
    const facts = this.store.buildAccountFacts(query.version, this.now());
    const matches = facts.inventory.items.filter((item) => (item.name ?? "").toLocaleLowerCase().includes(text))
      .filter((item) => !query.storage || item.locations.some((location) => location.storage === query.storage));
    const selected = matches.slice(offset, offset + limit);
    const metadata = metadataByItemRef(this.store, query.version, selected.map((item) => item.itemKey.startsWith("item:") ? item.itemKey : `item:${item.itemKey}`));
    const result = selected.map((item) => {
      const value = /^\d+$/.test(item.itemKey) ? metadata.get(Number(item.itemKey)) : undefined;
      const scopedLocations = query.storage ? item.locations.filter((location) => location.storage === query.storage) : item.locations;
      const locations: InventorySearchLocation[] = scopedLocations.flatMap((location) => {
        const snapshot = this.store.listSnapshots(location.identityKey)[0];
        const section = snapshot?.parsed[location.storage];
        if (!snapshot || !section || section.status.state === "UNKNOWN") return [];
        const observedAt = section.status.observedAt ?? snapshot.generatedAt ?? snapshot.importedAt;
        return [{ ...location, state: section.status.state, ...(observedAt !== undefined ? { observedAt } : {}), importedAt: snapshot.importedAt, snapshotId: snapshot.id, freshness: classifyFreshness(observedAt, this.now()) }];
      });
      const scopedItem = { ...item, locations };
      return { item: scopedItem, metadataState: value ? "KNOWN" as const : "UNKNOWN" as const, ...(value ? { metadata: value } : {}) };
    });
    const describeUnknown = (entry: AccountFacts["inventory"]["unknownBags"][number], storage: StorageLocation) => {
      const snapshot = this.store.listSnapshots(entry.identityKey)[0];
      return { ...entry, ...(snapshot ? { snapshotId: snapshot.id, reason: snapshot.parsed[storage].status.reason } : {}) };
    };
    const allUnknownBags = query.storage === "bank" ? [] : facts.inventory.unknownBags;
    const allUnknownBank = query.storage === "bags" ? [] : facts.inventory.unknownBank;
    const unknownBags = allUnknownBags.map((entry) => describeUnknown(entry, "bags")).slice(0, 100);
    const unknownBank = allUnknownBank.map((entry) => describeUnknown(entry, "bank")).slice(0, 100);
    return { data: { items: result, offset, limit, totalCount: matches.length, truncated: offset + result.length < matches.length, unknownBags, unknownBagsTotal: allUnknownBags.length, unknownBank, unknownBankTotal: allUnknownBank.length }, provenance: { state: "DERIVED", version: query.version, source: "AccountFacts character inventory observations", derivedFrom: facts.characters.map((character) => character.identityKey) } };
  }

  /** Latest captured contents for one character-owned storage location. Shared storage is never attributed here. */
  getCharacterStorage(query: CharacterStorageQuery): CharacterResolution<ReadValue<CharacterStorageContents>> {
    return this.resolve(query, (character, snapshot) => {
      const section = snapshot?.parsed[query.storage];
      if (!section) return { provenance: { state: "UNKNOWN", version: query.version, identityKey: character.identityKey, reason: "No snapshot has captured this storage." } };
      const state = statusToReadState(section.status.state);
      const { offset, limit } = pageBounds(query.offset, query.limit);
      const items = section.items.slice(offset, offset + limit);
      const metadata = metadataByItemRef(this.store, query.version, items.map((item) => item.itemRef));
      const value: CharacterStorageContents = {
        storage: query.storage,
        sectionState: state,
        itemsKnownEmpty: section.itemsKnownEmpty,
        ...(state === "UNKNOWN" ? {} : { items, containers: section.containers, ...(section.freeSlots !== undefined ? { freeSlots: section.freeSlots } : {}), ...(section.totalSlots !== undefined ? { totalSlots: section.totalSlots } : {}) }),
        metadata: items.map((item) => metadataFor(item.itemRef, metadata)),
        returnedCount: items.length,
        totalCount: section.items.length,
        truncated: offset + items.length < section.items.length,
      };
      return { data: value, provenance: { state, version: query.version, identityKey: character.identityKey, observedAt: section.status.observedAt ?? snapshot.generatedAt ?? snapshot.importedAt, importedAt: snapshot.importedAt, snapshotId: snapshot.id, source: "WOWSYNC v1 character storage section", ...(state === "UNKNOWN" ? { reason: section.status.reason ?? "This storage section is UNKNOWN." } : {}), ...(state === "LAST_SEEN" ? { warning: "Historical observation; not current." } : {}) } };
    });
  }

  getAccountFacts(query: { version: VersionOrUnknown }): ReadValue<AccountFacts> {
    requireVersion(query.version);
    const facts = this.store.buildAccountFacts(query.version, this.now());
    return { data: facts, provenance: { state: "DERIVED", version: query.version, source: "AccountFacts", derivedFrom: facts.characters.map((character) => character.identityKey) } };
  }
  getProfessionCoverage(query: { version: VersionOrUnknown }): ReadValue<ProfessionFacts> {
    requireVersion(query.version);
    const facts = this.store.buildAccountFacts(query.version, this.now());
    return { data: facts.professions, provenance: { state: "DERIVED", version: query.version, source: "AccountFacts profession coverage", derivedFrom: facts.professions.byCharacter.map((character) => character.identityKey) } };
  }
  getSharedStorage(query: { version: VersionOrUnknown }): ReadValue<SharedStorageResponse> {
    requireVersion(query.version);
    if (query.version !== "retail") return { provenance: { state: "UNKNOWN", version: query.version, reason: "Warband and Guild Bank shared storage is Retail-only." } };
    return { data: buildSharedStorageResponse(this.store.projectSharedStorage(), this.now()), provenance: { state: "DERIVED", version: "retail", source: "immutable shared-storage observation journal", derivedFrom: ["shared-storage-journal"], warning: "Current shared storage is a derived selection of immutable observations; it is never a live bank view." } };
  }

  /** Bounded owner-scoped slice over the immutable shared-storage journal projection. */
  getSharedStorageContents(query: SharedStorageReadQuery): ReadValue<SharedStorageReadPage> {
    requireVersion(query.version);
    if (query.version !== "retail") return { provenance: { state: "UNKNOWN", version: query.version, reason: "Warband and Guild Bank shared storage is Retail-only." } };
    if (query.kind === "guild" && query.guildClubId !== undefined && !query.guildClubId.trim()) throw new TypeError("guildClubId cannot be empty");
    if (query.query !== undefined && !query.query.trim()) throw new TypeError("query cannot be empty when provided");
    const { offset, limit } = pageBounds(query.offset, query.limit);
    const owners = pageBounds(query.ownerOffset, query.ownerLimit ?? 20);
    const projection = this.getSharedStorage({ version: query.version }).data!;
    const allOwners = (query.kind === "warband" ? (projection.warband ? [projection.warband] : []) : projection.guilds.filter((owner) => owner.owner.kind === "guild" && (query.guildClubId === undefined || owner.owner.guildClubId === query.guildClubId)))
      .filter((owner) => owner.owner.kind === query.kind);
    const selectedOwners = allOwners.slice(owners.offset, owners.offset + Math.min(owners.limit, 20));
    const result: SharedStorageReadPage = {
      asOf: projection.asOf,
      ownerOffset: owners.offset,
      ownerLimit: Math.min(owners.limit, 20),
      totalOwners: allOwners.length,
      ownersTruncated: owners.offset + selectedOwners.length < allOwners.length,
      owners: selectedOwners.map((owner) => ({
        owner: owner.owner,
        basis: "DERIVED",
        observationCount: owner.observationCount,
        hasConflict: owner.conflict !== null,
        ...(owner.conflict ? { conflictObservedAt: owner.conflict.effectiveObservedAt } : {}),
        current: pageSharedObservation(owner.current, query, offset, limit),
        latestPartial: pageSharedObservation(owner.latestPartial, query, offset, limit),
        broaderCoverageEarlier: pageSharedObservation(owner.broaderCoverageEarlier, query, offset, limit),
      })),
    };
    return { data: result, provenance: { state: "DERIVED", version: "retail", source: "immutable shared-storage observation journal", derivedFrom: ["shared-storage-journal"], warning: "Observations are historical records; LAST_SEEN carrier state never represents a live view." } };
  }

  getItemMetadata(query: { version: VersionOrUnknown; itemIds: number[] }): ReadValue<Array<{ baseItemId: number; state: "KNOWN" | "UNKNOWN"; metadata?: ItemMetadataView }>> {
    requireVersion(query.version);
    if (query.itemIds.length > 100 || query.itemIds.some((id) => !Number.isSafeInteger(id) || id < 1)) throw new TypeError("itemIds must contain at most 100 positive integers");
    const found = new Map(this.store.getItemMetadata(query.version, query.itemIds).map((item) => [item.baseItemId, item]));
    return { data: [...new Set(query.itemIds)].map((baseItemId) => { const metadata = found.get(baseItemId); return { baseItemId, state: metadata ? "KNOWN" as const : "UNKNOWN" as const, ...(metadata ? { metadata } : {}) }; }), provenance: { state: "DERIVED", version: query.version, source: "game-client item metadata evidence" } };
  }

  /**
   * Azeroth ERP Vertical Slice 1: the deterministic allocation decision for one explicit-version
   * commodity (base item id) against its currently active STOCK_TARGET demand, if any. Always DERIVED —
   * recomputed on every read from the current demand plus current character-storage and shared-storage
   * evidence; nothing about the decision itself is persisted. Allocation/demand are Retail-only in this
   * slice, matching getSharedStorage.
   */
  getItemAllocation(query: { version: VersionOrUnknown; baseItemId: number }): ReadValue<AllocationResult> {
    requireVersion(query.version);
    if (!Number.isSafeInteger(query.baseItemId) || query.baseItemId <= 0) throw new TypeError("baseItemId must be a positive integer");
    if (query.version !== "retail") {
      return { provenance: { state: "UNKNOWN", version: query.version, reason: "Explicit demand and allocation are Retail-only in this slice." } };
    }
    const active = this.store.getActiveDemand(query.version, "STOCK_TARGET", query.baseItemId);
    const data = gateAllocationForProjectReservations(allocationForItem(projectAccountOwnedEvidenceMap(this.store, query.version), query.baseItemId, active ? [active] : []), this.store.listErpProjects(query.version));
    return {
      data,
      provenance: {
        state: "DERIVED",
        version: query.version,
        source: "explicit demand plus character-storage and shared-storage evidence",
        warning: "Allocation is recomputed on every read from current observations and current demand; the decision itself is never stored.",
      },
    };
  }

  /**
   * Azeroth ERP Vertical Slice 2: the account-wide allocation review for one explicit version. Partitions
   * the account's base items into `demanded` (every ACTIVE STOCK_TARGET demand, each evaluated exactly as
   * getItemAllocation evaluates it — same projection, same buildAllocationResult) and `unallocated`
   * (account-owned holdings with no active demand; never surplus, never given a disposition). Both lists
   * are paged independently over a deterministic order; the evidence is projected once per read, never once
   * per item. Retail-only, matching getItemAllocation. Item metadata enriches unallocated entries after
   * paging and never selects or filters them.
   */
  getAllocationReview(query: AllocationReviewQuery): ReadValue<AccountAllocationReview> {
    requireVersion(query.version);
    const demandedPage = pageBounds(query.demandedOffset ?? 0, query.demandedLimit ?? 50);
    const unallocatedPage = pageBounds(query.unallocatedOffset ?? 0, query.unallocatedLimit ?? 50);
    if (query.version !== "retail") {
      return { provenance: { state: "UNKNOWN", version: query.version, reason: "Explicit demand and allocation are Retail-only in this slice." } };
    }
    const evidenceMap = projectAccountOwnedEvidenceMap(this.store, query.version);
    const review = buildAllocationReview(evidenceMap, this.store.listDemands(query.version));
    // Search filters unallocated entries BEFORE paging; whole-list counts above stay whole-account.
    const matchingUnallocated = filterUnallocatedByQuery(review.unallocated, query.q);
    const projects = this.store.listErpProjects(query.version);
    const gatedDemanded = review.demanded.map((result) => gateAllocationForProjectReservations(result, projects));
    const dispositionCounts: DispositionCounts = { HOLD_ALLOCATED: 0, REQUIRES_REVIEW: 0, SEND_HELLOMAGS: 0, NO_ACTION: 0 };
    for (const result of gatedDemanded) dispositionCounts[result.disposition]++;
    const demanded = gatedDemanded.slice(demandedPage.offset, demandedPage.offset + demandedPage.limit);
    const unallocated = matchingUnallocated.slice(unallocatedPage.offset, unallocatedPage.offset + unallocatedPage.limit);
    const itemNames: Record<number, string> = {};
    for (const result of demanded) {
      const name = itemNameForItem(evidenceMap, result.commodity.baseItemId);
      if (name !== undefined) itemNames[result.commodity.baseItemId] = name;
    }
    const metadata = new Map(this.store.getItemMetadata(query.version, unallocated.map((entry) => entry.baseItemId)).map((item) => [item.baseItemId, item]));
    return {
      data: {
        version: query.version,
        unresolvedStorage: review.unresolvedStorage,
        hasUnresolvedStorage: review.unresolvedStorage.length > 0,
        unidentifiedItemRowCount: review.unidentifiedItemRowCount,
        dispositionCounts,
        unallocatedItemStringIdentityCounts: review.unallocatedItemStringIdentityCounts,
        demanded: { items: demanded, offset: demandedPage.offset, limit: demandedPage.limit, totalCount: review.demanded.length, truncated: demandedPage.offset + demanded.length < review.demanded.length },
        unallocated: {
          items: unallocated.map((entry) => {
            const item = metadata.get(entry.baseItemId);
            return { ...entry, metadataState: item ? "KNOWN" as const : "UNKNOWN" as const, ...(item ? { metadata: item } : {}) };
          }),
          offset: unallocatedPage.offset,
          limit: unallocatedPage.limit,
          totalCount: matchingUnallocated.length,
          truncated: unallocatedPage.offset + unallocated.length < matchingUnallocated.length,
        },
        itemNames,
      },
      provenance: {
        state: "DERIVED",
        version: query.version,
        source: "explicit demand plus character-storage and shared-storage evidence",
        warning: "Recomputed on every read; nothing is stored. Unallocated inventory has no active demand and is never surplus: no surplus, disposition, or sale recommendation can be determined for it.",
      },
    };
  }

  /** Existing get_renown projection over the distinct captured Major Faction records. */
  getRenown(query: CharacterQuery): CharacterResolution<ReadValue<{ majorFactions: Record<string, unknown>[]; completeness: string }>> {
    return this.resolve(query, (character, snapshot) => {
      if (query.version !== "retail" || !snapshot?.parsed.characterState?.reputation) {
        return { provenance: { state: "UNKNOWN", version: query.version, identityKey: character.identityKey, reason: "WoWSync does not currently capture Renown for this character." } };
      }
      const state = snapshot.parsed.characterState as CapturedCharacterState;
      const characterDomain = state.reputation?.character;
      const accountDomain = state.reputation?.account;
      const rows: Record<string, unknown>[] = [];
      for (const [ownerScope, domain] of [["CHARACTER", characterDomain], ["ACCOUNT_WARBAND", accountDomain]] as const) {
        const data = domain?.data as Record<string, unknown> | undefined;
        for (const row of (Array.isArray(data?.majorFactions) ? data.majorFactions : []) as Record<string, unknown>[]) {
          if (row.renownEvidence !== "OBSERVED_VALUE" || !row.renown || typeof row.renown !== "object") continue;
          const renown = row.renown as Record<string, unknown>;
          const hasPositiveProgress = [renown.level, renown.earned].some((value) => typeof value === "number" && value > 0);
          // Keep locked/all-zero API records in raw snapshot evidence, but do not project them
          // as a character's earned/unlocked Renown state without a positive API signal.
          if (row.isUnlocked === false && !hasPositiveProgress) continue;
          // Character sidecars may also carry explicitly account-wide records; those belong only
          // to the separate account section and must not be double-counted as character state.
          if (ownerScope === "CHARACTER" && row.ownerScope === "ACCOUNT_WARBAND") continue;
          const explicitScope = ownerScope === "ACCOUNT_WARBAND" ? "ACCOUNT_WARBAND" : row.ownerScope === "CHARACTER" ? "CHARACTER" : "UNKNOWN";
          rows.push({ ...row, ownerScope: explicitScope, ownerScopeEvidence: ownerScope === "ACCOUNT_WARBAND" || explicitScope === "CHARACTER" ? "OBSERVED" : "UNKNOWN", conventionalFactionID: row.conventionalFactionID });
        }
      }
      if (rows.length === 0) return { provenance: { state: "UNKNOWN", version: query.version, identityKey: character.identityKey, reason: "Major Faction enumeration was observed, but no usable Renown records were captured." } };
      const partial = [characterDomain, accountDomain].some((domain) => domain && domain.completeness !== "complete");
      return { data: { majorFactions: rows, completeness: partial ? "partial" : "complete" }, provenance: {
        state: "OBSERVED", version: query.version, identityKey: character.identityKey,
        ...([characterDomain?.observedAt, accountDomain?.observedAt].some((n) => typeof n === "number") ? { observedAt: Math.max(...[characterDomain?.observedAt, accountDomain?.observedAt].filter((n): n is number => typeof n === "number")) } : {}),
        snapshotId: snapshot.id, source: "captured C_MajorFactions Renown records",
        ...(partial ? { warning: "Renown observations are useful, but overall reputation coverage is partial." } : {}),
      } };
    });
  }

  private resolve<T>(query: CharacterQuery, build: (character: StoredCharacterSummary, latest: StoredSnapshot | undefined) => T): CharacterResolution<T> {
    requireVersion(query.version);
    const candidates = this.store.listCharacters(query.version).filter((character) => character.name.toLowerCase() === query.name.toLowerCase() && (!query.realm || character.realm === query.realm));
    if (candidates.length === 0) return { status: "NOT_FOUND", version: query.version, name: query.name, ...(query.realm ? { realm: query.realm } : {}) };
    if (candidates.length > 1) return { status: "AMBIGUOUS", version: query.version, name: query.name, candidates: candidates.map(({ identityKey, realm, name }) => ({ identityKey, realm, name })) };
    const character = candidates[0];
    return { status: "FOUND", value: build(character, this.store.listSnapshots(character.identityKey)[0]) };
  }

  private resolveSelectedSnapshot<T>(query: CharacterSnapshotQuery, build: (character: StoredCharacterSummary, snapshot: StoredSnapshot | undefined) => T): CharacterResolution<T> {
    requireVersion(query.version);
    if (query.snapshotId !== undefined && (!Number.isSafeInteger(query.snapshotId) || query.snapshotId < 1)) throw new TypeError("snapshotId must be a positive integer");
    const candidates = this.store.listCharacters(query.version).filter((character) => character.name.toLowerCase() === query.name.toLowerCase() && (!query.realm || character.realm === query.realm));
    if (candidates.length === 0) return { status: "NOT_FOUND", version: query.version, name: query.name, ...(query.realm ? { realm: query.realm } : {}) };
    if (candidates.length > 1) return { status: "AMBIGUOUS", version: query.version, name: query.name, candidates: candidates.map(({ identityKey, realm, name }) => ({ identityKey, realm, name })) };
    const character = candidates[0]!;
    const snapshots = this.store.listSnapshots(character.identityKey);
    const snapshot = query.snapshotId === undefined ? snapshots[0] : snapshots.find((entry) => entry.id === query.snapshotId);
    if (query.snapshotId !== undefined && !snapshot) throw new TypeError("snapshotId must belong to the resolved character in the requested WoW version");
    return { status: "FOUND", value: build(character, snapshot) };
  }

  private resolveSection<T extends EquipmentSection | ProfessionsSection>(query: CharacterQuery, section: "equipment" | "professions"): CharacterResolution<ReadValue<T>> {
    return this.resolve(query, (character, snapshot) => {
      if (!snapshot) return { provenance: { state: "UNKNOWN", version: query.version, identityKey: character.identityKey, reason: "No snapshot exists for this character." } };
      const value = snapshot.parsed[section] as T;
      const state = statusToReadState(value.status.state);
      return { ...(state === "UNKNOWN" ? {} : { data: value }), provenance: { state, version: query.version, identityKey: character.identityKey, observedAt: value.status.observedAt ?? snapshot.generatedAt ?? snapshot.importedAt, importedAt: snapshot.importedAt, snapshotId: snapshot.id, source: "WOWSYNC v1 snapshot", ...(state === "UNKNOWN" ? { reason: value.status.reason ?? "This section was not captured." } : {}), ...(state === "LAST_SEEN" ? { warning: "This section is historical and not a current observation." } : {}) } };
    });
  }
}

/** Compile-time reminder that no implicit Retail default can enter this API. */
export const READ_MODEL_VERSIONS: readonly VersionOrUnknown[] = [...WOW_VERSIONS, "unknown-version"];
