// Focused, provider-neutral, read-only domain queries. This layer calls the
// SnapshotStore directly; it is intentionally not an HTTP wrapper and has no
// provider, filesystem, SQL, or mutation primitive in its public API.
import { extractForeverTrainerVisit, type ForeverTrainerVisit } from "./foreverTrainer.ts";
import { extractForeverClassSpells, extractForeverRecipeCaptureIssue, extractForeverReputationDomain, extractForeverSkillLines, extractForeverTalents, type ForeverClassSpells, type ForeverSkillLines, type ForeverTalent, type ForeverTalents } from "./foreverSkills.ts";
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
import { buildForeverQuestObservation, buildQuestObservation, type ForeverQuestObservation } from "./foreverQuests.ts";
import { buildClassicReputationView, buildClassicTalentView, type ClassicReputationView, type ClassicTalentView } from "./classicProgression.ts";
import { isClassicVersion } from "./classicState.ts";
import { buildForeverCraftedUpgradeAssessment, type ForeverCraftedUpgradeAssessment } from "./foreverCraftedUpgrades.ts";
import { resolveRecipeEvidence, supportsRecipeCapture } from "./recipeEvidence.ts";
import { resolveSnapshotView } from "./snapshotEvidence.ts";
import { foreverBuildVerification, foreverCompatibility, isForeverClient, parseForeverProfile, supportsForeverGearEvaluation } from "./foreverProfile.ts";
import { findRecipeCrafters, knowledgeRows, matchesRecipeFilter, matchTrainerService, reagentAvailability, recipeRowIdentity, type CharacterHistory, type ReagentAvailabilityView, type RecipeCraftersResult, type RecipeFilter, type RecipeKnowledgeRow } from "./recipeIntelligence.ts";
import { assessForeverEligibility, assessForeverSuitability, calibrateForeverStatDelta, classifyForeverRecordedUpgrade, compareForeverStatTables, evaluateForeverSlotCompatibility, type ForeverGearAssessmentEvaluation, type ForeverSlotEvidence, type ForeverStatTable } from "./foreverGearEvaluation.ts";
import { assessForeverBinding, combineForeverEligibility, evaluateForeverArmorProficiency, evaluateForeverExplicitClassRestriction, evaluateForeverRecipientFit, evaluateForeverWeaponProficiency } from "./foreverGearRules.ts";
import { marketPrice } from "./foreverPrices.ts";
import { eligibleMailRecipients, orderMailPlanSteps, routeMaterial as routeMailMaterial, routePouch } from "./foreverMailRouting.ts";
import { deriveForeverSpec, foreverSpecProjection } from "./foreverSpec.ts";

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
export interface CharacterQuestQuery extends CharacterSnapshotQuery { completedQuestIDs?: number[] }
export interface CharacterProgressionQuery extends CharacterSnapshotQuery { factionQuery?: string; includeTalents?: boolean }
/** One recipe chosen by exactly one identity: recipeID (Retail/Forever), recipeKey (Classic), outputItemID, enchantID, or exact name. */
export interface RecipeSelector { recipeID?: number; recipeKey?: string; outputItemID?: number; enchantID?: number; recipeName?: string }
export interface CharacterSpellsQuery extends CharacterSnapshotQuery { query?: string; offset?: number; limit?: number }
export interface CharacterTrainerQuery extends CharacterSnapshotQuery { category?: string; query?: string; status?: "known" | "available" | "unavailable" | "other"; offset?: number; limit?: number }
export interface AccountChangesQuery { version: VersionOrUnknown; realm?: string; offset?: number; limit?: number }

/** Optional process-configured identityKey -> planned spec map; malformed config stays empty. */
const plannedSpecConfig = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.FOREVER_PLANNED_SPECS;
function plannedSpecsFromConfig(): Readonly<Record<string, string>> {
  if (!plannedSpecConfig) return Object.freeze({});
  try {
    const parsed = JSON.parse(plannedSpecConfig) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return Object.freeze({});
    return Object.freeze(Object.fromEntries(Object.entries(parsed).filter(([key, value]) => key.trim() && typeof value === "string" && value.trim()).map(([key, value]) => [key, (value as string).trim()])));
  } catch { return Object.freeze({}); }
}
export const FOREVER_PLANNED_SPECS = plannedSpecsFromConfig();

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
  if (!supportsForeverGearEvaluation((evidence as { clientProfile?: unknown }).clientProfile)) return false;
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
  services: Array<{ category: string; categoryState: SectionState; observedAt?: number; freshness: "recent" | "stale" | "unknown"; spellID?: string; ability?: string; rank?: string; statusAtVisit?: string; requiredLevel?: string; costCopper?: number; requirementsAtVisit?: string ; recipeMatch?: import("./recipeIntelligence.ts").TrainerRecipeMatch }>;
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
  identity: { version: VersionOrUnknown; identityKey: string; name: string; realm: string; class?: string; faction?: string; level?: number; clientVersion?: string; clientBuild?: string; interface?: string };
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
  /**
   * Which structured (SavedVariables) observation domains exist for this character and how current each is.
   * Domains a version does not capture are omitted; UNKNOWN means not captured, never empty.
   */
  structuredObservations?: {
    clientCompatibility?: ReturnType<typeof foreverCompatibility>;
    recipes?: { state: ReadState; sourceSnapshotId?: number; professions?: string[] };
    quests?: { state: ReadState; observedAt?: number; sourceSnapshotId?: number };
    reputation?: { state: ReadState; observedAt?: number; sourceSnapshotId?: number };
    talents?: { state: ReadState; observedAt?: number; sourceSnapshotId?: number };
  };
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
  private readonly charactersByVersion = new Map<VersionOrUnknown, StoredCharacterSummary[]>();
  private readonly snapshotsByIdentity = new Map<string, StoredSnapshot[]>();
  constructor(store: SnapshotReadStore, now: () => number = () => Math.floor(Date.now() / 1000)) {
    this.store = store;
    this.now = now;
  }

  listVersions(): VersionSummary[] { return this.store.listVersions(); }
  listCharacters(query: { version: VersionOrUnknown; realm?: string }): StoredCharacterSummary[] {
    requireVersion(query.version);
    return this.characters(query.version).filter((character) => !query.realm || character.realm === query.realm);
  }

  /** Read caches live only as long as this request-scoped model instance. */
  private characters(version: VersionOrUnknown): StoredCharacterSummary[] {
    let characters = this.charactersByVersion.get(version);
    if (!characters) {
      characters = this.store.listCharacters(version);
      this.charactersByVersion.set(version, characters);
    }
    return characters;
  }

  private snapshots(identityKey: string): StoredSnapshot[] {
    let snapshots = this.snapshotsByIdentity.get(identityKey);
    if (!snapshots) {
      snapshots = this.store.listSnapshots(identityKey);
      this.snapshotsByIdentity.set(identityKey, snapshots);
    }
    return snapshots;
  }

  /** Durable planning intent plus a fresh evidence projection from each explicitly named character only. */
  getErpProjects(query: { version: VersionOrUnknown }): ErpProjectView[] {
    requireVersion(query.version);
    const projects = this.store.listErpProjects(query.version);
    const currencies = this.store.listVersionCurrencies(query.version);
    const candidateSources = this.characters(query.version);
    const needsSharedStorage = query.version === "retail" && projects.some((project) => project.needs.some((need) => need.sourceOwnerKey !== undefined));
    const sharedStorage = needsSharedStorage ? this.store.projectSharedStorage() : undefined;
    const needsSharedHistory = query.version === "retail" && projects.some((project) => project.needs.some((need) => need.sourceOwnerKey !== undefined) || project.workOrders.some((order) => order.kind === "RETRIEVE" && order.resourceNeedIds.some((needId) => project.needs.some((need) => need.stableId === needId && need.sourceOwnerKey !== undefined))));
    const sharedJournal = needsSharedHistory ? this.store.loadSharedJournal() : undefined;
    return projects.map((project) => {
      const historyEventCount = this.store.countErpProjectHistory(project.stableId);
      const history = this.store.listErpProjectHistory(project.stableId, 50);
      return {
        ...evaluateErpProject(project, (identityKey) => this.snapshots(identityKey), projects, this.now(), currencies, sharedStorage, candidateSources, sharedJournal, (identityKey, snapshotId) => this.store.getCharacterCurrenciesForSnapshot(identityKey, snapshotId)),
        history, historyEventCount, historyTruncated: historyEventCount > history.length,
      };
    });
  }

  /** Snapshot-scoped Retail candidate evidence; this is not an inventory, allocation, or gear-policy projection. */
  getGearCandidateEvidence(query: { version: VersionOrUnknown; offset?: number; limit?: number }): ReadValue<GearCandidateEvidenceRead> {
    requireVersion(query.version);
    if (query.version !== "retail") return { provenance: { state: "UNKNOWN", version: query.version, reason: "Gear Candidates ContractVersion 1 is Retail-only." } };
    const characters: GearCandidateEvidenceRead["characters"] = this.characters("retail").map((character) => {
      const snapshots = this.snapshots(character.identityKey);
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
    const exporter = this.characters("retail").find((c) => c.identityKey === query.exporterIdentityKey);
    if (!exporter) return { status: "EXPORTER_NOT_FOUND" as const };
    const snapshot = this.snapshots(exporter.identityKey).find((s) => s.id === query.snapshotId);
    const section = snapshot?.parsed.gearCandidates;
    if (!section) return { status: "CANDIDATE_EVIDENCE_NOT_FOUND" as const, reason: "The selected source snapshot does not contain Retail [GEAR CANDIDATES] evidence." };
    const candidate = section.rows[query.rowOrdinal - 1];
    if (!candidate) return { status: "CANDIDATE_ROW_NOT_FOUND" as const };
    const characters = this.characters("retail").map((c) => {
      const latest = this.snapshots(c.identityKey)[0];
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

    const resolveExact = (name: string, realm: string) => this.characters("retail").filter((character) =>
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
    const exporterSnapshots = this.snapshots(exporter.identityKey);
    const candidateSnapshot = exporterSnapshots.find((snapshot) => snapshot.parsed.gearCandidates !== undefined);
    const recipientSnapshot = this.snapshots(recipient.identityKey)[0];
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
    const characters = this.characters(query.version).filter((character) => !realmScoped || character.realm === query.realm);
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
        identity: { version: query.version, identityKey: character.identityKey, name: character.name, realm: character.realm, ...(parsed.character.class ? { class: parsed.character.class } : {}), ...(parsed.character.faction ? { faction: parsed.character.faction } : {}), ...(parsed.character.level !== undefined ? { level: parsed.character.level } : {}), ...(parsed.character.clientVersion !== undefined ? { clientVersion: parsed.character.clientVersion } : {}), ...(parsed.character.clientBuild !== undefined ? { clientBuild: parsed.character.clientBuild } : {}), ...(parsed.character.interface !== undefined ? { interface: parsed.character.interface } : {}) },
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
        ...this.structuredObservations(query.version, character.identityKey, snapshot),
      }, provenance: sectionProvenance("OBSERVED", observedAt) };
    });
  }

  private structuredObservations(version: VersionOrUnknown, identityKey: string, snapshot: StoredSnapshot): Pick<CharacterCurrentState, "structuredObservations"> {
    const out: NonNullable<CharacterCurrentState["structuredObservations"]> = {};
    if (version === "forever" && isForeverClient(snapshot.parsed.character)) out.clientCompatibility = foreverCompatibility(snapshot.parsed.character);
    if (supportsRecipeCapture(version)) {
      const resolution = resolveRecipeEvidence(version, this.snapshots(identityKey), snapshot);
      const professions = Array.isArray((resolution.section?.data as Record<string, unknown> | undefined)?.professions) ? ((resolution.section!.data as Record<string, unknown>).professions as Record<string, unknown>[]).map((row) => typeof row.professionName === "string" ? row.professionName : typeof row.name === "string" ? row.name : undefined).filter((name): name is string => !!name) : [];
      out.recipes = { state: resolution.state, ...(resolution.sourceSnapshotId !== undefined ? { sourceSnapshotId: resolution.sourceSnapshotId } : {}), ...(professions.length ? { professions } : {}) };
    }
    if (isClassicVersion(version)) {
      const state = snapshot.parsed.characterState?.clientFamily === "Classic" ? snapshot.parsed.characterState : undefined;
      const summarize = (domain: CapturedCharacterState["quests"]) => domain ? { state: statusToReadState(domain.status.state), ...(domain.observedAt !== undefined ? { observedAt: domain.observedAt } : {}), ...(domain.status.carriedFromSnapshotId !== undefined ? { sourceSnapshotId: domain.status.carriedFromSnapshotId } : {}) } : { state: "UNKNOWN" as const };
      out.quests = summarize(state?.quests);
      out.reputation = summarize(state?.reputation?.character);
      out.talents = summarize(state?.talents);
    }
    return Object.keys(out).length ? { structuredObservations: out } : {};
  }

  getCharacterEquipment(query: CharacterQuery): CharacterResolution<ReadValue<EquipmentSection>> {
    return this.resolveSection(query, "equipment");
  }

  getForeverGearObservation(query: CharacterQuery): CharacterResolution<ReadValue<ReturnType<typeof buildForeverGearObservation>>> {
    requireVersion(query.version);
    if (query.version !== "forever") return { status: "FOUND", value: { provenance: { state: "UNKNOWN", version: query.version, reason: "Forever gear observations are isolated to Forever 1.60.1 profiles." } } };
    return this.resolve(query, (character, snapshot) => {
      if (!snapshot) return { provenance: { state: "UNKNOWN", version: "forever", identityKey: character.identityKey, reason: "No Forever snapshot exists for this character." } };
      const profile = snapshot.parsed.character;
      if (!isForeverClient(profile)) {
        return { provenance: { state: "UNKNOWN", version: "forever", identityKey: character.identityKey, snapshotId: snapshot.id, source: "WOWSYNC v1 character profile", reason: "This observation view requires a well-formed Forever client profile (family, version, build, interface)." } };
      }
      const snapshots = this.snapshots(character.identityKey);
      const latestObservation = snapshot.parsed.foreverGearObservation;
      const latestGuid = latestObservation?.sourceCharacterGuid;
      const hasGuidConflict = snapshots.some((entry) => entry.parsed.foreverGearObservation?.sourceCharacterGuidConflict);
      const distinctGuids = new Set(snapshots.map((entry) => entry.parsed.foreverGearObservation?.sourceCharacterGuid).filter((guid): guid is string => !!guid));
      const identityIssue = hasGuidConflict
        ? "A Forever snapshot contains a WoWSyncDB character GUID conflict marker; source-character identity cannot be resolved safely."
        : !latestGuid
          ? "The latest Forever snapshot has no WoWSyncDB character GUID; its current source character cannot be resolved safely."
          : distinctGuids.size > 1
            ? "Forever snapshot history contains differing WoWSyncDB character GUIDs; source-character identity cannot be resolved safely."
            : undefined;
      if (identityIssue) return { provenance: { state: "UNKNOWN", version: "forever", identityKey: character.identityKey, snapshotId: snapshot.id, reason: identityIssue } };
      const data = buildForeverGearObservation({
        identity: { version: "forever", identityKey: character.identityKey, name: character.name, ...(character.surname ? { surname: character.surname } : {}), ...(character.surnameSource ? { surnameSource: character.surnameSource } : {}), realm: character.realm },
        snapshotId: snapshot.id, generatedAt: snapshot.generatedAt, importedAt: snapshot.importedAt,
        equipment: snapshot.parsed.equipment, bags: snapshot.parsed.bags, bank: snapshot.parsed.bank,
        structured: snapshot.parsed.foreverGearObservation,
        now: this.now(),
      });
      const observedAt = snapshot.parsed.foreverGearObservation?.generatedAt ?? snapshot.generatedAt ?? snapshot.importedAt;
      return { data, provenance: { state: "DERIVED", version: "forever", identityKey: character.identityKey, observedAt, importedAt: snapshot.importedAt, snapshotId: snapshot.id, freshness: classifyFreshness(observedAt, this.now()), source: snapshot.parsed.foreverGearObservation ? `Forever WoWSyncDB structured sections (${snapshot.parsed.foreverGearObservation.clientProfile}) plus WOWSYNC v1 export` : "WOWSYNC v1 export; structured WoWSyncDB section timestamps unavailable", reason: snapshot.parsed.foreverGearObservation ? undefined : "Structured Forever section sidecar was not available for this imported snapshot." } };
    });
  }

  getForeverQuestObservation(query: CharacterSnapshotQuery): CharacterResolution<ReadValue<ForeverQuestObservation>> {
    if (query.version !== "forever") return { status: "FOUND", value: { provenance: { state: "UNKNOWN", version: query.version, reason: "Quest observations are isolated to Forever 1.60.1 build 70291 or 70338 / interface 16001." } } };
    return this.resolveSelectedSnapshot(query, (character, snapshot) => {
      const identity = { identityKey: character.identityKey, name: character.name, realm: character.realm };
      if (!snapshot) return { data: buildForeverQuestObservation({ identity, profile: "UNKNOWN", now: this.now() }), provenance: { state: "UNKNOWN", version: "forever", identityKey: character.identityKey, reason: "No Forever snapshot exists for this character." } };

      const profile = snapshot.parsed.character;
      const allowed = isForeverClient(profile);
      const structured = snapshot.parsed.foreverGearObservation;
      const structuredIdentityMatches = structured !== undefined
        && structured.name.toLocaleLowerCase() === character.name.toLocaleLowerCase()
        && structured.realm.toLocaleLowerCase() === character.realm.toLocaleLowerCase()
        && structured.generatedAt === snapshot.generatedAt;
      const section = allowed && structuredIdentityMatches ? structured?.quests : undefined;
      const observation = buildForeverQuestObservation({
        section,
        profile: allowed && structuredIdentityMatches ? structured!.clientProfile : "UNKNOWN",
        identity,
        now: this.now(),
      });
      const state = observation.state;
      const observedAt = observation.observedAt;
      return {
        data: observation,
        provenance: {
          state,
          version: "forever",
          identityKey: character.identityKey,
          ...(observedAt !== undefined ? { observedAt } : {}),
          importedAt: snapshot.importedAt,
          snapshotId: snapshot.id,
          freshness: observation.freshness,
          source: "Forever C_QuestLog quest observation sidecar",
          ...(!allowed ? { reason: "This observation view requires a well-formed Forever client profile." }
            : !structuredIdentityMatches ? { reason: "The persisted Forever sidecar identity or export generation does not match the canonical character snapshot." }
            : observation.reason ? { reason: observation.reason } : {}),
          ...(state === "LAST_SEEN" ? { warning: "Quest values are historical and are not a current observation." } : {}),
        },
      };
    });
  }

  getForeverCraftedUpgradeAssessment(query: CharacterSnapshotQuery): CharacterResolution<ReadValue<ForeverCraftedUpgradeAssessment>> {
    requireVersion(query.version);
    if (query.version !== "forever") return { status: "FOUND", value: { provenance: { state: "UNKNOWN", version: query.version, reason: "Crafted-equipment assessments are isolated to Forever snapshots." } } };
    return this.resolveSelectedSnapshot(query, (character, snapshot) => {
      if (!snapshot) return { provenance: { state: "UNKNOWN", version: "forever", identityKey: character.identityKey, reason: "No Forever snapshot exists for this character." } };
      const profile = snapshot.parsed.character;
      if (!isForeverClient(profile)) {
        return { provenance: { state: "UNKNOWN", version: "forever", identityKey: character.identityKey, snapshotId: snapshot.id, reason: "This assessment requires a well-formed Forever client profile (family, version, build, interface)." } };
      }
      const recipeEvidence = resolveRecipeEvidence("forever", this.snapshots(character.identityKey), snapshot);
      if (!snapshot.parsed.foreverGearObservation && recipeEvidence.state === "UNKNOWN") return { provenance: { state: "UNKNOWN", version: "forever", identityKey: character.identityKey, snapshotId: snapshot.id, reason: `This snapshot has no structured Forever item evidence sidecar, and no compatible recipe observation was found. ${recipeEvidence.reason}` } };
      const data = buildForeverCraftedUpgradeAssessment({ identity: { identityKey: character.identityKey, name: character.name, ...(character.surname ? { surname: character.surname } : {}), realm: character.realm }, snapshot, now: this.now(), recipeEvidence });
      const observedAt = snapshot.generatedAt ?? recipeEvidence.observedAt;
      return { data, provenance: { state: "DERIVED", version: "forever", identityKey: character.identityKey, ...(observedAt !== undefined ? { observedAt, freshness: classifyFreshness(observedAt, this.now()) } : {}), importedAt: snapshot.importedAt, snapshotId: snapshot.id, source: recipeEvidence.state === "LAST_SEEN" ? `Forever snapshot ${snapshot.id} equipment/bags/item evidence combined with LAST_SEEN learned recipes from snapshot ${recipeEvidence.sourceSnapshotId}` : "Forever canonical versioned snapshot, learned-recipe sidecar, equipped slots, and exact item API evidence", reason: "Each fact keeps its own provenance: recipe knowledge may be LAST_SEEN from an earlier compatible snapshot; equipment, bags, and item stats come only from the selected snapshot. The historical gear GUID guard is not weakened. Missing or mismatched evidence remains UNKNOWN." } };
    });
  }

  /**
   * Evidence-first cross-character Forever evaluation. Candidate rows retain
   * their observed carrier; Dashboard import-context membership is never
   * promoted into account ownership or transfer access.
   */
  getForeverGearAllocation(query: CharacterQuery): CharacterResolution<ReadValue<{
    version: "forever";
    ruleset: "forever-min-70291-allocation-screen-v3";
    buildVerification: "VERIFIED" | "UNVERIFIED_BUILD";
    clientBuild?: number;
    scope: { accountMembership: "UNKNOWN"; reason: string };
    recipient: { identityKey: string; name: string; surname?: string; realm: string; snapshotId?: number; observedAt?: number; freshness: "recent" | "stale" | "unknown"; buildVerification: "VERIFIED" | "UNVERIFIED_BUILD"; class?: { value: string; provenance: "OBSERVED" | "LAST_SEEN"; observedAt?: number; source: string }; level?: { value: number; provenance: "OBSERVED" | "LAST_SEEN"; observedAt?: number; source: string }; observedSkillLines: Array<{ name: string; rank?: number; maxRank?: number; rawCategoryID?: number; observedAt?: number; provenance: "OBSERVED" | "LAST_SEEN" | "UNKNOWN" }>; equipment: ReturnType<typeof buildForeverGearObservation>["equipment"] };
    candidateSources: Array<{ source: { identityKey: string; name: string; surname?: string; realm: string }; observationState: string; buildVerification: "VERIFIED" | "UNVERIFIED_BUILD"; observedAt?: number; freshness?: string; carried: { state: string; observedAt?: number; freshness?: string; itemCount?: number }; carriedItems: ReturnType<typeof buildForeverGearObservation>["carried"]["items"]; bank: { state: string; observedAt?: number; freshness?: string; reason?: string; items?: ReturnType<typeof buildForeverGearObservation>["bank"]["items"] }; candidates: ReturnType<typeof buildForeverGearObservation>["evaluationCandidates"]["items"]; unclassifiedItems: ReturnType<typeof buildForeverGearObservation>["evaluationCandidates"]["unclassifiedItems"]; carriedBuckets: ReturnType<typeof buildForeverGearObservation>["evaluationCandidates"]["carriedBuckets"] }>;
    assessments: Array<ForeverGearAssessmentEvaluation & { buildVerification: "VERIFIED" | "UNVERIFIED_BUILD"; confidenceQualifier: "STANDARD" | "LOWERED_UNVERIFIED_BUILD"; candidate: ReturnType<typeof buildForeverGearObservation>["evaluationCandidates"]["items"][number]; source: { identityKey: string; name: string; surname?: string; realm: string }; recipient: { identityKey: string; name: string; surname?: string; realm: string }; eligibilityAssessment: ReturnType<typeof combineForeverEligibility> }>;
    recipientEvaluations: Array<{ source: { identityKey: string; name: string; surname?: string; realm: string }; itemRef?: string; recipients: Array<{ identityKey: string; name: string; surname?: string; realm: string; eligibility: string; armorProficiency: string; slotCompatibility: string; upgradeStatus: string; transferability: string; fit: "EXCLUDED" | "LOCAL_REVIEW" | "POTENTIAL_GEAR_FIT" | "UNRANKED"; reasons: string[] }> }>;
    allocationPlan: Array<{ disposition: "EQUIP_CANDIDATE" | "KEEP" | "POSSIBLE_OTHER_CHARACTER" | "NOT_AN_UPGRADE_ON_OBSERVED_METRICS" | "INSUFFICIENT_EVIDENCE"; item: { name?: string; itemRef?: string; itemIdentity?: string }; source: { identityKey: string; name: string; surname?: string; realm: string; location: "CARRIED_INVENTORY" | "EQUIPPED" | "UNKNOWN"; provenance: "OBSERVED" | "LAST_SEEN" | "UNKNOWN"; observedAt?: number; freshness: string }; recipient: { identityKey: string; name: string; surname?: string; realm: string }; comparison?: { upgradeStatus: string; confidence: string; rawComparisons: ForeverGearAssessmentEvaluation["rawStatComparisons"] }; evidence: { provenance: "DERIVED" | "HYPOTHESIS" | "UNKNOWN"; eligibility: string; suitability: string; transferability: string; confidence: "LIMITED" | "UNKNOWN"; reasons: string[]; whatWouldChange: string[] } }>;
    exclusions: Array<{ character: { identityKey: string; name: string; surname?: string; realm: string }; state: string; reason: string }>;
    conclusion: "LOCAL_REVIEW_CANDIDATE_AVAILABLE" | "INSUFFICIENT_EVIDENCE";
    reason: string;
  }>> {
    if (query.version !== "forever") return { status: "FOUND", value: { provenance: { state: "UNKNOWN", version: query.version, reason: "Forever allocation accepts Forever 1.60.1 profiles at or above build 70291; no other version rules are applied." } } };
    const resolved = this.getForeverGearObservation(query);
    if (resolved.status !== "FOUND") return resolved;
    if (!resolved.value.data) return { status: "FOUND", value: { provenance: { ...resolved.value.provenance, state: "UNKNOWN", reason: resolved.value.provenance.reason ?? "The recipient has no safely resolved Forever observation at or above the build 70291 gear-screen intake floor; allocation cannot be evaluated." } } };
    const recipientData = resolved.value.data;
    const recipientCharacter = this.characters("forever").find((c) => c.identityKey === recipientData.identity.identityKey);
    if (!recipientCharacter) return { status: "NOT_FOUND", version: "forever", name: query.name, ...(query.realm ? { realm: query.realm } : {}) };
    const recipientSnapshot = this.snapshots(recipientCharacter.identityKey)[0];
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
      buildVerification: recipientData.snapshot.buildVerification,
      ...(profile && profile.status.state !== "UNKNOWN" && profile.class ? { class: { value: profile.class, provenance: profileState, ...(profile.status.observedAt !== undefined ? { observedAt: profile.status.observedAt } : {}), source: "WOWSYNC v1 CHARACTER field" } } : {}),
      ...(profile && profile.status.state !== "UNKNOWN" && profile.level !== undefined ? { level: { value: profile.level, provenance: profileState, ...(profile.status.observedAt !== undefined ? { observedAt: profile.status.observedAt } : {}), source: "WOWSYNC v1 CHARACTER field" } } : {}),
      observedSkillLines,
      equipment: recipientData.equipment,
    };
    const candidateSources: Array<{ source: { identityKey: string; name: string; surname?: string; realm: string }; observationState: string; buildVerification: "VERIFIED" | "UNVERIFIED_BUILD"; observedAt?: number; freshness?: string; carried: { state: string; observedAt?: number; freshness?: string; itemCount?: number }; carriedItems: ReturnType<typeof buildForeverGearObservation>["carried"]["items"]; bank: { state: string; observedAt?: number; freshness?: string; reason?: string; items?: ReturnType<typeof buildForeverGearObservation>["bank"]["items"] }; candidates: ReturnType<typeof buildForeverGearObservation>["evaluationCandidates"]["items"]; unclassifiedItems: ReturnType<typeof buildForeverGearObservation>["evaluationCandidates"]["unclassifiedItems"]; carriedBuckets: ReturnType<typeof buildForeverGearObservation>["evaluationCandidates"]["carriedBuckets"] }> = [];
    const exclusions: Array<{ character: { identityKey: string; name: string; surname?: string; realm: string }; state: string; reason: string }> = [];
    for (const sourceCharacter of this.characters("forever")) {
      const observation = this.getForeverGearObservation({ version: "forever", name: sourceCharacter.name, realm: sourceCharacter.realm });
      if (observation.status !== "FOUND" || !observation.value.data) {
        exclusions.push({ character: { identityKey: sourceCharacter.identityKey, name: sourceCharacter.name, ...(sourceCharacter.surname ? { surname: sourceCharacter.surname } : {}), realm: sourceCharacter.realm }, state: observation.status, reason: observation.status === "FOUND" ? observation.value.provenance.reason ?? "Observation data unavailable." : "Source identity or supported Forever gear evidence could not be safely resolved." });
        continue;
      }
      candidateSources.push({ source: { identityKey: sourceCharacter.identityKey, name: sourceCharacter.name, ...(sourceCharacter.surname ? { surname: sourceCharacter.surname } : {}), realm: sourceCharacter.realm }, observationState: observation.value.data.evaluationCandidates.state, buildVerification: observation.value.data.snapshot.buildVerification,
        ...(observation.value.data.evaluationCandidates.observedAt !== undefined ? { observedAt: observation.value.data.evaluationCandidates.observedAt, freshness: observation.value.data.evaluationCandidates.freshness } : {}),
        carried: { state: observation.value.data.carried.state, ...(observation.value.data.carried.observedAt !== undefined ? { observedAt: observation.value.data.carried.observedAt, freshness: observation.value.data.carried.freshness } : {}), ...(observation.value.data.carried.items !== undefined ? { itemCount: observation.value.data.carried.items.length } : {}) },
        carriedItems: observation.value.data.carried.items, bank: { state: observation.value.data.bank.state, ...(observation.value.data.bank.observedAt !== undefined ? { observedAt: observation.value.data.bank.observedAt, freshness: observation.value.data.bank.freshness } : {}), ...(observation.value.data.bank.reason ? { reason: observation.value.data.bank.reason } : {}), ...(observation.value.data.bank.items ? { items: observation.value.data.bank.items } : {}) },
        candidates: observation.value.data.evaluationCandidates.items, unclassifiedItems: observation.value.data.evaluationCandidates.unclassifiedItems, carriedBuckets: observation.value.data.evaluationCandidates.carriedBuckets });
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
        buildVerification: candidate.itemApiEvidence.buildVerification === "VERIFIED" && recipientData.snapshot.buildVerification === "VERIFIED" ? "VERIFIED" as const : "UNVERIFIED_BUILD" as const,
        confidenceQualifier: candidate.itemApiEvidence.buildVerification === "VERIFIED" && recipientData.snapshot.buildVerification === "VERIFIED" ? "STANDARD" as const : "LOWERED_UNVERIFIED_BUILD" as const,
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
    const foreverRoster = this.characters("forever").flatMap((character) => {
      const resolvedObservation = this.getForeverGearObservation({ version: "forever", name: character.name, realm: character.realm });
      if (resolvedObservation.status !== "FOUND" || !resolvedObservation.value.data) return [];
      const snapshot = this.snapshots(character.identityKey)[0];
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
      data: { version: "forever", ruleset: "forever-min-70291-allocation-screen-v3", buildVerification: recipientData.snapshot.buildVerification, scope: { accountMembership: "UNKNOWN", reason: "Characters are drawn from the Dashboard Forever import context; exports do not include a validated WoW account ID. Candidate presence on another character is not ownership sharing or transfer access." }, recipient,
        candidateSources, assessments, recipientEvaluations, allocationPlan, exclusions,
        conclusion: assessments.some((assessment) => assessment.decision === "REVIEW_LOCAL_CANDIDATE") ? "LOCAL_REVIEW_CANDIDATE_AVAILABLE" : "INSUFFICIENT_EVIDENCE",
        reason: assessments.some((assessment) => assessment.decision === "REVIEW_LOCAL_CANDIDATE")
          ? "At least one source-local item has a current positive player API result and a limited structural or raw-stat signal. This review candidate is not a confirmed eligibility result, upgrade, or cross-character allocation."
          : assessments.length === 0 ? "No currently observed potential-equipment rows are available to assess; missing candidate data does not prove there is no useful equipment." : "Potential-equipment rows were found, but the evidence does not support a source-local equip candidate or cross-character recommendation." },
      provenance: { state: "DERIVED", version: "forever", identityKey: recipient.identityKey, ...(observedAt !== undefined ? { observedAt, freshness: classifyFreshness(observedAt, this.now()) } : {}), snapshotId: recipientSnapshot?.id, source: "Forever build-qualified observations from the Dashboard import context", reason: "No Retail rules are used; unresolved evidence remains UNKNOWN." },
    } };
  }

  /** A mailbox errand projection over the canonical Forever gear evaluator. */
  getForeverMailPlan(query: CharacterQuery, config: { holdItemIds?: readonly number[]; vendorPrices?: Readonly<Record<number, number>> } = {}) {
    if (query.version !== "forever") return { status: "FOUND" as const, value: { provenance: { state: "UNKNOWN" as const, version: query.version, reason: "Mail planning is isolated to Forever 1.60.1 snapshots at or above build 70291." } } };
    const base = this.getForeverGearAllocation(query);
    if (base.status !== "FOUND" || !base.value.data) return base;
    const data = base.value.data;
    const sourceCharacter = this.characters("forever").find((c) => c.identityKey === data.recipient.identityKey);
    if (!sourceCharacter) return { status: "NOT_FOUND" as const, version: "forever" as const, name: query.name, ...(query.realm ? { realm: query.realm } : {}) };
    const source = data.candidateSources.find((row) => row.source.identityKey === sourceCharacter.identityKey);
    const sameRealmFaction = eligibleMailRecipients(sourceCharacter, this.characters("forever"));
    const mail: Array<Record<string, unknown>> = [];
    const keep: Array<Record<string, unknown>> = [];
    const noRecipient: Array<Record<string, unknown>> = [];
    const unknownReasons: string[] = [];
    const holdItemIds = new Set(config.holdItemIds ?? []);
    const materialMail: Array<Record<string, unknown>> = [];
    const pouchMail: Array<Record<string, unknown>> = [];
    const sale: Array<Record<string, unknown>> = [];
    if (!source || source.carried.state !== "OBSERVED" || source.carried.freshness !== "recent") unknownReasons.push(source?.carried.state === "UNKNOWN" ? `The latest bag scan failed; prior bag rows are LAST_SEEN${source.carried.observedAt !== undefined ? ` at ${new Date(source.carried.observedAt * 1000).toISOString()}` : " with time UNKNOWN"}. Character snapshot freshness is separate.` : "Current character bags are not freshly OBSERVED; item presence and quantity are UNKNOWN.");
    const screenedRecipients: Array<Record<string, unknown>> = sameRealmFaction.map((character) => {
      const snap = this.snapshots(character.identityKey)[0];
      const obsAt = snap?.generatedAt ?? snap?.importedAt;
      const freshness = obsAt === undefined ? "unknown" : classifyFreshness(obsAt, this.now());
      const allocation = this.getForeverGearAllocation({ version: "forever", name: character.name, realm: character.realm });
      const profile = snap?.parsed.character;
      const status = allocation.status === "FOUND" && allocation.value.data ? "SCREENED" : allocation.status;
      const reason = status === "SCREENED" ? "Recipient reached the supported Forever gear screening; item-specific checks are recorded per candidate." : allocation.status === "FOUND" ? allocation.value.provenance.reason ?? "Recipient evaluation data is UNKNOWN." : "Recipient snapshot or supported gear evidence could not be resolved.";
      return { name: character.name, class: profile?.class ?? "UNKNOWN", level: profile?.level ?? "UNKNOWN", faction: character.faction ?? "UNKNOWN", snapshotId: snap?.id ?? "UNKNOWN", freshness, evaluation: { status, reason } };
    });
    const materialUsers = [sourceCharacter, ...sameRealmFaction];
    const recipientProfessions = materialUsers.map((character) => {
      const professions = this.getCharacterProfessions({ version: "forever", name: character.name, realm: character.realm });
      const observed = professions.status === "FOUND" && professions.value.provenance.state === "OBSERVED";
      const knowledge = professions.status === "FOUND" ? professions.value.data?.recipeKnowledge as any : undefined;
      const groups = knowledge?.data?.professions ?? [];
      const reagentProfessions = groups.flatMap((group: any) => (group.recipes ?? [])
        .filter((recipe: any) => ["OBSERVED", "LAST_SEEN"].includes(recipe.evidence ?? group.evidence))
        .flatMap((recipe: any) => (recipe.reagentSlots ?? []).filter((slot: any) => slot.required !== false)
          .flatMap((slot: any) => slot.alternatives ?? slot.reagents ?? [])
          .filter((reagent: any) => typeof reagent.itemID === "number")
          .map((reagent: any) => ({ itemId: reagent.itemID as number, profession: String(group.professionName ?? group.name ?? "UNKNOWN profession"), evidence: (recipe.evidence ?? group.evidence) as "OBSERVED" | "LAST_SEEN" }))));
      const observedReagentIds = reagentProfessions.filter((use: any) => use.evidence === "OBSERVED")
        .map((use: any) => use.itemId);
      const snap = this.snapshots(character.identityKey)[0];
      const bags = snap?.parsed.bags as any;
      const bagObservedAt = bags?.status?.observedAt ?? snap?.generatedAt ?? snap?.importedAt;
      const observedBagSlots = bags?.status?.state === "OBSERVED" && Number.isSafeInteger(bags.totalSlots)
        && classifyFreshness(bagObservedAt, this.now()) === "recent" ? bags.totalSlots as number : undefined;
      const recipeKnowledgeComplete = professions.status === "FOUND"
        && professions.value.provenance.state === "OBSERVED"
        && knowledge?.completeness === "complete"
        && knowledge?.status?.state === "OBSERVED"
        && knowledge?.evidence?.state === "OBSERVED";
      const hasObservedProfessions = professions.status === "FOUND" && professions.value.provenance.state === "OBSERVED" && (professions.value.data?.entries.length ?? 0) > 0;
      return { character, professions, observed, professionEvidenceState: professions.status === "FOUND" ? professions.value.provenance.state : "UNKNOWN", observedReagentIds, reagentProfessions, recipeKnowledgeComplete, hasObservedProfessions, observedBagSlots };
    });
    const routeMaterial = (item: Record<string, any>) => {
      const itemId = typeof item.itemID === "number" ? item.itemID : typeof item.itemId === "number" ? item.itemId : item.itemRef ? itemIdFromItemRef(item.itemRef) : undefined;
      const ah = marketPrice(itemId, sourceCharacter.realm, sourceCharacter.faction);
      const vendor = itemId === undefined ? undefined : config.vendorPrices?.[itemId];
      const routed = routeMailMaterial({ ...item, itemId }, recipientProfessions.map((row) => ({
        identityKey: row.character.identityKey, name: row.character.name, realm: row.character.realm, faction: row.character.faction,
        professionsState: row.professionEvidenceState, observedReagentIds: row.observedReagentIds, reagentProfessions: row.reagentProfessions,
        recipeKnowledgeComplete: row.recipeKnowledgeComplete, hasObservedProfessions: row.hasObservedProfessions, observedBagSlots: row.observedBagSlots,
      })), { holderIdentityKey: sourceCharacter.identityKey, heldItemIds: holdItemIds, ahMedianUnitCopper: ah?.price.median7d ?? ah?.price.median, vendorUnitCopper: vendor });
      for (const action of routed) {
        const { disposition, ...details } = action;
        if (disposition === "MAIL_TO_CRAFTER") materialMail.push({ ...details, disposition });
        else if (disposition === "SELL_AH" || disposition === "VENDOR") sale.push({ ...details, disposition });
        else keep.push({ ...details, disposition });
      }
    };
    if (!sourceCharacter.faction) unknownReasons.push("Current character faction is UNKNOWN; cross-character mailbox eligibility cannot be scoped safely.");
    if (source?.bank.state !== "OBSERVED") unknownReasons.push(source?.bank.state === "LAST_SEEN"
      ? "Bank contents are LAST_SEEN and may have changed since the last visit."
      : source?.bank.reason ?? "Bank inventory is UNKNOWN; inaccessible is not empty.");
    for (const candidate of source?.candidates ?? []) {
      const item = { name: candidate.name ?? "UNKNOWN item", itemRef: candidate.itemRef, quantity: candidate.quantity };
      const candidateItemId = candidate.itemRef ? itemIdFromItemRef(candidate.itemRef) : undefined;
      if (candidateItemId !== undefined && holdItemIds.has(candidateItemId)) { keep.push({ item, disposition: "KEEP", reason: "on hold list" }); continue; }
      const candidateMetadata = candidateItemId === undefined ? undefined : this.store.getItemMetadata("forever", [candidateItemId])[0];
      const isContainer = (candidate as any).itemType === "Container"
        || (candidateMetadata?.classId.state === "KNOWN" && candidateMetadata.classId.value === 1);
      if (isContainer) {
        if (source?.carried.state !== "OBSERVED" || source.carried.freshness !== "recent" || candidate.provenance === "LAST_SEEN" || candidate.bound !== false) {
          noRecipient.push({ item, reason: candidate.bound === true ? "Observed bound container cannot be mailed to another character." : candidate.bound === undefined ? "Container binding is UNKNOWN; mail routing is withheld." : "Container observation is stale or not current; mail routing is withheld." });
          continue;
        }
        const routed = routePouch({ itemId: candidateItemId, itemRef: candidate.itemRef, name: candidate.name, quantity: candidate.quantity }, recipientProfessions
          .filter((entry) => entry.character.identityKey !== sourceCharacter.identityKey)
          .map((entry) => ({ identityKey: entry.character.identityKey, name: entry.character.name, realm: entry.character.realm, faction: entry.character.faction, professionsState: entry.professionEvidenceState, observedReagentIds: entry.observedReagentIds, observedBagSlots: entry.observedBagSlots })));
        if (routed.disposition === "POUCH_TO_ALT") pouchMail.push(routed);
        else keep.push(routed);
        continue;
      }
      if (source?.carried.state !== "OBSERVED" || source.carried.freshness !== "recent" || candidate.provenance === "LAST_SEEN" || candidate.bound !== false || !candidate.itemRef) {
        const reason = source?.carried.state === "UNKNOWN" || source?.carried.freshness === "stale" || candidate.provenance === "LAST_SEEN" ? `Stale bag observation${source?.carried.observedAt !== undefined ? `; LAST_SEEN at ${new Date(source.carried.observedAt * 1000).toISOString()}` : "; LAST_SEEN time UNKNOWN"}.` : candidate.bound === true ? "Observed bound item cannot be mailed to another character." : candidate.bound === undefined ? "Binding is UNKNOWN." : !candidate.itemRef ? "Exact item identity is UNKNOWN." : "Item evidence is not current.";
        noRecipient.push({ item, capturedBinding: candidate.bound === undefined ? "UNKNOWN" : candidate.bound ? "OBSERVED_BOUND" : "OBSERVED_UNBOUND", reason });
        continue;
      }
      let found: Record<string, unknown> | undefined;
      for (const character of sameRealmFaction) {
        const allocation = this.getForeverGearAllocation({ version: "forever", name: character.name, realm: character.realm });
        if (allocation.status !== "FOUND" || !allocation.value.data) continue;
        const assessment = allocation.value.data.assessments.find((row) => row.source.identityKey === sourceCharacter.identityKey && row.candidate.itemRef === candidate.itemRef);
        if (!assessment) continue;
        const proficiencyKnown = ["PASS", "NOT_APPLICABLE"].includes(assessment.eligibilityChecks.armorProficiency.state)
          && ["PASS", "NOT_APPLICABLE"].includes(assessment.eligibilityChecks.weaponProficiency.state);
        const canMail = assessment.eligibilityChecks.requiredLevel.state === "MET"
          && proficiencyKnown
          && assessment.eligibilityChecks.slotCompatibility.state === "MAPPED"
          && ["POSSIBLE_RECORDED_STAT_UPGRADE", "POSSIBLE_EMPTY_SLOT_FILL"].includes(assessment.upgradeStatus);
        if (!canMail) continue;
        const cmp = assessment.rawStatComparisons[0];
        found = { item, recipient: { name: character.name, realm: character.realm }, slot: assessment.eligibilityChecks.slotCompatibility.possibleSlots?.[0] ?? "UNKNOWN",
          why: { statDeltas: cmp?.values?.map((v) => ({ stat: v.label, delta: v.delta })) ?? "UNKNOWN", requiredLevel: assessment.eligibilityChecks.requiredLevel,
            proficiency: { armor: assessment.eligibilityChecks.armorProficiency, weapon: assessment.eligibilityChecks.weaponProficiency } },
          confidence: assessment.confidenceQualifier === "STANDARD" ? assessment.upgradeConfidence : `${assessment.upgradeConfidence}; lowered because build verification is UNVERIFIED_BUILD`, buildVerification: assessment.buildVerification,
          recipientFreshness: allocation.value.data.recipient.equipment.state === "OBSERVED" && allocation.value.data.recipient.equipment.freshness === "recent" ? "OBSERVED" : allocation.value.data.recipient.equipment.state === "LAST_SEEN" || allocation.value.data.recipient.equipment.freshness === "stale" ? "LAST_SEEN" : "UNKNOWN",
          evidence: assessment.upgradeStatus, transferability: "UNBOUND OBSERVED; same realm and faction; mail route still player-executed" };
        break;
      }
      if (found) mail.push(found);
      else {
        const professionStatus = this.getCharacterProfessions({ version: "forever", name: sourceCharacter.name, realm: sourceCharacter.realm });
        noRecipient.push({ item, reason: "No same-realm, same-faction recipient has a supported equipment fit; consider vendor/AH only after checking professions.", ownerProfessionEvidence: professionStatus.status === "FOUND" ? professionStatus.value.provenance.state : "UNKNOWN" });
      }
    }
    for (const [bucket, rows] of Object.entries(source?.carriedBuckets ?? {})) for (const row of rows) {
      const rowItemId = typeof (row as any).itemID === "number" ? (row as any).itemID as number : typeof row.itemRef === "string" ? itemIdFromItemRef(row.itemRef) : undefined;
      if (rowItemId !== undefined && holdItemIds.has(rowItemId)) { keep.push({ item: { name: typeof row.name === "string" ? row.name : undefined, itemRef: typeof row.itemRef === "string" ? row.itemRef : undefined, quantity: typeof row.quantity === "number" ? row.quantity : undefined }, disposition: "KEEP", reason: "on hold list" }); continue; }
      const itemMetadata = rowItemId === undefined ? undefined : this.store.getItemMetadata("forever", [rowItemId])[0];
      const isPouch = row.itemType === "Container" || (itemMetadata?.classId.state === "KNOWN" && itemMetadata.classId.value === 1);
      if (isPouch && source?.carried.state === "OBSERVED" && source.carried.freshness === "recent" && row.provenance !== "LAST_SEEN" && row.bound === false) {
        const routed = routePouch({ itemId: rowItemId, itemRef: typeof row.itemRef === "string" ? row.itemRef : undefined, name: typeof row.name === "string" ? row.name : undefined, quantity: typeof row.quantity === "number" ? row.quantity : undefined }, recipientProfessions.filter((entry) => entry.character.identityKey !== sourceCharacter.identityKey).map((entry) => ({
          identityKey: entry.character.identityKey, name: entry.character.name, realm: entry.character.realm, faction: entry.character.faction,
          professionsState: entry.professionEvidenceState, observedReagentIds: entry.observedReagentIds, observedBagSlots: entry.observedBagSlots,
        })));
        if (routed.disposition === "POUCH_TO_ALT") pouchMail.push(routed);
        else keep.push(routed);
        continue;
      }
      if (bucket === "materials" && source?.carried.state === "OBSERVED" && source.carried.freshness === "recent" && row.provenance !== "LAST_SEEN" && row.bound === false) { routeMaterial({ ...row, itemID: rowItemId }); continue; }
      const stale = source?.carried.state === "LAST_SEEN" || source?.carried.freshness === "stale" || row.provenance === "LAST_SEEN";
      noRecipient.push({ item: { name: row.name ?? "UNKNOWN item", itemRef: row.itemRef, quantity: row.quantity }, bucket: bucket === "questUtility" ? "quest/utility" : bucket, capturedBinding: row.bound === undefined ? "UNKNOWN" : row.bound ? "OBSERVED_BOUND" : "OBSERVED_UNBOUND", ...(stale && source?.carried.observedAt !== undefined ? { lastSeenAt: new Date(source.carried.observedAt * 1000).toISOString() } : {}), reason: stale ? `Stale bag observation${source?.carried.observedAt !== undefined ? `; LAST_SEEN at ${new Date(source.carried.observedAt * 1000).toISOString()}` : "; LAST_SEEN time UNKNOWN"}.` : row.reason ?? "Classification UNKNOWN." });
    }
    const bankItems = source?.bank.items ?? [];
    for (const item of bankItems) noRecipient.push({ item: { name: item.name ?? "UNKNOWN item", itemRef: item.itemRef, quantity: item.quantity }, location: "BANK", reason: "Bank item is observed but the gear evaluator has no exact bank-source item API comparison; withdraw/location and suitability remain UNKNOWN." });
    const professionChecks = this.characters("forever").map((character) => {
      const result = this.getCharacterProfessions({ version: "forever", name: character.name, realm: character.realm });
      return { character: character.name, realm: character.realm, state: result.status === "FOUND" ? result.value.provenance.state : result.status, professions: result.status === "FOUND" ? result.value.data?.entries?.map((entry) => entry.name) ?? "UNKNOWN" : "UNKNOWN" };
    });
    for (const entry of data.allocationPlan.filter((row) => row.source.identityKey === sourceCharacter.identityKey && row.source.location === "EQUIPPED")) keep.push({ item: entry.item, reason: "Already equipped." });
    const observedAt = data.recipient.observedAt;
    const buildVerification = data.buildVerification;
    const sourceProfile = (this.snapshots(sourceCharacter.identityKey)[0]?.parsed.foreverGearObservation as { clientProfile?: string } | undefined)?.clientProfile;
    const clientBuild = parseForeverProfile(sourceProfile)?.clientBuild;
    return { status: "FOUND" as const, value: { data: { version: "forever", ruleset: "forever-min-70291-allocation-screen-v3", buildVerification, ...(clientBuild ? { build: Number(clientBuild) } : {}), confidenceQualifier: buildVerification === "VERIFIED" ? "STANDARD" : "LOWERED_UNVERIFIED_BUILD", scope: { accountMembership: "UNKNOWN", reason: "Dashboard roster membership does not establish WoW account ownership. Recipient matching uses only known same-realm and same-faction characters." }, steps: orderMailPlanSteps({ gear: mail, materials: materialMail, pouches: pouchMail, sale, keep }), screenedRecipients, mail, materialMail, pouchMail, sale, keep, noRecipient, unknownReasons,
      bank: source?.bank ?? { state: "UNKNOWN", reason: "No bank evidence." }, professionChecks,
      plannedSpecs: Object.entries(FOREVER_PLANNED_SPECS).map(([identityKey, spec]) => ({ identityKey, spec, provenance: "USER_CONFIGURED" as const, informational: true as const })),
    }, provenance: { ...base.value.provenance, state: "DERIVED" as const, ...(observedAt !== undefined ? { observedAt } : {}) } } };
  }

  getCharacterProfessions(query: CharacterQuery): CharacterResolution<ReadValue<ProfessionsSection>> {
    return this.resolve(query, (character, snapshot) => {
      if (!snapshot) return { provenance: { state: "UNKNOWN", version: query.version, identityKey: character.identityKey, reason: "No snapshot exists for this character." } };
      const value = snapshot.parsed.professions;
      const captured = snapshot.parsed.characterState?.professionSpecializations;
      const resolution = supportsRecipeCapture(query.version) ? resolveRecipeEvidence(query.version, this.snapshots(character.identityKey), snapshot) : undefined;
      const recipeKnowledge = resolution
        ? resolution.section
          ? { ...resolution.section, evidence: { state: resolution.state, sourceSnapshotId: resolution.sourceSnapshotId, selectedSnapshotId: resolution.selectedSnapshotId, excludedScopes: resolution.excludedScopes, reason: resolution.reason } }
          : { status: { state: "UNKNOWN" as const, reason: resolution.reason }, completeness: "unknown" as const }
        : undefined;
      // Recipe knowledge is a separate evidence section. A recipe-panel capture
      // must not upgrade profession-skill provenance or its timestamp.
      const state = value.status.state === "UNKNOWN" && captured
        ? statusToReadState(captured.status.state)
        : statusToReadState(value.status.state);
      const data = { ...value, ...(captured ? { specialization: captured } : {}), ...(recipeKnowledge ? { recipeKnowledge } : {}) } as ProfessionsSection;
      const observedAt = value.status.state !== "UNKNOWN"
        ? value.status.observedAt ?? snapshot.generatedAt ?? snapshot.importedAt
        : captured?.observedAt;
      return { ...(state === "UNKNOWN" && !recipeKnowledge ? {} : { data }), provenance: { state, version: query.version, identityKey: character.identityKey, ...(observedAt !== undefined ? { observedAt } : {}), importedAt: snapshot.importedAt, snapshotId: snapshot.id, source: "WOWSYNC v1 professions plus structured specialization and recipe sidecars", ...(state === "UNKNOWN" ? { reason: value.status.reason ?? "Profession skills were not captured in this snapshot; recipe knowledge is reported separately." } : {}), ...(state === "LAST_SEEN" ? { warning: "This section is historical and not a current observation." } : {}) } };
    });
  }

  private characterHistories(version: VersionOrUnknown): CharacterHistory[] {
    return this.characters(version).map((character) => ({ character, snapshots: this.snapshots(character.identityKey) })).filter((entry) => entry.snapshots.length > 0);
  }

  /** Characters in one explicit version with captured evidence for a recipe or its output item. */
  findRecipeCrafters(query: { version: VersionOrUnknown } & RecipeFilter): ReadValue<RecipeCraftersResult> {
    requireVersion(query.version);
    const { version, ...filter } = query;
    if (filter.recipeID === undefined && filter.recipeKey === undefined && filter.outputItemID === undefined && filter.enchantID === undefined && !filter.nameContains?.trim()) throw new TypeError("Provide recipeID, recipeKey, outputItemID, enchantID, or nameContains");
    if (!supportsRecipeCapture(version)) return { provenance: { state: "UNKNOWN", version, reason: `Structured learned-recipe capture is not supported for ${version}; which characters know a recipe is UNKNOWN, not none.` } };
    const data = findRecipeCrafters(version, this.characterHistories(version), filter);
    return { data, provenance: { state: "DERIVED", version, source: "Version-scoped captured recipe rows, resolved per character to the freshest compatible observation", reason: data.semantics } };
  }

  /** One character's recipe reagents with per-owner observed holdings. Read-only; implies no transfer or craft. */
  getRecipeReagentAvailability(query: CharacterQuery & RecipeSelector): CharacterResolution<ReadValue<{ recipe: RecipeKnowledgeRow; reagents: ReagentAvailabilityView[]; recipeEvidence: { state: string; sourceSnapshotId?: number; reason: string }; sharedStorage: string; craftability: "NOT_ESTABLISHED"; semantics: string } | { ambiguous: Array<Pick<RecipeKnowledgeRow, "recipeID" | "recipeKey" | "name" | "profession" | "outputItemID" | "enchantID" | "evidence" | "knowledgeClass">>; reason: string }>> {
    const selectors = [query.recipeID, query.recipeKey, query.outputItemID, query.enchantID, query.recipeName].filter((value) => value !== undefined);
    if (selectors.length !== 1) throw new TypeError("Provide exactly one of recipeID, recipeKey, outputItemID, enchantID, or recipeName");
    for (const key of ["recipeID", "outputItemID", "enchantID"] as const) if (query[key] !== undefined && (!Number.isSafeInteger(query[key]) || query[key]! < 1)) throw new TypeError(`${key} must be a positive integer`);
    const label = query.recipeID !== undefined ? `Recipe ${query.recipeID}` : query.recipeKey !== undefined ? `Recipe key ${query.recipeKey}` : query.outputItemID !== undefined ? `A recipe making item ${query.outputItemID}` : query.enchantID !== undefined ? `Enchant ${query.enchantID}` : `Recipe "${query.recipeName}"`;
    return this.resolve(query, (character, snapshot) => {
      if (!snapshot) return { provenance: { state: "UNKNOWN", version: query.version, identityKey: character.identityKey, reason: "No snapshot exists for this character." } };
      if (!supportsRecipeCapture(query.version)) return { provenance: { state: "UNKNOWN", version: query.version, identityKey: character.identityKey, reason: `Structured recipe reagent capture is not supported for ${query.version}.` } };
      const snapshots = this.snapshots(character.identityKey);
      const resolution = resolveRecipeEvidence(query.version, snapshots, snapshot);
      const name = query.recipeName?.trim().toLowerCase();
      const candidates = knowledgeRows(resolution).filter((row) => name !== undefined ? row.name?.trim().toLowerCase() === name : matchesRecipeFilter(row, { recipeID: query.recipeID, recipeKey: query.recipeKey, outputItemID: query.outputItemID, enchantID: query.enchantID }));
      const distinct = [...new Map(candidates.map((row) => [recipeRowIdentity(row), row])).values()];
      if (distinct.length === 0) return { provenance: { state: "UNKNOWN", version: query.version, identityKey: character.identityKey, snapshotId: snapshot.id, reason: `${label} is not among this character's captured recipe rows. Candidate coverage is partial, so this does not mean unlearned or unknown reagents in the game. ${resolution.reason}` } };
      if (distinct.length > 1) return { data: { ambiguous: distinct.slice(0, 20).map((row) => ({ ...(row.recipeID !== undefined ? { recipeID: row.recipeID } : {}), ...(row.recipeKey ? { recipeKey: row.recipeKey } : {}), ...(row.name ? { name: row.name } : {}), ...(row.profession ? { profession: row.profession } : {}), ...(row.outputItemID !== undefined ? { outputItemID: row.outputItemID } : {}), ...(row.enchantID !== undefined ? { enchantID: row.enchantID } : {}), evidence: row.evidence, knowledgeClass: row.knowledgeClass })), reason: `${label} matches ${distinct.length} captured recipe rows; select one by recipeID or recipeKey. Rows without a stable identity are never merged.` }, provenance: { state: "UNKNOWN", version: query.version, identityKey: character.identityKey, snapshotId: snapshot.id, reason: "Ambiguous recipe selection; nothing was chosen on the caller's behalf." } };
      const recipe = distinct[0]!;
      const others = this.characterHistories(query.version).filter((entry) => entry.character.identityKey !== character.identityKey);
      const reagents = reagentAvailability(query.version, { character, snapshots }, others, recipe, this.now());
      const sharedStorage = query.version === "retail" ? "Warband and guild bank holdings are separate ownership domains and are not included; read them with get_shared_storage."
        : query.version === "forever" ? "Forever has no captured shared storage domain; none is assumed."
        : "Classic Era / TBC have no account-wide storage; guild bank contents are not captured and are never counted as personal holdings.";
      const knowledgeNote = recipe.knowledgeClass === "LEARNED" ? "" : recipe.knowledgeClass === "VISIBLE_LEARNED_UNKNOWN" ? " This row was visible in a Classic Craft window, which does not establish that the recipe is learned." : ` Learned state is ${recipe.learnedState}; the recipe is not established as known.`;
      return { data: { recipe, reagents, recipeEvidence: { state: resolution.state, ...(resolution.sourceSnapshotId !== undefined ? { sourceSnapshotId: resolution.sourceSnapshotId } : {}), reason: resolution.reason },
        sharedStorage,
        craftability: "NOT_ESTABLISHED", semantics: `Reagents must be in the crafter's bags to craft. Bank and other-character holdings are listed separately and require moves this tool never performs or assumes possible. Required skill, tools, and facilities are not captured and remain UNKNOWN. A clientReportedCount/clientReportedCarried value is the client's report at observation time, not current availability.${knowledgeNote}` },
        provenance: { state: "DERIVED", version: query.version, identityKey: character.identityKey, snapshotId: snapshot.id, source: "Resolved recipe row plus per-owner bag and bank observations", reason: recipe.evidence === "LAST_SEEN" ? `Recipe row is LAST_SEEN from snapshot ${recipe.sourceSnapshotId}.` : "Each holding keeps its own provenance." } };
    });
  }

  /**
   * Active quests, objectives, and client-returned completed quest IDs for Forever (C_QuestLog) or Classic Era /
   * TBC (legacy quest log). Retail quest state is not captured. Optional exact completed-ID lookups.
   */
  getCharacterQuests(query: CharacterQuestQuery): CharacterResolution<ReadValue<ForeverQuestObservation>> {
    if (query.completedQuestIDs !== undefined && (query.completedQuestIDs.length > 50 || !query.completedQuestIDs.every((id) => Number.isSafeInteger(id) && id > 0))) throw new TypeError("completedQuestIDs must be at most 50 positive integers");
    if (query.version === "forever") {
      const forever = this.getForeverQuestObservation(query);
      if (forever.status !== "FOUND" || !query.completedQuestIDs?.length || !forever.value.data) return forever;
      return this.resolveSelectedSnapshot(query, (character, snapshot) => {
        const structured = snapshot?.parsed.foreverGearObservation;
        const data = buildForeverQuestObservation({ section: structured?.quests, profile: structured?.clientProfile ?? "UNKNOWN", identity: { identityKey: character.identityKey, name: character.name, realm: character.realm }, now: this.now(), completedLookup: query.completedQuestIDs });
        return { ...forever.value, data: { ...forever.value.data!, completedHistory: data.completedHistory } };
      });
    }
    if (!isClassicVersion(query.version)) {
      requireVersion(query.version);
      return { status: "FOUND", value: { provenance: { state: "UNKNOWN", version: query.version, reason: "Quest observations are captured for Forever, Classic Era, and TBC Anniversary only; Retail quest state is not part of the WoWSync capture." } } };
    }
    const version = query.version;
    return this.resolveSelectedSnapshot(query, (character, snapshot) => {
      const identity = { identityKey: character.identityKey, name: character.name, realm: character.realm };
      if (!snapshot) return { provenance: { state: "UNKNOWN", version, identityKey: character.identityKey, reason: "No snapshot exists for this character." } };
      const domain = snapshot.parsed.characterState?.clientFamily === "Classic" ? snapshot.parsed.characterState.quests : undefined;
      const carried = domain?.status.state === "LAST_SEEN";
      const section = domain ? { data: domain.data, observedAt: domain.observedAt, completeness: domain.completeness, ...(domain.status.reason ? { reason: domain.status.reason } : {}), ...(carried ? { lastAttemptStale: true } : {}) } : undefined;
      const profile = typeof (domain?.data as Record<string, unknown> | undefined)?.clientProfile === "string" ? (domain!.data as Record<string, unknown>).clientProfile as string : "UNKNOWN";
      const observation = buildQuestObservation({ version, section, profile, identity, now: this.now(), ...(query.completedQuestIDs ? { completedLookup: query.completedQuestIDs } : {}) });
      return { data: observation, provenance: { state: observation.state, version, identityKey: character.identityKey, ...(observation.observedAt !== undefined ? { observedAt: observation.observedAt } : {}), importedAt: snapshot.importedAt, snapshotId: domain?.status.carriedFromSnapshotId ?? snapshot.id, freshness: observation.freshness, source: "Classic legacy quest log sidecar (GearExport WoWSyncDB)",
        ...(observation.reason ? { reason: observation.reason } : !domain ? { reason: "No Classic quest sidecar has been imported for this character." } : {}),
        ...(observation.state === "LAST_SEEN" ? { warning: carried ? `Quest values are carried from snapshot ${domain!.status.carriedFromSnapshotId}; they are historical, not current.` : "Quest values are historical and are not a current observation." } : {}) } };
    });
  }

  /** Classic Era / TBC visible reputation rows and talent trees. Retail reputation is read with get_renown. */
  getCharacterProgression(query: CharacterProgressionQuery): CharacterResolution<ReadValue<{ version: VersionOrUnknown; reputation: ClassicReputationView; talents: ClassicTalentView | ForeverTalentView }>> {
    if (query.version === "forever") return this.getForeverProgression(query);
    if (!isClassicVersion(query.version)) {
      requireVersion(query.version);
      return { status: "FOUND", value: { provenance: { state: "UNKNOWN", version: query.version, reason: query.version === "retail" ? "Retail reputation is captured separately; use get_renown (major factions) and get_account_overview. Retail talents are summarized under combat specialization." : "Reputation and talent observations are captured for Classic Era and TBC Anniversary only." } } };
    }
    return this.resolveSelectedSnapshot(query, (character, snapshot) => {
      if (!snapshot) return { provenance: { state: "UNKNOWN", version: query.version, identityKey: character.identityKey, reason: "No snapshot exists for this character." } };
      const state = snapshot.parsed.characterState?.clientFamily === "Classic" ? snapshot.parsed.characterState : undefined;
      const reputation = buildClassicReputationView(state?.reputation?.character, this.now(), { ...(query.factionQuery ? { query: query.factionQuery } : {}) });
      const talents = buildClassicTalentView(state?.talents, this.now(), { includeTalents: query.includeTalents === true });
      const states = [reputation.state, talents.state];
      const overall: ReadState = states.every((value) => value === "UNKNOWN") ? "UNKNOWN" : states.includes("LAST_SEEN") ? "LAST_SEEN" : "OBSERVED";
      return { data: { version: query.version, reputation, talents }, provenance: { state: overall, version: query.version, identityKey: character.identityKey, snapshotId: snapshot.id, importedAt: snapshot.importedAt, source: "Classic legacy reputation and talent sidecars (GearExport WoWSyncDB)", ...(overall === "UNKNOWN" ? { reason: "Neither reputation nor talents have been captured for this character." } : {}), ...(overall === "LAST_SEEN" ? { warning: "At least one domain is historical; each domain states its own evidence." } : {}) } };
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
      // Trainer offers joined to this character's captured recipe rows (Forever/Retail only).
      const recipeRows = supportsRecipeCapture(query.version) ? knowledgeRows(resolveRecipeEvidence(query.version, this.snapshots(character.identityKey), snapshot)) : [];
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
        .map((service) => {
          const recipeMatch = matchTrainerService(service, recipeRows, category.category);
          return { category: category.category, categoryState: category.status.state, observedAt, freshness, spellID: service.spellID, ability: service.ability, rank: service.rank, statusAtVisit: service.statusAtVisit, requiredLevel: service.requiredLevel, costCopper: service.costCopper, requirementsAtVisit: service.requirementsAtVisit, ...(recipeMatch ? { recipeMatch } : {}) };
        }));
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
      const allSnapshots = this.snapshots(character.identityKey);
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
      const snapshots = this.snapshots(character.identityKey);
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
        const snapshots = this.snapshots(location.identityKey);
        const snapshot = snapshots[0] && resolveSnapshotView(query.version, snapshots, snapshots[0]);
        const section = snapshot?.parsed[location.storage];
        if (!snapshot || !section || section.status.state === "UNKNOWN") return [];
        const observedAt = section.status.observedAt ?? snapshot.generatedAt ?? snapshot.importedAt;
        return [{ ...location, state: section.status.state, ...(observedAt !== undefined ? { observedAt } : {}), importedAt: snapshot.importedAt, snapshotId: section.status.carriedFromSnapshotId ?? snapshot.id, freshness: classifyFreshness(observedAt, this.now()) }];
      });
      const scopedItem = { ...item, locations };
      return { item: scopedItem, metadataState: value ? "KNOWN" as const : "UNKNOWN" as const, ...(value ? { metadata: value } : {}) };
    });
    const describeUnknown = (entry: AccountFacts["inventory"]["unknownBags"][number], storage: StorageLocation) => {
      const snapshot = this.snapshots(entry.identityKey)[0];
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
   * commodity (base item id) against its currently active STOCK_TARGET demand, if any. Always DERIVED â€”
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
   * getItemAllocation evaluates it â€” same projection, same buildAllocationResult) and `unallocated`
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
      // Carried-forward or import-merged domains are historical; never report them as current.
      const historical = [characterDomain, accountDomain].some((domain) => domain?.status.state === "LAST_SEEN");
      return { data: { majorFactions: rows, completeness: partial ? "partial" : "complete" }, provenance: {
        state: historical ? "LAST_SEEN" : "OBSERVED", ...(historical ? { warning: "Renown is from an earlier observation and is not current." } : {}), version: query.version, identityKey: character.identityKey,
        ...([characterDomain?.observedAt, accountDomain?.observedAt].some((n) => typeof n === "number") ? { observedAt: Math.max(...[characterDomain?.observedAt, accountDomain?.observedAt].filter((n): n is number => typeof n === "number")) } : {}),
        snapshotId: snapshot.id, source: "captured C_MajorFactions Renown records",
        ...(partial ? { warning: "Renown observations are useful, but overall reputation coverage is partial." } : {}),
      } };
    });
  }

  private resolve<T>(query: CharacterQuery, build: (character: StoredCharacterSummary, latest: StoredSnapshot | undefined) => T): CharacterResolution<T> {
    requireVersion(query.version);
    const candidates = this.characters(query.version).filter((character) => character.name.toLowerCase() === query.name.toLowerCase() && (!query.realm || character.realm === query.realm));
    if (candidates.length === 0) return { status: "NOT_FOUND", version: query.version, name: query.name, ...(query.realm ? { realm: query.realm } : {}) };
    if (candidates.length > 1) return { status: "AMBIGUOUS", version: query.version, name: query.name, candidates: candidates.map(({ identityKey, realm, name }) => ({ identityKey, realm, name })) };
    const character = candidates[0];
    const snapshots = this.snapshots(character.identityKey);
    return { status: "FOUND", value: build(character, snapshots[0] && resolveSnapshotView(query.version, snapshots, snapshots[0])) };
  }

  /** Forever reputation (visible rows) and full talent capture, each from the newest snapshot that carries it (or from snapshotId and older). */
  private getForeverProgression(query: CharacterProgressionQuery): CharacterResolution<ReadValue<{ version: VersionOrUnknown; reputation: ClassicReputationView; talents: ForeverTalentView; upcomingAbilities?: unknown }>> {
    const candidates = this.characters("forever").filter((character) => character.name.toLowerCase() === query.name.toLowerCase() && (!query.realm || character.realm === query.realm));
    if (candidates.length === 0) return { status: "NOT_FOUND", version: "forever", name: query.name, ...(query.realm ? { realm: query.realm } : {}) };
    if (candidates.length > 1) return { status: "AMBIGUOUS", version: "forever", name: query.name, candidates: candidates.map(({ identityKey, realm, name }) => ({ identityKey, realm, name })) };
    const character = candidates[0]!;
    let snapshots = this.snapshots(character.identityKey);
    if (query.snapshotId !== undefined) {
      const at = snapshots.findIndex((snapshot) => snapshot.id === query.snapshotId);
      if (at < 0) return { status: "FOUND", value: { provenance: { state: "UNKNOWN", version: "forever", identityKey: character.identityKey, reason: `Snapshot ${query.snapshotId} does not belong to this character.` } } };
      snapshots = snapshots.slice(at);
    }
    const newestId = snapshots[0]?.id;
    let talents: ForeverTalents | undefined;
    let classSpells: ForeverClassSpells | undefined;
    let reputation: { domain: Parameters<typeof buildClassicReputationView>[0]; snapshotId: number } | undefined;
    for (const snapshot of snapshots) {
      talents ??= extractForeverTalents(snapshot.parsed, snapshot.id);
      classSpells ??= extractForeverClassSpells(snapshot.parsed, snapshot.id);
      if (!reputation) { const found = extractForeverReputationDomain(snapshot.parsed); if (found) reputation = { domain: found.domain, snapshotId: snapshot.id }; }
      if (talents && reputation) break;
    }
    const carried = (snapshotId: number | undefined) => snapshotId !== undefined && snapshotId !== newestId;
    const repDomain = reputation?.domain && carried(reputation.snapshotId) ? { ...reputation.domain, status: { ...reputation.domain.status, state: "LAST_SEEN" as const, carriedFromSnapshotId: reputation.snapshotId } } : reputation?.domain;
    const reputationView = buildClassicReputationView(repDomain, this.now(), { ...(query.factionQuery ? { query: query.factionQuery } : {}) });
    const talentView = foreverTalentView(talents, this.now(), { includeTalents: query.includeTalents === true, carried: carried(talents?.snapshotId) });
    const currentSnapshot = snapshots[0];
    const level = typeof currentSnapshot?.parsed.character?.level === "number" ? currentSnapshot.parsed.character.level : undefined;
    const planned = FOREVER_PLANNED_SPECS[character.identityKey];
    const specialization = foreverSpecProjection(deriveForeverSpec(talents?.trees, level), planned);
    (talentView as any).spec = specialization;
    const states = [reputationView.state, talentView.state];
    const overall: ReadState = states.every((value) => value === "UNKNOWN") ? "UNKNOWN" : states.includes("LAST_SEEN") ? "LAST_SEEN" : "OBSERVED";
    return { status: "FOUND", value: { data: { version: "forever", reputation: reputationView, talents: talentView, upcomingAbilities: classSpells ? { state: carried(classSpells.snapshotId) ? "LAST_SEEN" : "OBSERVED", observedAt: classSpells.observedAt, sourceSnapshotId: classSpells.snapshotId, entries: classSpells.entries, semantics: "Spellbook future entries with the level the Forever client reports; training cost comes from trainer visits (get_character_trainer)." } : { state: "UNKNOWN", entries: [], semantics: "UNKNOWN: the Forever 1.60.1 spellbook does not list unlearned abilities. Upcoming abilities, ranks and costs come from the class trainer window: open it once on this character, then /wowsync and /reload, and read get_character_trainer." } }, provenance: { state: overall, version: "forever", identityKey: character.identityKey, ...(newestId !== undefined ? { snapshotId: newestId } : {}), source: "Forever reputation and talent sections (GearExport WoWSyncDB, C_Reputation and C_ClassTalents/C_Traits)", ...(overall === "UNKNOWN" ? { reason: "Neither reputation nor talents have been captured for this character; /wowsync and /reload with a current GearExport." } : {}) } } };
  }

  /** Newest observed Forever skill lines and talents, each from the newest snapshot that carries it. */
  getForeverSkillsAndTalents(query: CharacterQuery): CharacterResolution<{ skills?: ForeverSkillLines; talents?: ForeverTalents; classSpells?: ForeverClassSpells }> {
    requireVersion(query.version);
    if (query.version !== "forever") return { status: "FOUND", value: {} };
    const candidates = this.characters(query.version).filter((character) => character.name.toLowerCase() === query.name.toLowerCase() && (!query.realm || character.realm === query.realm));
    if (candidates.length === 0) return { status: "NOT_FOUND", version: query.version, name: query.name, ...(query.realm ? { realm: query.realm } : {}) };
    if (candidates.length > 1) return { status: "AMBIGUOUS", version: query.version, name: query.name, candidates: candidates.map(({ identityKey, realm, name }) => ({ identityKey, realm, name })) };
    let skills: ForeverSkillLines | undefined;
    let talents: ForeverTalents | undefined;
    let classSpells: ForeverClassSpells | undefined;
    for (const snapshot of this.snapshots(candidates[0]!.identityKey)) {
      skills ??= extractForeverSkillLines(snapshot.parsed, snapshot.id);
      talents ??= extractForeverTalents(snapshot.parsed, snapshot.id);
      classSpells ??= extractForeverClassSpells(snapshot.parsed, snapshot.id);
      if (skills && talents && classSpells) break;
    }
    return { status: "FOUND", value: { skills, talents, classSpells } };
  }

  /** Whether the character's latest export reports a failed profession-recipe capture (only the newest snapshot counts). */
  getForeverRecipeCaptureIssue(query: CharacterQuery): { error: string; at?: number; snapshotId: number } | undefined {
    if (query.version !== "forever") return undefined;
    const candidates = this.characters("forever").filter((character) => character.name.toLowerCase() === query.name.toLowerCase() && (!query.realm || character.realm === query.realm));
    if (candidates.length !== 1) return undefined;
    const latest = this.snapshots(candidates[0]!.identityKey)[0];
    const issue = latest ? extractForeverRecipeCaptureIssue(latest.parsed) : undefined;
    return issue && latest ? { ...issue, snapshotId: latest.id } : undefined;
  }

  /** Newest raw Forever trainer-window capture per trainer frame, scanning the character's history. */
  getForeverTrainerVisits(query: CharacterQuery): CharacterResolution<ForeverTrainerVisit[]> {
    requireVersion(query.version);
    if (query.version !== "forever") return { status: "FOUND", value: [] };
    const candidates = this.characters(query.version).filter((character) => character.name.toLowerCase() === query.name.toLowerCase() && (!query.realm || character.realm === query.realm));
    if (candidates.length === 0) return { status: "NOT_FOUND", version: query.version, name: query.name, ...(query.realm ? { realm: query.realm } : {}) };
    if (candidates.length > 1) return { status: "AMBIGUOUS", version: query.version, name: query.name, candidates: candidates.map(({ identityKey, realm, name }) => ({ identityKey, realm, name })) };
    const visits = new Map<string, ForeverTrainerVisit>();
    for (const snapshot of this.snapshots(candidates[0]!.identityKey)) {
      const visit = extractForeverTrainerVisit(snapshot.parsed, snapshot.id);
      if (!visit) continue;
      const key = visit.kind;
      const existing = visits.get(key);
      if (!existing || (visit.observedAt ?? 0) > (existing.observedAt ?? 0)) visits.set(key, visit);
    }
    return { status: "FOUND", value: [...visits.values()] };
  }

  private resolveSelectedSnapshot<T>(query: CharacterSnapshotQuery, build: (character: StoredCharacterSummary, snapshot: StoredSnapshot | undefined) => T): CharacterResolution<T> {
    requireVersion(query.version);
    if (query.snapshotId !== undefined && (!Number.isSafeInteger(query.snapshotId) || query.snapshotId < 1)) throw new TypeError("snapshotId must be a positive integer");
    const candidates = this.characters(query.version).filter((character) => character.name.toLowerCase() === query.name.toLowerCase() && (!query.realm || character.realm === query.realm));
    if (candidates.length === 0) return { status: "NOT_FOUND", version: query.version, name: query.name, ...(query.realm ? { realm: query.realm } : {}) };
    if (candidates.length > 1) return { status: "AMBIGUOUS", version: query.version, name: query.name, candidates: candidates.map(({ identityKey, realm, name }) => ({ identityKey, realm, name })) };
    const character = candidates[0]!;
    const snapshots = this.snapshots(character.identityKey);
    const snapshot = query.snapshotId === undefined ? snapshots[0] : snapshots.find((entry) => entry.id === query.snapshotId);
    if (query.snapshotId !== undefined && !snapshot) throw new TypeError("snapshotId must belong to the resolved character in the requested WoW version");
    return { status: "FOUND", value: build(character, snapshot && resolveSnapshotView(query.version, snapshots, snapshot)) };
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

export interface ForeverTalentView {
  state: ReadState;
  completeness: string;
  observedAt?: number;
  freshness: string;
  sourceSnapshotId?: number;
  source?: string;
  specialization?: { id?: number; name?: string };
  unspentPoints?: number;
  totalPointsSpent?: number;
  trees: Array<{ name: string; pointsSpent?: number; talentCount: number; talents: ForeverTalent[] }>;
  semantics: string;
}

function foreverTalentView(talents: ForeverTalents | undefined, now: number, options: { includeTalents: boolean; carried: boolean }): ForeverTalentView {
  const semantics = "Ranks, availability and points come from the Forever client (C_ClassTalents/C_Traits) at export time. tier/column are DERIVED from node positions; requires is DERIVED from tree edges. Forever reports one combined tree per class (the three Classic trees side by side). canPurchaseRank means the talent is eligible now (tier and prerequisites met); it can be true with 0 unspentPoints, so check unspentPoints before saying a point can be spent. Pass includeTalents for every talent, not only ranked ones.";
  if (!talents) return { state: "UNKNOWN", completeness: "unknown", freshness: "unknown", trees: [], semantics: "Talents were not captured for this character (needs GearExport with the Forever trait reader, then /wowsync and /reload). " + semantics };
  const total = talents.trees.reduce((sum, tree) => sum + (tree.pointsSpent ?? 0), 0);
  return {
    state: options.carried ? "LAST_SEEN" : "OBSERVED",
    completeness: talents.completeness ?? "unknown",
    ...(talents.observedAt !== undefined ? { observedAt: talents.observedAt } : {}),
    freshness: classifyFreshness(talents.observedAt, now),
    sourceSnapshotId: talents.snapshotId,
    ...(talents.source ? { source: talents.source } : {}),
    ...(talents.specialization ? { specialization: talents.specialization } : {}),
    ...(talents.unspentPoints !== undefined ? { unspentPoints: talents.unspentPoints } : {}),
    totalPointsSpent: total,
    trees: talents.trees.map((tree) => ({ name: tree.name, pointsSpent: tree.pointsSpent, talentCount: tree.talents.length, talents: options.includeTalents ? tree.talents : tree.talents.filter((talent) => (talent.currentRank ?? 0) > 0) })),
    semantics,
  };
}
