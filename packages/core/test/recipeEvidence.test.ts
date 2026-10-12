import assert from "node:assert/strict";
import { test } from "node:test";
import { SqliteSnapshotStore } from "../src/sqliteStore.ts";
import { DashboardReadModel } from "../src/readModel.ts";
import { assessErpNeed } from "../src/erpProjects.ts";
import { matchTrainerService, type RecipeKnowledgeRow } from "../src/recipeIntelligence.ts";
import { RORDIN_SNAPSHOT_180, RORDIN_SNAPSHOT_190, seedRordinSnapshot190 } from "./fixtures/foreverSnapshot180.ts";
import { buildWowSyncExport } from "./fixtureBuilder.ts";

const NOW = RORDIN_SNAPSHOT_190.generatedAt + 30;
const RORDIN = { version: "forever" as const, name: "Rordin", realm: "Classic Beta PvP 2" };

function withStore(fn: (store: SqliteSnapshotStore) => void) {
  const store = new SqliteSnapshotStore(":memory:");
  try { fn(store); } finally { store.close(); }
}

test("RORDIN ACCEPTANCE: latest snapshot 190 combines LAST_SEEN recipes from 180 with its own current bags and equipment", () => withStore((store) => {
  assert.equal(seedRordinSnapshot190(store), 190);
  const read = new DashboardReadModel(store, () => NOW);
  const result = read.getForeverCraftedUpgradeAssessment(RORDIN);
  assert.equal(result.status, "FOUND");
  if (result.status !== "FOUND") return;
  const assessment = result.value.data!;
  assert.equal(result.value.provenance.snapshotId, 190, "the assessment is anchored to the latest snapshot");
  assert.equal(assessment.snapshot.snapshotId, 190);
  assert.equal(assessment.snapshot.buildVerification, "VERIFIED");
  assert.equal(assessment.recipeEvidence.state, "LAST_SEEN");
  assert.equal(assessment.recipeEvidence.sourceSnapshotId, 180);
  assert.deepEqual(assessment.candidates.map((c) => [c.recipe.recipeID, c.output.itemID, c.recipe.evidence, c.recipe.sourceSnapshotId, c.recipe.profession]), [[2663, 2853, "LAST_SEEN", 180, "Blacksmithing"], [12260, 10421, "LAST_SEEN", 180, "Blacksmithing"]]);
  const [bracers, vest] = assessment.candidates;
  assert.deepEqual(bracers!.reagents.map((r) => [r.itemID, r.quantity, r.availability, r.observedQuantity]), [[2840, 2, "OBSERVED_AVAILABLE", 3]], "current bags from 190 are used for availability");
  assert.deepEqual(vest!.reagents.map((r) => [r.itemID, r.quantity, r.availability, r.observedQuantity]), [[2840, 4, "OBSERVED_INSUFFICIENT", 3]]);
  assert.equal(vest!.crafting.state, "BLOCKED_BY_OBSERVED_REAGENTS");
  assert.equal(bracers!.crafting.state, "NOT_ESTABLISHED", "available reagents never prove craftability");
  assert.equal(bracers!.eligibility.professionSkill.skill, 4, "profession skill comes from the current snapshot");
  assert.ok(bracers!.crafting.reasons.some((reason) => /LAST_SEEN from snapshot 180/.test(reason)));
  assert.equal(bracers!.slot.equippedItem?.itemID, 2651);
  assert.equal(bracers!.slot.equippedItem?.state, "OBSERVED");
  assert.equal(bracers!.upgradeConclusion.state, "UNKNOWN", "no candidate stats exist in 190; nothing is fabricated");
  assert.equal(assessment.bank.state, "UNKNOWN");
  assert.match(result.value.provenance.source ?? "", /LAST_SEEN learned recipes from snapshot 180/);

  const professions = read.getCharacterProfessions(RORDIN);
  assert.equal(professions.status, "FOUND");
  if (professions.status !== "FOUND") return;
  const knowledge = professions.value.data?.recipeKnowledge as any;
  assert.equal(knowledge.status.state, "LAST_SEEN");
  assert.equal(knowledge.evidence.sourceSnapshotId, 180);
  const rows = knowledge.data.professions[0].recipes as any[];
  assert.ok(rows.length === 5 && rows.every((row) => row.evidence === "LAST_SEEN"), "carried rows are never presented as current observations");
  assert.equal(professions.value.provenance.snapshotId, 190);

  const facts = store.buildAccountFacts("forever", NOW).professions;
  const rordinFacts = facts.byCharacter.find((row) => row.name === "Rordin");
  assert.equal(rordinFacts?.recipeKnowledge?.status, "LAST_SEEN", "account facts no longer report UNKNOWN when only the latest snapshot lacks recipes");
  const bracersFact = facts.knownRecipes.find((row) => row.recipeID === 2663);
  assert.equal(bracersFact?.characters[0]?.evidence, "LAST_SEEN");
  assert.ok(facts.knownRecipes.some((row) => row.recipeID === 12260));
}));

test("pinned snapshot 180 keeps OBSERVED recipe evidence, and older pins never borrow newer evidence", () => withStore((store) => {
  seedRordinSnapshot190(store);
  const read = new DashboardReadModel(store, () => NOW);
  const pinned = read.getForeverCraftedUpgradeAssessment({ ...RORDIN, snapshotId: 180 });
  assert.equal(pinned.status === "FOUND" && pinned.value.data?.recipeEvidence.state, "OBSERVED");
  assert.equal(pinned.status === "FOUND" && pinned.value.data?.candidates[0]?.recipe.evidence, "OBSERVED");
  const older = read.getForeverCraftedUpgradeAssessment({ ...RORDIN, snapshotId: 179 });
  assert.equal(older.status, "FOUND");
  if (older.status === "FOUND") {
    assert.equal(older.value.data?.recipeEvidence.state ?? older.value.provenance.state, "UNKNOWN");
    assert.equal(older.value.data?.candidates.length ?? 0, 0);
  }
}));

test("a different character GUID in the latest snapshot blocks carrying older recipes forward", () => withStore((store) => {
  seedRordinSnapshot190(store, { guid: "Player-4613-RECREATED" });
  const result = new DashboardReadModel(store, () => NOW).getForeverCraftedUpgradeAssessment(RORDIN);
  assert.equal(result.status, "FOUND");
  if (result.status !== "FOUND") return;
  assert.equal(result.value.data?.recipeEvidence.state, "UNKNOWN");
  assert.match(result.value.data?.recipeEvidence.reason ?? "", /recreated/);
  assert.equal(result.value.data?.candidates.length, 0);
}));

test("a current profession list without Blacksmithing excludes older Blacksmithing recipes as conflicting", () => withStore((store) => {
  seedRordinSnapshot190(store, { professions: [{ name: "Mining", skill: 9, maxSkill: 75 }, { name: "Engineering", skill: 1, maxSkill: 75 }] });
  const result = new DashboardReadModel(store, () => NOW).getForeverCraftedUpgradeAssessment(RORDIN);
  assert.equal(result.status, "FOUND");
  if (result.status !== "FOUND") return;
  assert.equal(result.value.data?.candidates.length, 0);
  assert.equal(result.value.data?.recipeEvidence.excludedScopes[0]?.professionName, "Blacksmithing");
}));

test("missing current reagents never become a shortage unless the current bag scan is complete", () => withStore((store) => {
  seedRordinSnapshot190(store, { copperBars: 0 });
  const result = new DashboardReadModel(store, () => NOW).getForeverCraftedUpgradeAssessment(RORDIN);
  assert.equal(result.status === "FOUND" && result.value.data?.candidates[0]?.reagents[0]?.availability, "OBSERVED_INSUFFICIENT");
  assert.equal(result.status === "FOUND" && result.value.data?.candidates[0]?.reagents[0]?.observedQuantity, 0);
}));

test("recipe evidence never crosses WoW versions for a same-named character", () => withStore((store) => {
  seedRordinSnapshot190(store);
  store.importSnapshot(buildWowSyncExport({ generatedAt: NOW - 10, character: { name: "Rordin", realm: "Classic Beta PvP 2", class: "Warrior", level: 20, clientVersion: "1.15.7", clientBuild: "60000", interface: "11507" }, professions: { entries: [{ name: "Blacksmithing", skill: 90, maxSkill: 150 }] } }));
  const read = new DashboardReadModel(store, () => NOW);
  const classic = read.getCharacterProfessions({ version: "classic-era", name: "Rordin" });
  assert.equal(classic.status, "FOUND", "the Classic Era twin is a separate identity");
  if (classic.status === "FOUND") {
    assert.notEqual(classic.value.provenance.identityKey, RORDIN_SNAPSHOT_180.identity.identityKey);
    assert.equal((classic.value.data as any)?.recipeKnowledge?.status.state, "UNKNOWN", "Classic Era never receives Forever recipe rows");
    assert.equal((classic.value.data as any)?.recipeKnowledge?.data, undefined);
  }
  const forever = read.getCharacterProfessions(RORDIN);
  assert.equal(forever.status === "FOUND" && (forever.value.data?.recipeKnowledge as any)?.evidence.sourceSnapshotId, 180);
}));

test("Retail tier-named recipe scopes carry forward and are not excluded by base profession names", () => withStore((store) => {
  const ts = NOW - 5_000;
  const character = { name: "Tinker", realm: "Area 52", class: "Mage", level: 90, clientFamily: "Retail", clientVersion: "12.1.0", clientBuild: "69933", interface: "120100" };
  const scope = { baseSkillLineID: 202, skillLineID: 2910, parentProfessionID: 202, professionID: 2910, client: { clientFamily: "Retail", clientVersion: "12.1.0", clientBuild: 69933 }, professionName: "Midnight Engineering", evidence: "OBSERVED", observedAt: ts, coverage: { state: "PARTIAL", enumeration: "OBSERVED", candidateCompleteness: "UNKNOWN", filteredEnumerationUsed: false, returnedRecipeCount: 1 },
    recipes: [{ recipeID: 1229853, learned: true, learnedState: "OBSERVED_TRUE", evidence: "OBSERVED", skillLineAssociationState: "OBSERVED", skillLineIDs: [2910], recipeInfoResult: "OBSERVED_VALUE" }] };
  const characterState = { formatVersion: 1, clientFamily: "Retail", professionRecipes: { formatVersion: 1, observedAt: ts, completeness: "partial", data: { formatVersion: 1, ownerScope: "CHARACTER", coverage: { state: "PARTIAL", candidateCompleteness: "UNKNOWN", returnedRecipeCount: 1 }, professions: [scope] } } };
  store.importSnapshot(buildWowSyncExport({ generatedAt: ts, character, professions: { entries: [{ name: "Engineering", skill: 50, maxSkill: 100 }] } }), { characterState } as any);
  store.importSnapshot(buildWowSyncExport({ generatedAt: ts + 1_000, character, professions: { entries: [{ name: "Engineering", skill: 55, maxSkill: 100 }] } }));
  const result = new DashboardReadModel(store, () => NOW).getCharacterProfessions({ version: "retail", name: "Tinker" });
  assert.equal(result.status, "FOUND");
  if (result.status !== "FOUND") return;
  const knowledge = result.value.data?.recipeKnowledge as any;
  assert.equal(knowledge.status.state, "LAST_SEEN");
  assert.deepEqual(knowledge.evidence.excludedScopes, []);
  assert.equal(knowledge.data.professions[0].recipes[0].recipeID, 1229853);
}));

test("find_recipe_crafters: Rordin is a LAST_SEEN crafter; characters without captures are not reported as unable", () => withStore((store) => {
  seedRordinSnapshot190(store);
  store.importSnapshot(buildWowSyncExport({ generatedAt: NOW - 20, character: { name: "Hallo", surname: "Emberstone", realm: "Classic Beta PvP 2", class: "Paladin", level: 7, clientFamily: "Forever", clientVersion: "1.60.1", clientBuild: "70338", interface: "16001" }, bags: { containers: [{ id: 0, capacity: 16, items: [{ itemRef: "item:2840::::::::6:1491:::::::::", name: "Copper Bar", qty: 20 }] }] }, bank: { unknown: true } }));
  const read = new DashboardReadModel(store, () => NOW);
  const byOutput = read.findRecipeCrafters({ version: "forever", outputItemID: 2853 }).data!;
  assert.deepEqual(byOutput.learned.map((row) => [row.name, row.recipe.recipeID, row.recipe.evidence, row.recipe.sourceSnapshotId, row.professionSkill?.skill]), [["Rordin", 2663, "LAST_SEEN", 180, 4]]);
  assert.deepEqual(byOutput.charactersWithoutRecipeEvidence.map((row) => row.name), ["Hallo"]);
  const byName = read.findRecipeCrafters({ version: "forever", nameContains: "copper" }).data!;
  assert.deepEqual(byName.learned.map((row) => row.recipe.recipeID!).sort((a, b) => a - b), [2663, 12260, 1245287]);
  assert.equal(read.findRecipeCrafters({ version: "retail", recipeID: 2663 }).data?.learned.length, 0, "Forever rows never appear in Retail");
  assert.equal(read.findRecipeCrafters({ version: "classic-era", recipeID: 2663 }).data?.learned.length, 0, "Forever rows never appear in Classic Era");
  assert.throws(() => read.findRecipeCrafters({ version: "forever" }), /Provide recipeID/);
}));

test("get_recipe_reagent_availability separates crafter bags, unknown bank, and another character's holdings", () => withStore((store) => {
  seedRordinSnapshot190(store);
  store.importSnapshot(buildWowSyncExport({ generatedAt: NOW - 20, character: { name: "Hallo", surname: "Emberstone", realm: "Classic Beta PvP 2", class: "Paladin", level: 7, clientFamily: "Forever", clientVersion: "1.60.1", clientBuild: "70338", interface: "16001" }, bags: { containers: [{ id: 0, capacity: 16, items: [{ itemRef: "item:2840::::::::6:1491:::::::::", name: "Copper Bar", qty: 20 }] }] }, bank: { unknown: true } }));
  const result = new DashboardReadModel(store, () => NOW).getRecipeReagentAvailability({ ...RORDIN, recipeID: 12260 });
  assert.equal(result.status, "FOUND");
  if (result.status !== "FOUND") return;
  const raw = result.value.data!;
  assert.ok("recipe" in raw);
  const value = raw;
  assert.equal(value.recipe.evidence, "LAST_SEEN");
  assert.equal(value.craftability, "NOT_ESTABLISHED");
  const copper = value.reagents[0]!.perAlternative[0]!;
  assert.equal(copper.carriedConclusion, "INSUFFICIENT_IN_COMPLETE_CURRENT_BAGS", "3 carried bars < 4 required");
  const [bags, bank, other] = copper.holdings;
  assert.deepEqual([bags!.ownerScope, bags!.state, bags!.quantity, bags!.usableForCraftingWithoutMove], ["CRAFTER_BAGS", "OBSERVED", 3, true]);
  assert.deepEqual([bank!.ownerScope, bank!.state, bank!.quantity], ["CRAFTER_BANK", "UNKNOWN", undefined], "unobserved bank is UNKNOWN, not zero");
  assert.deepEqual([other!.ownerScope, other!.name, other!.quantity, other!.usableForCraftingWithoutMove], ["OTHER_CHARACTER", "Hallo", 20, false]);
  assert.match(other!.reason, /transfer is not assumed/);
  const missing = new DashboardReadModel(store, () => NOW).getRecipeReagentAvailability({ ...RORDIN, recipeID: 999999 });
  assert.equal(missing.status === "FOUND" && missing.value.provenance.state, "UNKNOWN");
}));

test("ERP RECIPE needs use the shared resolver: snapshot 190 reports LAST_SEEN coverage, never current coverage", () => withStore((store) => {
  seedRordinSnapshot190(store);
  const snapshots = store.listSnapshots(RORDIN_SNAPSHOT_180.identity.identityKey);
  const need = { stableId: "bracers_recipe", kind: "RECIPE" as const, resourceKey: "2663", label: "Copper Bracers recipe", requiredQuantity: 1, sourceIdentityKey: RORDIN_SNAPSHOT_180.identity.identityKey };
  const result = assessErpNeed(need, snapshots, NOW, undefined, "forever");
  assert.equal(result.state, "POTENTIAL_COVERAGE_LAST_SEEN");
  const shuffled = assessErpNeed(need, [...snapshots].reverse(), NOW, undefined, "forever");
  assert.equal(shuffled.state, "POTENTIAL_COVERAGE_LAST_SEEN", "resolution does not depend on caller ordering");
  assert.equal(assessErpNeed(need, snapshots, NOW, undefined, "retail").state, "UNKNOWN", "never crosses versions");
}));

test("an older observed bank is carried forward as LAST_SEEN, never as current, when the latest export did not open the bank", () => withStore((store) => {
  const character = { name: "Banker", realm: "Classic Beta PvP 2", class: "Mage", level: 10, clientFamily: "Forever", clientVersion: "1.60.1", clientBuild: "70338", interface: "16001" };
  store.importSnapshot(buildWowSyncExport({ generatedAt: NOW - 3_000, character, bank: { containers: [{ id: -1, capacity: 24, items: [{ itemRef: "item:2840::::::::10:1491:::::::::", name: "Copper Bar", qty: 12 }] }] } }));
  store.importSnapshot(buildWowSyncExport({ generatedAt: NOW - 100, character, bank: { unknown: true } }));
  const read = new DashboardReadModel(store, () => NOW);
  const storage = read.getCharacterStorage({ version: "forever", name: "Banker", storage: "bank" } as any);
  assert.equal(storage.status, "FOUND");
  if (storage.status === "FOUND") assert.equal(storage.value.provenance.state, "LAST_SEEN");
  const facts = store.buildAccountFacts("forever", NOW);
  assert.equal(facts.characters.find((row) => row.name === "Banker")?.bankStatus, "LAST_SEEN");
  assert.equal(facts.inventory.unknownBank.some((row) => row.name === "Banker"), false, "a carried bank is historical, not unknown");
  const state = read.getCharacterState({ version: "forever", name: "Banker" });
  assert.equal(state.status, "FOUND");
}));

test("trainer offers join captured recipe rows by exact ID first, then by unique name (DERIVED), and carry forward as LAST_SEEN", () => withStore((store) => {
  seedRordinSnapshot190(store);
  const character = { name: "Rordin", surname: "Longbraid", race: "Dwarf", faction: "Alliance", realm: "Classic Beta PvP 2", class: "Warrior", level: 6, clientFamily: "Forever", clientVersion: "1.60.1", clientBuild: "70338", interface: "16001" };
  // A later visit to a Blacksmithing trainer, then an export taken away from the trainer.
  store.importSnapshot(buildWowSyncExport({ generatedAt: NOW - 20, character, bank: { unknown: true }, trainer: { categories: [{ category: "Blacksmithing", name: "Trainer", services: [
    { spellID: "2663", ability: "Copper Bracers", status: "known", requiredLevel: 1, cost: 10 },
    { spellID: "999001", ability: "Rough Copper Vest", status: "known", requiredLevel: 1, cost: 10 },
    { spellID: "999002", ability: "Copper Chain Pants", status: "available", requiredLevel: 1, cost: 50 },
  ] }] } } as any));
  store.importSnapshot(buildWowSyncExport({ generatedAt: NOW - 10, character, bank: { unknown: true }, trainer: { unknown: true } } as any));
  const read = new DashboardReadModel(store, () => NOW);
  const trainer = read.getCharacterTrainer({ ...RORDIN });
  assert.equal(trainer.status, "FOUND");
  if (trainer.status !== "FOUND") return;
  const data = trainer.value.data!;
  assert.equal(data.sectionState, "LAST_SEEN", "a trainer visit from an earlier export is historical, not current");
  const byName = Object.fromEntries(data.services.map((service) => [service.ability, service.recipeMatch]));
  assert.equal(byName["Copper Bracers"]?.basis, "RECIPE_ID");
  assert.equal(byName["Copper Bracers"]?.recipeID, 2663);
  assert.equal(byName["Rough Copper Vest"]?.basis, "DERIVED_NAME");
  assert.equal(byName["Rough Copper Vest"]?.recipeID, 12260);
  assert.equal(byName["Copper Chain Pants"], undefined, "no captured recipe row means no fabricated match");
}));

test("matchTrainerService never joins across professions and refuses ambiguous names", () => {
  const row = (recipeID: number, name: string, profession: string): RecipeKnowledgeRow => ({ recipeID, identityBasis: "RECIPE_ID", name, profession, learnedState: "OBSERVED_FALSE", knowledgeClass: "VISIBLE_NOT_LEARNED", evidence: "OBSERVED", outputKind: "UNKNOWN", reagentSlots: [] });
  const rows = [row(100, "Copper Rod", "Blacksmithing"), row(200, "Elixir", "Alchemy"), row(300, "Twin", "Blacksmithing"), row(301, "Twin", "Blacksmithing")];
  assert.equal(matchTrainerService({ spellID: "200", ability: "Elixir" }, rows, "Blacksmithing"), undefined, "an ID from another profession is not a match");
  assert.equal(matchTrainerService({ spellID: "100" }, rows, "Blacksmithing")?.basis, "RECIPE_ID");
  assert.equal(matchTrainerService({ ability: "Elixir" }, rows, "Alchemy")?.recipeID, 200);
  assert.equal(matchTrainerService({ ability: "Twin" }, rows, "Blacksmithing"), undefined, "two recipe IDs with one name stay unmatched");
  assert.equal(matchTrainerService({ ability: "Copper Rod" }, rows, "Midnight Blacksmithing")?.basis, "DERIVED_NAME", "tier-named categories still match");
});
