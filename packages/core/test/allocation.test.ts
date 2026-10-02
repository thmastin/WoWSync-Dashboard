// Azeroth ERP Vertical Slice 1 — the pure allocation domain. Covers the six required acceptance
// scenarios directly against hand-built evidence (no SQLite, no fixtures): CONFIRMED_IS_NEVER_ZERO,
// LAST_SEEN inadmissibility, the conservative UNKNOWN gate, Guild isolation, and the structurally
// distinct NO_ACTIVE_DEMAND / CONFLICTING_DEMAND resolutions. The small account-owned-evidence adapter
// (projectAccountOwnedEvidence) is covered separately in readModelAllocation.test.ts, against a real
// SqliteSnapshotStore.
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildAllocationResult, type EvidenceContribution, type GuildContextEntry } from "../src/allocation.ts";
import { commodityIdentity, type ExplicitDemand } from "../src/demand.ts";

const COMMODITY = commodityIdentity(700001);

function demand(requiredQuantity: number, overrides: Partial<ExplicitDemand> = {}): ExplicitDemand {
  return {
    stableId: "demand_fixture",
    gameVersion: "retail",
    demandType: "STOCK_TARGET",
    commodity: COMMODITY,
    requiredQuantity,
    status: "ACTIVE",
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

function confirmed(quantity: number, scope: EvidenceContribution["scope"] = "character-bags"): EvidenceContribution {
  return { scope, admissibility: "CONFIRMED", quantity, identityKey: "retail::cairne::fixture" };
}
function potential(quantity: number, scope: EvidenceContribution["scope"] = "warband"): EvidenceContribution {
  return { scope, admissibility: "POTENTIAL", quantity };
}
function unresolved(scope: EvidenceContribution["scope"]): EvidenceContribution {
  return { scope, admissibility: "UNRESOLVED" };
}

test("Scenario 1 — confirmed deficit: demand 40, OBSERVED 27", () => {
  const result = buildAllocationResult(COMMODITY, [demand(40)], [confirmed(27)]);
  assert.equal(result.resolution, "RESOLVED");
  if (result.resolution !== "RESOLVED") throw new Error("unreachable");
  assert.equal(result.confirmedAvailable, 27);
  assert.equal(result.allocated, 27);
  assert.equal(result.confirmedDeficit, 13);
  assert.equal(result.confirmedSurplus, 0);
  assert.equal(result.disposition, "HOLD_ALLOCATED");
  assert.ok(!result.reasons.some((r) => r.code === "SALE_PIPELINE_APPROVED"), "no sale routing on a deficit");
});

test("Scenario 2 — confirmed surplus: demand 20, OBSERVED 35, fully resolved evidence", () => {
  const result = buildAllocationResult(COMMODITY, [demand(20)], [confirmed(35)]);
  assert.equal(result.resolution, "RESOLVED");
  if (result.resolution !== "RESOLVED") throw new Error("unreachable");
  assert.equal(result.allocated, 20);
  assert.equal(result.confirmedSurplus, 15);
  assert.equal(result.confirmedDeficit, 0);
  assert.equal(result.hasUnresolvedEvidence, false);
  assert.equal(result.disposition, "SEND_HELLOMAGS");
  assert.ok(result.reasons.some((r) => r.code === "SALE_PIPELINE_APPROVED"));
});

test("Scenario 3 — historical ambiguity: demand 40, OBSERVED 27, LAST_SEEN Warband 25 never satisfies or creates surplus", () => {
  const result = buildAllocationResult(COMMODITY, [demand(40)], [confirmed(27), potential(25, "warband")]);
  assert.equal(result.resolution, "RESOLVED");
  if (result.resolution !== "RESOLVED") throw new Error("unreachable");
  assert.equal(result.confirmedAvailable, 27);
  assert.equal(result.allocated, 27);
  assert.equal(result.confirmedDeficit, 13);
  assert.equal(result.potentialAdditionalAvailable, 25);
  assert.equal(result.confirmedSurplus, 0);
  assert.equal(result.disposition, "HOLD_ALLOCATED");
  assert.ok(result.reasons.some((r) => r.code === "LAST_SEEN_NOT_ADMISSIBLE"));
  assert.ok(!result.reasons.some((r) => r.code === "SALE_PIPELINE_APPROVED"), "LAST_SEEN evidence never triggers sale routing");
});

test("Scenario 4 — UNKNOWN is not zero / conservative gate: demand 20, OBSERVED 35, one relevant scope UNKNOWN", () => {
  const result = buildAllocationResult(COMMODITY, [demand(20)], [confirmed(35), unresolved("character-bank")]);
  assert.equal(result.resolution, "RESOLVED");
  if (result.resolution !== "RESOLVED") throw new Error("unreachable");
  // Arithmetic stays precise: the 35 OBSERVED is a real floor, unaffected by what the UNKNOWN scope might hold.
  assert.equal(result.confirmedAvailable, 35);
  assert.equal(result.allocated, 20);
  assert.equal(result.confirmedDeficit, 0);
  assert.equal(result.confirmedSurplus, 15);
  assert.equal(result.hasUnresolvedEvidence, true);
  assert.deepEqual(result.unresolvedScopes, ["character-bank"]);
  // But disposition is conservative: never SEND_HELLOMAGS while relevant evidence remains unresolved.
  assert.equal(result.disposition, "REQUIRES_REVIEW");
  assert.ok(result.reasons.some((r) => r.code === "SURPLUS_CONFIRMED"), "the floor surplus is still reported as confirmed");
  assert.ok(result.reasons.some((r) => r.code === "SALE_DISPOSITION_GATED_BY_UNRESOLVED_EVIDENCE"));
  assert.ok(!result.reasons.some((r) => r.code === "SALE_PIPELINE_APPROVED"));
});

test("Scenario 5 — guild isolation: demand 20, account OBSERVED 10, Guild OBSERVED 100 never satisfies or inflates account surplus", () => {
  const guildContext: GuildContextEntry[] = [{ ownerKey: "retail::guild::111", admissibility: "CONFIRMED", quantity: 100 }];
  const result = buildAllocationResult(COMMODITY, [demand(20)], [confirmed(10)], guildContext);
  assert.equal(result.resolution, "RESOLVED");
  if (result.resolution !== "RESOLVED") throw new Error("unreachable");
  assert.equal(result.confirmedAvailable, 10);
  assert.equal(result.allocated, 10);
  assert.equal(result.confirmedDeficit, 10);
  assert.equal(result.confirmedSurplus, 0);
  assert.deepEqual(result.guildContext, guildContext);
  assert.ok(result.reasons.some((r) => r.code === "GUILD_EVIDENCE_EXCLUDED"));
});

test("Scenario 6 — no demand: OBSERVED 500 never becomes '500 surplus'; NO_ACTIVE_DEMAND carries no allocation numbers at all", () => {
  const result = buildAllocationResult(COMMODITY, [], [confirmed(500)]);
  assert.equal(result.resolution, "NO_ACTIVE_DEMAND");
  assert.equal(result.disposition, "NO_ACTION");
  // Type-level guarantee: these fields do not exist on this branch of the discriminated union at all.
  assert.ok(!("allocated" in result));
  assert.ok(!("confirmedSurplus" in result));
  assert.ok(!("confirmedDeficit" in result));
  assert.ok(result.reasons.some((r) => r.code === "NO_ACTIVE_DEMAND"));
});

test("defensive allocator behavior: two contradictory active demands for one commodity produce an explicit CONFLICTING_DEMAND result, never a silently chosen winner", () => {
  const result = buildAllocationResult(COMMODITY, [demand(20, { stableId: "demand_a" }), demand(40, { stableId: "demand_b" })], [confirmed(30)]);
  assert.equal(result.resolution, "CONFLICTING_DEMAND");
  assert.equal(result.disposition, "REQUIRES_REVIEW");
  if (result.resolution !== "CONFLICTING_DEMAND") throw new Error("unreachable");
  assert.deepEqual(result.conflictingDemandIds, ["demand_a", "demand_b"]);
  assert.ok(!("allocated" in result));
});

test("a NO_ACTIVE_DEMAND and a resolved zero-requirement demand are structurally distinct results", () => {
  const noDemand = buildAllocationResult(COMMODITY, [], [confirmed(5)]);
  const zeroRequirement = buildAllocationResult(COMMODITY, [demand(0)], [confirmed(5)]);
  assert.equal(noDemand.resolution, "NO_ACTIVE_DEMAND");
  assert.equal(zeroRequirement.resolution, "RESOLVED");
  if (zeroRequirement.resolution !== "RESOLVED") throw new Error("unreachable");
  assert.equal(zeroRequirement.confirmedSurplus, 5);
  assert.equal(zeroRequirement.disposition, "SEND_HELLOMAGS");
});

test("confirmed surplus and disposition remain distinct even when one scope is UNKNOWN but the required quantity is zero-deficit with no surplus", () => {
  // demand exactly met (20 == 20), unresolved elsewhere: no surplus to gate, so NO_ACTION, not REQUIRES_REVIEW.
  const result = buildAllocationResult(COMMODITY, [demand(20)], [confirmed(20), unresolved("warband")]);
  assert.equal(result.resolution, "RESOLVED");
  if (result.resolution !== "RESOLVED") throw new Error("unreachable");
  assert.equal(result.confirmedDeficit, 0);
  assert.equal(result.confirmedSurplus, 0);
  assert.equal(result.hasUnresolvedEvidence, true);
  assert.equal(result.disposition, "NO_ACTION");
});
