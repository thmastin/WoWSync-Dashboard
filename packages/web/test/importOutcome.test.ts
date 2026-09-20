// How an import result is classified and when "No changes detected." may be shown.
import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyImport, hasAnyChange } from "../src/importOutcome.ts";
import type { SnapshotDiff } from "../src/types.ts";

const nd = { from: undefined, to: undefined, delta: undefined };
const emptyDiff = (over: Partial<SnapshotDiff> = {}): SnapshotDiff => ({
  level: { ...nd },
  xp: { ...nd },
  xpMax: { ...nd },
  moneyCopper: { ...nd },
  playedSeconds: { ...nd },
  levelPlayedSeconds: { ...nd },
  location: { changed: false },
  professions: [],
  bagsItems: [],
  bankItems: [],
  equipment: [],
  trainerUnlocks: [],
  ...over,
});

// --- classification -----------------------------------------------------------------------------------

test("a duplicate export is 'duplicate' whatever else the flags say", () => {
  assert.equal(classifyImport({ isFirstSnapshot: false, isDuplicate: true, isLatest: true }), "duplicate");
  assert.equal(classifyImport({ isFirstSnapshot: false, isDuplicate: true, isLatest: false }), "duplicate");
});

test("the first snapshot of a character is 'first'", () => {
  assert.equal(classifyImport({ isFirstSnapshot: true, isDuplicate: false, isLatest: true }), "first");
});

test("an older observation imported after a newer one is 'older' (current state unchanged)", () => {
  assert.equal(classifyImport({ isFirstSnapshot: false, isDuplicate: false, isLatest: false }), "older");
});

test("an ordinary new latest snapshot is 'normal'", () => {
  assert.equal(classifyImport({ isFirstSnapshot: false, isDuplicate: false, isLatest: true }), "normal");
});

test("a reply from an OLDER server, which sends neither flag, is a normal import - a missing flag must never read as 'older' or 'duplicate'", () => {
  assert.equal(classifyImport({ isFirstSnapshot: false }), "normal");
  assert.equal(classifyImport({ isFirstSnapshot: true }), "first");
  assert.equal(classifyImport({ isFirstSnapshot: false, isDuplicate: undefined, isLatest: undefined }), "normal");
});

// --- "No changes detected" -------------------------------------------------------------------------------

test("an empty diff has no changes", () => {
  assert.equal(hasAnyChange(emptyDiff()), false);
});

test("every dimension the summary lists counts as a change, including XP and /played", () => {
  const cases: [string, Partial<SnapshotDiff>][] = [
    ["level", { level: { from: 1, to: 2, delta: 1 } }],
    ["xp", { xp: { from: 10, to: 50, delta: 40 } }],
    ["gold", { moneyCopper: { from: 5, to: 9, delta: 4 } }],
    ["/played", { playedSeconds: { from: 100, to: 400, delta: 300 } }],
    ["location", { location: { changed: true } }],
    ["professions", { professions: [{ name: "Mining", skill: { ...nd, delta: 1 }, maxSkill: { ...nd } }] }],
    ["equipment", { equipment: [{ slot: 1, slotName: "Head", from: "a", to: "b" }] }],
    ["bags", { bagsItems: [{ fromQty: 0, toQty: 1, deltaQty: 1 }] }],
    ["bank", { bankItems: [{ fromQty: 1, toQty: 0, deltaQty: -1 }] }],
    ["trainer", { trainerUnlocks: [{ category: "CLASS", ability: "Fireball" }] }],
  ];
  for (const [name, over] of cases) {
    assert.equal(hasAnyChange(emptyDiff(over)), true, name);
  }
});

test("a re-export with ONLY XP or /played growth is not 'no changes' (the old gate ignored both and printed it under the list)", () => {
  assert.equal(hasAnyChange(emptyDiff({ xp: { from: 1, to: 2, delta: 1 } })), true);
  assert.equal(hasAnyChange(emptyDiff({ playedSeconds: { from: 1, to: 2, delta: 1 } })), true);
});

test("a delta of exactly 0 is not a change", () => {
  assert.equal(hasAnyChange(emptyDiff({ moneyCopper: { from: 5, to: 5, delta: 0 }, xp: { from: 1, to: 1, delta: 0 } })), false);
});
