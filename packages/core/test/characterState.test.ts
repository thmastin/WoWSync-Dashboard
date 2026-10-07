import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeCharacterState, normalizeCharacterStateSidecar } from "../src/characterState.ts";
import { SqliteSnapshotStore } from "../src/sqliteStore.ts";
import { DashboardReadModel } from "../src/readModel.ts";
import { buildWowSyncExport } from "./fixtureBuilder.ts";
import { observation } from "./equipmentObservationFixtures.ts";

const ts = 1_800_000_000;
const domain = (data: Record<string, unknown>, completeness: "complete" | "partial" = "complete") => ({
  formatVersion: 1, observedAt: ts, completeness, data: { formatVersion: 1, client: { clientFamily: "Retail" }, ...data },
});
const rep = (factions: Record<string, unknown>[], majorFactions: Record<string, unknown>[]) => domain({ factions, majorFactions }, "partial");

test("character state is Retail-only, keeps stable IDs, and never interprets missing fields as zero", () => {
  const sidecar = {
    formatVersion: 1, clientFamily: "Retail",
    combatSpecialization: domain({ activeSpec: { specID: 263, classID: 7, name: "Enhancement", role: "DAMAGER" }, talentConfig: { configID: 99679859 }, heroTalent: { subtreeID: 55, name: "Stormbringer" } }),
    professionSpecializations: domain({ professions: [{ baseSkillLineID: 182, tiers: [{ skillLineID: 2912, configID: 108309675, trees: [{ treeID: 1073, state: "Unlocked", currencies: [{ currencyID: 3778, quantity: 0, spent: 22 }], nodes: [{ nodeID: 104421, ranksPurchased: 19, maxRanks: 41, committedEntries: [1] }] }] }] }] }),
    reputation: { character: rep([{ factionID: 1090, ownerScope: "CHARACTER", currentStanding: 2275 }], []), account: rep([{ factionID: 2503, ownerScope: "ACCOUNT_WARBAND" }], [{ majorFactionID: 2503, conventionalFactionID: 2503, ownerScope: "ACCOUNT_WARBAND", renownEvidence: "OBSERVED_VALUE", renown: { evidence: "OBSERVED", level: 24, earned: 899, threshold: 2500 } }]) },
  };
  const normalized = normalizeCharacterStateSidecar(sidecar, "retail");
  assert.equal(normalized?.combatSpecialization?.data?.activeSpec && (normalized.combatSpecialization.data.activeSpec as any).specID, 263);
  assert.equal(normalized?.professionSpecializations?.data && ((normalized.professionSpecializations.data.professions as any[])[0].tiers[0].skillLineID), 2912);
  assert.equal(normalized?.reputation?.account?.completeness, "partial");
  assert.equal(normalizeCharacterStateSidecar(sidecar, "classic-era"), undefined);
  assert.equal(normalizeCharacterStateSidecar({ ...sidecar, clientFamily: "Classic" }, "retail"), undefined);
});

test("later partial and missing captures retain prior identities as LAST_SEEN", () => {
  const old = normalizeCharacterStateSidecar({ formatVersion: 1, clientFamily: "Retail",
    combatSpecialization: domain({ activeSpec: { specID: 263, classID: 7 } }),
    professionSpecializations: domain({ professions: [{ baseSkillLineID: 182, tiers: [{ skillLineID: 2912, configID: 9, trees: [{ treeID: 1073, nodes: [{ nodeID: 12, currentRank: 2 }] }, { treeID: 1080, nodes: [{ nodeID: 13, currentRank: 4 }] }] }] }] }),
    reputation: { character: rep([{ factionID: 1090, currentStanding: 20 }], []), account: rep([{ factionID: 2503 }], []) },
  }, "retail")!;
  const fresh = normalizeCharacterStateSidecar({ formatVersion: 1, clientFamily: "Retail",
    combatSpecialization: domain({ activeSpec: { classID: 7 } }),
    professionSpecializations: domain({ professions: [{ baseSkillLineID: 182, tiers: [{ skillLineID: 2912, configID: 9, trees: [{ treeID: 1073, nodes: [{ nodeID: 12, currentRank: 3 }] }] }] }] }, "partial"),
    reputation: { character: rep([], []), account: rep([], []) },
  }, "retail")!;
  const merged = mergeCharacterState(old, fresh)!;
  assert.equal((merged.combatSpecialization?.data?.activeSpec as any).specID, 263);
  const trees = (((merged.professionSpecializations?.data?.professions as any[])[0].tiers[0].trees) as any[]);
  assert.equal(trees.find((t) => t.treeID === 1073).nodes[0].currentRank, 3);
  assert.equal(trees.find((t) => t.treeID === 1080).evidence, "LAST_SEEN");
  assert.equal((merged.reputation?.character?.data?.factions as any[])[0].evidence, "LAST_SEEN");
  const absent = mergeCharacterState(merged, undefined)!;
  assert.equal(absent.combatSpecialization?.status.state, "LAST_SEEN");
});

test("structured state imports into existing summary, profession, and Renown projections with ownership intact", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    const text = buildWowSyncExport({ generatedAt: ts, character: { name: "Groit", realm: "Stormrage", clientFamily: "Retail", clientVersion: "12.1.0" } });
    const sidecar = { formatVersion: 1, clientFamily: "Retail",
      combatSpecialization: domain({ activeSpec: { specID: 263, classID: 7, name: "Enhancement", role: "DAMAGER" }, talentConfig: { configID: 99679859 }, heroTalent: { subtreeID: 55, name: "Stormbringer" } }),
      professionSpecializations: domain({ professions: [{ baseSkillLineID: 182, tiers: [{ skillLineID: 2912, configID: 108309675, trees: [{ treeID: 1073, state: "Unlocked", nodes: [{ nodeID: 104421, currentRank: 19, maxRanks: 41 }] }] }] }] }),
      reputation: { character: rep([{ factionID: 1090, ownerScope: "CHARACTER", currentStanding: 2275 }], []), account: rep([], [{ majorFactionID: 2503, conventionalFactionID: 2503, ownerScope: "ACCOUNT_WARBAND", renownEvidence: "OBSERVED_VALUE", renown: { evidence: "OBSERVED", level: 24, earned: 899, threshold: 2500 } }]) },
    };
    store.importSnapshot(text, { characterState: sidecar });
    const read = new DashboardReadModel(store, () => ts + 1);
    const summary = read.getCharacterSummary({ version: "retail", name: "Groit", realm: "Stormrage" });
    assert.equal(summary.status === "FOUND" && summary.value.data?.combatSpecialization?.data?.activeSpec && (summary.value.data.combatSpecialization.data.activeSpec as any).specID, 263);
    const professions = read.getCharacterProfessions({ version: "retail", name: "Groit", realm: "Stormrage" });
    assert.equal(professions.status === "FOUND" && professions.value.data?.specialization?.completeness, "complete");
    assert.equal(professions.status === "FOUND" && professions.value.data?.recipeKnowledge?.status.state, "UNKNOWN", "legacy Retail snapshots without recipe data remain explicitly unknown");
    const renown = read.getRenown({ version: "retail", name: "Groit", realm: "Stormrage" });
    assert.equal(renown.status === "FOUND" && renown.value.data?.majorFactions[0].ownerScope, "ACCOUNT_WARBAND");
    assert.equal(renown.status === "FOUND" && renown.value.data?.majorFactions[0].majorFactionID, 2503);
    const reputation = read.getAccountFacts({ version: "retail" }).data?.reputation;
    assert.equal(reputation?.completeness, "partial");
    assert.equal(reputation?.account.majorFactions.length, 1);
    assert.equal(reputation?.account.majorFactions[0].ownerScope, "ACCOUNT_WARBAND");
    assert.equal(reputation?.byCharacter[0].factions.some((row) => row.factionID === 1090), true);
    assert.equal(read.getRenown({ version: "classic-era", name: "Groit", realm: "Stormrage" }).status, "NOT_FOUND");
  } finally { store.close(); }
});

test("account-wide reputation is projected once and generic zero-standing candidates are not presented as earned", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    const state = { formatVersion: 1, clientFamily: "Retail",
      reputation: {
        character: rep([{ evidence: "OBSERVED", factionID: 1, ownerScope: "CHARACTER", currentStanding: 0 }, { evidence: "OBSERVED", factionID: 1090, ownerScope: "CHARACTER", currentStanding: 1 }], []),
        account: rep([{ evidence: "OBSERVED", factionID: 2503, ownerScope: "ACCOUNT_WARBAND", currentStanding: 100 }], [{ evidence: "OBSERVED", majorFactionID: 2503, ownerScope: "ACCOUNT_WARBAND", isUnlocked: true, renownEvidence: "OBSERVED_VALUE", renown: { level: 1, earned: 5, threshold: 2500 } }]),
      },
    };
    store.importSnapshot(buildWowSyncExport({ generatedAt: ts - 2, character: { name: "One", realm: "Stormrage", clientFamily: "Retail", clientVersion: "12.1.0" } }), { characterState: state });
    store.importSnapshot(buildWowSyncExport({ generatedAt: ts - 1, character: { name: "Two", realm: "Stormrage", clientFamily: "Retail", clientVersion: "12.1.0" } }), { characterState: state });
    const facts = store.buildAccountFacts("retail", ts).reputation;
    assert.equal(facts.account.factions.length, 1);
    assert.equal(facts.account.majorFactions.length, 1);
    assert.equal(facts.byCharacter.length, 2);
    assert.equal(facts.byCharacter[0].factions.some((row) => row.factionID === 1), false, "zero-standing generic candidates stay in raw snapshot evidence only");
    assert.equal(facts.byCharacter[0].factions.some((row) => row.factionID === 1090), true);
    assert.equal(facts.completeness, "partial", "bounded candidate discovery never claims global completeness");
  } finally { store.close(); }
});

test("compatible Retail snapshots derive only observed spec, node-rank, standing, and Renown deltas", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    const makeState = (at: number, specID: number, rank: number, standing: number, earned: number, omitFaction = false) => ({
      formatVersion: 1, clientFamily: "Retail",
      combatSpecialization: { ...domain({ activeSpec: { specID, classID: 7, evidence: "OBSERVED" } }), observedAt: at },
      professionSpecializations: { ...domain({ professions: [{ baseSkillLineID: 182, tiers: [{ skillLineID: 2912, configID: 42, trees: [{ treeID: 1073, nodes: [{ nodeID: 99, evidence: "OBSERVED", ranksPurchased: rank }] }] }] }] }), observedAt: at },
      reputation: {
        character: { ...rep(omitFaction ? [] : [{ evidence: "OBSERVED", factionID: 1090, ownerScope: "CHARACTER", currentStanding: standing }], []), observedAt: at },
        account: { ...rep([], [{ evidence: "OBSERVED", majorFactionID: 2503, conventionalFactionID: 2503, ownerScope: "ACCOUNT_WARBAND", renownEvidence: "OBSERVED_VALUE", renown: { level: 24, earned, threshold: 2500 } }]), observedAt: at },
      },
    });
    const first = buildWowSyncExport({ generatedAt: ts - 10, character: { name: "Groit", realm: "Stormrage", clientFamily: "Retail", clientVersion: "12.1.0" } });
    const second = buildWowSyncExport({ generatedAt: ts, character: { name: "Groit", realm: "Stormrage", clientFamily: "Retail", clientVersion: "12.1.0" } });
    store.importSnapshot(first, { characterState: makeState(ts - 10, 263, 12, 100, 899) });
    const result = store.importSnapshot(second, { characterState: makeState(ts, 264, 15, 125, 999, true) });
    const changes = result.diff?.characterStateChanges ?? [];
    assert.ok(changes.some((change) => change.domain === "combat-specialization" && change.from === 263 && change.to === 264));
    assert.ok(changes.some((change) => change.domain === "profession-node-rank" && change.from === 12 && change.to === 15 && change.delta === 3));
    assert.ok(changes.some((change) => change.domain === "major-faction-renown" && change.from === 899 && change.to === 999));
    assert.equal(changes.some((change) => change.domain === "reputation-standing"), false, "an omitted faction is not interpreted as removed or zero");
  } finally { store.close(); }
});

test("duplicate imports may attach a structured observation, and later missing state is LAST_SEEN", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    const text = buildWowSyncExport({ generatedAt: ts, character: { name: "Groit", realm: "Stormrage", clientFamily: "Retail", clientVersion: "12.1.0" } });
    const state = { formatVersion: 1, clientFamily: "Retail", combatSpecialization: domain({ activeSpec: { specID: 263, classID: 7 } }) };
    store.importSnapshot(text);
    const duplicate = store.importSnapshot(text, { characterState: state });
    assert.equal(duplicate.isDuplicate, true);
    assert.equal(duplicate.snapshot.parsed.characterState?.combatSpecialization?.status.state, "OBSERVED");

    const later = buildWowSyncExport({ generatedAt: ts + 10, character: { name: "Groit", realm: "Stormrage", clientFamily: "Retail", clientVersion: "12.1.0" } });
    const next = store.importSnapshot(later);
    assert.equal(next.snapshot.parsed.characterState?.combatSpecialization?.status.state, "LAST_SEEN");
    assert.equal((next.snapshot.parsed.characterState?.combatSpecialization?.data?.activeSpec as any).specID, 263);
  } finally { store.close(); }
});

const recipeScope = (baseSkillLineID: number, skillLineID: number, ids: Array<[number, boolean | undefined, string, number[]?]>, evidence = "OBSERVED") => ({
  baseSkillLineID, skillLineID, professionID: skillLineID, parentProfessionID: baseSkillLineID, professionName: skillLineID === 2910 ? "Midnight Engineering" : "Midnight Alchemy",
  expansionName: "Midnight", evidence, observedAt: ts, client: { clientFamily: "Retail", clientVersion: "12.1.0", clientBuild: 69933 },
  coverage: { state: "PARTIAL", enumeration: "OBSERVED", candidateCompleteness: "UNKNOWN", filteredEnumerationUsed: false, returnedRecipeCount: ids.length },
  recipes: ids.map(([recipeID, learned, learnedState, skillLineIDs = []]) => ({ recipeID, ...(learned === undefined ? {} : { learned }), learnedState, recipeInfoResult: learned === undefined ? "NIL_RESULT" : "OBSERVED_VALUE", skillLineAssociationState: "OBSERVED", evidence, skillLineIDs })),
});
const recipeDomain = (professions: ReturnType<typeof recipeScope>[]) => ({ formatVersion: 1, observedAt: ts, completeness: "partial", data: { formatVersion: 1, ownerScope: "CHARACTER", coverage: { state: "PARTIAL", candidateCompleteness: "UNKNOWN", enumeration: "OBSERVED", filteredEnumerationUsed: false, returnedRecipeCount: professions.reduce((count, profession) => count + profession.recipes.length, 0) }, professions } });

test("Retail recipe sidecar preserves explicit learned values, unknowns, IDs, and client isolation", () => {
  const scope = recipeScope(202, 2910, [[1229853, true, "OBSERVED_TRUE", [2910]], [1291687, false, "OBSERVED_FALSE", []], [7, undefined, "UNKNOWN"]]);
  scope.recipes[2].recipeInfoResult = "API_ERROR";
  scope.recipes[2].skillLineAssociationState = "UNKNOWN";
  const sidecar = { formatVersion: 1, clientFamily: "Retail", professionRecipes: recipeDomain([
    scope,
  ]) };
  const state = normalizeCharacterStateSidecar(sidecar, "retail");
  const rows = (state?.professionRecipes?.data?.professions as any[])[0].recipes;
  assert.deepEqual(rows.map((row: any) => [row.recipeID, row.learned, row.learnedState]), [[1229853, true, "OBSERVED_TRUE"], [1291687, false, "OBSERVED_FALSE"], [7, undefined, "UNKNOWN"]]);
  assert.equal(state?.professionRecipes?.completeness, "partial");
  assert.equal(normalizeCharacterStateSidecar(sidecar, "classic-era"), undefined);
  assert.equal(normalizeCharacterStateSidecar({ ...sidecar, clientFamily: "Classic" }, "retail"), undefined);
});

test("profession-scoped recipe merges preserve Engineering through Alchemy and keep failed/empty evidence LAST_SEEN", () => {
  const engineering = normalizeCharacterStateSidecar({ formatVersion: 1, clientFamily: "Retail", professionRecipes: recipeDomain([
    recipeScope(202, 2910, [[1229853, true, "OBSERVED_TRUE", [2910]], [1291687, false, "OBSERVED_FALSE", []]]),
  ]) }, "retail")!;
  const alchemy = normalizeCharacterStateSidecar({ formatVersion: 1, clientFamily: "Retail", professionRecipes: recipeDomain([
    recipeScope(171, 2906, [[1233130, true, "OBSERVED_TRUE", [2906]], [1230869, false, "OBSERVED_FALSE", []]]),
  ]) }, "retail")!;
  const switched = mergeCharacterState(engineering, alchemy)!;
  const scopes = switched.professionRecipes!.data!.professions as any[];
  assert.equal(scopes.length, 2);
  assert.equal(scopes.find((row) => row.skillLineID === 2910).evidence, "LAST_SEEN");
  assert.equal(scopes.find((row) => row.skillLineID === 2906).recipes.find((r: any) => r.recipeID === 1233130).learned, true);
  const empty = normalizeCharacterStateSidecar({ formatVersion: 1, clientFamily: "Retail", professionRecipes: recipeDomain([]) }, "retail");
  const retained = mergeCharacterState(switched, empty)!.professionRecipes!.data!.professions as any[];
  assert.equal(retained.length, 2);
  assert.ok(retained.every((row) => row.evidence === "LAST_SEEN"));
  assert.equal(retained.find((row) => row.skillLineID === 2910).recipes.find((r: any) => r.recipeID === 1291687).learnedState, "OBSERVED_FALSE");
  const reverse = mergeCharacterState(alchemy, engineering)!.professionRecipes!.data!.professions as any[];
  assert.equal(reverse.find((row) => row.skillLineID === 2906).evidence, "LAST_SEEN", "Engineering refresh retains Alchemy as LAST_SEEN");
  assert.equal(reverse.find((row) => row.skillLineID === 2910).evidence, "OBSERVED");
  assert.equal(normalizeCharacterStateSidecar({ formatVersion: 1, clientFamily: "Retail", professionRecipes: recipeDomain([]) }, "retail"), undefined, "empty enumeration is not zero-coverage evidence");
});

test("an incoming stale recipe cache cannot replace newer learned evidence", () => {
  const observed = normalizeCharacterStateSidecar({ formatVersion: 1, clientFamily: "Retail", professionRecipes: recipeDomain([
    recipeScope(202, 2910, [[1229853, true, "OBSERVED_TRUE", [2910]]]),
  ]) }, "retail")!;
  const oldCache = normalizeCharacterStateSidecar({ formatVersion: 1, clientFamily: "Retail", professionRecipes: recipeDomain([
    recipeScope(202, 2910, [[1229853, false, "OBSERVED_FALSE", [2910]]], "LAST_SEEN"),
  ]) }, "retail")!;
  const merged = mergeCharacterState(observed, oldCache)!.professionRecipes!.data!.professions as any[];
  const recipe = merged[0].recipes[0];
  assert.equal(recipe.learned, true);
  assert.equal(recipe.learnedState, "OBSERVED_TRUE");
  assert.equal(recipe.evidence, "LAST_SEEN");
  const refreshed = normalizeCharacterStateSidecar({ formatVersion: 1, clientFamily: "Retail", professionRecipes: recipeDomain([
    recipeScope(202, 2910, [[1229853, false, "OBSERVED_FALSE", [2910]]]),
  ]) }, "retail")!;
  const next = mergeCharacterState(observed, refreshed)!.professionRecipes!.data!.professions as any[];
  assert.equal(next[0].recipes[0].learned, false, "a later explicit fresh false is retained as an observation");
  assert.equal(next[0].recipes[0].learnedState, "OBSERVED_FALSE");
});

test("known-by-account includes explicit learned=true only and the professions read model exposes partial recipe evidence", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    const state = { formatVersion: 1, clientFamily: "Retail", professionRecipes: recipeDomain([
      recipeScope(202, 2910, [[1229853, true, "OBSERVED_TRUE", [2910]], [1291687, false, "OBSERVED_FALSE", []], [6, undefined, "UNKNOWN", []]]),
    ]) };
    store.importSnapshot(buildWowSyncExport({ generatedAt: ts, character: { name: "Virek", realm: "Cairne", clientFamily: "Retail", clientVersion: "12.1.0" } }), { characterState: state });
    const facts = store.buildAccountFacts("retail", ts);
    assert.deepEqual(facts.professions.knownRecipes.map((recipe) => recipe.recipeID), [1229853]);
    assert.deepEqual(facts.professions.knownRecipes[0].skillLineIDs, [2910]);
    assert.equal(facts.professions.knownRecipes[0].contextSkillLineID, 2910);
    assert.equal(facts.professions.byCharacter[0].recipeKnowledge?.completeness, "partial");
    const read = new DashboardReadModel(store, () => ts + 1).getCharacterProfessions({ version: "retail", name: "Virek", realm: "Cairne" });
    assert.equal(read.status, "FOUND");
    assert.equal(read.status === "FOUND" && read.value.data?.recipeKnowledge?.status.state, "OBSERVED");
    assert.equal(read.status === "FOUND" && (read.value.data?.recipeKnowledge?.data?.professions as any[])[0].recipes.length, 3);
    assert.equal(read.status === "FOUND" && read.value.data?.recipeKnowledge?.completeness, "partial");
    assert.deepEqual(store.buildAccountFacts("classic-era", ts).professions.knownRecipes, []);
  } finally { store.close(); }
});

test("A27 characterState merge and LAST_SEEN carry-forward are identical whether or not equipment observations ride along", () => {
  const combat = (specID: number) => ({ formatVersion: 1, clientFamily: "Retail", combatSpecialization: domain({ activeSpec: { specID, classID: 3 } }) });
  const run = (withObservation: boolean) => {
    const store = new SqliteSnapshotStore(":memory:");
    try {
      const extra = (n: number) => (withObservation ? { equipmentObservation: observation({ tuple: { observedAt: ts + n, capture: n, revision: 1 }, specID: 253 }) } : {});
      const text = (at: number) => buildWowSyncExport({ generatedAt: at, character: { name: "Virek", realm: "Cairne", clientFamily: "Retail", clientVersion: "12.1.0" } });
      const outcomes = [
        store.importSnapshot(text(ts), { characterState: combat(253), ...extra(1) }).characterState,
        store.importSnapshot(text(ts), { characterState: combat(254), ...extra(2) }).characterState,
        store.importSnapshot(text(ts + 100), extra(3)).characterState,
        store.importSnapshot(text(ts + 200), { characterState: combat(255) }).characterState,
      ];
      return { outcomes, states: store.listSnapshots("retail::cairne::virek").map((s) => s.parsed.characterState) };
    } finally {
      store.close();
    }
  };
  const plain = run(false);
  const observed = run(true);
  assert.deepEqual(observed, plain);
  assert.equal(plain.states.some((state) => state?.combatSpecialization?.status.state === "LAST_SEEN"), true, "the existing carry-forward still happens");
  assert.equal(JSON.stringify(observed.states).includes("equipmentObservation"), false);
});
