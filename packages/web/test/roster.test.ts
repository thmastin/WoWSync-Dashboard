import assert from "node:assert/strict";
import { test } from "node:test";
import { filterAndSortRoster, parseSort, rosterClassOptions, toggleSort, type RosterFilters } from "../src/roster.ts";
import type { CharacterFacts } from "../src/types.ts";

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
  char({ identityKey: "a", name: "Aldor", class: "Priest", level: 70, goldCopper: 50000, freshness: "stale", lastObservedAt: 100, bankStatus: "UNKNOWN" }),
  char({ identityKey: "b", name: "Brom", class: "Warrior", level: 80, goldCopper: 100, freshness: "recent", lastObservedAt: 300 }),
  char({ identityKey: "c", name: "Cyra", class: "Mage", level: 60, goldCopper: 90000, freshness: "unknown", lastObservedAt: undefined, bankStatus: "UNKNOWN" }),
];

const base: RosterFilters = { q: "", classFilter: "", age: "", sort: "name", bankMissing: false };

test("default sort is by name ascending", () => {
  const rows = filterAndSortRoster(sample, base);
  assert.deepEqual(rows.map((r) => r.name), ["Aldor", "Brom", "Cyra"]);
});

test("q matches name or class", () => {
  assert.equal(filterAndSortRoster(sample, { ...base, q: "war" }).map((r) => r.name).join(), "Brom");
  assert.equal(filterAndSortRoster(sample, { ...base, q: "ald" }).map((r) => r.name).join(), "Aldor");
});

test("class and age and bank-missing filters compose", () => {
  const rows = filterAndSortRoster(sample, { ...base, classFilter: "Priest", age: "stale", bankMissing: true });
  assert.deepEqual(rows.map((r) => r.name), ["Aldor"]);
});

test("sort by level descending", () => {
  const rows = filterAndSortRoster(sample, { ...base, sort: "-level" });
  assert.deepEqual(rows.map((r) => r.level), [80, 70, 60]);
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
  assert.deepEqual(rosterClassOptions(sample), ["Mage", "Priest", "Warrior"]);
});