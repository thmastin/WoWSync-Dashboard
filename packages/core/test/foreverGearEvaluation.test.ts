import test from "node:test";
import assert from "node:assert/strict";
import {
  assessForeverEligibility, assessForeverSuitability, calibrateForeverStatDelta,
  classifyForeverRecordedUpgrade, compareForeverStatTables,
  evaluateForeverSlotCompatibility, evaluateForeverTransferability,
  foreverSlotsForEquipLocation,
} from "../src/foreverGearEvaluation.ts";

const slot = (n: number, itemRef: string, equipLocation: string): { slot: number; itemRef: string; equipLocation: string; provenance: string } => ({ slot: n, itemRef, equipLocation, provenance: "OBSERVED" });
const table = (pairs: Record<string, number>, complete = true) => ({ state: "OBSERVED_TABLE", complete, entries: Object.entries(pairs).map(([key, value]) => ({ key, state: "OBSERVED", value })) });

test("Forever equip-location rules map body, multi-slot, hand, legacy ranged, and ammo slots", () => {
  assert.deepEqual(foreverSlotsForEquipLocation("INVTYPE_ROBE"), [5]);
  assert.deepEqual(foreverSlotsForEquipLocation("INVTYPE_FINGER"), [11, 12]);
  assert.deepEqual(foreverSlotsForEquipLocation("INVTYPE_TRINKET"), [13, 14]);
  assert.deepEqual(foreverSlotsForEquipLocation("INVTYPE_WEAPON"), [16, 17]);
  assert.deepEqual(foreverSlotsForEquipLocation("INVTYPE_RANGED"), [18]);
  assert.deepEqual(foreverSlotsForEquipLocation("INVTYPE_AMMO"), [0]);
  assert.equal(foreverSlotsForEquipLocation("INVTYPE_FUTURE"), undefined);
});

test("two-hand candidates report observed off-hand conflicts; off-hand candidates report two-hand main-hand conflicts", () => {
  const twoHand = evaluateForeverSlotCompatibility({ equipLocation: "INVTYPE_2HWEAPON", equipment: [slot(17, "item:off", "INVTYPE_SHIELD")], equipmentComplete: true });
  assert.deepEqual(twoHand.possibleSlots, [16]);
  assert.equal(twoHand.conflicts[0]?.slot, 17);
  assert.equal(twoHand.conflicts[0]?.state, "REQUIRES_REPLACEMENT");
  const offHand = evaluateForeverSlotCompatibility({ equipLocation: "INVTYPE_HOLDABLE", equipment: [slot(16, "item:2h", "INVTYPE_2HWEAPON")], equipmentComplete: true });
  assert.equal(offHand.conflicts[0]?.slot, 16);
  assert.deepEqual(offHand.knownEmptySlots, [], "a two-handed main hand prevents an off-hand empty-slot fill");
  assert.equal(classifyForeverRecordedUpgrade([], offHand).status, "REQUIRES_HAND_CONFLICT_RESOLUTION");
  const unknownOffHand = evaluateForeverSlotCompatibility({ equipLocation: "INVTYPE_SHIELD", equipment: [{ slot: 16, itemRef: "item:unknown-type", provenance: "OBSERVED" }], equipmentComplete: true });
  assert.equal(unknownOffHand.state, "UNKNOWN");
  assert.deepEqual(unknownOffHand.knownEmptySlots, []);
  assert.equal(unknownOffHand.conflicts[0]?.state, "UNKNOWN_CONFLICT");
  const missingIdentityOffHand = evaluateForeverSlotCompatibility({ equipLocation: "INVTYPE_SHIELD", equipment: [{ slot: 16, provenance: "OBSERVED" }], equipmentComplete: true });
  assert.equal(missingIdentityOffHand.state, "UNKNOWN", "occupied main-hand row with missing item identity still blocks a positive off-hand result");
  const unknownCurrent = evaluateForeverSlotCompatibility({ equipLocation: "INVTYPE_2HWEAPON", equipment: [], equipmentComplete: false });
  assert.deepEqual(unknownCurrent.knownEmptySlots, []);
});

test("complete slot scans distinguish empty slots from partial equipment, including repeated slots", () => {
  const ring = evaluateForeverSlotCompatibility({ equipLocation: "INVTYPE_FINGER", equipment: [slot(11, "item:ring", "INVTYPE_FINGER")], equipmentComplete: true });
  assert.deepEqual(ring.currentlyOccupiedSlots, [11]);
  assert.deepEqual(ring.knownEmptySlots, [12]);
  const partial = evaluateForeverSlotCompatibility({ equipLocation: "INVTYPE_FINGER", equipment: [], equipmentComplete: false });
  assert.deepEqual(partial.knownEmptySlots, []);
  assert.equal(evaluateForeverSlotCompatibility({ equipLocation: "INVTYPE_BAG", equipment: [], equipmentComplete: true }).state, "NOT_EQUIPMENT");
});

test("complete raw stat vectors distinguish dominance, losses, ties, and trade-offs", () => {
  assert.equal(compareForeverStatTables(table({ ITEM_MOD_STAMINA_SHORT: 8, ITEM_MOD_ARMOR: 20 }), table({ ITEM_MOD_STAMINA_SHORT: 5, ITEM_MOD_ARMOR: 20 }), 5, "item:old")?.classification, "CANDIDATE_DOMINATES_RECORDED_STATS");
  assert.equal(compareForeverStatTables(table({ ITEM_MOD_STAMINA_SHORT: 4 }), table({ ITEM_MOD_STAMINA_SHORT: 5 }), 16, "item:old", "Weapon")?.classification, "EQUIPPED_DOMINATES_RECORDED_STATS");
  const tradeoff = compareForeverStatTables(table({ ITEM_MOD_STAMINA_SHORT: 5 }), table({ ITEM_MOD_STRENGTH_SHORT: 2 }), 5, "item:old");
  assert.equal(tradeoff?.classification, "STAT_TRADEOFF", "complete-table absence is zero; both non-zero keys remain visible");
  assert.deepEqual(tradeoff?.values.map((row) => [row.key, row.delta]), [["ITEM_MOD_STAMINA_SHORT", 5], ["ITEM_MOD_STRENGTH_SHORT", -2]]);
  assert.equal(compareForeverStatTables(table({ ITEM_MOD_STAMINA_SHORT: 5 }), table({ ITEM_MOD_STAMINA_SHORT: 5 }), 5, "item:old")?.classification, "RECORDED_STAT_TIE");
  assert.equal(compareForeverStatTables(table({ ITEM_MOD_STAMINA_SHORT: 5 }, false), table({ ITEM_MOD_STAMINA_SHORT: 4 }), 5, "item:old"), undefined);
});

test("stat delta direction is calibrated against exact GetItemStats values, never guessed", () => {
  const candidate = table({ ITEM_MOD_STAMINA_SHORT: 8 });
  const equipped = table({ ITEM_MOD_STAMINA_SHORT: 5 });
  assert.equal(calibrateForeverStatDelta({ candidate, equipped, delta: table({ ITEM_MOD_STAMINA_SHORT: 3 }) }).state, "MATCHES_CANDIDATE_MINUS_EQUIPPED");
  assert.equal(calibrateForeverStatDelta({ candidate, equipped, delta: table({ ITEM_MOD_STAMINA_SHORT: -3 }) }).state, "MATCHES_EQUIPPED_MINUS_CANDIDATE");
  assert.equal(calibrateForeverStatDelta({ candidate, equipped, delta: table({ ITEM_MOD_STAMINA_SHORT: 2 }) }).state, "CONFLICT");
  assert.equal(calibrateForeverStatDelta({ candidate, equipped, delta: undefined }).state, "UNKNOWN");
});

test("upgrade classification is explicitly limited and handles fills, trade-offs, and missing comparisons", () => {
  const fit = evaluateForeverSlotCompatibility({ equipLocation: "INVTYPE_CHEST", equipment: [slot(5, "item:old", "INVTYPE_CHEST")], equipmentComplete: true });
  const dominates = compareForeverStatTables(table({ ITEM_MOD_STAMINA_SHORT: 8 }), table({ ITEM_MOD_STAMINA_SHORT: 5 }), 5, "item:old")!;
  const positive = classifyForeverRecordedUpgrade([dominates], fit);
  assert.equal(positive.status, "POSSIBLE_RECORDED_STAT_UPGRADE");
  assert.equal(positive.confidence, "LIMITED_RAW_STATS");
  const empty = evaluateForeverSlotCompatibility({ equipLocation: "INVTYPE_HEAD", equipment: [], equipmentComplete: true });
  assert.equal(classifyForeverRecordedUpgrade([], empty).status, "POSSIBLE_EMPTY_SLOT_FILL");
  assert.equal(classifyForeverRecordedUpgrade([], fit).status, "UNKNOWN");
});

test("eligibility is character-scoped, level-gated, and unknown without that player's API result", () => {
  assert.equal(assessForeverEligibility({ sameCharacter: true, apiEquippable: true, apiObservedRecent: true, requiredLevel: 1, recipientLevel: 8 }).playerApiSignal, "TRUE");
  assert.equal(assessForeverEligibility({ sameCharacter: true, apiEquippable: true, apiObservedRecent: true, requiredLevel: 1, recipientLevel: 8 }).state, "UNKNOWN");
  assert.equal(assessForeverEligibility({ sameCharacter: false, apiEquippable: true, apiObservedRecent: true, requiredLevel: 1, recipientLevel: 8 }).state, "UNKNOWN");
  assert.equal(assessForeverEligibility({ sameCharacter: false, apiObservedRecent: false, requiredLevel: 12, recipientLevel: 8 }).state, "INELIGIBLE_REQUIRED_LEVEL");
  assert.equal(assessForeverEligibility({ sameCharacter: true, apiEquippable: true, apiObservedRecent: true, requiredLevel: 12, recipientLevel: 8 }).state, "UNKNOWN", "conflicting player API and level evidence is not silently resolved");
  assert.equal(assessForeverEligibility({ sameCharacter: true, apiEquippable: false, apiObservedRecent: true }).playerApiSignal, "FALSE");
});

test("item spec tags are suitability hints only; missing tags stay unknown", () => {
  assert.equal(assessForeverSuitability({ activeSpecializationID: 3, itemSpecializationIDs: [3, 4], specializationEvidenceCurrent: true }).state, "OBSERVED_SPEC_TAG_MATCH");
  assert.equal(assessForeverSuitability({ activeSpecializationID: 3, itemSpecializationIDs: [4], specializationEvidenceCurrent: true }).state, "OBSERVED_SPEC_TAG_MISMATCH");
  assert.equal(assessForeverSuitability({ activeSpecializationID: 3, itemSpecializationIDs: [], specializationEvidenceCurrent: true }).state, "UNKNOWN");
});

test("binding blocks a cross-character route only when the source bound facet is observed true", () => {
  assert.equal(evaluateForeverTransferability(true).state, "BLOCKED_BOUND_TO_SOURCE");
  assert.equal(evaluateForeverTransferability(false).state, "UNKNOWN");
  assert.equal(evaluateForeverTransferability(undefined).state, "UNKNOWN");
});
