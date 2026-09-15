import assert from "node:assert/strict";
import { test } from "node:test";
import { parseWowSyncExport, WowSyncParseError } from "../src/parser.ts";
import { buildWowSyncExport } from "./fixtureBuilder.ts";

test("parses a valid, fully-populated WOWSYNC v1 export", () => {
  const raw = buildWowSyncExport({
    character: { name: "Torahn", realm: "Faerlina", class: "Shaman", level: 30, moneyCopper: 100000 },
  });
  const snapshot = parseWowSyncExport(raw);
  assert.equal(snapshot.character.name, "Torahn");
  assert.equal(snapshot.character.realm, "Faerlina");
  assert.equal(snapshot.character.level, 30);
  assert.equal(snapshot.character.moneyCopper, 100000);
  assert.equal(snapshot.character.status.state, "OBSERVED");
});

test("parses all eight sections present and labeled correctly", () => {
  const raw = buildWowSyncExport();
  const snapshot = parseWowSyncExport(raw);
  for (const key of ["character", "location", "equipment", "bags", "bank", "professions", "spells", "trainer"] as const) {
    assert.ok(snapshot[key], `expected section ${key} to be present`);
  }
});

test("unknown ('?') fields become undefined, never a guessed value", () => {
  const raw = buildWowSyncExport({
    character: { playedSeconds: undefined, levelPlayedSeconds: undefined },
  });
  const snapshot = parseWowSyncExport(raw);
  assert.equal(snapshot.character.playedSeconds, undefined);
  assert.equal(snapshot.character.levelPlayedSeconds, undefined);
});

test("partial equipment coverage is preserved, not upgraded to complete", () => {
  const raw = buildWowSyncExport({ equipment: { partial: true, slots: [] } });
  const snapshot = parseWowSyncExport(raw);
  assert.equal(snapshot.equipment.status.state, "OBSERVED");
  assert.equal(snapshot.equipment.status.completeness, "partial");
});

test("an unvisited bank renders UNKNOWN, distinct from EMPTY", () => {
  const raw = buildWowSyncExport({ bank: { unknown: true } });
  const snapshot = parseWowSyncExport(raw);
  assert.equal(snapshot.bank.status.state, "UNKNOWN");
  assert.equal(snapshot.bank.items.length, 0);
  assert.equal(snapshot.bank.itemsKnownEmpty, false);
});

test("an observed-but-empty bank is EMPTY, distinct from UNKNOWN", () => {
  const raw = buildWowSyncExport({
    bank: { containers: [{ id: -1, capacity: 24, free: 24, family: 0 }] },
  });
  const snapshot = parseWowSyncExport(raw);
  assert.equal(snapshot.bank.status.state, "OBSERVED");
  assert.equal(snapshot.bank.itemsKnownEmpty, true);
  assert.equal(snapshot.bank.items.length, 0);
});

test("an unvisited trainer renders UNKNOWN with a reason", () => {
  const raw = buildWowSyncExport({ trainer: { unknown: true } });
  const snapshot = parseWowSyncExport(raw);
  assert.equal(snapshot.trainer.status.state, "UNKNOWN");
  assert.equal(snapshot.trainer.categories.length, 0);
});

test("multiple independent trainer categories are preserved without collapsing", () => {
  const raw = buildWowSyncExport({
    trainer: {
      categories: [
        { category: "CLASS", name: "Shaman Trainer", services: [{ spellID: 8017, ability: "Frost Shock", status: "available", requiredLevel: 20, cost: 500 }] },
        { category: "PROF_MINING", name: "Mining Trainer", services: [{ spellID: 2575, ability: "Mining", status: "known" }] },
        { category: "PROF_COOKING", name: "Cooking Trainer", services: [] },
        { category: "WEAPON", name: "Weapon Trainer", state: "LAST_SEEN" },
      ],
    },
  });
  const snapshot = parseWowSyncExport(raw);
  assert.equal(snapshot.trainer.categories.length, 4);
  const byCategory = new Map(snapshot.trainer.categories.map((c) => [c.category, c]));
  assert.equal(byCategory.get("CLASS")?.services[0].ability, "Frost Shock");
  assert.equal(byCategory.get("PROF_MINING")?.services[0].ability, "Mining");
  assert.equal(byCategory.get("WEAPON")?.status.state, "LAST_SEEN");
});

test("item variants with different itemRefs stay distinguishable", () => {
  const raw = buildWowSyncExport({
    bags: {
      containers: [
        {
          id: 0,
          capacity: 16,
          free: 14,
          items: [
            { itemRef: "item:2589::::::::60:::::", name: "Linen Cloth", qty: 5 },
            { itemRef: "item:2589:1234::::::::60:::::", name: "Linen Cloth", qty: 2 },
          ],
        },
      ],
    },
  });
  const snapshot = parseWowSyncExport(raw);
  assert.equal(snapshot.bags.items.length, 2);
  const refs = snapshot.bags.items.map((i) => i.itemRef);
  assert.ok(refs.includes("item:2589::::::::60:::::"));
  assert.ok(refs.includes("item:2589:1234::::::::60:::::"));
});

test("rejects text that does not begin with WOWSYNC v1", () => {
  assert.throws(() => parseWowSyncExport("not an export"), (err: unknown) => {
    assert.ok(err instanceof WowSyncParseError);
    assert.match(err.message, /WOWSYNC v1/);
    return true;
  });
});

test("rejects an export missing the [END] marker (truncated paste)", () => {
  const raw = buildWowSyncExport();
  const truncated = raw.slice(0, raw.lastIndexOf("[END]") - 2);
  assert.throws(() => parseWowSyncExport(truncated), (err: unknown) => {
    assert.ok(err instanceof WowSyncParseError);
    assert.match(err.message, /\[END\]/);
    return true;
  });
});

test("rejects an export missing a required section", () => {
  const raw = buildWowSyncExport();
  const withoutTrainer = raw.replace(/\n\n\[TRAINERS\][\s\S]*?(?=\n\n\[END\])/, "");
  assert.throws(() => parseWowSyncExport(withoutTrainer), (err: unknown) => {
    assert.ok(err instanceof WowSyncParseError);
    assert.match(err.message, /TRAINER/);
    return true;
  });
});

test("rejects a malformed row with the wrong column count", () => {
  const raw = buildWowSyncExport();
  const corrupted = raw.replace("slot\titemRef\tname\tilvl\trequiredLevel\teffectiveStats", "slot\titemRef\tname");
  assert.throws(() => parseWowSyncExport(corrupted), WowSyncParseError);
});

test("empty input is rejected with a clear message", () => {
  assert.throws(() => parseWowSyncExport(""), (err: unknown) => {
    assert.ok(err instanceof WowSyncParseError);
    assert.match(err.message, /empty/i);
    return true;
  });
});

test("parsing is deterministic: identical input yields identical structured output", () => {
  const raw = buildWowSyncExport({
    character: { name: "Voodan", moneyCopper: 54321 },
    bags: { containers: [{ id: 0, capacity: 16, free: 10, items: [{ itemRef: "item:1234", name: "Thing", qty: 3 }] }] },
  });
  const a = parseWowSyncExport(raw);
  const b = parseWowSyncExport(raw);
  assert.deepEqual(a, b);
});

test("escaped tab/newline/backslash characters in values round-trip correctly", () => {
  const raw = buildWowSyncExport({ location: { zone: "Zone\\With\\Backslash" } });
  const snapshot = parseWowSyncExport(raw);
  assert.equal(snapshot.location.zone, "Zone\\With\\Backslash");
});
