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
import { itemIdFromItemRef } from "./itemMetadata.ts";
import type { CommodityIdentity, ExplicitDemand } from "./demand.ts";
import type { SnapshotReadStore } from "./store.ts";
import type { VersionOrUnknown } from "./types.ts";

export type AllocationAdmissibility = "CONFIRMED" | "POTENTIAL" | "UNRESOLVED";

/** Where one account-eligible evidence contribution came from. Guild storage is never a scope here. */
export type AllocationEvidenceScope = "character-bags" | "character-bank" | "warband";

/**
 * Why an UNRESOLVED contribution is unresolved:
 *   STORAGE_UNKNOWN       - the whole storage scope is UNKNOWN (a character's bags/bank section never
 *                           observed, or a Warband never observed at all). Applies to every item.
 *   ITEM_QUANTITY_UNKNOWN - the scope is OBSERVED and holds row(s) of this item, but the export did not
 *                           report those rows' quantity. The scope's known-quantity rows still count as a
 *                           confirmed floor; the unknown rows are never counted as 0.
 */
export type UnresolvedEvidenceCause = "STORAGE_UNKNOWN" | "ITEM_QUANTITY_UNKNOWN";

/**
 * One contribution toward (or unresolved gap in) account-owned evidence for one base item.
 * `quantity` is absent exactly when `admissibility` is "UNRESOLVED" — never 0. On a CONFIRMED/POTENTIAL
 * contribution, `quantity` sums only rows whose quantity was reported; `unknownQuantityRowCount` (present
 * only when > 0) counts rows of this item whose quantity was not reported, so the sum is a floor.
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
  | "SURPLUS_CONFIRMED"
  | "SALE_DISPOSITION_GATED_BY_UNRESOLVED_EVIDENCE"
  | "SALE_PIPELINE_APPROVED"
  | "GUILD_EVIDENCE_EXCLUDED";

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

export type AllocationResolution = "RESOLVED" | "NO_ACTIVE_DEMAND" | "CONFLICTING_DEMAND";

interface AllocationResultBase {
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
  /** Sum of POTENTIAL (LAST_SEEN) contributions. Can never satisfy demand or create confirmed surplus. */
  readonly potentialAdditionalAvailable: number;
  readonly hasUnresolvedEvidence: boolean;
  readonly unresolvedScopes: AllocationEvidenceScope[];
  readonly allocated: number;
  readonly confirmedDeficit: number;
  /** A mathematically confirmed FLOOR: it can only grow if an unresolved scope turns out to hold more, never shrink. */
  readonly confirmedSurplus: number;
  readonly disposition: Disposition;
}

export type AllocationResult = NoActiveDemandResult | ConflictingDemandResult | ResolvedAllocationResult;

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
): AllocationResult {
  const confirmedAvailable = sum(evidence, "CONFIRMED");
  const potentialAdditionalAvailable = sum(evidence, "POTENTIAL");
  const unresolved = evidence.filter((e) => e.admissibility === "UNRESOLVED");
  const hasUnresolvedEvidence = unresolved.length > 0;
  const unresolvedScopes = [...new Set(unresolved.map((e) => e.scope))];
  const guildReasons: AllocationReason[] = guildContext.some((g) => (g.quantity ?? 0) > 0)
    ? [{ code: "GUILD_EVIDENCE_EXCLUDED", detail: "Guild-owned evidence is reported for context only; it never satisfies or inflates account demand." }]
    : [];

  if (activeDemands.length > 1) {
    return {
      resolution: "CONFLICTING_DEMAND",
      commodity,
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
      disposition: "NO_ACTION",
      guildContext: [...guildContext],
      reasons: [{ code: "NO_ACTIVE_DEMAND", detail: "No active explicit demand exists for this commodity; observed inventory alone is never treated as surplus." }, ...guildReasons],
      evidence: [...evidence],
    };
  }

  const demand = activeDemands[0]!;
  const allocated = Math.min(confirmedAvailable, demand.requiredQuantity);
  const confirmedDeficit = Math.max(demand.requiredQuantity - confirmedAvailable, 0);
  const confirmedSurplus = Math.max(confirmedAvailable - demand.requiredQuantity, 0);

  const reasons: AllocationReason[] = [{ code: "EXPLICIT_DEMAND_EXISTS" }];
  reasons.push({ code: confirmedDeficit > 0 ? "CONFIRMED_INVENTORY_BELOW_DEMAND" : "CONFIRMED_INVENTORY_MEETS_DEMAND" });
  if (potentialAdditionalAvailable > 0) {
    reasons.push(
      { code: "LAST_SEEN_INVENTORY_PRESENT" },
      { code: "LAST_SEEN_NOT_ADMISSIBLE", detail: "Historical LAST_SEEN evidence cannot satisfy demand or create confirmed surplus." },
    );
  }
  if (hasUnresolvedEvidence) {
    reasons.push({ code: "UNRESOLVED_STORAGE_PRESENT", detail: `Unresolved account-owned storage scope(s): ${unresolvedScopes.join(", ")}.` });
  }

  let disposition: Disposition;
  if (confirmedDeficit > 0) {
    disposition = "HOLD_ALLOCATED";
  } else if (confirmedSurplus === 0) {
    disposition = "NO_ACTION";
  } else {
    reasons.push({ code: "SURPLUS_CONFIRMED" });
    if (hasUnresolvedEvidence) {
      disposition = "REQUIRES_REVIEW";
      reasons.push({ code: "SALE_DISPOSITION_GATED_BY_UNRESOLVED_EVIDENCE", detail: "A confirmed floor surplus exists, but unresolved account-owned evidence gates sale-pipeline disposition until it is resolved." });
    } else {
      disposition = "SEND_HELLOMAGS";
      reasons.push({ code: "SALE_PIPELINE_APPROVED" });
    }
  }
  reasons.push(...guildReasons);

  return {
    resolution: "RESOLVED",
    commodity,
    demand: { stableId: demand.stableId, requiredQuantity: demand.requiredQuantity, ...(demand.purpose !== undefined ? { purpose: demand.purpose } : {}) },
    confirmedAvailable,
    potentialAdditionalAvailable,
    hasUnresolvedEvidence,
    unresolvedScopes,
    allocated,
    confirmedDeficit,
    confirmedSurplus,
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

function tallyItems(items: readonly { itemRef?: string; name?: string; qty?: number }[]): { tallies: Map<number, ItemTally>; unidentified: number } {
  const tallies = new Map<number, { knownQuantity: number; unknownQuantityRowCount: number; name?: string }>();
  let unidentified = 0;
  for (const item of items) {
    const baseItemId = itemIdFromItemRef(item.itemRef);
    if (baseItemId === undefined) {
      unidentified++;
      continue;
    }
    let tally = tallies.get(baseItemId);
    if (!tally) {
      tally = { knownQuantity: 0, unknownQuantityRowCount: 0, ...(item.name !== undefined ? { name: item.name } : {}) };
      tallies.set(baseItemId, tally);
    }
    if (tally.name === undefined && item.name !== undefined) tally.name = item.name;
    // A present row with no reported quantity is uncertainty, never an observed 0.
    if (item.qty === undefined) tally.unknownQuantityRowCount++;
    else tally.knownQuantity += item.qty;
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
 * conservative gate applies to it exactly as to an UNKNOWN storage scope. A POTENTIAL scope's unreported
 * rows are flagged by `unknownQuantityRowCount` only: historical evidence can never reach confirmed numbers,
 * so it cannot gate them either.
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
