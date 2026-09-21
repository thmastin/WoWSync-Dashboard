// Builders for Shared Storage UI tests: API documents shaped like GET /api/shared-storage, including the
// real Virek Warband (98 items, one observation carried by two LAST_SEEN exports). Not a test file.
import type { CarrierState, SharedObservationView, SharedOwnerIdentity, SharedOwnerView, SharedSourceView, SharedStorageResponse } from "../src/types.ts";

export const T = 1_789_965_174; // the real Warband observation time
export const BIG_ID = "18014398509481985";

/** Deterministic time formatting so wording assertions do not depend on the machine's locale. */
export const fmt = (t: number | undefined): string => (t === undefined ? "an unknown time" : `T${t}`);

export function source(over: Partial<SharedSourceView> = {}): SharedSourceView {
  return {
    characterName: "Virek",
    characterRealm: "Cairne",
    characterIdentityKey: "retail::cairne::virek",
    carrierState: "LAST_SEEN",
    exportObservedAt: T + 10,
    snapshotVisit: T - 1,
    visitedNpc: "Elana",
    visitedZone: "Silvermoon City",
    ...over,
  };
}

export function items(n: number, prefix = "Item") {
  return Array.from({ length: n }, (_, i) => ({ itemRef: `item:${1000 + i}`, name: `${prefix} ${String(i + 1).padStart(3, "0")}`, qty: (i % 7) + 1, bound: "no", vendorEachCopper: 100 * (i + 1) }));
}

export function observation(over: Partial<SharedObservationView> = {}): SharedObservationView {
  const base: SharedObservationView = {
    claimedObservedAt: T,
    effectiveObservedAt: T,
    claimedAfterCarrier: false,
    ageSeconds: 3600,
    freshness: "recent",
    completeness: "complete",
    informative: true,
    contentHash: "a".repeat(64),
    liveAtExport: false,
    carrierStates: ["LAST_SEEN"],
    coverage: { observedTabs: [], inaccessibleTabs: [], unconfirmedTabs: [], unidentifiedTabs: 0, observedContainerIds: [12] },
    content: {
      purchasedTabs: 1,
      tabs: [],
      containers: [{ id: 12, storage: "ACCOUNT_WARBAND", capacity: 98, free: 0, family: "0", bagRef: "-" }],
      freeSlots: 0,
      totalSlots: 98,
      itemsKnownEmpty: false,
      items: items(98),
    },
    provenance: { totalSources: 2, totalCharacters: 1, truncated: false, sources: [source({ exportObservedAt: T + 603 }), source()] },
  };
  return { ...base, ...over };
}

export const WARBAND_OWNER: SharedOwnerIdentity = { kind: "warband", ownerKey: "retail::warband::local", accountScope: "installation-local" };
export const guildIdentity = (id: string, name?: string): SharedOwnerIdentity => ({ kind: "guild", ownerKey: `retail::guild::${id}`, guildClubId: id, ...(name !== undefined ? { guildName: name } : {}) });

export function ownerView(owner: SharedOwnerIdentity, over: Partial<SharedOwnerView> = {}): SharedOwnerView {
  return {
    owner,
    basis: "DERIVED",
    current: observation(),
    latestPartial: null,
    broaderCoverageEarlier: null,
    conflict: null,
    observationCount: { total: 1, complete: 1, partial: 0, informationless: 0 },
    ...over,
  };
}

export function response(warband: SharedOwnerView | null, guilds: SharedOwnerView[] = []): SharedStorageResponse {
  return { schema: "shared-storage-1", asOf: T + 3600, warband, guilds };
}

/** The real Virek case: one Warband, one observation, two exports. */
export const realWarband = () => ownerView(WARBAND_OWNER);

const tab = (id: number, name: string, state: string, viewable: boolean, note?: string) => ({ id, name, state, viewable, ...(note ? { note } : {}) });

/** A guild observation where the observer could see tabs 1-2 only. */
export function narrowGuildObservation(over: Partial<SharedObservationView> = {}): SharedObservationView {
  return observation({
    carrierStates: ["OBSERVED"] as CarrierState[],
    liveAtExport: true,
    coverage: { observedTabs: [1, 2], inaccessibleTabs: [3], unconfirmedTabs: [4], unidentifiedTabs: 0, observedContainerIds: [1, 2] },
    content: {
      tabs: [tab(1, "Materials", "OBSERVED", true), tab(2, "Consumables", "OBSERVED", true), tab(3, "Officers", "INACCESSIBLE", false), tab(4, "Raid", "UNKNOWN", true, "Guild Bank query response timed out")],
      containers: [],
      freeSlots: 190,
      totalSlots: 196,
      itemsKnownEmpty: false,
      items: items(6, "Guild item"),
      guildName: "Restricted Guild",
    },
    provenance: { totalSources: 1, totalCharacters: 1, truncated: false, sources: [source({ carrierState: "OBSERVED", characterName: "Memberly", characterRealm: "Thrall", characterIdentityKey: "retail::thrall::memberly" })] },
    ...over,
  });
}
