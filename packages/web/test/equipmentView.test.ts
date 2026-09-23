import assert from "node:assert/strict";
import { test } from "node:test";
import { parseItemLevel, summarizeEquipmentIlvl } from "../src/equipmentView.ts";

test("parseItemLevel accepts numbers and rejects unknown forms", () => {
  assert.equal(parseItemLevel("123"), 123);
  assert.equal(parseItemLevel(" 45.0 "), 45);
  assert.equal(parseItemLevel(undefined), undefined);
  assert.equal(parseItemLevel(""), undefined);
  assert.equal(parseItemLevel("?"), undefined);
  assert.equal(parseItemLevel("UNKNOWN"), undefined);
  assert.equal(parseItemLevel("n/a"), undefined);
});

test("average ignores empty slots and never invents zero from unknowns", () => {
  assert.equal(summarizeEquipmentIlvl([]), null);
  assert.equal(summarizeEquipmentIlvl([{ empty: true, slotName: "Shirt" }]), null);
  assert.equal(
    summarizeEquipmentIlvl([
      { empty: false, name: "Sword", itemLevel: undefined },
      { empty: false, name: "Helm", itemLevel: "?" },
    ]),
    null,
  );
});

test("average is the rounded mean of known equipped ilvls", () => {
  const summary = summarizeEquipmentIlvl([
    { empty: false, name: "A", itemLevel: "100" },
    { empty: false, name: "B", itemLevel: "200" },
    { empty: true, slotName: "Tabard" },
    { empty: false, name: "C", itemLevel: "?" },
  ]);
  assert.deepEqual(summary, {
    average: 150,
    counted: 2,
    equipped: 3,
    empty: 1,
    unknownIlvl: 1,
  });
});

test("single known ilvl averages to itself", () => {
  const summary = summarizeEquipmentIlvl([{ empty: false, name: "Ring", itemLevel: "489" }]);
  assert.equal(summary?.average, 489);
  assert.equal(summary?.counted, 1);
  assert.equal(summary?.equipped, 1);
});