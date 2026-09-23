import assert from "node:assert/strict";
import { test } from "node:test";
import {
  characterHasCurrentRetailExpansion,
  classifyRetailProfessionCoverage,
  expansionRank,
  highestProfessionExpansionLabel,
  professionPlanningKind,
  selectPrimaryProfessionCharacter,
} from "../src/professionCatalog.ts";

test("professionPlanningKind: gathering names (case-insensitive)", () => {
  assert.equal(professionPlanningKind("Herbalism"), "gathering");
  assert.equal(professionPlanningKind("mining"), "gathering");
  assert.equal(professionPlanningKind(" SKINNING "), "gathering");
  assert.equal(professionPlanningKind("Fishing"), "gathering");
});

test("professionPlanningKind: crafting names", () => {
  for (const name of [
    "Alchemy",
    "Blacksmithing",
    "Enchanting",
    "Engineering",
    "Inscription",
    "Jewelcrafting",
    "Leatherworking",
    "Tailoring",
    "Cooking",
    "First Aid",
  ]) {
    assert.equal(professionPlanningKind(name), "crafting", name);
  }
});

test("professionPlanningKind: unknown Forever-style name defaults to crafting", () => {
  assert.equal(professionPlanningKind("WeirdFutureCraft"), "crafting");
  assert.equal(professionPlanningKind("Archaeology"), "crafting");
});

test("expansionRank: Midnight newest, Classic older, unknown -1", () => {
  assert.ok(expansionRank("Midnight") > expansionRank("Dragon Isles"));
  assert.ok(expansionRank("Dragon Isles Herbalism") > expansionRank("Shadowlands"));
  assert.ok(expansionRank("Kul Tiran Skinning") > expansionRank("Legion"));
  assert.ok(expansionRank("The War Within") > expansionRank("Dragonflight"));
  assert.ok(expansionRank("Khaz Algar") > expansionRank("Dragon Isles"));
  assert.equal(expansionRank(undefined), -1);
  assert.equal(expansionRank("Unknown"), -1);
  assert.equal(expansionRank(""), -1);
});

test("characterHasCurrentRetailExpansion: expansion or tier Midnight", () => {
  assert.equal(characterHasCurrentRetailExpansion({ expansion: "Midnight" }), true);
  assert.equal(characterHasCurrentRetailExpansion({ tier: "Midnight Mining" }), true);
  assert.equal(characterHasCurrentRetailExpansion({ expansion: "Unknown", tier: "midnight cooking" }), true);
  assert.equal(characterHasCurrentRetailExpansion({ expansion: "Unknown", tier: "Dragon Isles Mining" }), false);
  assert.equal(characterHasCurrentRetailExpansion({}), false);
});

test("classifyRetailProfessionCoverage: olderOnly vs currentCovered", () => {
  assert.equal(
    classifyRetailProfessionCoverage({
      coverageStatus: "covered",
      characters: [{ tier: "Midnight Mining" }],
    }),
    "currentCovered",
  );
  assert.equal(
    classifyRetailProfessionCoverage({
      coverageStatus: "covered",
      characters: [{ tier: "Dragon Isles Mining" }, { expansion: "Unknown", tier: "Classic Mining" }],
    }),
    "olderOnly",
  );
  assert.equal(classifyRetailProfessionCoverage({ coverageStatus: "none", characters: [] }), "none");
  assert.equal(classifyRetailProfessionCoverage({ coverageStatus: "unknown", characters: [] }), "unknown");
});

test("highestProfessionExpansionLabel prefers newest match", () => {
  assert.equal(
    highestProfessionExpansionLabel([
      { tier: "Classic Mining" },
      { tier: "Dragon Isles Mining" },
      { expansion: "Unknown", tier: "Shadowlands Mining" },
    ]),
    "Dragon Isles",
  );
});

test("selectPrimaryProfessionCharacter: empty returns undefined", () => {
  assert.equal(selectPrimaryProfessionCharacter([]), undefined);
});

test("selectPrimaryProfessionCharacter: highest skill wins when expansion equal", () => {
  const primary = selectPrimaryProfessionCharacter([
    { identityKey: "a", name: "Alice", skill: 100, maxSkill: 300, tier: "Midnight Mining" },
    { identityKey: "b", name: "Bob", skill: 250, maxSkill: 300, tier: "Midnight Mining" },
    { identityKey: "c", name: "Cara", skill: 200, maxSkill: 300, tier: "Midnight Mining" },
  ]);
  assert.equal(primary?.identityKey, "b");
});

test("selectPrimaryProfessionCharacter: higher expansion beats higher skill", () => {
  const primary = selectPrimaryProfessionCharacter([
    { identityKey: "a", name: "Alice", skill: 300, maxSkill: 300, tier: "Dragon Isles Mining" },
    { identityKey: "b", name: "Bob", skill: 10, maxSkill: 100, tier: "Midnight Mining" },
  ]);
  assert.equal(primary?.identityKey, "b");
});

test("selectPrimaryProfessionCharacter: Unknown expansion falls back to tier rank", () => {
  const primary = selectPrimaryProfessionCharacter([
    { identityKey: "a", name: "Alice", skill: 90, expansion: "Unknown", tier: "Classic Mining" },
    { identityKey: "b", name: "Bob", skill: 5, expansion: "Unknown", tier: "Midnight Mining" },
  ]);
  assert.equal(primary?.identityKey, "b");
});

test("selectPrimaryProfessionCharacter: undefined skill sorts last, never as 0", () => {
  const primary = selectPrimaryProfessionCharacter([
    { identityKey: "a", name: "Alice", skill: undefined, maxSkill: 300 },
    { identityKey: "b", name: "Bob", skill: 1, maxSkill: 75 },
    { identityKey: "c", name: "Cara" },
  ]);
  assert.equal(primary?.identityKey, "b");
});

test("selectPrimaryProfessionCharacter: skill 0 beats undefined", () => {
  const primary = selectPrimaryProfessionCharacter([
    { identityKey: "a", name: "Alice" },
    { identityKey: "b", name: "Bob", skill: 0, maxSkill: 75 },
  ]);
  assert.equal(primary?.identityKey, "b");
});

test("selectPrimaryProfessionCharacter: tie-break higher maxSkill", () => {
  const primary = selectPrimaryProfessionCharacter([
    { identityKey: "a", name: "Alice", skill: 100, maxSkill: 150 },
    { identityKey: "b", name: "Bob", skill: 100, maxSkill: 300 },
  ]);
  assert.equal(primary?.identityKey, "b");
});

test("selectPrimaryProfessionCharacter: undefined maxSkill sorts last on tie", () => {
  const primary = selectPrimaryProfessionCharacter([
    { identityKey: "a", name: "Alice", skill: 100 },
    { identityKey: "b", name: "Bob", skill: 100, maxSkill: 75 },
  ]);
  assert.equal(primary?.identityKey, "b");
});

test("selectPrimaryProfessionCharacter: name localeCompare on full tie", () => {
  const primary = selectPrimaryProfessionCharacter([
    { identityKey: "z", name: "Zed", skill: 50, maxSkill: 75 },
    { identityKey: "a", name: "Ann", skill: 50, maxSkill: 75 },
    { identityKey: "m", name: "Mia", skill: 50, maxSkill: 75 },
  ]);
  assert.equal(primary?.identityKey, "a");
  assert.equal(primary?.name, "Ann");
});