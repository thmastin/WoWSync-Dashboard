import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DashboardReadModel, SqliteSnapshotStore } from "../src/index.ts";
import { buildWowSyncExport } from "./fixtureBuilder.ts";

const structured = JSON.parse(readFileSync(new URL("./fixtures/classic-progression/ashtest-structured.json", import.meta.url), "utf8").replace(/^\uFEFF/, ""));
const generatedAt = 1_792_863_300;
function text() { return readFileSync(new URL("./fixtures/ashtest-classic-era-wow-sync.txt", import.meta.url), "utf8").replace(/^Generated: \d+$/m, `Generated: ${generatedAt}`).replace(/observed=\d+/g, `observed=${generatedAt - 20}`); }

test("Classic Era current SavedVariables quest and reputation sections survive normalization and text talent fallback", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    const imported = store.importSnapshot(text(), { characterState: structured });
    assert.deepEqual(Object.keys(imported.snapshot.parsed.characterState!).sort(), ["clientFamily", "clientProfile", "formatVersion", "quests", "reputation", "talents"]);
    const read = new DashboardReadModel(store, () => generatedAt + 30);
    const quests = read.getCharacterQuests({ version: "classic-era", name: "Ashtest", realm: "Mankrik" });
    assert.equal(quests.status, "FOUND");
    if (quests.status === "FOUND") {
      assert.equal(quests.value.data?.state, "OBSERVED");
      assert.deepEqual(quests.value.data?.active?.map((row) => [row.title, row.rowEvidence]), [["The Reports", "OBSERVED"], ["In Defense of the King's Lands", "OBSERVED"]]);
      assert.equal(quests.value.data?.active?.[0]?.questID, undefined, "the SavedVariables rows do not provide IDs");
    }
    const progression = read.getCharacterProgression({ version: "classic-era", name: "Ashtest", realm: "Mankrik" });
    assert.equal(progression.status, "FOUND");
    if (progression.status === "FOUND") {
      assert.equal(progression.value.data?.reputation.state, "OBSERVED");
      assert.equal(progression.value.data?.reputation.factions.length, 0, "an empty visible list is not Neutral");
      assert.equal(progression.value.data?.talents.state, "OBSERVED", "text fallback was merged into, not substituted for, the structured state");
    }
  } finally { store.close(); }
});

test("Classic visible reputation rows retain OBSERVED evidence and derived standing labels", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    const withFaction = structured as any;
    withFaction.reputation.character.data.factions = [{ factionID: 72, factionKey: "legacy:Classic:1:11509:Alliance:Stormwind", name: "Stormwind", standingID: 6, barMin: 3000, barMax: 9000, barValue: 6100, evidence: "OBSERVED" }];
    store.importSnapshot(text(), { characterState: withFaction });
    const result = new DashboardReadModel(store, () => generatedAt + 30).getCharacterProgression({ version: "classic-era", name: "Ashtest", realm: "Mankrik" });
    assert.equal(result.status, "FOUND");
    if (result.status === "FOUND") assert.deepEqual(result.value.data?.reputation.factions.map((row) => [row.name, row.evidence, row.standingLabel, row.standingLabelBasis]), [["Stormwind", "OBSERVED", "Honored", "DERIVED_FROM_STANDING_ID"]]);
  } finally { store.close(); }
});

test("Classic progression stays UNKNOWN when structured SavedVariables are absent", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    store.importSnapshot(text());
    const read = new DashboardReadModel(store, () => generatedAt + 30);
    const quests = read.getCharacterQuests({ version: "classic-era", name: "Ashtest", realm: "Mankrik" });
    assert.equal(quests.status === "FOUND" && quests.value.data?.state, "UNKNOWN");
    const progression = read.getCharacterProgression({ version: "classic-era", name: "Ashtest", realm: "Mankrik" });
    assert.equal(progression.status === "FOUND" && progression.value.data?.reputation.state, "UNKNOWN");
  } finally { store.close(); }
});

test("Forever current SavedVariables quest/reputation rows are adapted without changing Classic or Retail identity", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    const foreverText = buildWowSyncExport({ generatedAt, character: { name: "Ashtest", realm: "Forever Realm", class: "Warlock", level: 10, clientFamily: "Forever", clientVersion: "1.60.1", clientBuild: "70338", interface: "16001" } });
    store.importSnapshot(foreverText, { foreverGearObservation: {
      clientProfile: "Forever:1.60.1:70338:16001", name: "Ashtest", realm: "Forever Realm", generatedAt,
      quests: { observedAt: generatedAt - 10, completeness: "complete", data: { formatVersion: 1, clientFamily: "1.60.1", evidence: "OBSERVED", observedAt: generatedAt - 10, quests: [{ title: "Forever observed quest", level: 10, objectives: [] }] } },
      reputation: { observedAt: generatedAt - 10, completeness: "partial", data: { formatVersion: 1, clientFamily: "1.60.1", evidence: "OBSERVED", observedAt: generatedAt - 10, factions: [{ factionID: 72, name: "Stormwind", standingID: 6, evidence: "OBSERVED" }] } },
    } });
    const read = new DashboardReadModel(store, () => generatedAt + 30);
    const quests = read.getCharacterQuests({ version: "forever", name: "Ashtest", realm: "Forever Realm" });
    assert.equal(quests.status === "FOUND" && quests.value.data?.state, "OBSERVED");
    assert.equal(quests.status === "FOUND" && quests.value.data?.active?.[0]?.title, "Forever observed quest");
    const progression = read.getCharacterProgression({ version: "forever", name: "Ashtest", realm: "Forever Realm" });
    assert.equal(progression.status === "FOUND" && progression.value.data?.reputation.factions[0]?.evidence, "OBSERVED");
  } finally { store.close(); }
});
