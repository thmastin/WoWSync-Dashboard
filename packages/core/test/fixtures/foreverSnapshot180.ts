import { SqliteSnapshotStore } from "../../src/sqliteStore.ts";
import { buildWowSyncExport } from "../fixtureBuilder.ts";

export const RORDIN_SNAPSHOT_180 = {
  id: 180,
  identity: { version: "forever" as const, identityKey: "forever::classic beta pvp 2::rordin", name: "Rordin", realm: "Classic Beta PvP 2" },
  generatedAt: 1_791_764_829,
  questObservedAt: 1_791_764_792,
  sourceCharacterGuid: "Player-4613-016F932B",
  questIDs: [384, 400, 96629, 98321, 98322, 99158],
  completedQuestIDs: [170, 179, 182, 183, 218, 233, 234, 282, 420, 2160, 3106, 3361, 3364, 3365, 95998, 96101, 96604, 96605, 96606, 96607, 96608, 96627, 96628, 96630, 96638, 96652, 96656, 96659, 97277],
};

const QUEST_PROFILE = "Forever:1.60.1:70338:16001";
const quest = (questID: number, extra: Record<string, unknown> = {}) => ({
  questID,
  titleState: "OBSERVED",
  title: ({ 384: "Beer Basted Boar Ribs", 400: "Tools for Steelgrill", 96629: "Camping 101: Cooking", 98321: "Flintfire's Shipment", 98322: "Secure the Mountain", 99158: "Dawn in the Mountains" } as Record<number, string>)[questID],
  objectiveState: "OBSERVED",
  completionState: "OBSERVED",
  isComplete: false,
  turnInReadinessState: "OBSERVED",
  readyForTurnIn: false,
  waypointState: "UNKNOWN",
  watchState: "OBSERVED",
  watchType: 1,
  ...extra,
});

export const RORDIN_SNAPSHOT_180_QUEST_SECTION = {
  observedAt: RORDIN_SNAPSHOT_180.questObservedAt,
  completeness: "complete",
  source: "client",
  data: {
    formatVersion: 1,
    clientProfile: QUEST_PROFILE,
    clientFamily: "Forever",
    source: "C_QuestLog",
    observedAt: RORDIN_SNAPSHOT_180.questObservedAt,
    activeState: "OBSERVED",
    activeCompleteness: "complete",
    activeCounts: { scannedRows: 9, visibleEntries: 9, quests: 6, returnedQuests: 6 },
    active: [
      quest(384, { logIndex: 9, objectives: [
        { type: "item", index: 1, numRequired: 6, finished: false, text: "0/6 Crag Boar Rib", objectiveType: 1, numFulfilled: 0 },
        { type: "item", index: 2, numRequired: 1, finished: false, text: "0/1 Rhapsody Malt", objectiveType: 1, numFulfilled: 0 },
      ] }),
      quest(400, { logIndex: 2, readyForTurnIn: true, isComplete: true, objectives: [{ type: "log", index: 1, numRequired: 1, text: "Deliver Steelgrill's Tools to Beldin Steelgrill.", finished: true, numFulfilled: 1 }] }),
      quest(96629, { logIndex: 7, readyForTurnIn: false, isComplete: false, objectives: [{ type: "object", index: 1, numRequired: 1, finished: false, text: "Learn cooking from Gremlock Pilsnor in Kharanos", objectiveType: 14, numFulfilled: 1 }] }),
      quest(98321, { logIndex: 3, objectives: [{ type: "item", index: 1, numRequired: 8, finished: false, text: "0/8 Flintfire's Shipment", objectiveType: 1, numFulfilled: 0 }] }),
      quest(98322, { logIndex: 5, readyForTurnIn: true, isComplete: true, objectives: {} }),
      quest(99158, { logIndex: 4, readyForTurnIn: true, isComplete: true, objectives: [{ type: "log", index: 1, numRequired: 1, text: "Bring the crate of candles to Father Gavin at Misty Pine Refuge.", finished: true, numFulfilled: 1 }] }),
    ],
    completedHistory: { state: "OBSERVED", questIDs: RORDIN_SNAPSHOT_180.completedQuestIDs, returnedCount: 29 },
    issues: [],
  },
};

/** Creates snapshot ids 1–179 without gear sidecars, then the captured Rordin snapshot 180. */
export function seedRordinSnapshot180(store: SqliteSnapshotStore): number {
  const { name, realm } = RORDIN_SNAPSHOT_180.identity;
  for (let id = 1; id < RORDIN_SNAPSHOT_180.id; id++) {
    const generatedAt = RORDIN_SNAPSHOT_180.generatedAt - (RORDIN_SNAPSHOT_180.id - id) * 100;
    const text = buildWowSyncExport({ generatedAt, character: { name, surname: "Longbraid", realm, class: "Warrior", level: 6, clientFamily: "Forever", clientVersion: "1.60.1", clientBuild: "70338", interface: "16001" } });
    store.importSnapshot(text, id === RORDIN_SNAPSHOT_180.id - 1 ? { foreverGearObservation: {
      clientProfile: QUEST_PROFILE, name, realm, generatedAt, sourceCharacterGuid: "Player-HISTORICAL-MISMATCH",
    } } : undefined);
  }
  const generatedAt = RORDIN_SNAPSHOT_180.generatedAt;
  const text = buildWowSyncExport({ generatedAt, character: { name, surname: "Longbraid", realm, class: "Warrior", level: 6, race: "Dwarf", faction: "Alliance", clientFamily: "Forever", clientVersion: "1.60.1", clientBuild: "70338", interface: "16001" } });
  const result = store.importSnapshot(text, { foreverGearObservation: {
    clientProfile: QUEST_PROFILE,
    name,
    realm,
    generatedAt,
    sourceCharacterGuid: RORDIN_SNAPSHOT_180.sourceCharacterGuid,
    quests: RORDIN_SNAPSHOT_180_QUEST_SECTION,
  } });
  return result.snapshot.id;
}
