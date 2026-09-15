import assert from "node:assert/strict";
import { test } from "node:test";
import { diffSnapshots } from "../src/diff.ts";
import { parseWowSyncExport } from "../src/parser.ts";
import { buildWowSyncExport } from "./fixtureBuilder.ts";

test("computes level and gold deltas between two snapshots", () => {
  const from = parseWowSyncExport(buildWowSyncExport({ character: { level: 20, moneyCopper: 50000 } }));
  const to = parseWowSyncExport(buildWowSyncExport({ character: { level: 22, moneyCopper: 70000 } }));
  const diff = diffSnapshots(from, to);
  assert.deepEqual(diff.level, { from: 20, to: 22, delta: 2 });
  assert.deepEqual(diff.moneyCopper, { from: 50000, to: 70000, delta: 20000 });
});

test("computes playtime deltas from PlayedSeconds/LevelPlayedSeconds", () => {
  const from = parseWowSyncExport(buildWowSyncExport({ character: { playedSeconds: 3600, levelPlayedSeconds: 600 } }));
  const to = parseWowSyncExport(buildWowSyncExport({ character: { playedSeconds: 7200, levelPlayedSeconds: 1200 } }));
  const diff = diffSnapshots(from, to);
  assert.equal(diff.playedSeconds.delta, 3600);
  assert.equal(diff.levelPlayedSeconds.delta, 600);
});

test("does not fabricate a delta when either side is unknown", () => {
  const from = parseWowSyncExport(buildWowSyncExport({ character: { moneyCopper: 50000 } }));
  const to = parseWowSyncExport(buildWowSyncExport({ character: { playedSeconds: undefined } }));
  // simulate unknown money on the "to" side by re-parsing with unknown fields
  const toUnknownMoney = parseWowSyncExport(buildWowSyncExport({ character: { level: 5 } }));
  const diff = diffSnapshots(from, toUnknownMoney);
  assert.equal(diff.moneyCopper.delta, undefined);
  assert.equal(diff.moneyCopper.from, 50000);
});

test("computes profession skill deltas", () => {
  const from = parseWowSyncExport(
    buildWowSyncExport({ professions: { entries: [{ name: "Mining", skill: 60, maxSkill: 300 }] } }),
  );
  const to = parseWowSyncExport(
    buildWowSyncExport({ professions: { entries: [{ name: "Mining", skill: 74, maxSkill: 300 }] } }),
  );
  const diff = diffSnapshots(from, to);
  assert.equal(diff.professions.length, 1);
  assert.equal(diff.professions[0].name, "Mining");
  assert.equal(diff.professions[0].skill.delta, 14);
});

test("computes inventory gained/lost deltas by itemRef", () => {
  const from = parseWowSyncExport(
    buildWowSyncExport({
      bags: { containers: [{ id: 0, capacity: 16, free: 10, items: [{ itemRef: "item:2589", name: "Linen Cloth", qty: 5 }] }] },
    }),
  );
  const to = parseWowSyncExport(
    buildWowSyncExport({
      bags: {
        containers: [
          {
            id: 0,
            capacity: 16,
            free: 8,
            items: [
              { itemRef: "item:2589", name: "Linen Cloth", qty: 8 },
              { itemRef: "item:2592", name: "Wool Cloth", qty: 2 },
            ],
          },
        ],
      },
    }),
  );
  const diff = diffSnapshots(from, to);
  const linen = diff.bagsItems.find((i) => i.itemRef === "item:2589");
  const wool = diff.bagsItems.find((i) => i.itemRef === "item:2592");
  assert.equal(linen?.deltaQty, 3);
  assert.equal(wool?.deltaQty, 2);
  assert.equal(wool?.fromQty, 0);
});

test("does not diff inventory when one side is UNKNOWN (never visited)", () => {
  const from = parseWowSyncExport(buildWowSyncExport({ bank: { unknown: true } }));
  const to = parseWowSyncExport(
    buildWowSyncExport({ bank: { containers: [{ id: -1, capacity: 24, free: 20, items: [{ itemRef: "item:1", name: "X", qty: 4 }] }] } }),
  );
  const diff = diffSnapshots(from, to);
  assert.equal(diff.bankItems.length, 0);
});

test("detects equipment slot changes", () => {
  const from = parseWowSyncExport(
    buildWowSyncExport({ equipment: { slots: [{ slot: 16, slotName: "MainHand", itemRef: "item:100", name: "Old Sword" }] } }),
  );
  const to = parseWowSyncExport(
    buildWowSyncExport({ equipment: { slots: [{ slot: 16, slotName: "MainHand", itemRef: "item:200", name: "New Sword" }] } }),
  );
  const diff = diffSnapshots(from, to);
  const mainHand = diff.equipment.find((e) => e.slot === 16);
  assert.equal(mainHand?.from, "item:100");
  assert.equal(mainHand?.to, "item:200");
});
