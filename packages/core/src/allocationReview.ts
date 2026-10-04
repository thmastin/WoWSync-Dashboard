// Azeroth ERP Vertical Slice 2 — Account Allocation Review (pure assembly).
//
// One account-wide, read-only partition of the account's base items into:
//   - demanded:    every base item with an ACTIVE STOCK_TARGET demand, evaluated by the SAME
//                  `allocationForItem` Slice 1's per-item `getItemAllocation` uses, over the SAME
//                  evidence projection (one `AccountOwnedEvidenceMap`). There is no second allocator.
//   - unallocated: every base item held in account-owned storage with NO active modeled demand.
//
// UNALLOCATED INVENTORY IS NOT SURPLUS. Surplus is only ever "what remains after an explicit demand was
// allocated" (Slice 1's `confirmedSurplus` on a RESOLVED result). An unallocated entry therefore has no
// surplus, no allocation numbers, no disposition, and no sale recommendation — structurally absent fields,
// not zero/NO_ACTION values. It reports evidence only: what is held, at which evidence tier, where.
//
// Everything here is DERIVED on every read and never persisted. Guild-owned evidence never contributes to
// account quantities and an item held only by a guild never becomes an unallocated account item. No price,
// valuation, threshold, or item metadata is an input to anything in this module.
import { allocationForItem, evidenceForItem, heldItemFacetsForItem, type AccountOwnedEvidenceMap, type AllocationEvidenceScope, type AllocationResult, type Disposition, type EvidenceContribution, type GuildContextEntry } from "./allocation.ts";
import type { ExplicitDemand } from "./demand.ts";
import { ITEM_STRING_IDENTITY_CLASSES, type HeldItemFacets, type ItemStringIdentityClass } from "./heldItemIdentity.ts";

/** A whole account-owned storage scope whose contents are UNKNOWN. It applies to every item. */
export interface UnresolvedStorageScope {
  readonly scope: AllocationEvidenceScope;
  /** Character scopes only. */
  readonly identityKey?: string;
}

/**
 * Account-owned base-item inventory that no ACTIVE demand currently explains or reserves. Deliberately
 * carries no surplus, allocation, disposition, or recommendation field: none of those can be determined
 * without an explicit demand.
 */
export interface UnallocatedInventoryEntry extends HeldItemFacets {
  readonly allocationState: "UNALLOCATED";
  readonly baseItemId: number;
  /** An item name as observed in the evidence, for presentation only. */
  readonly name?: string;
  /** Sum of reported quantities in CONFIRMED (OBSERVED) account-owned scopes. A floor when `hasUnresolvedEvidence`. */
  readonly confirmedQuantity: number;
  /**
   * Sum of KNOWN quantities in POTENTIAL (LAST_SEEN) account-owned scopes. Historical; never added into
   * `confirmedQuantity`. A floor, not a complete historical quantity, when `potentialUnknownQuantityRowCount > 0`.
   */
  readonly potentialQuantity: number;
  /**
   * Number of POTENTIAL (LAST_SEEN) item rows contributing to this entry whose quantity is unknown. When > 0,
   * `potentialQuantity` is only a known floor — the unknown rows are never 0 and no quantity is invented for
   * them. Historical-only uncertainty: it never affects confirmed numbers, so it never sets `hasUnresolvedEvidence`.
   */
  readonly potentialUnknownQuantityRowCount: number;
  /**
   * True when account-owned evidence that could change this item's CONFIRMED quantity is unresolved: a whole
   * storage scope is UNKNOWN (see the review's `unresolvedStorage`), or OBSERVED storage holds rows of this
   * item with unreported quantity (an `ITEM_QUANTITY_UNKNOWN` holding — the storage itself was observed).
   * Unreported LAST_SEEN quantities are reported by `potentialUnknownQuantityRowCount` instead.
   */
  readonly hasUnresolvedEvidence: boolean;
  readonly unresolvedScopes: AllocationEvidenceScope[];
  /**
   * The account-owned contributions that actually hold this item (reported quantity > 0, or rows with
   * unreported quantity), plus any `ITEM_QUANTITY_UNKNOWN` unresolved contribution for it. Whole-scope
   * UNKNOWN storage is reported once at the review level (`unresolvedStorage`), not repeated per item.
   */
  readonly holdings: EvidenceContribution[];
  /** Guild-owned evidence for the same item, context only. Never part of any quantity above. */
  readonly guildContext: GuildContextEntry[];
}

export type DispositionCounts = Record<Disposition, number>;

/**
 * Slice 3: how many unallocated entries fall into each item-string identity class, per evidence tier, over
 * the WHOLE unallocated list (not a page). Reporting only: unallocated entries are never filtered or reordered by class.
 */
export interface UnallocatedItemStringIdentityCounts {
  readonly confirmed: Record<ItemStringIdentityClass, number>;
  readonly potential: Record<ItemStringIdentityClass, number>;
}

export interface AllocationReviewParts {
  readonly unresolvedStorage: UnresolvedStorageScope[];
  readonly unidentifiedItemRowCount: number;
  /** Every demanded item, in review order (see DISPOSITION_REVIEW_ORDER), unpaged. */
  readonly demanded: AllocationResult[];
  readonly dispositionCounts: DispositionCounts;
  /** Every unallocated item, ascending base item id, unpaged. */
  readonly unallocated: UnallocatedInventoryEntry[];
  readonly unallocatedItemStringIdentityCounts: UnallocatedItemStringIdentityCounts;
}

/** Attention order for demanded results: shortfalls first, then review-gated, then sale-eligible, then nothing to do. A fixed order, not a score. */
export const DISPOSITION_REVIEW_ORDER: readonly Disposition[] = ["HOLD_ALLOCATED", "REQUIRES_REVIEW", "SEND_HELLOMAGS", "NO_ACTION"];

function sumTier(evidence: readonly EvidenceContribution[], admissibility: "CONFIRMED" | "POTENTIAL"): number {
  return evidence.filter((e) => e.admissibility === admissibility).reduce((total, e) => total + (e.quantity ?? 0), 0);
}

function holdsItem(contribution: EvidenceContribution): boolean {
  if (contribution.admissibility === "UNRESOLVED") return contribution.unresolvedCause === "ITEM_QUANTITY_UNKNOWN";
  return (contribution.quantity ?? 0) > 0 || (contribution.unknownQuantityRowCount ?? 0) > 0;
}

/** Every base item held (reported quantity > 0, or present with unreported quantity) in any CONFIRMED/POTENTIAL account-owned scope. Guild scopes are never consulted. */
function heldAccountItems(map: AccountOwnedEvidenceMap): Map<number, string | undefined> {
  const held = new Map<number, string | undefined>();
  for (const source of map.scopes) {
    if (!source.items) continue;
    for (const [baseItemId, tally] of source.items) {
      if (tally.knownQuantity <= 0 && tally.unknownQuantityRowCount === 0) continue;
      if (!held.has(baseItemId) || held.get(baseItemId) === undefined) held.set(baseItemId, tally.name);
    }
  }
  return held;
}

/**
 * The presentation name for one base item, read from the SAME account-owned evidence projection the review
 * uses: the first name any CONFIRMED/POTENTIAL account-owned scope recorded for it, or undefined when no
 * account-owned row carried one. Guild scopes are never consulted, and no other pipeline (AccountFacts, item
 * metadata) is read. Presentation only: never an input to allocation.
 */
export function itemNameForItem(map: AccountOwnedEvidenceMap, baseItemId: number): string | undefined {
  for (const source of map.scopes) {
    const name = source.items?.get(baseItemId)?.name;
    if (name !== undefined) return name;
  }
  return undefined;
}

/**
 * The Dashboard Allocation tab's unallocated search. An empty or whitespace-only query returns the list
 * unchanged. Otherwise an entry matches when its observed name contains the query case-insensitively, or when
 * the query is all digits and equals its base item id exactly. An entry with no observed name can still be
 * found by its id, so no held inventory is unreachable. Order is preserved; this never reclassifies anything.
 */
export function filterUnallocatedByQuery<T extends Pick<UnallocatedInventoryEntry, "baseItemId" | "name">>(entries: readonly T[], query: string | undefined): T[] {
  const needle = (query ?? "").trim().toLowerCase();
  if (needle === "") return [...entries];
  const exactId = /^\d+$/.test(needle) ? Number(needle) : undefined;
  return entries.filter((entry) => entry.baseItemId === exactId || (entry.name !== undefined && entry.name.toLowerCase().includes(needle)));
}

/**
 * Builds the full (unpaged) account allocation review from one evidence projection and the version's
 * demands. Pure: no I/O, no clock reads. `demands` may contain any status/type; only ACTIVE STOCK_TARGET
 * demands allocate. More than one ACTIVE demand for one item is handed to `buildAllocationResult`, which
 * returns its explicit CONFLICTING_DEMAND result rather than a chosen winner.
 */
export function buildAllocationReview(map: AccountOwnedEvidenceMap, demands: readonly ExplicitDemand[]): AllocationReviewParts {
  const activeByItem = new Map<number, ExplicitDemand[]>();
  for (const demand of demands) {
    if (demand.status !== "ACTIVE" || demand.demandType !== "STOCK_TARGET") continue;
    const list = activeByItem.get(demand.commodity.baseItemId) ?? [];
    list.push(demand);
    activeByItem.set(demand.commodity.baseItemId, list);
  }

  const order = new Map(DISPOSITION_REVIEW_ORDER.map((disposition, index) => [disposition, index]));
  const demanded = [...activeByItem.entries()]
    .map(([baseItemId, active]) => allocationForItem(map, baseItemId, active))
    .sort((a, b) => order.get(a.disposition)! - order.get(b.disposition)! || a.commodity.baseItemId - b.commodity.baseItemId);

  const dispositionCounts: DispositionCounts = { HOLD_ALLOCATED: 0, REQUIRES_REVIEW: 0, SEND_HELLOMAGS: 0, NO_ACTION: 0 };
  for (const result of demanded) dispositionCounts[result.disposition]++;

  const unallocated: UnallocatedInventoryEntry[] = [...heldAccountItems(map).entries()]
    .filter(([baseItemId]) => !activeByItem.has(baseItemId))
    .sort(([a], [b]) => a - b)
    .map(([baseItemId, name]) => {
      const { evidence, guildContext } = evidenceForItem(map, baseItemId);
      const unresolved = evidence.filter((e) => e.admissibility === "UNRESOLVED");
      return {
        allocationState: "UNALLOCATED" as const,
        baseItemId,
        ...(name !== undefined ? { name } : {}),
        confirmedQuantity: sumTier(evidence, "CONFIRMED"),
        potentialQuantity: sumTier(evidence, "POTENTIAL"),
        potentialUnknownQuantityRowCount: evidence.filter((e) => e.admissibility === "POTENTIAL").reduce((total, e) => total + (e.unknownQuantityRowCount ?? 0), 0),
        hasUnresolvedEvidence: unresolved.length > 0,
        unresolvedScopes: [...new Set(unresolved.map((e) => e.scope))],
        holdings: evidence.filter(holdsItem),
        guildContext,
        ...heldItemFacetsForItem(map, baseItemId),
      };
    });

  const zeroCounts = (): Record<ItemStringIdentityClass, number> => Object.fromEntries(ITEM_STRING_IDENTITY_CLASSES.map((c) => [c, 0])) as Record<ItemStringIdentityClass, number>;
  const unallocatedItemStringIdentityCounts = { confirmed: zeroCounts(), potential: zeroCounts() };
  for (const entry of unallocated) {
    unallocatedItemStringIdentityCounts.confirmed[entry.confirmedItemStringIdentity.class]++;
    unallocatedItemStringIdentityCounts.potential[entry.potentialItemStringIdentity.class]++;
  }

  const unresolvedStorage: UnresolvedStorageScope[] = map.scopes
    .filter((source) => !source.items)
    .map((source) => ({ scope: source.scope, ...(source.identityKey !== undefined ? { identityKey: source.identityKey } : {}) }));

  return { unresolvedStorage, unidentifiedItemRowCount: map.unidentifiedItemRowCount, demanded, dispositionCounts, unallocated, unallocatedItemStringIdentityCounts };
}
