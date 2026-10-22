import test from "node:test";
import assert from "node:assert/strict";
import { buildWowSyncExport } from "./fixtureBuilder.ts";
import { parseWowSyncExport } from "../src/parser.ts";
import { classifyForeverEmptySlot, equipmentSlotLabel, FOREVER_EQUIPMENT_SLOT_LABELS, unresolvedItemName } from "../src/foreverEquipmentSlots.ts";

test("Forever equipment slot labels cover the client inventory slot IDs and do not leak into other versions", () => {
  assert.deepEqual(Object.keys(FOREVER_EQUIPMENT_SLOT_LABELS).map(Number), Array.from({ length: 19 }, (_, index) => index + 1));
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19].map((slot) => FOREVER_EQUIPMENT_SLOT_LABELS[slot]), [
    "Head", "Neck", "Shoulder", "Shirt", "Chest", "Waist", "Legs", "Feet", "Wrist", "Hands",
    "Finger 1", "Finger 2", "Trinket 1", "Trinket 2", "Back", "Main Hand", "Off Hand", "Ranged", "Tabard",
  ]);
  const forever = parseWowSyncExport(buildWowSyncExport({ character: { name: "Rordin", realm: "Classic Beta PvP 2", clientFamily: "Forever", clientVersion: "1.60.1", clientBuild: "70338", interface: "16001" }, equipment: { slots: [{ slot: 16, slotName: "MainHand", itemRef: "item:1", name: "Axe" }] } }));
  assert.equal(forever.equipment.slots.find((slot) => slot.slot === 16)?.slotName, "Main Hand");
  const retail = parseWowSyncExport(buildWowSyncExport({ character: { name: "Retail", realm: "Cairne", clientFamily: "Retail", clientVersion: "12.1.0", clientBuild: "70000" }, equipment: { slots: [{ slot: 16, slotName: "Slot 16", itemRef: "item:1", name: "Axe" }] } }));
  assert.equal(retail.equipment.slots.find((slot) => slot.slot === 16)?.slotName, "Slot 16", "Forever mapping is profile isolated");
  assert.equal(equipmentSlotLabel("forever", 16, "Slot 16"), "Main Hand");
  assert.equal(equipmentSlotLabel("retail", 16, "MainHand"), "MainHand", "non-Forever presentation keeps the caller's own labels");
});

test("empty slots stay physical observations and do not become inferred gear deficiencies", () => {
  assert.equal(classifyForeverEmptySlot(4), "OPTIONAL_OR_COSMETIC");
  assert.equal(classifyForeverEmptySlot(19), "OPTIONAL_OR_COSMETIC");
  assert.equal(classifyForeverEmptySlot(16), "UNKNOWN_APPLICABILITY");
  assert.equal(classifyForeverEmptySlot(99), "UNKNOWN_SLOT");
  assert.equal(unresolvedItemName(undefined, "item:4237"), "Item name unresolved (item ID 4237)");
  assert.equal(unresolvedItemName(undefined, undefined), "Item name unresolved (item ID UNKNOWN)");
});
