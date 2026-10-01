import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeCharacterState, normalizeCharacterStateSidecar } from "../src/characterState.ts";
import { SqliteSnapshotStore } from "../src/sqliteStore.ts";
import { DashboardReadModel } from "../src/readModel.ts";
import { buildWowSyncExport } from "./fixtureBuilder.ts";

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
