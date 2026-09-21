// The HTTP-facing shape of reconciled shared storage (checkpoint C4).
//
// PURE serialization of the domain projection (sharedStorage.ts) for the local API. There is no
// reconciliation here and none in the server: `SnapshotStore.projectSharedStorage()` decides which
// observation is current; this only renames, caps and annotates what the domain already decided.
//
// Contract conventions (the same as the rest of the API):
//   - an UNKNOWN scalar is OMITTED, never 0/""/false (e.g. no `freeSlots` key = unknown);
//   - whole branches that may be absent are explicit `null` (`warband`, `current`, `latestPartial`,
//     `broaderCoverageEarlier`, `conflict`) so the top-level shape is stable, including when empty;
//   - no database ids: an observation is identified by its owner, `claimedObservedAt` and `contentHash`
//     (its domain identity); a source by what it says (character label, carrier state, export time);
//   - everything here is DERIVED from OBSERVED journal facts. A view is ONE real observation with its
//     own time and coverage; nothing is ever assembled from several (no synthetic OBSERVED bank).
import { classifyFreshness, type Freshness } from "./freshness.ts";
import type {
  CarrierState,
  OwnerProjection,
  ProjectedObservation,
  SharedContent,
  SharedObservationSource,
  SharedStorageOwner,
  SharedStorageProjection,
} from "./sharedStorage.ts";
import { ownerKey } from "./sharedStorage.ts";

/** Most recent carrying exports listed per observation. The total is always reported, so the cap can change without breaking the contract. */
export const SHARED_STORAGE_PROVENANCE_CAP = 10;

/** Who owns a shared storage. NOT a character, and the Warband's `installation-local` scope is NOT a Battle.net account id. */
export type SharedOwnerIdentity =
  | {
      kind: "warband";
      /** e.g. "retail::warband::local". Opaque; also the confirmation string for the delete route. */
      ownerKey: string;
      /**
       * "installation-local": this Dashboard installation's single, undifferentiated Retail account
       * scope. Two Battle.net accounts imported into one Dashboard cannot be told apart.
       */
      accountScope: "installation-local";
    }
  | {
      kind: "guild";
      ownerKey: string;
      /** The addon's GuildClubID, exact text (never a number: it can exceed 2^53). This is the identity. */
      guildClubId: string;
      /** DISPLAY DATA ONLY, from the newest observation that carries one; a guild can be renamed. Never identity. */
      guildName?: string;
    };

/** One carrying export of an observation: provenance, not ownership. The character may since have been deleted from the Dashboard. */
export interface SharedSourceView {
  /** Historical label of the character whose export carried the observation. */
  characterName: string;
  characterRealm: string;
  /** Historical identity key (version::realm::name); the character may no longer exist. */
  characterIdentityKey: string;
  /** OBSERVED = the storage was open when that export was made; LAST_SEEN = it replayed an earlier observation. Neither is a new observation. */
  carrierState: CarrierState;
  /** When that export's game state existed. NOT the observation time. */
  exportObservedAt: number;
  snapshotVisit?: number;
  visitedNpc?: string;
  visitedZone?: string;
}

export interface SharedProvenanceView {
  /** Carrying exports of this observation (every one, even when `sources` is capped). */
  totalSources: number;
  /** Distinct carrying characters. */
  totalCharacters: number;
  /** The most recent carrying exports, newest first, at most SHARED_STORAGE_PROVENANCE_CAP. */
  sources: SharedSourceView[];
  /** True when more sources exist than are listed. */
  truncated: boolean;
}

export interface SharedObservationView {
  /** `observed=` as the addon claimed it. */
  claimedObservedAt: number;
  /** min(claimed, every carrying export's own time): the time this observation is ordered and aged by. */
  effectiveObservedAt: number;
  /** True when the claimed time was later than a carrying export and was clamped. */
  claimedAfterCarrier: boolean;
  /** Age of `effectiveObservedAt` at `asOf`, and its classification by the Dashboard's single freshness rule. A shared storage is never "live". */
  ageSeconds: number;
  freshness: Freshness;
  completeness: "complete" | "partial";
  /** False when nothing was actually scanned (e.g. every guild tab inaccessible): recorded, never a current state. */
  informative: boolean;
  /** Part of the observation's domain identity (with owner and claimed time). Opaque. */
  contentHash: string;
  /** At least one carrying export saw the storage open (OBSERVED); false = only ever seen replayed (LAST_SEEN). */
  liveAtExport: boolean;
  carrierStates: CarrierState[];
  coverage: {
    /** Guild tabs whose contents were observed. */
    observedTabs: number[];
    /** Guild tabs the observer could not view: contents UNKNOWN, never empty. */
    inaccessibleTabs: number[];
    /** Guild tabs viewable but not confirmed: contents UNKNOWN. */
    unconfirmedTabs: number[];
    unidentifiedTabs: number;
    observedContainerIds: number[];
  };
  /** The observation exactly as observed: guild tabs, containers, slot totals, aggregated items. Item rows do not say which tab held them. */
  content: SharedContent;
  provenance: SharedProvenanceView;
}

export interface SharedOwnerView {
  owner: SharedOwnerIdentity;
  /** Always "DERIVED": a selection over observations, never itself an observation. */
  basis: "DERIVED";
  /** The newest informative complete observation (else the newest informative partial). null when no observation is informative. */
  current: SharedObservationView | null;
  /** A newer informative PARTIAL observation than a complete `current`. Never merged into it. */
  latestPartial: SharedObservationView | null;
  /** Guild only. An OLDER complete observation that observed strictly more tabs than `current`. Never spliced into it. */
  broaderCoverageEarlier: SharedObservationView | null;
  /** Different content at the same effective time; `current` was chosen by a fixed content rule. */
  conflict: { effectiveObservedAt: number; others: SharedObservationView[] } | null;
  observationCount: { total: number; complete: number; partial: number; informationless: number };
}

/**
 * GET /api/shared-storage. Reconciled Warband and guild storage, derived from the journal. It is NOT
 * part of AccountFacts, totals, search, diffs, AccountContext or the LLM context. Empty when nothing has
 * been observed: `{ warband: null, guilds: [] }`.
 */
export interface SharedStorageResponse {
  schema: "shared-storage-1";
  /** Unix seconds the ages/freshness were computed against. */
  asOf: number;
  warband: SharedOwnerView | null;
  /** Sorted by owner key. */
  guilds: SharedOwnerView[];
}

/** The reply to a successful explicit owner deletion. */
export interface DeleteSharedStorageOwnerResponse {
  deleted: {
    owner: SharedOwnerIdentity;
    existed: true;
    observationsDeleted: number;
    sourcesDeleted: number;
  };
}

/** The body of the HTTP integrity failure (status 500, code SHARED_STORAGE_INTEGRITY). */
export interface SharedStorageIntegrityErrorBody {
  error: string;
  code: "SHARED_STORAGE_INTEGRITY";
  /** Owners whose stored rows failed validation, when known. Each can be cleared with the explicit delete route (which never parses content). */
  damagedOwners: Array<{ ownerKey: string; kind?: "warband" | "guild"; guildClubId?: string }>;
}

export function sharedOwnerIdentity(owner: SharedStorageOwner, guildName?: string): SharedOwnerIdentity {
  if (owner.kind === "warband") return { kind: "warband", ownerKey: ownerKey(owner), accountScope: "installation-local" };
  return { kind: "guild", ownerKey: ownerKey(owner), guildClubId: owner.guildClubId, ...(guildName !== undefined ? { guildName } : {}) };
}

function sourceView(source: SharedObservationSource): SharedSourceView {
  const view: SharedSourceView = {
    characterName: source.sourceName,
    characterRealm: source.sourceRealm,
    characterIdentityKey: source.sourceIdentityKey,
    carrierState: source.carrierState,
    exportObservedAt: source.exportObservedAt,
  };
  if (source.snapshotVisit !== undefined) view.snapshotVisit = source.snapshotVisit;
  if (source.visitedNpc !== undefined) view.visitedNpc = source.visitedNpc;
  if (source.visitedZone !== undefined) view.visitedZone = source.visitedZone;
  return view;
}

/** Newest export first; ties by character key, carrier state and visit, so the capped list is deterministic. */
function compareSourcesRecentFirst(a: SharedObservationSource, b: SharedObservationSource): number {
  return (
    b.exportObservedAt - a.exportObservedAt ||
    (a.sourceIdentityKey < b.sourceIdentityKey ? -1 : a.sourceIdentityKey > b.sourceIdentityKey ? 1 : 0) ||
    (a.carrierState < b.carrierState ? -1 : a.carrierState > b.carrierState ? 1 : 0) ||
    (a.snapshotVisit ?? 0) - (b.snapshotVisit ?? 0)
  );
}

function provenanceView(observation: ProjectedObservation): SharedProvenanceView {
  const ordered = [...observation.sources].sort(compareSourcesRecentFirst);
  return {
    totalSources: ordered.length,
    totalCharacters: observation.sourceCharacterKeys.length,
    sources: ordered.slice(0, SHARED_STORAGE_PROVENANCE_CAP).map(sourceView),
    truncated: ordered.length > SHARED_STORAGE_PROVENANCE_CAP,
  };
}

export function sharedObservationView(observation: ProjectedObservation, now: number): SharedObservationView {
  return {
    claimedObservedAt: observation.claimedObservedAt,
    effectiveObservedAt: observation.effectiveObservedAt,
    claimedAfterCarrier: observation.claimedAfterCarrier,
    ageSeconds: Math.max(0, now - observation.effectiveObservedAt),
    freshness: classifyFreshness(observation.effectiveObservedAt, now),
    completeness: observation.completeness,
    informative: observation.informative,
    contentHash: observation.contentHash,
    liveAtExport: observation.liveAtExport,
    carrierStates: [...observation.carrierStates],
    coverage: {
      observedTabs: [...observation.coverage.observedTabs],
      inaccessibleTabs: [...observation.coverage.inaccessibleTabs],
      unconfirmedTabs: [...observation.coverage.unconfirmedTabs],
      unidentifiedTabs: observation.coverage.unidentifiedTabs,
      observedContainerIds: [...observation.coverage.observedContainerIds],
    },
    content: observation.content,
    provenance: provenanceView(observation),
  };
}

export function sharedOwnerView(projection: OwnerProjection, now: number): SharedOwnerView {
  const view = (o: ProjectedObservation | undefined) => (o ? sharedObservationView(o, now) : null);
  return {
    owner: sharedOwnerIdentity(projection.owner, projection.guildName),
    basis: "DERIVED",
    current: view(projection.current),
    latestPartial: view(projection.latestPartial),
    broaderCoverageEarlier: view(projection.broaderCoverageEarlier),
    conflict: projection.conflict
      ? { effectiveObservedAt: projection.conflict.effectiveObservedAt, others: projection.conflict.others.map((o) => sharedObservationView(o, now)) }
      : null,
    observationCount: { ...projection.observationCount },
  };
}

export function buildSharedStorageResponse(projection: SharedStorageProjection, now: number): SharedStorageResponse {
  return {
    schema: "shared-storage-1",
    asOf: now,
    warband: projection.warband ? sharedOwnerView(projection.warband, now) : null,
    guilds: projection.guilds.map((g) => sharedOwnerView(g, now)),
  };
}
