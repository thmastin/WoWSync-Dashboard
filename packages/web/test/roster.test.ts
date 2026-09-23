import assert from "node:assert/strict";
import { test } from "node:test";
import { filterAndSortRoster, formatBagSlots, parseSort, rosterClassOptions, toggleSort, type RosterFilters } from "../src/roster.ts";
import type { CharacterFacts } from "../src/types.ts";

const NOW = 1_700_000_000;
const day = 86400;

function char(over: Partial<CharacterFacts> & Pick<CharacterFacts, "identityKey" | "name">): CharacterFacts {
  return {
    realm: "Cairne",
    snapshotCount: 1,
    freshness: "recent",
    bankStatus: "OBSERVED",
    professionsObservationStatus: "OBSERVED",
    bagsStatus: "OBSERVED",
    ...over,
  };
}

const sample: CharacterFacts[] = [
  char({
    identityKey: "a",
    name: "Aldor",
    class: "Priest",
    level: 70,
    goldCopper: 50000,
    freshness: "stale",
    lastObservedAt: NOW - 10 * day,
    bankStatus: "UNKNOWN",
  }),
  char({
    identityKey: "b",
    name: "Brom",
    class: "Warrior",
    level: 80,
    goldCopper: 100,
    freshness: "recent",
    lastObservedAt: NOW - day,
  }),
  char({
    identityKey: "c",
    name: "Cyra",
    class: "Mage",
    level: 60,
    goldCopper: 90000,
    freshness: "unknown",
    lastObservedAt: undefined,
    bankStatus: "UNKNOWN",
  }),
  char({
    identityKey: "d",
    name: "Dara",
    class: "Hunter",
    level: 85,
    goldCopper: 200,
    freshness: "stale",
    lastObservedAt: NOW - 20 * day,
  }),
];

const base: RosterFilters = { q: "", classFilter: "", age: "", sort: "name", bankMissing: false, now: NOW };

test("default sort is by name ascending", () => {
  const rows = filterAndSortRoster(sample, base);
  assert.deepEqual(rows.map((r) => r.name), ["Aldor", "Brom", "Cyra", "Dara"]);
});

test("q matches name or class", () => {
  assert.equal(filterAndSortRoster(sample, { ...base, q: "war" }).map((r) => r.name).join(), "Brom");
  assert.equal(filterAndSortRoster(sample, { ...base, q: "ald" }).map((r) => r.name).join(), "Aldor");
});

test("class and age bands and bank-missing filters compose", () => {
  const rows = filterAndSortRoster(sample, { ...base, classFilter: "Priest", age: "aging", bankMissing: true });
  assert.deepEqual(rows.map((r) => r.name), ["Aldor"]);
});

test("age bands: recent / aging / old / never", () => {
  assert.deepEqual(filterAndSortRoster(sample, { ...base, age: "recent" }).map((r) => r.name), ["Brom"]);
  assert.deepEqual(filterAndSortRoster(sample, { ...base, age: "aging" }).map((r) => r.name), ["Aldor"]);
  assert.deepEqual(filterAndSortRoster(sample, { ...base, age: "old" }).map((r) => r.name), ["Dara"]);
  assert.deepEqual(filterAndSortRoster(sample, { ...base, age: "never" }).map((r) => r.name), ["Cyra"]);
});

test("legacy age=stale matches aging and old; unknown matches never", () => {
  assert.deepEqual(filterAndSortRoster(sample, { ...base, age: "stale" }).map((r) => r.name), ["Aldor", "Dara"]);
  assert.deepEqual(filterAndSortRoster(sample, { ...base, age: "unknown" }).map((r) => r.name), ["Cyra"]);
});

test("sort by level descending", () => {
  const rows = filterAndSortRoster(sample, { ...base, sort: "-level" });
  assert.deepEqual(rows.map((r) => r.level), [85, 80, 70, 60]);
});

test("synced defaults to newest first", () => {
  assert.deepEqual(parseSort("synced"), { key: "synced", descending: true });
  const rows = filterAndSortRoster(sample, { ...base, sort: "synced" });
  assert.equal(rows[0].name, "Brom");
  assert.equal(rows[rows.length - 1].name, "Cyra");
});

test("toggleSort flips direction on the same key", () => {
  assert.equal(toggleSort("name", "name"), "-name");
  assert.equal(toggleSort("-name", "name"), "name");
  assert.equal(toggleSort("name", "level"), "level");
});

test("rosterClassOptions is sorted unique", () => {
  assert.deepEqual(rosterClassOptions(sample), ["Hunter", "Mage", "Priest", "Warrior"]);
});
test("formatBagSlots: never shows unknown as 0", () => {
  assert.equal(formatBagSlots(undefined, undefined), "?");
  assert.equal(formatBagSlots(undefined, 80), "?/80");
  assert.equal(formatBagSlots(12, undefined), "12/?");
  assert.equal(formatBagSlots(0, 80), "0/80");
  assert.equal(formatBagSlots(12, 80), "12/80");
});

test("sort by bags: known free slots before unknown; unknown never sorts as 0", () => {
  const mixed = [
    char({ identityKey: "u", name: "UnknownBags", bagsFreeSlots: undefined, bagsTotalSlots: undefined }),
    char({ identityKey: "z", name: "ZeroFree", bagsFreeSlots: 0, bagsTotalSlots: 80 }),
    char({ identityKey: "t", name: "TenFree", bagsFreeSlots: 10, bagsTotalSlots: 80 }),
  ];
  const asc = filterAndSortRoster(mixed, { ...base, sort: "bags" });
  assert.deepEqual(asc.map((r) => r.name), ["ZeroFree", "TenFree", "UnknownBags"]);
  const desc = filterAndSortRoster(mixed, { ...base, sort: "-bags" });
  assert.deepEqual(desc.map((r) => r.name), ["TenFree", "ZeroFree", "UnknownBags"]);
});

test("sort by bank: observed before unknown (unknown last)", () => {
  const mixed = [
    char({ identityKey: "u", name: "NoBank", bankStatus: "UNKNOWN" }),
    char({ identityKey: "o", name: "HasBank", bankStatus: "OBSERVED" }),
    char({ identityKey: "l", name: "LastSeen", bankStatus: "LAST_SEEN" }),
  ];
  const asc = filterAndSortRoster(mixed, { ...base, sort: "bank" });
  assert.deepEqual(asc.map((r) => r.name), ["HasBank", "LastSeen", "NoBank"]);
});

test("sort by gold: unknown gold sorts after known, including after a real 0", () => {
  const mixed = [
    char({ identityKey: "u", name: "UnknownGold", goldCopper: undefined }),
    char({ identityKey: "z", name: "ZeroGold", goldCopper: 0 }),
    char({ identityKey: "r", name: "Rich", goldCopper: 50000 }),
  ];
  const asc = filterAndSortRoster(mixed, { ...base, sort: "gold" });
  assert.deepEqual(asc.map((r) => r.name), ["ZeroGold", "Rich", "UnknownGold"]);
});

test("every visible column has a recognized sort key", () => {
  for (const key of ["name", "realm", "class", "level", "gold", "bank", "bags", "synced"] as const) {
    assert.equal(parseSort(key).key, key);
    assert.equal(parseSort("-" + key).key, key);
  }
});

test("toggleSort flips synced via +synced for ascending", () => {
  assert.equal(toggleSort("name", "synced"), "synced");
  assert.deepEqual(parseSort("synced"), { key: "synced", descending: true });
  assert.equal(toggleSort("synced", "synced"), "+synced");
  assert.deepEqual(parseSort("+synced"), { key: "synced", descending: false });
  assert.equal(toggleSort("+synced", "synced"), "synced");
});
