import assert from "node:assert/strict";
import { test } from "node:test";
import {
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

test("selectPrimaryProfessionCharacter: empty returns undefined", () => {
  assert.equal(selectPrimaryProfessionCharacter([]), undefined);
});

test("selectPrimaryProfessionCharacter: highest skill wins", () => {
  const primary = selectPrimaryProfessionCharacter([
    { identityKey: "a", name: "Alice", skill: 100, maxSkill: 300 },
    { identityKey: "b", name: "Bob", skill: 250, maxSkill: 300 },
    { identityKey: "c", name: "Cara", skill: 200, maxSkill: 300 },
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
