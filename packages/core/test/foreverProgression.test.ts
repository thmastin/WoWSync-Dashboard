import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { SqliteSnapshotStore } from "../src/sqliteStore.ts";
import { DashboardReadModel, type ForeverTalentView } from "../src/readModel.ts";
import { ForeverKnowledgeIndex, collectForeverObservedIds, type ForeverKnowledgeBundle } from "../src/foreverKnowledgeBundle.ts";
import { describeForeverTalents, lookupForeverKnowledge } from "../src/foreverKnowledgeLookup.ts";
import { answerForeverCopilot } from "../src/foreverCopilot.ts";

// Bramm's real import payload plus talent and reputation sections in the exact shape GearExport 8a81302+
// writes on Forever 1.60.1 (C_ClassTalents/C_Traits, C_Reputation). Talent names/spells are Bramm's real
// capture; availability, edges and the gate are the fields the newer collector adds.
const FIXTURE_DIR = new URL("./fixtures/forever/", import.meta.url);
const NOW = 1_791_890_800;
const bundle = JSON.parse(readFileSync(new URL("knowledge-fixture.json", FIXTURE_DIR), "utf8")) as ForeverKnowledgeBundle;
bundle.tooltips.spells["16178"] = { id: 16178, name: "Purification", tools: [], reagents: [], description: "Increases the effectiveness of your healing spells by 10%.", sourceUrl: "https://www.wowhead.com/forever/spell=16178", retrievedAt: "2026-10-13T11:20:00Z" };
const KNOWLEDGE = new ForeverKnowledgeIndex(bundle);

function brammWith(talentsData: Record<string, unknown>, unspent = 0, classSpellCatalog?: Record<string, unknown>) {
  const { text, foreverGearObservation, ...rest } = JSON.parse(readFileSync(new URL("copilot-bramm.import.json", FIXTURE_DIR), "utf8"));
  const observedAt = foreverGearObservation.generatedAt;
  const talents = { observedAt, changedAt: observedAt, completeness: "complete", data: { formatVersion: 2, source: "C_ClassTalents/C_Traits", unspentPoints: unspent, specialization: { id: 263, name: "Enhancement" }, ...talentsData } };
  const reputation = { observedAt, changedAt: observedAt, completeness: "partial", data: { formatVersion: 1, source: "C_Reputation.GetFactionDataByIndex", coverage: "VISIBLE_REPUTATION_ROWS_ONLY", factions: [
    { name: "Ironforge", factionID: 47, standingID: 5, barMin: 3000, barMax: 9000, barValue: 4200, parentCategory: "Alliance", evidence: "OBSERVED", ownerScope: "CHARACTER" },
  ], majorFactions: [] } };
  const store = new SqliteSnapshotStore(":memory:");
  store.importSnapshot(text, { ...rest, foreverGearObservation: { ...foreverGearObservation, talents, reputation, ...(classSpellCatalog ? { classSpellCatalog: { observedAt, changedAt: observedAt, completeness: "complete", data: classSpellCatalog } } : {}) } });
  return { store, read: new DashboardReadModel(store, () => NOW) };
}

const TREE = { trees: [{ treeID: 1082, name: "Talent tree 1082", nameSource: "DERIVED", pointsSpent: 2, talents: [
  { nodeID: 1, name: "Thundering Strikes", spellID: 16255, currentRank: 2, maxRank: 5, ranksPurchased: 2, posX: 9000, posY: 2130, isAvailable: true, canPurchaseRank: true, unlocksNodeIDs: [2] },
  { nodeID: 2, name: "Purification", spellID: 16178, currentRank: 0, maxRank: 5, posX: 9600, posY: 5130, isAvailable: false, canPurchaseRank: false, conditions: [{ conditionID: 9, isMet: false, spentAmountRequired: 5 }] },
  { nodeID: 3, name: "Toughness", spellID: 16252, currentRank: 0, maxRank: 5, posX: 9000, posY: 2730, isAvailable: true, canPurchaseRank: true },
] }] };

test("Forever get_character_progression returns the full trait capture with derived tiers, prerequisites and gates", () => {
  const { store, read } = brammWith(TREE);
  try {
    const result = read.getCharacterProgression({ version: "forever", name: "Bramm" });
    assert.equal(result.status, "FOUND");
    const data = (result as { value: { data: { talents: ForeverTalentView; reputation: { state: string; factions: Array<{ name: string; standingLabel?: string; barValue?: number }> } } } }).value.data;
    assert.equal(data.talents.state, "OBSERVED");
    assert.equal(data.talents.totalPointsSpent, 2);
    assert.equal(data.talents.specialization?.name, "Enhancement");
    assert.deepEqual(data.talents.trees[0]!.talents.map((talent) => talent.name), ["Thundering Strikes"], "ranked talents only by default");
    assert.equal(data.talents.trees[0]!.talentCount, 3);
    const all = read.getCharacterProgression({ version: "forever", name: "Bramm", includeTalents: true });
    const talents = (all as { value: { data: { talents: ForeverTalentView } } }).value.data.talents.trees[0]!.talents;
    const purification = talents.find((talent) => talent.name === "Purification")!;
    assert.deepEqual(purification.requires, ["Thundering Strikes"], "prerequisite derived from the edge");
    assert.equal(purification.pointsInTreeRequired, 5);
    assert.equal(purification.canPurchaseRank, false);
    assert.deepEqual(talents.map((talent) => talent.tier), [1, 3, 2], "tiers derived from vertical position");
    assert.equal(data.reputation.state, "OBSERVED");
    assert.equal(data.reputation.factions[0]!.name, "Ironforge");
    assert.equal(data.reputation.factions[0]!.standingLabel, "Friendly");

    const described = describeForeverTalents((all as { value: { data: { talents: ForeverTalentView } } }).value.data.talents, KNOWLEDGE);
    const text = described.trees[0]!.talents.find((talent) => talent.name === "Purification") as { description?: string };
    assert.equal(text.description, "Increases the effectiveness of your healing spells by 10%.");

    assert.ok(collectForeverObservedIds(read).spells.includes(16178), "talent spells feed the knowledge refresh");
  } finally { store.close(); }
});

test("Forever progression is UNKNOWN, not empty, when neither domain was captured", () => {
  const store = new SqliteSnapshotStore(":memory:");
  const { text, ...extras } = JSON.parse(readFileSync(new URL("copilot-rordin.import.json", FIXTURE_DIR), "utf8"));
  store.importSnapshot(text, extras);
  try {
    const result = new DashboardReadModel(store, () => NOW).getCharacterProgression({ version: "forever", name: "Rordin" });
    const value = (result as { value: { provenance: { state: string }; data: { talents: ForeverTalentView } } }).value;
    assert.equal(value.provenance.state, "UNKNOWN");
    assert.equal(value.data.talents.state, "UNKNOWN");
  } finally { store.close(); }
});

test("Co-pilot lists purchasable talents with Forever text when points are unspent, and checks the point rule", () => {
  const { store, read } = brammWith(TREE, 1);
  try {
    const answer = answerForeverCopilot(read, { version: "forever", question: "Bramm: what should I do over the next five levels?", limit: 20 }, KNOWLEDGE);
    const talents = answer.recommendations.find((rec) => rec.id === "talents")!;
    assert.match(talents.title, /Spend 1 unspent talent point/);
    assert.match(talents.what, /Talents you can take now: Thundering Strikes 2\/5.*Toughness 0\/5/);
    assert.doesNotMatch(talents.what, /Purification 0\/5/, "gated talents are not offered");
    assert.ok(talents.evidence.some((line) => line.kind === "DERIVED" && /one point per level from 10/.test(line.statement)));
  } finally { store.close(); }
});

test("lookup_forever_knowledge finds items, quests, NPCs, spells and zones with sources, and never prices", () => {
  assert.equal(lookupForeverKnowledge(undefined, { kind: "item", id: 61 }).status, "UNAVAILABLE");
  const item = lookupForeverKnowledge(KNOWLEDGE, { kind: "item", name: "dwarven leather pants" }) as { status: string; results: Array<{ name: string; questReward: string[]; vendorBuyPrice: string; auctionPrice: string }> };
  assert.equal(item.status, "FOUND");
  assert.equal(item.results[0]!.name, "Dwarven Leather Pants");
  assert.equal(item.results[0]!.vendorBuyPrice, "UNKNOWN");
  assert.equal(item.results[0]!.auctionPrice, "UNKNOWN");
  const quest = lookupForeverKnowledge(KNOWLEDGE, { kind: "quest", id: 990001 }) as { results: Array<{ name: string; zone: string; faction: string; startedBy: string[]; rewards: Array<{ id: number }> }> };
  assert.equal(quest.results[0]!.zone, "Mulgore");
  assert.equal(quest.results[0]!.faction, "Horde");
  assert.match(quest.results[0]!.startedBy[0]!, /Synthetic Plainswalker in Mulgore/);
  assert.equal(quest.results[0]!.rewards[0]!.id, 4964);
  const npc = lookupForeverKnowledge(KNOWLEDGE, { kind: "npc", id: 990101 }) as { results: Array<{ startsQuests: Array<{ id: number }>; roles: string[] }> };
  assert.ok(npc.results[0]!.startsQuests.some((entry) => entry.id === 990001));
  assert.ok(npc.results[0]!.roles.includes("questgiver"));
  const spell = lookupForeverKnowledge(KNOWLEDGE, { kind: "spell", name: "Purification" }) as { results: Array<{ description: string }> };
  assert.match(spell.results[0]!.description, /healing spells by 10%/);
  const zone = lookupForeverKnowledge(KNOWLEDGE, { kind: "zone", name: "Mulgore" }) as { results: Array<{ questCount: number }> };
  assert.ok(zone.results[0]!.questCount >= 2);
  assert.equal(lookupForeverKnowledge(KNOWLEDGE, { kind: "quest", name: "no such quest anywhere" }).status, "NOT_FOUND");
});

test("Spellbook future entries become a class ability catalog in answers, plan and MCP progression", () => {
  const catalog = { futureSpellType: "OBSERVED", observedAt: 0, entries: [
    { spellID: 16178, name: "Purification", levelLearned: 1, evidence: "OBSERVED" },
    { spellID: 8042, name: "Earth Shock", levelLearned: 4, evidence: "OBSERVED" },
    { spellID: 324, name: "Lightning Shield", levelLearned: 8, evidence: "OBSERVED" },
    { spellID: 2484, name: "Earthbind Totem", levelLearned: 40, evidence: "OBSERVED" },
  ] };
  const { store, read } = brammWith(TREE, 0, catalog);
  try {
    const answer = answerForeverCopilot(read, { version: "forever", question: "Bramm: what should I do over the next five levels?", limit: 20 }, KNOWLEDGE);
    const abilities = answer.recommendations.find((rec) => rec.id === "class-abilities");
    assert.ok(abilities, "class ability recommendation present");
    assert.ok(!/Earthbind Totem/.test(abilities!.what), "abilities beyond the 5-level window are not listed");
    assert.match(abilities!.what, /healing spells by 10%/, "Forever tooltip text included");
    assert.ok(abilities!.evidence.some((line) => line.kind === "OBSERVED" && /future entries/.test(line.statement)));
    const progression = read.getCharacterProgression({ version: "forever", name: "Bramm" }) as unknown as { value: { data: { upcomingAbilities: { state: string; entries: unknown[] } } } };
    assert.equal(progression.value.data.upcomingAbilities.state, "OBSERVED");
    assert.equal(progression.value.data.upcomingAbilities.entries.length, 4);
    assert.ok(collectForeverObservedIds(read).spells.includes(2484), "catalog spells feed the knowledge refresh");
  } finally { store.close(); }
});
