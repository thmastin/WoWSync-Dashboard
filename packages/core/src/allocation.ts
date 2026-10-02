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
 * One contribution toward (or unresolved gap in) account-owned evidence for one commodity.
 * `quantity` is absent exactly when `admissibility` is "UNRESOLVED" — never 0.
 */
export interface EvidenceContribution {
  readonly scope: AllocationEvidenceScope;
  readonly admissibility: AllocationAdmissibility;
  readonly quantity?: number;
  /** Character scopes only. */
  readonly identityKey?: string;
  readonly observedAt?: number;
}

/** Guild-owned evidence, reported for context. The allocation arithmetic never reads this. */
export interface GuildContextEntry {
  readonly ownerKey: string;
  readonly admissibility: AllocationAdmissibility;
  readonly quantity?: number;
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

function quantityOf(items: readonly { itemRef?: string; qty?: number }[], baseItemId: number): number {
  let total = 0;
  for (const item of items) {
    if (itemIdFromItemRef(item.itemRef) === baseItemId) total += item.qty ?? 0;
  }
  return total;
}

/**
 * The small adapter the investigation anticipated might be needed: no unified "account-owned inventory
 * projection" existed before Slice 1. Projects existing character-storage and shared-storage evidence
 * into the EvidenceContribution shape the allocator needs, for one commodity. Reads only; stores nothing.
 *
 * Every account-owned scope that could hold the item is represented: an UNKNOWN character bags/bank
 * section, or a Warband never observed, becomes an UNRESOLVED contribution (never silently omitted,
 * never zero). Guild-owned evidence is returned separately in `guildContext` and is structurally never
 * mixed into `evidence` — the allocator has no way to count it toward account availability.
 */
export function projectAccountOwnedEvidence(
  store: SnapshotReadStore,
  version: VersionOrUnknown,
  baseItemId: number,
): { evidence: EvidenceContribution[]; guildContext: GuildContextEntry[] } {
  const evidence: EvidenceContribution[] = [];

  for (const character of store.listCharacters(version)) {
    const snapshot = store.listSnapshots(character.identityKey)[0];
    if (!snapshot) continue;
    for (const storage of ["bags", "bank"] as const) {
      const section = snapshot.parsed[storage];
      const scope: AllocationEvidenceScope = storage === "bags" ? "character-bags" : "character-bank";
      const observedAt = section.status.observedAt ?? snapshot.generatedAt ?? snapshot.importedAt;
      if (section.status.state === "OBSERVED") {
        evidence.push({ scope, admissibility: "CONFIRMED", quantity: quantityOf(section.items, baseItemId), identityKey: character.identityKey, observedAt });
      } else if (section.status.state === "LAST_SEEN") {
        evidence.push({ scope, admissibility: "POTENTIAL", quantity: quantityOf(section.items, baseItemId), identityKey: character.identityKey, observedAt });
      } else {
        evidence.push({ scope, admissibility: "UNRESOLVED", identityKey: character.identityKey });
      }
    }
  }

  const projection = version === "retail" ? store.projectSharedStorage() : { warband: undefined, guilds: [] };
  if (!projection.warband?.current) {
    evidence.push({ scope: "warband", admissibility: "UNRESOLVED" });
  } else {
    const current = projection.warband.current;
    evidence.push({
      scope: "warband",
      admissibility: current.liveAtExport ? "CONFIRMED" : "POTENTIAL",
      quantity: quantityOf(current.content.items, baseItemId),
      observedAt: current.effectiveObservedAt,
    });
  }

  const guildContext: GuildContextEntry[] = projection.guilds
    .filter((guild): guild is typeof guild & { current: NonNullable<(typeof guild)["current"]> } => guild.current !== undefined)
    .map((guild) => ({
      ownerKey: guild.ownerKey,
      admissibility: guild.current.liveAtExport ? "CONFIRMED" : "POTENTIAL",
      quantity: quantityOf(guild.current.content.items, baseItemId),
      observedAt: guild.current.effectiveObservedAt,
    }));

  return { evidence, guildContext };
}
