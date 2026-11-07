import assert from "node:assert/strict";
import { test } from "node:test";
import { DashboardReadModel } from "../src/readModel.ts";
import { SqliteSnapshotStore } from "../src/sqliteStore.ts";
import { buildWowSyncExport } from "./fixtureBuilder.ts";

const NOW = 1_800_000_000;
const REALM = "Twin Realm";

function foreverCharacter(surname: string, level: number, className: string, profession: string, skill: number, recipeID: number) {
  const generatedAt = NOW - 10;
  const text = buildWowSyncExport({
    generatedAt,
    character: { name: "Hallo", surname, realm: REALM, class: className, level, faction: "Alliance", clientFamily: "Forever", clientVersion: "1.60.1", clientBuild: "70338", interface: "16001" },
    professions: { entries: [{ name: profession, skill, maxSkill: 75 }] },
    bank: { unknown: true },
  });
  const professionRecipes = {
    observedAt: generatedAt,
    completeness: "partial",
    data: {
      formatVersion: 1,
      ownerScope: "CHARACTER",
      coverage: { state: "PARTIAL", candidateCompleteness: "UNKNOWN", returnedRecipeCount: 1 },
      professions: [{
        baseSkillLineID: 1, skillLineID: 1, professionName: profession, evidence: "OBSERVED", observedAt: generatedAt,
        recipes: [{ recipeID, name: `${surname} recipe`, learned: true, learnedState: "OBSERVED_TRUE", evidence: "OBSERVED", observedAt: generatedAt }],
      }],
    },
  };
  return { text, extras: { foreverGearObservation: { clientProfile: "Forever:1.60.1:70338:16001", name: "Hallo", realm: REALM, generatedAt, sourceCharacterGuid: `Player-1-${surname}`, professionRecipes } } };
}

function open() {
  const store = new SqliteSnapshotStore(":memory:");
  store.importSnapshot(foreverCharacter("Ashwick", 17, "Warlock", "Mining", 20, 111).text, foreverCharacter("Ashwick", 17, "Warlock", "Mining", 20, 111).extras);
  store.importSnapshot(foreverCharacter("Oldbeard", 2, "Hunter", "Skinning", 5, 222).text, foreverCharacter("Oldbeard", 2, "Hunter", "Skinning", 5, 222).extras);
  store.importSnapshot(buildWowSyncExport({ generatedAt: NOW - 5, character: { name: "Solo", realm: REALM, class: "Mage", level: 4, clientFamily: "Forever", clientVersion: "1.60.1", clientBuild: "70338", interface: "16001" }, professions: { entries: [{ name: "Tailoring", skill: 1, maxSkill: 75 }] } }));
  store.importSnapshot(buildWowSyncExport({ generatedAt: NOW - 5, character: { name: "Hallo", realm: REALM, class: "Mage", level: 60, clientFamily: "Retail", clientVersion: "12.1.0" } }));
  return { store, read: new DashboardReadModel(store, () => NOW) };
}

test("same first name and realm stays ambiguous until an exact Forever selector is supplied", () => {
  const { store, read } = open();
  try {
    const ambiguous = read.getCharacterSummary({ version: "forever", name: "Hallo", realm: REALM });
    assert.equal(ambiguous.status, "AMBIGUOUS");
    if (ambiguous.status === "AMBIGUOUS") {
      assert.deepEqual(ambiguous.candidates.map((candidate) => [candidate.name, candidate.surname, candidate.realm]).sort(), [["Hallo", "Ashwick", REALM], ["Hallo", "Oldbeard", REALM]]);
      assert.deepEqual(ambiguous.candidates.map((candidate) => candidate.identityKey).sort(), ["forever::twin realm::hallo::ashwick", "forever::twin realm::hallo::oldbeard"]);
    }
    assert.equal(read.getCharacterSummary({ version: "forever", name: "Hallo Ashwick", realm: REALM }).status, "NOT_FOUND");
    assert.equal(read.getCharacterSummary({ version: "forever", name: "Hallo", realm: REALM, surname: "Nobody" }).status, "NOT_FOUND");
    assert.equal(read.getCharacterSummary({ version: "forever", name: "Hallo", realm: REALM, identityKey: "forever::twin realm::hallo::missing" }).status, "NOT_FOUND");

    const bySurname = read.getCharacterSummary({ version: "forever", name: "Hallo", realm: REALM, surname: "ashwick" });
    const byKey = read.getCharacterSummary({ version: "forever", name: "Hallo", realm: REALM, identityKey: "forever::twin realm::hallo::oldbeard" });
    assert.equal(bySurname.status, "FOUND");
    assert.equal(byKey.status, "FOUND");
    if (bySurname.status === "FOUND" && byKey.status === "FOUND") {
      assert.equal(bySurname.value.data?.surname, "Ashwick");
      assert.equal(bySurname.value.data?.level, 17);
      assert.equal(bySurname.value.provenance.identityKey, "forever::twin realm::hallo::ashwick");
      assert.equal(byKey.value.data?.surname, "Oldbeard");
      assert.equal(byKey.value.data?.level, 2);
      assert.notEqual(bySurname.value.provenance.identityKey, byKey.value.provenance.identityKey);
    }

    const ashwickRecipes = read.getCharacterProfessions({ version: "forever", name: "Hallo", realm: REALM, surname: "Ashwick" });
    const oldbeardRecipes = read.getCharacterProfessions({ version: "forever", name: "Hallo", realm: REALM, identityKey: "forever::twin realm::hallo::oldbeard" });
    assert.equal(ashwickRecipes.status, "FOUND");
    assert.equal(oldbeardRecipes.status, "FOUND");
    if (ashwickRecipes.status === "FOUND" && oldbeardRecipes.status === "FOUND") {
      const recipeNames = (result: typeof ashwickRecipes) => JSON.stringify(result.value.data?.recipeKnowledge);
      assert.match(recipeNames(ashwickRecipes), /Ashwick recipe/);
      assert.doesNotMatch(recipeNames(ashwickRecipes), /Oldbeard recipe/);
      assert.match(recipeNames(oldbeardRecipes), /Oldbeard recipe/);
      assert.doesNotMatch(recipeNames(oldbeardRecipes), /Ashwick recipe/);
      assert.equal(ashwickRecipes.value.data?.entries.find((entry) => entry.name === "Mining")?.skill, 20);
      assert.equal(oldbeardRecipes.value.data?.entries.find((entry) => entry.name === "Skinning")?.skill, 5);
    }

    const conflict = read.getCharacterSummary({ version: "forever", name: "Hallo", realm: REALM, surname: "Oldbeard", identityKey: "forever::twin realm::hallo::ashwick" });
    assert.equal(conflict.status, "SELECTOR_CONFLICT");
    assert.equal(read.getCharacterSummary({ version: "forever", name: "Solo", realm: REALM, identityKey: "forever::twin realm::hallo::ashwick" }).status, "SELECTOR_CONFLICT");
    assert.equal(read.getCharacterSummary({ version: "forever", name: "Hallo", realm: "Other Realm", identityKey: "forever::twin realm::hallo::ashwick" }).status, "SELECTOR_CONFLICT");
    const otherVersion = read.getCharacterSummary({ version: "forever", name: "Hallo", realm: REALM, identityKey: "retail::twin realm::hallo" });
    assert.equal(otherVersion.status, "SELECTOR_CONFLICT");
    if (otherVersion.status === "SELECTOR_CONFLICT") assert.match(otherVersion.reason, /different WoW version/);
    const retail = read.getCharacterSummary({ version: "retail", name: "Hallo", realm: REALM });
    assert.equal(retail.status, "FOUND");
    if (retail.status === "FOUND") assert.equal(retail.value.provenance.version, "retail");

    const solo = read.getCharacterSummary({ version: "forever", name: "Solo", realm: REALM });
    assert.equal(solo.status, "FOUND");
    if (solo.status === "FOUND") assert.equal(solo.value.data?.name, "Solo");

    const context = store.buildAccountContext(NOW);
    const twins = context.versions.forever.characters.filter((character) => character.name === "Hallo" && character.realm === REALM);
    assert.equal(twins.length, 2);
    assert.deepEqual(twins.map((character) => character.foreverGearObservation?.status).sort(), ["FOUND", "FOUND"]);
    assert.deepEqual(twins.map((character) => character.foreverGearObservation?.status === "FOUND" ? character.foreverGearObservation.value.provenance.identityKey : "").sort(), ["forever::twin realm::hallo::ashwick", "forever::twin realm::hallo::oldbeard"]);
  } finally { store.close(); }
});
