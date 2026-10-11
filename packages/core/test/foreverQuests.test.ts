import test from "node:test";
import assert from "node:assert/strict";
import { buildForeverQuestObservation } from "../src/foreverQuests.ts";
import { SqliteSnapshotStore } from "../src/sqliteStore.ts";
import { DashboardReadModel } from "../src/readModel.ts";
import { buildWowSyncExport } from "./fixtureBuilder.ts";

const NOW = 1_797_000_000;
const identity = { identityKey: "forever::forever realm::questhero", name: "Questhero", realm: "Forever Realm" };
const questData = {
  formatVersion: 1,
  clientFamily: "Forever",
  clientProfile: "Forever:1.60.1:70338:16001",
  source: "C_QuestLog",
  observedAt: NOW - 10,
  activeState: "OBSERVED",
  activeCompleteness: "complete",
  activeCounts: { visibleEntries: 2, quests: 1, scannedRows: 2, returnedQuests: 1 },
  active: [{ questID: 501, logIndex: 2, title: "A Local Quest", level: 7, suggestedGroup: 5, isStory: true, evidence: "OBSERVED", titleState: "OBSERVED", objectiveState: "OBSERVED", objectives: [{ index: 1, text: "Collect 3 items", type: "item", finished: false, numFulfilled: 1, numRequired: 3 }], isComplete: false, completionState: "OBSERVED", readyForTurnIn: false, turnInReadinessState: "OBSERVED", watchType: 1, watchState: "OBSERVED", waypoint: { mapID: 12, x: .2, y: .7, state: "OBSERVED" }, waypointText: "North camp" }],
  completedHistory: { state: "OBSERVED", questIDs: [301], quests: [{ questID: 301, title: "An Old Errand", titleState: "OBSERVED" }], returnedCount: 1 },
  issues: [],
};
const section = (changes: Record<string, unknown> = {}) => ({ observedAt: NOW - 10, completeness: "complete", source: "client", data: { ...questData, ...changes } });

test("Forever quest projection preserves active progress, separate turn-in readiness, history, and provenance", () => {
  const view = buildForeverQuestObservation({ section: section(), profile: "Forever:1.60.1:70338:16001", identity, now: NOW });
  assert.equal(view.state, "OBSERVED");
  assert.equal(view.active?.[0]?.questID, 501);
  assert.equal(view.active?.[0]?.logIndex, 2);
  assert.equal(view.active?.[0]?.suggestedGroup, 5);
  assert.equal(view.active?.[0]?.waypointText, "North camp");
  assert.equal(view.active?.[0]?.objectives?.[0]?.numFulfilled, 1);
  assert.equal(view.active?.[0]?.objectives?.[0]?.index, 1);
  assert.equal(view.active?.[0]?.objectives?.[0]?.finished, false);
  assert.equal(view.active?.[0]?.isComplete, false);
  assert.equal(view.active?.[0]?.readyForTurnIn, false);
  assert.equal(view.completedHistory.questIDs?.[0], 301);
  assert.equal(view.completedHistory.quests?.[0]?.title, "An Old Errand");
  assert.equal(view.active?.[0]?.waypoint?.mapID, 12);
  assert.equal(view.identity.identityKey, identity.identityKey);
});

test("valid observed empty log is distinct from missing, malformed, and unavailable quest data", () => {
  const empty = buildForeverQuestObservation({ section: section({ active: [], activeCounts: { visibleEntries: 0, quests: 0, scannedRows: 0, returnedQuests: 0 } }), profile: "Forever:1.60.1:70338:16001", identity, now: NOW });
  assert.equal(empty.activeState, "OBSERVED");
  assert.deepEqual(empty.active, []);
  const missing = buildForeverQuestObservation({ profile: "Forever:1.60.1:70338:16001", identity, now: NOW });
  assert.equal(missing.state, "UNKNOWN");
  assert.equal(missing.active, undefined);
  const nilActive = buildForeverQuestObservation({ section: section({ active: undefined, completedHistory: { state: "UNKNOWN", questIDs: [] } }), profile: "Forever:1.60.1:70338:16001", identity, now: NOW });
  assert.equal(nilActive.state, "UNKNOWN");
  assert.equal(nilActive.activeState, "UNKNOWN");
  const historyOnly = buildForeverQuestObservation({ section: section({ activeState: "UNKNOWN", active: undefined }), profile: "Forever:1.60.1:70338:16001", identity, now: NOW });
  assert.equal(historyOnly.state, "OBSERVED", "an independent completed-history read can be useful while the active log is unknown");
  assert.equal(historyOnly.active, undefined);
  assert.equal(historyOnly.activeState, "UNKNOWN");
  assert.deepEqual(historyOnly.completedHistory.questIDs, [301]);
});

test("partial malformed rows and missing readiness/objectives stay UNKNOWN without inferred values", () => {
  const partial = buildForeverQuestObservation({ section: section({
    activeCompleteness: "partial",
    active: [{ questID: 502, title: "Partial Quest", objectiveState: "UNKNOWN", completionState: "UNKNOWN", turnInReadinessState: "UNKNOWN" }, { questID: -1 }],
    activeCounts: { visibleEntries: 2, quests: 2, scannedRows: 2, returnedQuests: 2 },
    completedHistory: { state: "PARTIAL", questIDs: [301, "bad", 301], truncated: true },
    issues: ["objective hydration unavailable"],
  }), profile: "Forever:1.60.1:70338:16001", identity, now: NOW });
  assert.equal(partial.completeness, "partial");
  assert.equal(partial.active?.length, 1);
  assert.equal(partial.active?.[0]?.objectiveState, "UNKNOWN");
  assert.equal(partial.active?.[0]?.isComplete, undefined);
  assert.equal(partial.active?.[0]?.readyForTurnIn, undefined);
  assert.equal(partial.active?.[0]?.turnInReadinessState, "UNKNOWN");
  assert.equal(partial.completedHistory.state, "PARTIAL");
  assert.deepEqual(partial.completedHistory.questIDs, [301]);
});

test("blank objective descriptions remain partial rather than appearing as observed progress rows", () => {
  const malformed = buildForeverQuestObservation({ section: section({
    activeCompleteness: "partial",
    active: [{ ...questData.active[0], objectiveState: "OBSERVED", objectives: [{ ...questData.active[0].objectives[0], text: "" }] }],
  }), profile: "Forever:1.60.1:70338:16001", identity, now: NOW });
  assert.equal(malformed.completeness, "partial");
  assert.equal(malformed.active?.[0]?.objectiveState, "PARTIAL");
  assert.equal(malformed.active?.[0]?.objectives?.[0]?.text, undefined);
});

test("unsupported profiles fail closed; old and failed refreshes remain LAST_SEEN", () => {
  const unsupported = buildForeverQuestObservation({ section: section(), profile: "Retail:12.0", identity, now: NOW });
  assert.equal(unsupported.state, "UNKNOWN");
  const old = buildForeverQuestObservation({ section: section({ clientProfile: "Forever:1.60.1:70291:16001" }), profile: "Forever:1.60.1:70291:16001", identity, now: NOW + 10 * 24 * 60 * 60 });
  assert.equal(old.state, "LAST_SEEN");
  const failed = buildForeverQuestObservation({ section: { ...section(), lastAttemptStale: true, lastAttemptError: "C_QuestLog unavailable" }, profile: "Forever:1.60.1:70338:16001", identity, now: NOW });
  assert.equal(failed.state, "LAST_SEEN");
  assert.equal(failed.activeState, "LAST_SEEN");
  assert.equal(failed.active?.[0]?.objectiveState, "LAST_SEEN", "failed refresh keeps objective values explicitly historical");
  assert.equal(failed.active?.[0]?.objectives?.[0]?.numFulfilledState, "LAST_SEEN");
  assert.deepEqual(failed.completedHistory.questIDs, [301], "failed refresh retains the last successful history rather than erasing it");
  assert.equal(failed.completedHistory.quests?.[0]?.titleState, "LAST_SEEN");
  assert.match(failed.reason ?? "", /last successful observation/);
});

test("active partial coverage does not downgrade independently observed completed history", () => {
  const result = buildForeverQuestObservation({ section: section({ activeCompleteness: "partial", active: [{ ...questData.active[0], readyForTurnIn: undefined, turnInReadinessState: "UNKNOWN" }] }), profile: "Forever:1.60.1:70338:16001", identity, now: NOW });
  assert.equal(result.completeness, "partial");
  assert.equal(result.completedHistory.state, "OBSERVED");
  assert.deepEqual(result.completedHistory.questIDs, [301]);
});

test("SQLite persistence, REST-facing read model, and AccountContext reuse the same Forever quest evidence", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    const generatedAt = NOW - 10;
    const exportText = buildWowSyncExport({ generatedAt, character: { name: identity.name, realm: identity.realm, clientFamily: "Forever", clientVersion: "1.60.1", clientBuild: "70338", interface: "16001" } });
    const sidecar = { clientProfile: "Forever:1.60.1:70338:16001", name: identity.name, realm: identity.realm, generatedAt, sourceCharacterGuid: "Player-Test-Quest", quests: section() };
    store.importSnapshot(exportText, { foreverGearObservation: sidecar });
    const read = new DashboardReadModel(store, () => NOW);
    const result = read.getForeverQuestObservation({ version: "forever", ...identity });
    assert.equal(result.status, "FOUND");
    if (result.status === "FOUND") {
      assert.equal(result.value.data?.active?.[0]?.questID, 501);
      assert.equal(result.value.provenance.snapshotId, 1);
      assert.equal(result.value.provenance.freshness, "recent");
    }
    const combined = read.getForeverGearObservation({ version: "forever", ...identity });
    assert.equal(combined.status, "FOUND");
    if (combined.status === "FOUND") assert.equal(combined.value.data?.quests.active?.[0]?.questID, 501);
    const account = store.buildAccountContext(NOW);
    const foreverCharacter = account.versions.forever.characters.find((row) => row.identityKey === identity.identityKey);
    assert.equal(foreverCharacter?.foreverGearObservation?.status, "FOUND");
    if (foreverCharacter?.foreverGearObservation?.status === "FOUND") assert.equal(foreverCharacter.foreverGearObservation.value.data?.quests.active?.[0]?.questID, 501);
    assert.equal(read.getForeverQuestObservation({ version: "retail", name: identity.name, realm: identity.realm }).status, "FOUND");
    const retail = read.getForeverQuestObservation({ version: "retail", name: identity.name, realm: identity.realm });
    if (retail.status === "FOUND") assert.equal(retail.value.data, undefined);
  } finally { store.close(); }
});
