// Azeroth ERP Vertical Slice 1 — the pure allocation domain.
//
// Everything here is DERIVED, never persisted (see demand.ts for the one new durable concept). The
// result is computed fresh on every read from: one commodity's explicit demand (if any), plus the
// account's already-observed inventory evidence. Nothing here stores a new inventory ledger, a
// decision, a surplus, a deficit, or a disposition — the next read recomputes all of it from the same
// observations and the same demand.
//
// Core invariants enforced structurally by this module (see docs/AZEROTH_ERP_ARCHITECTURE.md):
//   - UNKNOWN is never zero: an UNRESOLVED evidence contribution carries no `quantity` at all.
//   - LAST_SEEN (POTENTIAL) evidence can never satisfy demand or create confirmed surplus; it is kept
//     in a separate total (`potentialAdditionalAvailable`), never folded into `confirmedAvailable`.
//   - Guild-owned evidence is reported in `guildContext`, a field the arithmetic never reads.
//   - Missing demand is structurally distinct from zero demand or zero availability: `NO_ACTIVE_DEMAND`
//     carries no allocated/deficit/surplus numbers at all (a discriminated union, not optional fields).
//   - Conservative gate: a mathematically confirmed FLOOR surplus may still be reported precisely even
//     while account-owned evidence remains unresolved elsewhere, but disposition will never recommend
//     SEND_HELLOMAGS while that uncertainty exists — REQUIRES_REVIEW instead. Arithmetic precision under
//     uncertainty and disposition caution under uncertainty are deliberately two different questions.
//   - Slice 3 (held-item identity and binding, see heldItemIdentity.ts): confirmed arithmetic is performed only
//     when the CONFIRMED rows' item strings prove base-item aggregation is valid; otherwise the result is
//     BASE_ITEM_AGGREGATION_UNPROVEN and carries no allocated/deficit/surplus numbers at all. Confirmed bound or
//     binding-unknown rows withhold SEND_HELLOMAGS from a confirmed surplus (arithmetic unchanged). Neither gate
//     is unresolved evidence, and LAST_SEEN identity/binding facts are reported but never gate anything.
import { itemIdFromItemRef } from "./itemMetadata.ts";
import { allowsBaseItemAggregation, classifyItemStringIdentity, emptyHeldRowFacts, parseItemString, recordHeldRow, sumBinding, type HeldItemFacets, type HeldRowFacts } from "./heldItemIdentity.ts";
import { commodityIdentity, type CommodityIdentity, type ExplicitDemand } from "./demand.ts";
import type { SnapshotReadStore } from "./store.ts";
import type { VersionOrUnknown } from "./types.ts";

export type AllocationAdmissibility = "CONFIRMED" | "POTENTIAL" | "UNRESOLVED";

/** Where one account-eligible evidence contribution came from. Guild storage is never a scope here. */
export type AllocationEvidenceScope = "character-bags" | "character-bank" | "warband";

/**
 * Why an UNRESOLVED contribution is unresolved:
 *   STORAGE_UNKNOWN       - the whole storage scope is UNKNOWN (a character's bags/bank section never
 *                           observed, or a Warband never observed at all). Applies to every item.
 *   ITEM_QUANTITY_UNKNOWN - the scope itself WAS observed (OBSERVED, CONFIRMED tier) and holds row(s) of
 *                           this item, but the export did not report those rows' quantity. The storage is
 *                           not unknown; the item quantity is. The scope's known-quantity rows still count
 *                           as a confirmed floor; the unknown rows are never counted as 0.
 * A LAST_SEEN (POTENTIAL) scope's unknown-quantity rows never produce an UNRESOLVED contribution: they are
 * counted by `unknownQuantityRowCount` on the POTENTIAL contribution only (historical evidence can never
 * reach confirmed numbers, so it cannot gate them).
 */
export type UnresolvedEvidenceCause = "STORAGE_UNKNOWN" | "ITEM_QUANTITY_UNKNOWN";

/**
 * One contribution toward (or unresolved gap in) account-owned evidence for one base item.
 * `quantity` is absent exactly when `admissibility` is "UNRESOLVED" — never 0. On a CONFIRMED/POTENTIAL
 * contribution, `quantity` sums only rows whose quantity was reported; `unknownQuantityRowCount` (present
 * only when > 0) counts rows of this item whose quantity was not reported, so the sum is a known floor,
 * never a complete quantity and never a reason to read the unknown rows as 0.
 */
export interface EvidenceContribution {
  readonly scope: AllocationEvidenceScope;
  readonly admissibility: AllocationAdmissibility;
  readonly quantity?: number;
  readonly unknownQuantityRowCount?: number;
  /** UNRESOLVED contributions only. */
  readonly unresolvedCause?: UnresolvedEvidenceCause;
  /** Character scopes only. */
  readonly identityKey?: string;
  readonly observedAt?: number;
}

/** Guild-owned evidence, reported for context. The allocation arithmetic never reads this. */
export interface GuildContextEntry {
  readonly ownerKey: string;
  readonly admissibility: AllocationAdmissibility;
  readonly quantity?: number;
  readonly unknownQuantityRowCount?: number;
  readonly observedAt?: number;
}

export type AllocationReasonCode =
  | "EXPLICIT_DEMAND_EXISTS"
  | "NO_ACTIVE_DEMAND"
  | "CONFLICTING_ACTIVE_DEMAND"
  | "CONFIRMED_INVENTORY_BELOW_DEMAND"
  | "CONFIRMED_INVENTORY_MEETS_DEMAND"
  | "LAST_SEEN_INVENTORY_PRESENT"
  | "LAST_SEEN_NOT_ADMISSIBLE"
  | "UNRESOLVED_STORAGE_PRESENT"
  | "ITEM_QUANTITY_UNKNOWN_PRESENT"
  | "SURPLUS_CONFIRMED"
  | "SALE_DISPOSITION_GATED_BY_UNRESOLVED_EVIDENCE"
  | "SALE_PIPELINE_APPROVED"
  | "GUILD_EVIDENCE_EXCLUDED"
  // Slice 3 facts (CONFIRMED tier): independent of unknown storage, unknown quantity, and LAST_SEEN evidence.
  | "ITEM_STRING_VARIANTS_PRESENT"
  | "ITEM_STRING_INCOMPLETE"
  | "BOUND_INVENTORY_PRESENT"
  | "BINDING_UNKNOWN_PRESENT"
  // Slice 3 effects.
  | "BASE_ITEM_AGGREGATION_UNPROVEN"
  | "SALE_DISPOSITION_GATED_BY_BINDING";

export interface AllocationReason {
  readonly code: AllocationReasonCode;
  readonly detail?: string;
}

/**
 * SEND_HELLOMAGS means confirmed unallocated account surplus is ELIGIBLE for the Retail sale-inventory
 * pipeline — a recommendation, never an execution: it does not mail, move, vendor, or post anything.
 * REQUIRES_REVIEW means the same arithmetic question is gated by unresolved account-owned evidence.
 */
export type Disposition = "HOLD_ALLOCATED" | "SEND_HELLOMAGS" | "NO_ACTION" | "REQUIRES_REVIEW";

export type AllocationResolution = "RESOLVED" | "NO_ACTIVE_DEMAND" | "CONFLICTING_DEMAND" | "BASE_ITEM_AGGREGATION_UNPROVEN";

/**
 * Every read-model result carries the four held-row facets (see heldItemIdentity.ts). They are optional on the
 * pre-Slice-3 variants only because a hand-built pure call may supply no row facts, in which case the Slice 1/2
 * semantics apply unchanged (mirroring how evidence with no recorded unresolved cause keeps its original meaning).
 */
interface AllocationResultBase extends Partial<HeldItemFacets> {
  readonly commodity: CommodityIdentity;
  readonly guildContext: GuildContextEntry[];
  readonly reasons: AllocationReason[];
  readonly evidence: EvidenceContribution[];
}

/** Structurally distinct from a resolved zero-requirement or zero-availability demand: no numbers at all. */
export interface NoActiveDemandResult extends AllocationResultBase {
  readonly resolution: "NO_ACTIVE_DEMAND";
  readonly disposition: "NO_ACTION";
}

/**
 * Defensive-only: the read model never passes more than one active demand for a commodity (persistence
 * and the API both prevent that state). This exists so the pure allocator never silently invents a
 * priority if it is ever handed contradictory input directly (e.g. in a test, or a future caller).
 */
export interface ConflictingDemandResult extends AllocationResultBase {
  readonly resolution: "CONFLICTING_DEMAND";
  readonly disposition: "REQUIRES_REVIEW";
  readonly conflictingDemandIds: string[];
}

export interface ResolvedAllocationResult extends AllocationResultBase {
  readonly resolution: "RESOLVED";
  readonly demand: Pick<ExplicitDemand, "stableId" | "requiredQuantity" | "purpose">;
  /** Sum of CONFIRMED (OBSERVED-admissible) contributions only. */
  readonly confirmedAvailable: number;
  /**
   * Sum of KNOWN POTENTIAL (LAST_SEEN) quantities. Can never satisfy demand or create confirmed surplus. A
   * floor when LAST_SEEN rows have unreported quantity (then LAST_SEEN_INVENTORY_PRESENT says so).
   */
  readonly potentialAdditionalAvailable: number;
  readonly hasUnresolvedEvidence: boolean;
  /** Scopes with any UNRESOLVED contribution, whatever the cause; the reasons distinguish unknown storage from unknown item quantity. */
  readonly unresolvedScopes: AllocationEvidenceScope[];
  readonly allocated: number;
  readonly confirmedDeficit: number;
  /** A mathematically confirmed FLOOR: it can only grow if an unresolved scope turns out to hold more, never shrink. */
  readonly confirmedSurplus: number;
  readonly disposition: Disposition;
}

/**
 * An active, otherwise-allocatable demand whose CONFIRMED rows do not prove that base-item aggregation is
 * valid (`confirmedItemStringIdentity` is ITEM_STRING_VARIANTS or ITEM_STRING_INCOMPLETE). Like
 * NO_ACTIVE_DEMAND, it STRUCTURALLY carries no `allocated`, `confirmedDeficit`, or `confirmedSurplus`: the
 * arithmetic cannot honestly be performed, so no zero or approximate value is substituted.
 */
export interface BaseItemAggregationUnprovenResult extends Omit<AllocationResultBase, keyof HeldItemFacets>, HeldItemFacets {
  readonly resolution: "BASE_ITEM_AGGREGATION_UNPROVEN";
  readonly demand: Pick<ExplicitDemand, "stableId" | "requiredQuantity" | "purpose">;
  /** Sum of reported CONFIRMED (OBSERVED) quantities across rows that may not be one aggregable item. A floor when `hasUnresolvedEvidence`. */
  readonly confirmedQuantity: number;
  /** Sum of KNOWN POTENTIAL (LAST_SEEN) quantities; historical, never confirmed. */
  readonly potentialQuantity: number;
  readonly hasUnresolvedEvidence: boolean;
  readonly unresolvedScopes: AllocationEvidenceScope[];
  readonly disposition: "REQUIRES_REVIEW";
}

export type AllocationResult = NoActiveDemandResult | ConflictingDemandResult | BaseItemAggregationUnprovenResult | ResolvedAllocationResult;

function scopeList(evidence: readonly EvidenceContribution[]): AllocationEvidenceScope[] {
  return [...new Set(evidence.map((e) => e.scope))];
}

function sum(evidence: readonly EvidenceContribution[], admissibility: AllocationAdmissibility): number {
  return evidence.filter((e) => e.admissibility === admissibility).reduce((total, e) => total + (e.quantity ?? 0), 0);
}

/**
 * The deterministic core-domain allocation decision. Pure: no I/O, no clock reads. `activeDemands` is
 * everything the caller found ACTIVE for this commodity — normally 0 or 1 (persistence and the API both
 * enforce at most one), but this function never assumes that; 2+ produces an explicit CONFLICTING_DEMAND
 * result rather than picking a winner.
 */
export function buildAllocationResult(
  commodity: CommodityIdentity,
  activeDemands: readonly ExplicitDemand[],
  evidence: readonly EvidenceContribution[],
  guildContext: readonly GuildContextEntry[] = [],
  held?: HeldItemFacets,
): AllocationResult {
  const confirmedAvailable = sum(evidence, "CONFIRMED");
  const potentialAdditionalAvailable = sum(evidence, "POTENTIAL");
  const unresolved = evidence.filter((e) => e.admissibility === "UNRESOLVED");
  const hasUnresolvedEvidence = unresolved.length > 0;
  const unresolvedScopes = scopeList(unresolved);
  // Cause-aware explanation: an unreported quantity in OBSERVED storage is not unknown storage. Evidence
  // with no recorded cause (hand-built Slice 1 inputs) keeps the original storage meaning.
  const quantityUnknown = unresolved.filter((e) => e.unresolvedCause === "ITEM_QUANTITY_UNKNOWN");
  const storageUnknown = unresolved.filter((e) => e.unresolvedCause !== "ITEM_QUANTITY_UNKNOWN");
  const potential = evidence.filter((e) => e.admissibility === "POTENTIAL");
  const potentialUnknownQuantityRows = potential.reduce((total, e) => total + (e.unknownQuantityRowCount ?? 0), 0);
  const guildReasons: AllocationReason[] = guildContext.some((g) => (g.quantity ?? 0) > 0)
    ? [{ code: "GUILD_EVIDENCE_EXCLUDED", detail: "Guild-owned evidence is reported for context only; it never satisfies or inflates account demand." }]
    : [];
  const facets: Partial<HeldItemFacets> = held
    ? { confirmedItemStringIdentity: held.confirmedItemStringIdentity, potentialItemStringIdentity: held.potentialItemStringIdentity, confirmedBinding: held.confirmedBinding, potentialBinding: held.potentialBinding }
    : {};

  if (activeDemands.length > 1) {
    return {
      resolution: "CONFLICTING_DEMAND",
      commodity,
      ...facets,
      disposition: "REQUIRES_REVIEW",
      conflictingDemandIds: activeDemands.map((d) => d.stableId).sort(),
      guildContext: [...guildContext],
      reasons: [{ code: "CONFLICTING_ACTIVE_DEMAND", detail: `${activeDemands.length} active demands exist for this commodity; no priority is inferred.` }, ...guildReasons],
      evidence: [...evidence],
    };
  }

  if (activeDemands.length === 0) {
    return {
      resolution: "NO_ACTIVE_DEMAND",
      commodity,
      ...facets,
      disposition: "NO_ACTION",
      guildContext: [...guildContext],
      reasons: [{ code: "NO_ACTIVE_DEMAND", detail: "No active explicit demand exists for this commodity; observed inventory alone is never treated as surplus." }, ...guildReasons],
      evidence: [...evidence],
    };
  }

  const demand = activeDemands[0]!;
  const demandView = { stableId: demand.stableId, requiredQuantity: demand.requiredQuantity, ...(demand.purpose !== undefined ? { purpose: demand.purpose } : {}) };

  // Slice 3 factual reasons, CONFIRMED tier only (LAST_SEEN facts are reported by the potential facets).
  const identityReasons: AllocationReason[] = [];
  const bindingReasons: AllocationReason[] = [];
  if (held) {
    const identity = held.confirmedItemStringIdentity;
    if (identity.class === "ITEM_STRING_VARIANTS") {
      identityReasons.push({ code: "ITEM_STRING_VARIANTS_PRESENT", detail: `Confirmed rows of this base item carry ${identity.distinctItemStringCount} distinct normalized item strings (viewer linkLevel/specID ignored); they may not be one aggregable item.` });
    } else if (identity.class === "ITEM_STRING_INCOMPLETE") {
      identityReasons.push({ code: "ITEM_STRING_INCOMPLETE", detail: "At least one confirmed row was captured only as a bare item:<id>; its remaining item-string fields are unknown, not empty." });
    }
    if (held.confirmedBinding.boundRowCount > 0) {
      bindingReasons.push({ code: "BOUND_INVENTORY_PRESENT", detail: `${held.confirmedBinding.boundRowCount} confirmed row(s) are reported bound by the client (soulbound and account/Warbound are not distinguished); those units may be restricted.` });
    }
    if (held.confirmedBinding.unknownRowCount > 0) {
      bindingReasons.push({ code: "BINDING_UNKNOWN_PRESENT", detail: `${held.confirmedBinding.unknownRowCount} confirmed row(s) have unknown binding state.` });
    }
  }

  // Shared factual reasons (identical wording on RESOLVED and BASE_ITEM_AGGREGATION_UNPROVEN).
  const evidenceReasons: AllocationReason[] = [];
  // LAST_SEEN evidence exists when it has a known quantity OR rows of unreported quantity. The unknown rows
  // are reported, never counted: they add nothing to potentialAdditionalAvailable and gate nothing.
  if (potentialAdditionalAvailable > 0 || potentialUnknownQuantityRows > 0) {
    evidenceReasons.push(
      potentialUnknownQuantityRows > 0
        ? { code: "LAST_SEEN_INVENTORY_PRESENT", detail: `${potentialUnknownQuantityRows} LAST_SEEN item row(s) have unreported quantity; potentialAdditionalAvailable (${potentialAdditionalAvailable}) counts known quantities only and is a floor, not a complete historical quantity.` }
        : { code: "LAST_SEEN_INVENTORY_PRESENT" },
      { code: "LAST_SEEN_NOT_ADMISSIBLE", detail: "Historical LAST_SEEN evidence cannot satisfy demand or create confirmed surplus." },
    );
  }
  if (storageUnknown.length > 0) {
    evidenceReasons.push({ code: "UNRESOLVED_STORAGE_PRESENT", detail: `Unresolved account-owned storage scope(s): ${scopeList(storageUnknown).join(", ")}.` });
  }
  if (quantityUnknown.length > 0) {
    evidenceReasons.push({ code: "ITEM_QUANTITY_UNKNOWN_PRESENT", detail: `Observed account-owned storage holds item row(s) with unreported quantity in: ${scopeList(quantityUnknown).join(", ")}. The storage was observed; only those rows' quantities are unknown, so confirmed quantities are a floor.` });
  }

  if (held && !allowsBaseItemAggregation(held.confirmedItemStringIdentity)) {
    return {
      resolution: "BASE_ITEM_AGGREGATION_UNPROVEN",
      commodity,
      demand: demandView,
      confirmedQuantity: confirmedAvailable,
      potentialQuantity: potentialAdditionalAvailable,
      hasUnresolvedEvidence,
      unresolvedScopes,
      confirmedItemStringIdentity: held.confirmedItemStringIdentity,
      potentialItemStringIdentity: held.potentialItemStringIdentity,
      confirmedBinding: held.confirmedBinding,
      potentialBinding: held.potentialBinding,
      guildContext: [...guildContext],
      disposition: "REQUIRES_REVIEW",
      reasons: [
        { code: "EXPLICIT_DEMAND_EXISTS" },
        ...identityReasons,
        { code: "BASE_ITEM_AGGREGATION_UNPROVEN", detail: "Confirmed rows of this base item are not proven to be one aggregable item, so no allocation, deficit, or surplus is computed." },
        ...evidenceReasons,
        ...bindingReasons,
        ...guildReasons,
      ],
      evidence: [...evidence],
    };
  }

  const allocated = Math.min(confirmedAvailable, demand.requiredQuantity);
  const confirmedDeficit = Math.max(demand.requiredQuantity - confirmedAvailable, 0);
  const confirmedSurplus = Math.max(confirmedAvailable - demand.requiredQuantity, 0);

  const reasons: AllocationReason[] = [{ code: "EXPLICIT_DEMAND_EXISTS" }];
  reasons.push({ code: confirmedDeficit > 0 ? "CONFIRMED_INVENTORY_BELOW_DEMAND" : "CONFIRMED_INVENTORY_MEETS_DEMAND" });
  reasons.push(...evidenceReasons, ...bindingReasons);
  // Binding is not unresolved evidence: it never sets hasUnresolvedEvidence. It only withholds the sale
  // recommendation from a confirmed surplus. bound=no rows never gate, but certify nothing either.
  const bindingGates = held !== undefined && (held.confirmedBinding.boundRowCount > 0 || held.confirmedBinding.unknownRowCount > 0);

  let disposition: Disposition;
  if (confirmedDeficit > 0) {
    disposition = "HOLD_ALLOCATED";
  } else if (confirmedSurplus === 0) {
    disposition = "NO_ACTION";
  } else {
    reasons.push({ code: "SURPLUS_CONFIRMED" });
    if (hasUnresolvedEvidence || bindingGates) {
      disposition = "REQUIRES_REVIEW";
      if (hasUnresolvedEvidence) {
        reasons.push({ code: "SALE_DISPOSITION_GATED_BY_UNRESOLVED_EVIDENCE", detail: "A confirmed floor surplus exists, but unresolved account-owned evidence gates sale-pipeline disposition until it is resolved." });
      }
      if (bindingGates) {
        reasons.push({ code: "SALE_DISPOSITION_GATED_BY_BINDING", detail: "A confirmed surplus exists, but confirmed rows are bound or of unknown binding state; those units may be restricted, so the sale pipeline is not recommended." });
      }
    } else {
      disposition = "SEND_HELLOMAGS";
      reasons.push({ code: "SALE_PIPELINE_APPROVED" });
    }
  }
  reasons.push(...guildReasons);

  return {
    resolution: "RESOLVED",
    commodity,
    demand: demandView,
    confirmedAvailable,
    potentialAdditionalAvailable,
    hasUnresolvedEvidence,
    unresolvedScopes,
    allocated,
    confirmedDeficit,
    confirmedSurplus,
    ...facets,
    guildContext: [...guildContext],
    disposition,
    reasons,
    evidence: [...evidence],
  };
}

/** What one storage scope holds of one base item: reported quantities summed, unreported-quantity rows counted (never summed as 0). */
export interface ItemTally {
  readonly knownQuantity: number;
  readonly unknownQuantityRowCount: number;
  /** The first item name observed for this base item in this scope, for presentation only. */
  readonly name?: string;
  /** Slice 3: normalized item strings, bare-row presence, and binding row counts for this item in this scope. */
  readonly heldRows: Readonly<HeldRowFacts>;
}

/**
 * One account-owned storage scope, projected once for every item it holds. `items` is absent exactly when
 * the scope is UNRESOLVED (its contents are unknown, never empty).
 */
export interface AccountScopeEvidence {
  readonly scope: AllocationEvidenceScope;
  readonly admissibility: AllocationAdmissibility;
  readonly identityKey?: string;
  readonly observedAt?: number;
  readonly items?: ReadonlyMap<number, ItemTally>;
}

/** One guild owner's current observation, projected once. Context only: no allocation arithmetic reads it. */
export interface GuildScopeEvidence {
  readonly ownerKey: string;
  readonly admissibility: AllocationAdmissibility;
  readonly observedAt?: number;
  readonly items: ReadonlyMap<number, ItemTally>;
}

/**
 * The account-wide evidence projection: every account-owned scope (and, separately, every guild owner),
 * each tallied by base item id in ONE pass over the stored evidence. The per-item allocation path
 * (`evidenceForItem`) and the account-wide review are both lookups into this one structure, so they cannot
 * disagree about what any scope holds.
 */
export interface AccountOwnedEvidenceMap {
  readonly scopes: readonly AccountScopeEvidence[];
  readonly guilds: readonly GuildScopeEvidence[];
  /** Item rows in CONFIRMED/POTENTIAL account-owned scopes whose itemRef carries no base item id; they can never be attributed to an item. */
  readonly unidentifiedItemRowCount: number;
}

function tallyItems(items: readonly { itemRef?: string; name?: string; qty?: number; bound?: string }[]): { tallies: Map<number, ItemTally>; unidentified: number } {
  const tallies = new Map<number, { knownQuantity: number; unknownQuantityRowCount: number; name?: string; heldRows: HeldRowFacts }>();
  let unidentified = 0;
  for (const item of items) {
    const baseItemId = itemIdFromItemRef(item.itemRef);
    if (baseItemId === undefined) {
      unidentified++;
      continue;
    }
    let tally = tallies.get(baseItemId);
    if (!tally) {
      tally = { knownQuantity: 0, unknownQuantityRowCount: 0, ...(item.name !== undefined ? { name: item.name } : {}), heldRows: emptyHeldRowFacts() };
      tallies.set(baseItemId, tally);
    }
    if (tally.name === undefined && item.name !== undefined) tally.name = item.name;
    // A present row with no reported quantity is uncertainty, never an observed 0.
    if (item.qty === undefined) tally.unknownQuantityRowCount++;
    else tally.knownQuantity += item.qty;
    // An itemRef with a base item id that is not a recognizable full string is treated as incomplete, never as uniform.
    recordHeldRow(tally.heldRows, parseItemString(item.itemRef) ?? { kind: "BARE" }, item.bound);
  }
  return { tallies, unidentified };
}

/**
 * The small adapter the investigation anticipated might be needed: no unified "account-owned inventory
 * projection" existed before Slice 1. Projects existing character-storage and shared-storage evidence
 * once, for every item, reading each character's latest snapshot and the shared-storage projection exactly
 * once. Reads only; stores nothing.
 *
 * Every account-owned scope is represented: an UNKNOWN character bags/bank section, or a Warband never
 * observed, is an UNRESOLVED scope with no item tallies (never silently omitted, never empty). Guild-owned
 * evidence is kept in a separate `guilds` list and is structurally never mixed into `scopes`.
 */
export function projectAccountOwnedEvidenceMap(store: SnapshotReadStore, version: VersionOrUnknown): AccountOwnedEvidenceMap {
  const scopes: AccountScopeEvidence[] = [];
  let unidentifiedItemRowCount = 0;

  for (const character of store.listCharacters(version)) {
    const snapshot = store.listSnapshots(character.identityKey)[0];
    if (!snapshot) continue;
    for (const storage of ["bags", "bank"] as const) {
      const section = snapshot.parsed[storage];
      const scope: AllocationEvidenceScope = storage === "bags" ? "character-bags" : "character-bank";
      const observedAt = section.status.observedAt ?? snapshot.generatedAt ?? snapshot.importedAt;
      if (section.status.state === "OBSERVED" || section.status.state === "LAST_SEEN") {
        const { tallies, unidentified } = tallyItems(section.items);
        unidentifiedItemRowCount += unidentified;
        scopes.push({ scope, admissibility: section.status.state === "OBSERVED" ? "CONFIRMED" : "POTENTIAL", identityKey: character.identityKey, observedAt, items: tallies });
      } else {
        scopes.push({ scope, admissibility: "UNRESOLVED", identityKey: character.identityKey });
      }
    }
  }

  const projection = version === "retail" ? store.projectSharedStorage() : { warband: undefined, guilds: [] };
  if (!projection.warband?.current) {
    scopes.push({ scope: "warband", admissibility: "UNRESOLVED" });
  } else {
    const current = projection.warband.current;
    const { tallies, unidentified } = tallyItems(current.content.items);
    unidentifiedItemRowCount += unidentified;
    scopes.push({ scope: "warband", admissibility: current.liveAtExport ? "CONFIRMED" : "POTENTIAL", observedAt: current.effectiveObservedAt, items: tallies });
  }

  const guilds: GuildScopeEvidence[] = projection.guilds
    .filter((guild): guild is typeof guild & { current: NonNullable<(typeof guild)["current"]> } => guild.current !== undefined)
    .map((guild) => ({
      ownerKey: guild.ownerKey,
      admissibility: guild.current.liveAtExport ? "CONFIRMED" : "POTENTIAL",
      observedAt: guild.current.effectiveObservedAt,
      items: tallyItems(guild.current.content.items).tallies,
    }));

  return { scopes, guilds, unidentifiedItemRowCount };
}

/**
 * The per-item view of the account-wide projection: exactly the EvidenceContribution list and guild
 * context `buildAllocationResult` consumes. Pure lookup; no store access.
 *
 * A CONFIRMED scope holding rows of this item with unreported quantity contributes its reported quantity
 * as a confirmed floor PLUS a companion UNRESOLVED (`ITEM_QUANTITY_UNKNOWN`) contribution, so the existing
 * conservative gate applies to it (its explanation is ITEM_QUANTITY_UNKNOWN_PRESENT, not unknown storage).
 * A POTENTIAL scope's unreported rows are flagged by `unknownQuantityRowCount` only: historical evidence can
 * never reach confirmed numbers, so it cannot gate them; it is still reported as LAST_SEEN evidence.
 */
export function evidenceForItem(map: AccountOwnedEvidenceMap, baseItemId: number): { evidence: EvidenceContribution[]; guildContext: GuildContextEntry[] } {
  const evidence: EvidenceContribution[] = [];
  for (const source of map.scopes) {
    const identity = source.identityKey !== undefined ? { identityKey: source.identityKey } : {};
    if (!source.items) {
      evidence.push({ scope: source.scope, admissibility: "UNRESOLVED", unresolvedCause: "STORAGE_UNKNOWN", ...identity });
      continue;
    }
    const tally = source.items.get(baseItemId);
    const unknownRows = tally?.unknownQuantityRowCount ?? 0;
    evidence.push({
      scope: source.scope,
      admissibility: source.admissibility,
      quantity: tally?.knownQuantity ?? 0,
      ...(unknownRows > 0 ? { unknownQuantityRowCount: unknownRows } : {}),
      ...identity,
      ...(source.observedAt !== undefined ? { observedAt: source.observedAt } : {}),
    });
    if (unknownRows > 0 && source.admissibility === "CONFIRMED") {
      evidence.push({ scope: source.scope, admissibility: "UNRESOLVED", unresolvedCause: "ITEM_QUANTITY_UNKNOWN", ...identity, ...(source.observedAt !== undefined ? { observedAt: source.observedAt } : {}) });
    }
  }
  const guildContext: GuildContextEntry[] = map.guilds.map((guild) => {
    const tally = guild.items.get(baseItemId);
    const unknownRows = tally?.unknownQuantityRowCount ?? 0;
    return {
      ownerKey: guild.ownerKey,
      admissibility: guild.admissibility,
      quantity: tally?.knownQuantity ?? 0,
      ...(unknownRows > 0 ? { unknownQuantityRowCount: unknownRows } : {}),
      ...(guild.observedAt !== undefined ? { observedAt: guild.observedAt } : {}),
    };
  });
  return { evidence, guildContext };
}

/** Slice 1's per-item entry point, unchanged in signature and result: a lookup into the account-wide projection. */
export function projectAccountOwnedEvidence(
  store: SnapshotReadStore,
  version: VersionOrUnknown,
  baseItemId: number,
): { evidence: EvidenceContribution[]; guildContext: GuildContextEntry[] } {
  return evidenceForItem(projectAccountOwnedEvidenceMap(store, version), baseItemId);
}

/**
 * Slice 3: the four held-row facets for one base item, read from the SAME account-wide projection as
 * `evidenceForItem`. CONFIRMED and POTENTIAL tiers are kept independent; UNRESOLVED scopes have no rows to
 * read; guild owners are never consulted.
 */
export function heldItemFacetsForItem(map: AccountOwnedEvidenceMap, baseItemId: number): HeldItemFacets {
  const tier = (admissibility: "CONFIRMED" | "POTENTIAL"): HeldRowFacts[] =>
    map.scopes.flatMap((source) => {
      if (source.admissibility !== admissibility) return [];
      const rows = source.items?.get(baseItemId)?.heldRows;
      return rows ? [rows] : [];
    });
  const confirmed = tier("CONFIRMED");
  const potential = tier("POTENTIAL");
  return {
    confirmedItemStringIdentity: classifyItemStringIdentity(confirmed),
    potentialItemStringIdentity: classifyItemStringIdentity(potential),
    confirmedBinding: sumBinding(confirmed),
    potentialBinding: sumBinding(potential),
  };
}

/**
 * The single per-item allocation path over the account-wide projection: `getItemAllocation` and the
 * account allocation review both call this, so a demanded review entry is the same result by construction.
 */
export function allocationForItem(map: AccountOwnedEvidenceMap, baseItemId: number, activeDemands: readonly ExplicitDemand[]): AllocationResult {
  const { evidence, guildContext } = evidenceForItem(map, baseItemId);
  return buildAllocationResult(commodityIdentity(baseItemId), activeDemands, evidence, guildContext, heldItemFacetsForItem(map, baseItemId));
}
