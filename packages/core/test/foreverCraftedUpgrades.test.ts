import assert from "node:assert/strict";
import { test } from "node:test";
import { SqliteSnapshotStore } from "../src/sqliteStore.ts";
import { DashboardReadModel } from "../src/readModel.ts";
import { RORDIN_SNAPSHOT_180, seedRordinSnapshot180 } from "./fixtures/foreverSnapshot180.ts";
import { buildWowSyncExport } from "./fixtureBuilder.ts";

const NOW = RORDIN_SNAPSHOT_180.generatedAt + 30;
const RORDIN = { version: "forever" as const, name: "Rordin", realm: "Classic Beta PvP 2" };

test("snapshot 180 keeps recipe, output, gear, reference, reagent, bank, and eligibility evidence separate", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    assert.equal(seedRordinSnapshot180(store), 180);
    store.importSnapshot(buildWowSyncExport({ generatedAt: NOW, character: { name: "Hallo", surname: "Emberstone", realm: "Classic Beta PvP 2", clientFamily: "Forever", clientVersion: "1.60.1", clientBuild: "70338", interface: "16001" }, bags: { containers: [{ id: 0, capacity: 16, items: [{ itemRef: "item:2840::::::::6:1491:::::::::", name: "Copper Bar", qty: 20 }] }] }, bank: { unknown: true } }));
    const read = new DashboardReadModel(store, () => NOW);
    const result = read.getForeverCraftedUpgradeAssessment({ ...RORDIN, snapshotId: 180 });
    assert.equal(result.status, "FOUND");
    if (result.status !== "FOUND") return;
    const assessment = result.value.data!;
    assert.equal(assessment.identity.identityKey, RORDIN_SNAPSHOT_180.identity.identityKey);
    assert.equal(assessment.snapshot.snapshotId, 180);
    assert.equal(assessment.provenance.gearGuidHistoryGuard, "NOT_APPLIED_TO_THIS_SNAPSHOT_SCOPED_ASSESSMENT");
    assert.equal(assessment.recipeCoverage.state, "PARTIAL");
    assert.equal(assessment.recipeCoverage.candidateCompleteness, "UNKNOWN");
    assert.equal(assessment.recipeCoverage.knownNonEquipmentLearnedRecipeCount, 3);
    assert.deepEqual(assessment.candidates.map((candidate) => candidate.output.itemID), [2853, 10421]);

    const bracers = assessment.candidates[0]!;
    assert.deepEqual(bracers.reagents.map((row) => [row.itemID, row.quantity, row.availability, row.observedQuantity]), [[2840, 2, "LAST_SEEN", undefined]], "missing from a historical bag scan is not observed zero inventory");
    assert.equal(bracers.output.equipLocation, "INVTYPE_WRIST");
    assert.equal(bracers.output.itemAPIEquippable, "OBSERVED_TRUE");
    assert.equal(bracers.slot.equippedItem?.itemID, 2651);
    assert.equal(bracers.statComparison.status, "UNKNOWN");
    assert.equal(bracers.statComparison.referenceLeads[0]?.build, "70291");
    assert.equal(bracers.statComparison.referenceLeads[0]?.relationToSnapshot, "OLDER_BUILD_REFERENCE_ONLY");
    assert.equal(bracers.upgradeConclusion.state, "UNKNOWN");
    assert.equal(bracers.upgradeConclusion.provenUpgrade, false);
    assert.equal(bracers.eligibility.state, "UNKNOWN");
    assert.equal(bracers.eligibility.playerSpecificCheck, "UNKNOWN");
    assert.equal(bracers.eligibility.professionSkill.skill, 1);
    assert.equal(bracers.eligibility.professionSkill.requiredSkill, "UNKNOWN");
    assert.equal(bracers.crafting.facilities, "UNKNOWN");
    assert.equal(assessment.bank.state, "UNKNOWN");
    assert.equal(assessment.candidates[1]?.slot.equippedItem?.itemID, 1364);
    assert.deepEqual(assessment.candidates[1]?.reagents.map((row) => [row.itemID, row.quantity]), [[2840, 4]]);

    const gear = read.getForeverGearObservation(RORDIN);
    assert.equal(gear.status, "FOUND");
    if (gear.status === "FOUND") assert.equal(gear.value.provenance.state, "UNKNOWN", "the historical gear GUID guard remains active and unchanged");
  } finally { store.close(); }
});

test("complete same-snapshot candidate evidence can produce a positive recorded-stat assessment", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    seedRordinSnapshot180(store, { fullyEvidencedCandidateID: 2853 });
    const result = new DashboardReadModel(store, () => NOW).getForeverCraftedUpgradeAssessment({ ...RORDIN, snapshotId: 180 });
    assert.equal(result.status, "FOUND");
    if (result.status !== "FOUND") return;
    const candidate = result.value.data!.candidates.find((row) => row.output.itemID === 2853)!;
    assert.equal(candidate.statComparison.status, "POSSIBLE_RECORDED_STAT_UPGRADE");
    assert.deepEqual(candidate.statComparison.values.map((row) => [row.key, row.candidate, row.equipped, row.delta, row.labelState]), [["RESISTANCE0_NAME", 35, 25, 10, "UNKNOWN"]]);
    assert.equal(candidate.eligibility.state, "UNKNOWN", "a positive CanUseItem signal does not resolve explicit class and full eligibility semantics");
    assert.equal(candidate.upgradeConclusion.state, "POSSIBLE_RECORDED_STAT_UPGRADE");
    assert.equal(candidate.upgradeConclusion.provenUpgrade, false, "recorded-stat dominance is not an overall gameplay proof");
  } finally { store.close(); }
});

test("the exact compact assessment is shared by AccountContext and Ask My Account; versions stay isolated", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    seedRordinSnapshot180(store);
    store.importSnapshot(buildWowSyncExport({ generatedAt: NOW, character: { name: "Rordin", realm: "Classic Beta PvP 2", clientVersion: "1.15.9", class: "Warrior", level: 6 } }));
    const context = store.buildAccountContext(NOW);
    const character = context.versions.forever.characters.find((row) => row.identityKey === RORDIN_SNAPSHOT_180.identity.identityKey)!;
    assert.deepEqual(character.foreverCraftedUpgradeAssessment, new DashboardReadModel(store, () => NOW).getForeverCraftedUpgradeAssessment(RORDIN));
    const otherVersion = new DashboardReadModel(store, () => NOW).getForeverCraftedUpgradeAssessment({ version: "classic-era", name: "Rordin", realm: "Classic Beta PvP 2" });
    assert.equal(otherVersion.status, "FOUND");
    if (otherVersion.status === "FOUND") assert.equal(otherVersion.value.provenance.state, "UNKNOWN");
  } finally { store.close(); }
});

test("snapshot selection rejects a snapshot not belonging to the resolved canonical character", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    seedRordinSnapshot180(store);
    store.importSnapshot(buildWowSyncExport({ generatedAt: NOW, character: { name: "Twin", realm: "Classic Beta PvP 2", clientFamily: "Forever", clientVersion: "1.60.1", clientBuild: "70338", interface: "16001" } }));
    assert.throws(() => new DashboardReadModel(store, () => NOW).getForeverCraftedUpgradeAssessment({ version: "forever", name: "Twin", realm: "Classic Beta PvP 2", snapshotId: 180 }), /must belong to the resolved character/);
  } finally { store.close(); }
});
