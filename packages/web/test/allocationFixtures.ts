// Allocation-review JSON fixtures for web tests, shaped exactly like GET /api/versions/:version/allocation-review
// (each variant carries only the fields the core result variant carries). Not a test file.
import type {
  AccountAllocationReview,
  AllocationReason,
  AllocationReviewRead,
  BaseItemAggregationUnprovenResult,
  ConflictingDemandResult,
  Disposition,
  EvidenceContribution,
  ExplicitDemand,
  GuildContextEntry,
  HeldItemFacets,
  ItemStringIdentity,
  ResolvedAllocationResult,
  UnallocatedInventoryEntry,
  UnresolvedStorageScope,
} from "../src/types.ts";

const commodity = (id: number) => ({ kind: "commodity" as const, gameVersion: "retail" as const, baseItemId: id });

export function facets(over: Partial<HeldItemFacets> = {}): HeldItemFacets {
  return {
    confirmedItemStringIdentity: { class: "UNIFORM_ITEM_STRING", distinctItemStringCount: 1 },
    potentialItemStringIdentity: { class: "NONE_HELD", distinctItemStringCount: 0 },
    confirmedBinding: { boundRowCount: 0, unboundRowCount: 1, unknownRowCount: 0 },
    potentialBinding: { boundRowCount: 0, unboundRowCount: 0, unknownRowCount: 0 },
    ...over,
  };
}

const bags = (qty: number): EvidenceContribution => ({ scope: "character-bags", admissibility: "CONFIRMED", quantity: qty, identityKey: "retail::cairne::anchor", observedAt: 1 });

export interface ResolvedSpec {
  id: number;
  keep: number;
  have: number;
  disposition?: Disposition;
  purpose?: string;
  stableId?: string;
  reasons?: AllocationReason[];
  evidence?: EvidenceContribution[];
  guildContext?: GuildContextEntry[];
  potential?: number;
  hasUnresolvedEvidence?: boolean;
  facets?: Partial<HeldItemFacets>;
}

/** A RESOLVED result with the server's arithmetic (allocated = min, deficit/surplus = clamped differences). */
export function resolved(spec: ResolvedSpec): ResolvedAllocationResult {
  const deficit = Math.max(spec.keep - spec.have, 0);
  const surplus = Math.max(spec.have - spec.keep, 0);
  const disposition: Disposition = spec.disposition ?? (deficit > 0 ? "HOLD_ALLOCATED" : surplus > 0 ? "SEND_HELLOMAGS" : "NO_ACTION");
  return {
    resolution: "RESOLVED",
    commodity: commodity(spec.id),
    demand: { stableId: spec.stableId ?? `demand_${spec.id}`, requiredQuantity: spec.keep, ...(spec.purpose ? { purpose: spec.purpose } : {}) },
    confirmedAvailable: spec.have,
    potentialAdditionalAvailable: spec.potential ?? 0,
    hasUnresolvedEvidence: spec.hasUnresolvedEvidence ?? false,
    unresolvedScopes: spec.hasUnresolvedEvidence ? ["character-bank"] : [],
    allocated: Math.min(spec.have, spec.keep),
    confirmedDeficit: deficit,
    confirmedSurplus: surplus,
    ...facets(spec.facets),
    guildContext: spec.guildContext ?? [],
    disposition,
    reasons: spec.reasons ?? [{ code: "EXPLICIT_DEMAND_EXISTS" }],
    evidence: spec.evidence ?? [bags(spec.have)],
  };
}

export function unproven(spec: { id: number; keep: number; seen: number; identity: ItemStringIdentity; reasons?: AllocationReason[]; evidence?: EvidenceContribution[] }): BaseItemAggregationUnprovenResult {
  return {
    resolution: "BASE_ITEM_AGGREGATION_UNPROVEN",
    commodity: commodity(spec.id),
    demand: { stableId: `demand_${spec.id}`, requiredQuantity: spec.keep },
    confirmedQuantity: spec.seen,
    potentialQuantity: 0,
    hasUnresolvedEvidence: false,
    unresolvedScopes: [],
    ...facets({ confirmedItemStringIdentity: spec.identity }),
    guildContext: [],
    disposition: "REQUIRES_REVIEW",
    reasons: spec.reasons ?? [
      { code: "EXPLICIT_DEMAND_EXISTS" },
      { code: spec.identity.class === "ITEM_STRING_VARIANTS" ? "ITEM_STRING_VARIANTS_PRESENT" : "ITEM_STRING_INCOMPLETE" },
      { code: "BASE_ITEM_AGGREGATION_UNPROVEN", detail: "no allocation, deficit, or surplus is computed." },
    ],
    evidence: spec.evidence ?? [bags(spec.seen)],
  };
}

export function conflicting(id: number, demandIds: string[]): ConflictingDemandResult {
  return {
    resolution: "CONFLICTING_DEMAND",
    commodity: commodity(id),
    ...facets(),
    disposition: "REQUIRES_REVIEW",
    conflictingDemandIds: demandIds,
    guildContext: [],
    reasons: [{ code: "CONFLICTING_ACTIVE_DEMAND", detail: "2 active demands exist for this commodity; no priority is inferred." }],
    evidence: [bags(9)],
  };
}

export function heldEntry(spec: { id: number; seen: number; name?: string; potential?: number; potentialUnknownRows?: number; holdings?: EvidenceContribution[]; facets?: Partial<HeldItemFacets>; guildContext?: GuildContextEntry[] }): UnallocatedInventoryEntry {
  return {
    allocationState: "UNALLOCATED",
    baseItemId: spec.id,
    ...(spec.name !== undefined ? { name: spec.name } : {}),
    confirmedQuantity: spec.seen,
    potentialQuantity: spec.potential ?? 0,
    potentialUnknownQuantityRowCount: spec.potentialUnknownRows ?? 0,
    hasUnresolvedEvidence: (spec.holdings ?? []).some((h) => h.admissibility === "UNRESOLVED"),
    unresolvedScopes: [],
    holdings: spec.holdings ?? [bags(spec.seen)],
    guildContext: spec.guildContext ?? [],
    ...facets(spec.facets),
    metadataState: "UNKNOWN",
  };
}

export function demand(id: number, requiredQuantity: number, over: Partial<ExplicitDemand> = {}): ExplicitDemand {
  return { stableId: `demand_${id}`, gameVersion: "retail", demandType: "STOCK_TARGET", commodity: commodity(id), requiredQuantity, status: "ACTIVE", createdAt: 1_790_000_000, updatedAt: 1_790_000_000, ...over };
}

export function reviewData(over: Partial<AccountAllocationReview> & { demandedItems?: AccountAllocationReview["demanded"]["items"]; heldItems?: UnallocatedInventoryEntry[]; unresolved?: UnresolvedStorageScope[] } = {}): AccountAllocationReview {
  const { demandedItems = [], heldItems = [], unresolved = [], ...rest } = over;
  return {
    version: "retail",
    unresolvedStorage: unresolved,
    hasUnresolvedStorage: unresolved.length > 0,
    unidentifiedItemRowCount: 0,
    dispositionCounts: { HOLD_ALLOCATED: 0, REQUIRES_REVIEW: 0, SEND_HELLOMAGS: 0, NO_ACTION: 0 },
    unallocatedItemStringIdentityCounts: {
      confirmed: { UNIFORM_ITEM_STRING: 0, ITEM_STRING_VARIANTS: 0, ITEM_STRING_INCOMPLETE: 0, NONE_HELD: 0 },
      potential: { UNIFORM_ITEM_STRING: 0, ITEM_STRING_VARIANTS: 0, ITEM_STRING_INCOMPLETE: 0, NONE_HELD: 0 },
    },
    demanded: { items: demandedItems, offset: 0, limit: 50, totalCount: demandedItems.length, truncated: false },
    unallocated: { items: heldItems, offset: 0, limit: 50, totalCount: heldItems.length, truncated: false },
    itemNames: {},
    ...rest,
  };
}

export const read = (data: AccountAllocationReview): AllocationReviewRead => ({ data, provenance: { state: "DERIVED", version: "retail", source: "fixture" } });
