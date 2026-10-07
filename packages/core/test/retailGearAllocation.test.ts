import test from "node:test";
import assert from "node:assert/strict";
import { assessRetailCandidate, retainedRetailEquipment } from "../src/retailGearAllocation.ts";
import type { GearCandidateRow } from "../src/types.ts";
import type { StoredEquipmentObservation } from "../src/store.ts";
import type { QualifiedRetailEquipment } from "../src/retailGearAllocation.ts";

function obs(specID: number, observedAt: number, options: { capture?: number; revision?: number; complete?: boolean; ready?: boolean; stable?: boolean; after?: number; level?: number; emptySlot?: string } = {}): StoredEquipmentObservation {
  const capture = options.capture ?? 1, revision = options.revision ?? 1;
  const slots: Record<string, unknown> = { "5": { itemID: 7, itemLevel: 100 }, "11": { itemID: 1, itemLevel: options.level ?? 100 }, "12": { itemID: 2, itemLevel: 105 }, "13": { itemID: 3, itemLevel: 100 }, "14": { itemID: 4, itemLevel: 110 }, "16": { itemID: 5, itemLevel: 100 }, "17": { itemID: 6, itemLevel: 90 } };
  if (options.emptySlot) slots[options.emptySlot] = { empty: true };
  return { snapshotId: observedAt, observedAt, capture, revision, completeness: options.complete === false ? "partial" : "complete", evidence: { slots, specEquipmentObservation: { contractVersion: 1, clientFamily: "Retail", readiness: options.ready === false ? "UNKNOWN" : "READY", stability: options.stable === false ? "UNSTABLE" : "STABLE", activeSpecBefore: { specID }, activeSpecAfter: { specID: options.after ?? specID }, equipmentObservation: { observedAt, capture, revision } } } };
}
function candidate(location = "INVTYPE_FINGER", level = 120): GearCandidateRow {
  const k = <T>(value: T) => ({ state: "KNOWN" as const, value });
  const armor = location === "INVTYPE_CHEST";
  const jewelry = location === "INVTYPE_FINGER" || location === "INVTYPE_TRINKET";
  return { candidateState: "EQUIPPABLE", locationType: k("CONTAINER_SLOT"), containerID: k(0), slot: k(1), itemID: k(20), itemString: k("item:20"), itemGUID: { state: "UNKNOWN" }, equipType: k(location === "INVTYPE_FINGER" ? 11 : location === "INVTYPE_TRINKET" ? 12 : armor ? 5 : 13), currentItemLevel: k(level), requiredLevel: k(80), classID: k(jewelry || armor ? 4 : 2), subclassID: k(jewelry ? 0 : armor ? 4 : 7), baseEquipLocation: k(location), isBound: { state: "UNKNOWN" }, boundToAccountUntilEquip: { state: "UNKNOWN" }, itemBindToAccount: { state: "UNKNOWN" }, itemBindToAccountUntilEquip: { state: "UNKNOWN" }, tooltipBindingType: { state: "UNKNOWN" }, tooltipBindingRawValue: { state: "UNKNOWN" }, currentCharacterCanUse: { state: "UNKNOWN" }, observationState: "OBSERVED" };
}
const warriorObs = () => [obs(71, 5), obs(72, 5), obs(73, 5)];
const qualified = (observations: StoredEquipmentObservation[], specID: number) => retainedRetailEquipment(observations, specID) as Extract<QualifiedRetailEquipment, { state: "QUALIFIED" }>;

test("retained qualifying observation is per spec and does not expire by age", () => {
  const old = obs(253, 1_600_000_000);
  const newerOtherSpec = obs(254, 1_790_000_000);
  assert.equal(qualified([newerOtherSpec, old], 253).snapshotId, old.snapshotId);
  assert.equal(retainedRetailEquipment([newerOtherSpec], 253).state, "UNKNOWN");
});

test("newer nonqualifying observations do not erase older qualifying same-spec state", () => {
  const good = obs(253, 10);
  const partial = obs(253, 20, { complete: false });
  const unstable = obs(253, 30, { stable: false });
  const wrongLink = obs(253, 40);
  (wrongLink.evidence.specEquipmentObservation as any).equipmentObservation.capture = 8;
  assert.equal(qualified([partial, unstable, wrongLink, good], 253).snapshotId, good.snapshotId);
  assert.equal(retainedRetailEquipment([], 253).state, "UNKNOWN");
});

test("latest stored observation for another spec is labeled separately from retained state for this spec", () => {
  const old = obs(253, 10);
  const newer = obs(254, 20);
  const result = assessRetailCandidate({ candidate: candidate(), exporterSnapshotId: 99, rowOrdinal: 1, characters: [{ identityKey: "retail::a::x", name: "A", realm: "X", class: "Hunter", level: 80, characterState: "OBSERVED", latestSnapshotId: newer.snapshotId, observations: [newer, old] }] });
  const bm = result.assessments.find((a) => a.spec.specID === 253)!;
  assert.equal(bm.currentSnapshotObservation.state, "QUALIFYING");
  assert.equal(bm.currentSnapshotObservation.specID, 254);
  assert.equal(bm.latestStoredObservation.relationship, "LATEST_STORED_EQUIPMENT_OBSERVATION");
  assert.equal(bm.latestStoredObservation.specID, 254);
  assert.equal((bm.retained as Extract<QualifiedRetailEquipment, { state: "QUALIFIED" }>).snapshotId, old.snapshotId);
});

test("tuple ordering uses observedAt then capture then revision", () => {
  assert.equal(qualified([obs(253, 5, { capture: 3 }), obs(253, 5, { capture: 4 })], 253).capture, 4);
  assert.equal(qualified([obs(253, 5, { capture: 4, revision: 3 }), obs(253, 5, { capture: 4, revision: 4 })], 253).revision, 4);
});

test("ring comparison picks the lower interchangeable slot, and preserves equal-delta tie", () => {
  const result = assessRetailCandidate({ candidate: candidate(), exporterSnapshotId: 99, rowOrdinal: 1, characters: [{ identityKey: "retail::a::x", name: "A", realm: "X", class: "Warrior", level: 80, characterState: "OBSERVED", observations: [obs(71, 5)] }] });
  const arms = result.assessments.find((a) => a.spec.specID === 71)!;
  assert.equal(arms.comparison, "UPGRADE_BY_ITEM_LEVEL");
  assert.equal(arms.deltaItemLevel, 20);
  assert.deepEqual(arms.comparisonSlots, ["11"]);
  assert.equal((arms.retained as Extract<QualifiedRetailEquipment, { state: "QUALIFIED" }>).snapshotId, 5);
  assert.equal(result.candidate.binding, "NOT_ASSESSED");
  assert.equal(result.recommendation, "UNKNOWN", "other unobserved specs prevent an account-wide winner");
});

test("trinkets select the lower of their two retained slots", () => {
  const result = assessRetailCandidate({ candidate: candidate("INVTYPE_TRINKET"), exporterSnapshotId: 99, rowOrdinal: 1, characters: [{ identityKey: "retail::a::x", name: "A", realm: "X", class: "Warrior", level: 80, characterState: "OBSERVED", observations: warriorObs() }] });
  const arms = result.assessments.find((a) => a.spec.specID === 71)!;
  assert.equal(arms.comparison, "UPGRADE_BY_ITEM_LEVEL");
  assert.equal(arms.deltaItemLevel, 20);
  assert.deepEqual(arms.comparisonSlots, ["13"]);
});

test("an explicitly empty observed ring slot is a fill result, never an ilvl-zero delta", () => {
  const result = assessRetailCandidate({ candidate: candidate(), exporterSnapshotId: 99, rowOrdinal: 1, characters: [{ identityKey: "retail::a::x", name: "A", realm: "X", class: "Warrior", level: 80, characterState: "OBSERVED", observations: [obs(71, 5, { emptySlot: "11" }), obs(72, 5, { emptySlot: "11" }), obs(73, 5, { emptySlot: "11" })] }] });
  const arms = result.assessments.find((a) => a.spec.specID === 71)!;
  assert.equal(arms.comparison, "UPGRADE_BY_FILLING_EMPTY_SLOT");
  assert.equal(arms.deltaItemLevel, undefined);
  assert.deepEqual(arms.comparisonSlots, ["11"]);
});

test("ordinary armor compares only its mapped single slot", () => {
  const row = candidate("INVTYPE_CHEST");
  const result = assessRetailCandidate({ candidate: row, exporterSnapshotId: 99, rowOrdinal: 1, characters: [{ identityKey: "retail::a::x", name: "A", realm: "X", class: "Warrior", level: 80, characterState: "OBSERVED", observations: [obs(71, 5, { level: 100, complete: true })] }] });
  const arms = result.assessments.find((a) => a.spec.specID === 71)!;
  assert.equal(arms.comparison, "UPGRADE_BY_ITEM_LEVEL");
  assert.equal(arms.deltaItemLevel, 20);
});

test("equal and lower candidate item levels classify as sidegrade and downgrade", () => {
  const chars = [{ identityKey: "retail::a::x", name: "A", realm: "X", class: "Warrior", level: 80, characterState: "OBSERVED", observations: warriorObs() }];
  const equal = assessRetailCandidate({ candidate: candidate("INVTYPE_CHEST", 100), exporterSnapshotId: 99, rowOrdinal: 1, characters: chars });
  const lower = assessRetailCandidate({ candidate: candidate("INVTYPE_CHEST", 90), exporterSnapshotId: 99, rowOrdinal: 1, characters: chars });
  assert.equal(equal.assessments.find((a) => a.spec.specID === 71)?.comparison, "SIDEGRADE_BY_ITEM_LEVEL");
  assert.equal(lower.assessments.find((a) => a.spec.specID === 71)?.comparison, "DOWNGRADE_BY_ITEM_LEVEL");
  assert.equal(equal.recommendation, "NO_SUPPORTED_UPGRADE");
});

test("all recipients below the observed required level yields no supported upgrade without requiring equipment baselines", () => {
  const row = candidate();
  row.requiredLevel = { state: "KNOWN", value: 90 };
  const result = assessRetailCandidate({ candidate: row, exporterSnapshotId: 99, rowOrdinal: 1, characters: [{ identityKey: "retail::a::x", name: "A", realm: "X", class: "Warrior", level: 80, characterState: "OBSERVED", observations: [] }] });
  assert.ok(result.assessments.every((a) => a.eligibility === "INELIGIBLE"));
  assert.equal(result.recommendation, "NO_SUPPORTED_UPGRADE");
});

test("armor-family mismatch is plausibility UNKNOWN; missing level and baseline stay UNKNOWN", () => {
  const armor = candidate("INVTYPE_CHEST");
  const result = assessRetailCandidate({ candidate: armor, exporterSnapshotId: 99, rowOrdinal: 1, characters: [{ identityKey: "retail::a::x", name: "A", realm: "X", class: "Mage", level: 80, characterState: "OBSERVED", observations: [] }] });
  assert.equal(result.assessments[0]?.suitability, "UNKNOWN");
  assert.match(result.assessments[0]!.reasons.join(" "), /does not prove the client forbids/);
  assert.equal(result.assessments[0]?.comparison, "UNKNOWN");
  assert.match(result.assessments[0]!.reasons.join(" "), /No qualifying/);
});

test("stable deterministic ordering and equal supported upgrades report ambiguity", () => {
  const result = assessRetailCandidate({ candidate: candidate(), exporterSnapshotId: 99, rowOrdinal: 1, characters: ["Zed", "Ada"].map((name) => ({ identityKey: `retail::${name.toLowerCase()}::x`, name, realm: "X", class: "Warrior", level: 80, characterState: "OBSERVED", observations: warriorObs() })) });
  assert.equal(result.recommendation, "TIED_BEST_SUPPORTED_UPGRADE");
  assert.deepEqual([...new Set(result.assessments.map((a) => a.character.name))], ["Ada", "Zed"]);
  assert.deepEqual(result.assessments.map((a) => `${a.character.name}:${a.spec.specID}`), ["Ada:71", "Ada:72", "Ada:73", "Zed:71", "Zed:72", "Zed:73"]);
});

test("weapon class proficiency is not silently claimed as spec suitability; only checked weapon classes proceed", () => {
  const result = assessRetailCandidate({ candidate: candidate("INVTYPE_WEAPON"), exporterSnapshotId: 99, rowOrdinal: 1, characters: [{ identityKey: "retail::a::x", name: "A", realm: "X", class: "Mage", level: 80, characterState: "OBSERVED", observations: [obs(62, 5)] }] });
  assert.equal(result.assessments[0]?.suitability, "UNKNOWN");
  assert.equal(result.assessments[0]?.comparison, "UNKNOWN");
  assert.match(result.assessments[0]!.reasons.join(" "), /Weapon subclass proficiency/);
});

test("historical or contradictory candidate evidence cannot produce a recommendation", () => {
  const row = candidate();
  row.observationState = "LAST_SEEN";
  row.equipType = { state: "KNOWN", value: 13 };
  const result = assessRetailCandidate({ candidate: row, exporterSnapshotId: 99, rowOrdinal: 1, characters: [{ identityKey: "retail::a::x", name: "A", realm: "X", class: "Warrior", level: 80, characterState: "OBSERVED", observations: [obs(71, 5)] }] });
  assert.equal(result.candidate.validity, "UNKNOWN_OR_NOT_ALLOCATABLE");
  assert.equal(result.recommendation, "UNKNOWN");
  assert.equal(result.assessments[0]?.comparison, "UNKNOWN");
});

test("unknown candidate location or item identity cannot produce a per-spec comparison", () => {
  for (const [field, value] of [["locationType", { state: "UNKNOWN" }], ["itemID", { state: "UNKNOWN" }]] as const) {
    const row = candidate();
    (row as any)[field] = value;
    const result = assessRetailCandidate({ candidate: row, exporterSnapshotId: 99, rowOrdinal: 1, characters: [{ identityKey: "retail::a::x", name: "A", realm: "X", class: "Warrior", level: 80, characterState: "OBSERVED", observations: warriorObs() }] });
    assert.equal(result.candidate.validity, "UNKNOWN_OR_NOT_ALLOCATABLE");
    assert.ok(result.assessments.every((assessment) => assessment.comparison === "UNKNOWN"));
    assert.equal(result.recommendation, "UNKNOWN");
  }
});
