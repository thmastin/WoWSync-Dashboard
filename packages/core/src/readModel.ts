// Focused, provider-neutral, read-only domain queries. This layer calls the
// SnapshotStore directly; it is intentionally not an HTTP wrapper and has no
// provider, filesystem, SQL, or mutation primitive in its public API.
import { buildSharedStorageResponse, type SharedStorageResponse } from "./sharedStorageApi.ts";
import type { AccountFacts, CharacterFacts, ProfessionFacts } from "./accountFacts.ts";
import type { CharacterCurrencies } from "./wowCurrencies.ts";
import type { EquipmentSection, InventorySection, ProfessionsSection, SectionState, VersionOrUnknown } from "./types.ts";
import type { SnapshotReadStore, StoredCharacterSummary, StoredSnapshot, VersionSummary } from "./store.ts";
import { WOW_VERSIONS } from "./version.ts";
import { itemIdFromItemRef, type ItemMetadataView } from "./itemMetadata.ts";
import type { SharedObservationView, SharedOwnerView } from "./sharedStorageApi.ts";
import type { StorageLocation, InventoryAggregateEntry } from "./accountFacts.ts";
import { classifyFreshness } from "./freshness.ts";

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
export interface HistoryQuery extends CharacterQuery { limit?: number }
/**
 * Deliberately compact history record. Raw export text remains an import
 * concern and is not exposed through this consumer-facing read surface.
 */
export interface CharacterSnapshotHistoryRecord {
  snapshotId: number;
  generatedAt?: number;
  importedAt: number;
  level?: number;
  moneyCopper?: number;
  playedSeconds?: number;
  zone?: string;
  subzone?: string;
}

export interface BoundedPage<T> { items: T[]; offset: number; limit: number; totalCount: number; truncated: boolean }
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

  getCharacterEquipment(query: CharacterQuery): CharacterResolution<ReadValue<EquipmentSection>> {
    return this.resolveSection(query, "equipment");
  }
  getCharacterProfessions(query: CharacterQuery): CharacterResolution<ReadValue<ProfessionsSection>> {
    return this.resolveSection(query, "professions");
  }

  getCharacterCurrencies(query: CharacterQuery): CharacterResolution<ReadValue<CharacterCurrencies>> {
    return this.resolve(query, (character) => {
      const currencies = this.store.getCharacterCurrencies(character.identityKey);
      if (!currencies || currencies.state === "UNKNOWN") return { provenance: { state: "UNKNOWN", version: query.version, identityKey: character.identityKey, reason: "WoWSync has not captured a currency list for this character." } };
      return { data: currencies, provenance: { state: currencies.state, version: query.version, identityKey: character.identityKey, observedAt: currencies.observedAt ?? undefined, snapshotId: currencies.snapshotId ?? undefined, source: "WoWSync structured currencies", ...(currencies.state === "LAST_SEEN" ? { warning: currencies.lastSeenReason ?? "Historical currency observation." } : {}) } };
    });
  }

  getCharacterSnapshotHistory(query: HistoryQuery): CharacterResolution<ReadValue<CharacterSnapshotHistoryRecord[]>> {
    return this.resolve(query, (character) => {
      const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
      const snapshots = this.store.listSnapshots(character.identityKey).slice(0, limit);
      if (snapshots.length === 0) return { provenance: { state: "UNKNOWN", version: query.version, identityKey: character.identityKey, reason: "No stored snapshots exist for this character." } };
      const newest = snapshots[0];
      const history = snapshots.map((snapshot) => ({
        snapshotId: snapshot.id,
        generatedAt: snapshot.generatedAt,
        importedAt: snapshot.importedAt,
        level: snapshot.parsed.character.level,
        moneyCopper: snapshot.parsed.character.moneyCopper,
        playedSeconds: snapshot.parsed.character.playedSeconds,
        zone: snapshot.parsed.location.zone,
        subzone: snapshot.parsed.location.subzone,
      }));
      return { data: history, provenance: { state: "OBSERVED", version: query.version, identityKey: character.identityKey, observedAt: newest.generatedAt ?? newest.importedAt, importedAt: newest.importedAt, snapshotId: newest.id, source: "WOWSYNC compact snapshot history" } };
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

  /** Intentional unsupported-state response until the addon captures Renown. */
  getRenown(query: CharacterQuery): CharacterResolution<ReadValue<never>> {
    return this.resolve(query, (character) => ({ provenance: { state: "UNKNOWN", version: query.version, identityKey: character.identityKey, reason: "WoWSync does not currently capture Renown." } }));
  }

  private resolve<T>(query: CharacterQuery, build: (character: StoredCharacterSummary, latest: StoredSnapshot | undefined) => T): CharacterResolution<T> {
    requireVersion(query.version);
    const candidates = this.store.listCharacters(query.version).filter((character) => character.name.toLowerCase() === query.name.toLowerCase() && (!query.realm || character.realm === query.realm));
    if (candidates.length === 0) return { status: "NOT_FOUND", version: query.version, name: query.name, ...(query.realm ? { realm: query.realm } : {}) };
    if (candidates.length > 1) return { status: "AMBIGUOUS", version: query.version, name: query.name, candidates: candidates.map(({ identityKey, realm, name }) => ({ identityKey, realm, name })) };
    const character = candidates[0];
    return { status: "FOUND", value: build(character, this.store.listSnapshots(character.identityKey)[0]) };
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
