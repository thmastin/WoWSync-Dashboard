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
const professionRecipes = {
  observedAt: 1_791_754_503,
  completeness: "partial",
  data: {
    formatVersion: 1,
    ownerScope: "CHARACTER",
    coverage: { state: "PARTIAL", candidateCompleteness: "UNKNOWN", enumeration: "OBSERVED", filteredEnumerationUsed: false, returnedRecipeCount: 507, learnedTrueCount: 5, learnedFalseCount: 501, unknownLearnedCount: 0, uniqueCandidateCount: 506, duplicateRecipeIDCount: 1 },
    professions: [{ baseSkillLineID: 164, skillLineID: 2938, professionName: "Blacksmithing", evidence: "OBSERVED", observedAt: 1_791_754_503, coverage: { state: "PARTIAL", candidateCompleteness: "UNKNOWN", returnedRecipeCount: 507, learnedTrueCount: 5, learnedFalseCount: 501, unknownLearnedCount: 0, uniqueCandidateCount: 506, duplicateRecipeIDCount: 1 }, recipes: [
      { recipeID: 2660, name: "Rough Sharpening Stone", learned: true, learnedState: "OBSERVED_TRUE", evidence: "OBSERVED", observedAt: 1_791_754_503, outputItemID: 2862, outputQuantityMin: 1, outputQuantityMax: 1, outputItemInfo: { state: "OBSERVED", itemID: 2862, itemType: "Consumable", itemSubType: "Other", equipLocation: "INVTYPE_NON_EQUIP_IGNORE" }, reagentSlots: [{ required: true, reagents: [{ itemID: 2835 }], quantityRequired: 1 }] },
      { recipeID: 2663, name: "Copper Bracers", learned: true, learnedState: "OBSERVED_TRUE", evidence: "OBSERVED", observedAt: 1_791_754_503, outputItemID: 2853, outputQuantityMin: 1, outputQuantityMax: 1, outputItemInfo: { state: "OBSERVED", itemID: 2853, itemType: "Armor", itemSubType: "Mail", equipLocation: "INVTYPE_WRIST" }, reagentSlots: [{ required: true, reagents: [{ itemID: 2840 }], quantityRequired: 2 }] },
      { recipeID: 3115, name: "Rough Weightstone", learned: true, learnedState: "OBSERVED_TRUE", evidence: "OBSERVED", observedAt: 1_791_754_503, outputItemID: 3239, outputQuantityMin: 1, outputQuantityMax: 1, outputItemInfo: { state: "OBSERVED", itemID: 3239, itemType: "Consumable", itemSubType: "Other", equipLocation: "INVTYPE_NON_EQUIP_IGNORE" }, reagentSlots: [{ required: true, reagents: [{ itemID: 2835 }], quantityRequired: 1 }] },
      { recipeID: 12260, name: "Rough Copper Vest", learned: true, learnedState: "OBSERVED_TRUE", evidence: "OBSERVED", observedAt: 1_791_754_503, outputItemID: 10421, outputQuantityMin: 1, outputQuantityMax: 1, outputItemInfo: { state: "OBSERVED", itemID: 10421, itemType: "Armor", itemSubType: "Mail", equipLocation: "INVTYPE_CHEST" }, reagentSlots: [{ required: true, reagents: [{ itemID: 2840 }], quantityRequired: 4 }] },
      { recipeID: 1245287, name: "Copper Rod", learned: true, learnedState: "OBSERVED_TRUE", evidence: "OBSERVED", observedAt: 1_791_754_503, outputItemID: 6217, outputQuantityMin: 1, outputQuantityMax: 1, outputItemInfo: { state: "OBSERVED", itemID: 6217, itemType: "Trade Goods", itemSubType: "Enchanting", equipLocation: "INVTYPE_NON_EQUIP_IGNORE" }, reagentSlots: [{ required: true, reagents: [{ itemID: 2840 }], quantityRequired: 1 }] },
    ] }],
  },
};

const fact = (value: string | number | boolean) => ({ state: "OBSERVED", type: typeof value, value });
function capturedItem(itemID: number, itemString: string, name: string, itemType: string, itemSubType: string, equipLocation: string, armor?: number, options: { playerCanUse?: boolean; requiredLevel?: number; reference?: { armor: number; stamina?: number } } = {}) {
  const itemInfoReturns: Array<string | number | boolean | null> = [name, `|H${itemString}|h[${name}]|h`, 1, 5, options.requiredLevel ?? 1, itemType, itemSubType, 1, equipLocation, 1, 1, 1, 1, 0, 0, null, false, ""];
  return {
    itemID, itemString,
    itemInfoInstant: { api: "C_Item.GetItemInfoInstant", state: "OBSERVED_VALUE", input: { itemString }, observedAt: RORDIN_SNAPSHOT_180.questObservedAt, returns: [itemID, itemType, itemSubType, equipLocation].map((value) => ({ observation: fact(value) })) },
    itemInfo: { api: "C_Item.GetItemInfo", state: "OBSERVED_VALUE", input: { itemString }, observedAt: RORDIN_SNAPSHOT_180.questObservedAt, returns: itemInfoReturns.map((value) => ({ observation: value === null ? { state: "NIL", type: "nil" } : fact(value) })) },
    ...(armor !== undefined ? { itemStats: { api: "C_Item.GetItemStats", state: "OBSERVED_VALUE", complete: true, input: { itemString }, observedAt: RORDIN_SNAPSHOT_180.questObservedAt, table: { state: "OBSERVED_TABLE", complete: true, entryCount: 1, entries: [{ keyType: "string", key: "RESISTANCE0_NAME", observation: fact(armor) }] } } } : {}),
    isEquippableItem: { api: "C_Item.IsEquippableItem", state: "OBSERVED_VALUE", input: { itemString }, observedAt: RORDIN_SNAPSHOT_180.questObservedAt, returns: [{ observation: fact(true) }] },
    ...(options.playerCanUse !== undefined ? { playerCanUseItem: { api: "C_PlayerInfo.CanUseItem", state: "OBSERVED_VALUE", input: { scope: "CURRENT_PLAYER_ONLY", itemID, itemString }, observedAt: RORDIN_SNAPSHOT_180.questObservedAt, returns: [{ observation: fact(options.playerCanUse) }] } } : {}),
    ...(options.reference ? { referenceFacts: { leads: [{ build: "70291", source: "User-provided public Forever beta reference lead", fields: options.reference }] } } : {}),
  };
}

function rordinItemEvidence(fullyEvidencedCandidateID?: number) {
  const candidate = (itemID: number, itemString: string, name: string, slot: string, refArmor: number, stamina?: number) => capturedItem(itemID, itemString, name, "Armor", "Mail", slot, fullyEvidencedCandidateID === itemID ? refArmor : undefined, { requiredLevel: 2, ...(fullyEvidencedCandidateID === itemID ? { playerCanUse: true } : {}), reference: { armor: refArmor, ...(stamina !== undefined ? { stamina } : {}) } });
  return {
  observedAt: RORDIN_SNAPSHOT_180.questObservedAt,
  completeness: "partial",
  source: "Forever item API capture",
  data: { items: [
    capturedItem(1364, "item:1364::::::::6:1491:::::::::", "Ragged Leather Vest", "Armor", "Leather", "INVTYPE_CHEST", 31),
    capturedItem(2651, "item:2651::::::::6:1491:::::::::", "Flimsy Chain Bracers", "Armor", "Mail", "INVTYPE_WRIST", 25),
    candidate(2853, "item:2853::::::::6:1491:::::::::", "Copper Bracers", "INVTYPE_WRIST", 35),
    candidate(10421, "item:10421::::::::6:1491:::::::::", "Rough Copper Vest", "INVTYPE_CHEST", 108, 1),
  ] },
  };
}
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
export function seedRordinSnapshot180(store: SqliteSnapshotStore, options: { fullyEvidencedCandidateID?: number } = {}): number {
  const { name, realm } = RORDIN_SNAPSHOT_180.identity;
  for (let id = 1; id < RORDIN_SNAPSHOT_180.id; id++) {
    const generatedAt = RORDIN_SNAPSHOT_180.generatedAt - (RORDIN_SNAPSHOT_180.id - id) * 100;
    const text = buildWowSyncExport({ generatedAt, character: { name, surname: "Longbraid", realm, class: "Warrior", level: 6, clientFamily: "Forever", clientVersion: "1.60.1", clientBuild: "70338", interface: "16001" } });
    store.importSnapshot(text, id === RORDIN_SNAPSHOT_180.id - 1 ? { foreverGearObservation: {
      clientProfile: QUEST_PROFILE, name, realm, generatedAt, sourceCharacterGuid: "Player-HISTORICAL-MISMATCH",
    } } : undefined);
  }
  const generatedAt = RORDIN_SNAPSHOT_180.generatedAt;
  const text = buildWowSyncExport({ generatedAt, character: { name, surname: "Longbraid", race: "Dwarf", faction: "Alliance", realm, class: "Warrior", level: 6, clientFamily: "Forever", clientVersion: "1.60.1", clientBuild: "70338", interface: "16001" },
    equipment: { slots: [{ slot: 5, slotName: "Chest", itemRef: "item:1364::::::::6:1491:::::::::", name: "Ragged Leather Vest", itemLevel: 5, requiredLevel: 1 }, { slot: 9, slotName: "Wrist", itemRef: "item:2651::::::::6:1491:::::::::", name: "Flimsy Chain Bracers", itemLevel: 4, requiredLevel: 1 }] },
    professions: { entries: [{ name: "Mining", skill: 3, maxSkill: 75 }, { name: "Blacksmithing", skill: 1, maxSkill: 75 }] },
    bags: { partial: true, containers: [{ id: 0, capacity: 20, items: [{ itemRef: "item:117::::::::6:1491:::::::::", name: "Tough Jerky", qty: 13 }] }] }, bank: { unknown: true } });
  const result = store.importSnapshot(text, { foreverGearObservation: {
    clientProfile: QUEST_PROFILE,
    name,
    realm,
    generatedAt,
    sourceCharacterGuid: RORDIN_SNAPSHOT_180.sourceCharacterGuid,
    quests: RORDIN_SNAPSHOT_180_QUEST_SECTION,
    professionRecipes: professionRecipes,
    itemEvidence: rordinItemEvidence(options.fullyEvidencedCandidateID),
    equipment: { observedAt: RORDIN_SNAPSHOT_180.questObservedAt, completeness: "partial", data: { slots: { "5": { itemID: 1364, itemString: "item:1364::::::::6:1491:::::::::", name: "Ragged Leather Vest" }, "9": { itemID: 2651, itemString: "item:2651::::::::6:1491:::::::::", name: "Flimsy Chain Bracers" } } } },
    bags: {
      observedAt: 1_791_753_907, completeness: "complete", lastAttemptStale: true,
      data: { containers: [{ id: 0, slots: { "1": { itemID: 117, itemString: "item:117::::::::6:1491:::::::::", name: "Tough Jerky", count: 13 } } }] },
    },
    bank: { observedAt: RORDIN_SNAPSHOT_180.questObservedAt, completeness: "unknown", reason: "Not observed", data: {} },
  } });
  return result.snapshot.id;
}
