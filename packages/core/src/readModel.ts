// Focused, provider-neutral, read-only domain queries. This layer calls the
// SnapshotStore directly; it is intentionally not an HTTP wrapper and has no
// provider, filesystem, SQL, or mutation primitive in its public API.
import { buildSharedStorageResponse, type SharedStorageResponse } from "./sharedStorageApi.ts";
import { buildAllocationResult, projectAccountOwnedEvidence, type AllocationResult } from "./allocation.ts";
import { commodityIdentity } from "./demand.ts";
import type { AccountChangeSummary, AccountFacts, CharacterFacts, ProfessionFacts } from "./accountFacts.ts";
import { buildAccountCurrencies, type AccountCurrencies, type CharacterCurrencies } from "./wowCurrencies.ts";
import type { CapturedCharacterState, EquipmentSection, ProfessionsSection, SectionState, VersionOrUnknown } from "./types.ts";
import type { InventorySection, SpellEntry, TrainerService, TrainerCategorySnapshot } from "./types.ts";
import type { SnapshotReadStore, StoredCharacterSummary, StoredSnapshot, VersionSummary } from "./store.ts";
import { WOW_VERSIONS } from "./version.ts";
import { itemIdFromItemRef, type ItemMetadataView } from "./itemMetadata.ts";
import type { SharedObservationView, SharedOwnerView } from "./sharedStorageApi.ts";
import type { StorageLocation, InventoryAggregateEntry } from "./accountFacts.ts";
import { classifyFreshness } from "./freshness.ts";
import { snapshotObservedAt } from "./chronology.ts";
import { diffSnapshots, type ItemDelta, type ProfessionDelta, type EquipmentDelta } from "./diff.ts";

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
    const commodity = commodityIdentity(query.baseItemId);
    const active = this.store.getActiveDemand(query.version, "STOCK_TARGET", query.baseItemId);
    const { evidence, guildContext } = projectAccountOwnedEvidence(this.store, query.version, query.baseItemId);
    const data = buildAllocationResult(commodity, active ? [active] : [], evidence, guildContext);
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
