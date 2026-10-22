import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { FOREVER_STAT_LABELS } from "../src/foreverStatLabels.ts";
import {
  assessForeverEligibility, assessForeverSuitability, calibrateForeverStatDelta,
  classifyForeverRecordedUpgrade, compareForeverStatTables,
  evaluateForeverSlotCompatibility, evaluateForeverTransferability,
  foreverSlotsForEquipLocation, presentForeverStatKey,
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

test("Forever stat presentation resolves the pinned client vocabulary and preserves label provenance", () => {
  const vocabulary = Object.entries(FOREVER_STAT_LABELS).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  assert.equal(vocabulary.length, 140, "the source vocabulary should not shrink silently");
  assert.equal(createHash("sha256").update(JSON.stringify(vocabulary)).digest("hex"), "9127b98b8343d8864bc520291261b3dde9ed978401012efae8460646d75260a4", "the complete key/label table should match its reviewed source snapshot");
  for (const [key, expectedLabel] of vocabulary) {
    const expectedProvenance = key === "RESISTANCE0_NAME" ? "LIVE_VALIDATED_FOREVER_70291" : "FOREVER_GLOBALSTRINGS_70205";
    assert.deepEqual(presentForeverStatKey(key), { label: expectedLabel, labelState: "KNOWN", labelProvenance: expectedProvenance }, key);
  }
  for (const [key, expectedLabel] of [
    ["ITEM_MOD_STRENGTH_SHORT", "Strength"],
    ["ITEM_MOD_STAMINA_SHORT", "Stamina"],
    ["ITEM_MOD_DAMAGE_PER_SECOND_SHORT", "damage per second"],
    ["RESISTANCE0_NAME", "Armor"],
    ["RESISTANCE2_NAME", "Fire Resistance"],
  ]) {
    assert.equal(presentForeverStatKey(key).label, expectedLabel);
  }
  assert.deepEqual(presentForeverStatKey("FUTURE_UNKNOWN_STAT"), { label: "Unknown stat", labelState: "UNKNOWN", labelProvenance: "UNKNOWN" });
  assert.deepEqual(presentForeverStatKey("ITEM_MOD_CR_UNUSED_1_SHORT"), { label: "Unknown stat", labelState: "UNKNOWN", labelProvenance: "UNKNOWN" }, "placeholder globals are not treated as meaningful labels");
  assert.deepEqual(presentForeverStatKey("toString"), { label: "Unknown stat", labelState: "UNKNOWN", labelProvenance: "UNKNOWN" }, "inherited object keys do not resolve as stats");
});

test("Forever comparisons retain raw identifiers and exact numeric results without changing classification", () => {
  const comparison = compareForeverStatTables(table({ RESISTANCE0_NAME: 7 }), table({ RESISTANCE0_NAME: 2 }), 8, "item:old")!;
  assert.deepEqual(comparison.values[0], { key: "RESISTANCE0_NAME", label: "Armor", labelState: "KNOWN", labelProvenance: "LIVE_VALIDATED_FOREVER_70291", candidate: 7, equipped: 2, delta: 5 });
  assert.match(comparison.reason, /Armor: candidate 7 vs equipped 2 \(\+5 Armor\)/);
  const unknown = compareForeverStatTables(table({ FUTURE_UNKNOWN_STAT: 7 }), table({ FUTURE_UNKNOWN_STAT: 2 }), 8, "item:old")!;
  assert.deepEqual(unknown.values[0], { key: "FUTURE_UNKNOWN_STAT", label: "Unknown stat", labelState: "UNKNOWN", labelProvenance: "UNKNOWN", candidate: 7, equipped: 2, delta: 5 });
  assert.match(unknown.reason, /Unknown stat: candidate 7 vs equipped 2 \(\+5\)/);
  assert.equal(unknown.classification, "CANDIDATE_DOMINATES_RECORDED_STATS", "label lookup has no effect on comparison decisions");
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

test("a generic bound boolean does not distinguish soulbound from account-bound", () => {
  assert.equal(evaluateForeverTransferability(true).state, "UNKNOWN");
  assert.equal(evaluateForeverTransferability(false).state, "UNKNOWN");
  assert.equal(evaluateForeverTransferability(undefined).state, "UNKNOWN");
});
