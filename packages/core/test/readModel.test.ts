import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DashboardReadModel } from "../src/readModel.ts";
import { SqliteSnapshotStore } from "../src/sqliteStore.ts";
import { buildWowSyncExport } from "./fixtureBuilder.ts";
import { observation } from "./equipmentObservationFixtures.ts";

const NOW = 1_800_000_000;
function retail(name: string, realm: string, moneyCopper?: number) {
  return buildWowSyncExport({ generatedAt: NOW - 10, character: { name, realm, clientFamily: "Retail", clientVersion: "12.1.0", moneyCopper }, equipment: { slots: [{ slot: 1, slotName: "Head", itemRef: "item:1", name: "Observed Helm", itemLevel: 279 }] } });
}
function classic(name: string, realm: string) { return buildWowSyncExport({ generatedAt: NOW - 20, character: { name, realm, clientVersion: "1.15.9" } }); }

test("read model requires a version and cannot leak a same-named Classic character into Retail", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    store.importSnapshot(classic("Twin", "Era"));
    store.importSnapshot(retail("Twin", "Cairne", 0));
    const read = new DashboardReadModel(store, () => NOW);
    assert.throws(() => read.listCharacters({ version: undefined as never }), /version is required/);
    const result = read.getCharacterSummary({ version: "retail", name: "Twin", realm: "Cairne" });
    assert.equal(result.status, "FOUND");
    if (result.status === "FOUND") {
      assert.equal(result.value.data?.realm, "Cairne");
      assert.equal(result.value.data?.goldCopper, 0, "observed zero remains a real zero");
      assert.equal(result.value.provenance.version, "retail");
    }
  } finally { store.close(); }
});

test("same-name realm matches are ambiguity, never a silent choice", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    store.importSnapshot(retail("Twin", "Cairne"));
    store.importSnapshot(retail("Twin", "Thrall"));
    const result = new DashboardReadModel(store, () => NOW).getCharacterEquipment({ version: "retail", name: "Twin" });
    assert.equal(result.status, "AMBIGUOUS");
    if (result.status === "AMBIGUOUS") assert.deepEqual(result.candidates.map((entry) => entry.realm).sort(), ["Cairne", "Thrall"]);
  } finally { store.close(); }
});

test("Forever source character GUID collisions remain unresolved instead of merging account-context observations", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    for (const [generatedAt, guid] of [[NOW - 10, "Player-1-A"], [NOW - 5, "Player-2-B"]] as const) {
      const raw = buildWowSyncExport({ generatedAt, character: { name: "Hallo", realm: "Hallo", clientFamily: "Forever", clientVersion: "1.60.1", clientBuild: "70291", interface: "16001" } });
      store.importSnapshot(raw, { foreverGearObservation: { clientProfile: "Forever:1.60.1:70291:16001", name: "Hallo", realm: "Hallo", generatedAt, sourceCharacterGuid: guid, equipment: { observedAt: generatedAt, completeness: "complete", data: { slots: {} } } } });
    }
    const result = new DashboardReadModel(store, () => NOW).getForeverGearObservation({ version: "forever", name: "Hallo", realm: "Hallo" });
    assert.equal(result.status, "FOUND");
    if (result.status === "FOUND") {
      assert.equal(result.value.data, undefined);
      assert.match(result.value.provenance.reason ?? "", /missing or conflicting WoWSyncDB character GUIDs/);
    }
  } finally { store.close(); }
});

test("Forever duplicate text cannot erase a conflicting WoWSyncDB source GUID", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    const raw = buildWowSyncExport({ generatedAt: NOW, character: { name: "Hallo", realm: "Hallo", clientFamily: "Forever", clientVersion: "1.60.1", clientBuild: "70291", interface: "16001" } });
    const observation = { clientProfile: "Forever:1.60.1:70291:16001", name: "Hallo", realm: "Hallo", generatedAt: NOW, sourceCharacterGuid: "Player-1-A", equipment: { observedAt: NOW, completeness: "complete", data: { slots: {} } } };
    store.importSnapshot(raw, { foreverGearObservation: observation });
    const duplicate = { ...observation, sourceCharacterGuid: "Player-2-B" };
    assert.equal(store.importSnapshot(raw, { foreverGearObservation: duplicate }).foreverGearObservation, "conflict");
    const result = new DashboardReadModel(store, () => NOW).getForeverGearObservation({ version: "forever", name: "Hallo", realm: "Hallo" });
    assert.equal(result.status, "FOUND");
    if (result.status === "FOUND") assert.equal(result.value.data, undefined);
  } finally { store.close(); }
});

test("Forever observation resolves within its version and reports observed variants with explicit UNKNOWN claims", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    const raw = buildWowSyncExport({ generatedAt: NOW - 5, character: { name: "Hallo", realm: "Hallo", clientFamily: "Forever", clientVersion: "1.60.1", clientBuild: "70291", interface: "16001" }, equipment: { slots: [{ slot: 16, slotName: "Main Hand", itemRef: "item:42:0:0:0:0:0:0:0", name: "Observed", itemLevel: 2 }] }, bags: { containers: [{ id: 0, capacity: 16, items: [{ itemRef: "item:42:0:0:0:0:0:0:0:123:0:0:0", name: "Variant", qty: 1 }] }] }, bank: { unknown: true } });
    const sidecar = { clientProfile: "Forever:1.60.1:70291:16001", name: "Hallo", realm: "Hallo", generatedAt: NOW - 5, sourceCharacterGuid: "Player-1-HALLO", equipment: { observedAt: NOW - 4, completeness: "complete", data: { slots: { "16": { itemID: 42, itemString: "item:42:0:0:0:0:0:0:0", name: "Observed", itemLevel: 2 } } } }, bags: { observedAt: NOW - 3, completeness: "partial", data: { containers: [{ id: 0, slots: { "1": { itemID: 42, itemString: "item:42:0:0:0:0:0:0:0:123:0:0:0", name: "Variant", count: 1 } } }] } }, bank: { observedAt: NOW - 3, completeness: "unknown", reason: "not observed", data: {} }, itemMetadata: {} };
    const first = store.importSnapshot(raw, { foreverGearObservation: sidecar });
    const newer = structuredClone(sidecar);
    newer.equipment.observedAt = NOW - 1;
    newer.equipment.data.slots["16"] = { itemID: 43, itemString: "item:43:9", name: "Newer structured observation", itemLevel: 3 };
    const duplicate = store.importSnapshot(raw, { foreverGearObservation: newer });
    assert.equal(duplicate.isDuplicate, true);
    assert.equal(duplicate.foreverGearObservation, "updated");
    const conflicting = structuredClone(newer);
    conflicting.equipment.data.slots["16"] = { itemID: 44, itemString: "item:44:8", name: "Same-time conflict", itemLevel: 4 };
    assert.equal(store.importSnapshot(raw, { foreverGearObservation: conflicting }).foreverGearObservation, "conflict");
    const read = new DashboardReadModel(store, () => NOW);
    const result = read.getForeverGearObservation({ version: "forever", name: "Hallo", realm: "Hallo" });
    assert.equal(result.status, "FOUND");
    if (result.status === "FOUND") {
      assert.equal(result.value.provenance.version, "forever");
      assert.equal(result.value.data?.equipment.items[0]?.itemRef, "item:43:9");
      assert.equal(result.value.data?.equipment.items[0]?.provenance, "OBSERVED");
      assert.equal(result.value.data?.carried?.items?.[0]?.itemRef, "item:42:0:0:0:0:0:0:0:123:0:0:0");
      assert.equal(result.value.data?.evaluationCandidates.state, "UNKNOWN");
      assert.equal(result.value.data?.unknowns.transferability, "UNKNOWN");
      assert.equal(result.value.data?.bank.state, "UNKNOWN");
      assert.equal(result.value.data?.identity.accountScope, "UNKNOWN");
    }
    const wrongVersion = read.getForeverGearObservation({ version: "retail", name: "Hallo", realm: "Hallo" });
    assert.equal(wrongVersion.status, "FOUND");
    if (wrongVersion.status === "FOUND") assert.equal(wrongVersion.value.data, undefined);
    assert.equal(read.getForeverGearObservation({ version: "forever", name: "Nobody", realm: "Hallo" }).status, "NOT_FOUND");
  } finally { store.close(); }
});

test("Forever allocation keeps source location, unknown roster membership, and every decision dimension separate", () => {
  const store = new SqliteSnapshotStore(":memory:");
  const carriedRef = "item:2901::::::::8:1485::14:::::::";
  const equippedRef = "item:900001::::::::8:1485:::::::::";
  try {
    const observed = (value: string | number | boolean) => ({ state: "OBSERVED", type: typeof value, value });
    const fact = (id: number, itemRef: string, name: string, subClass: string, equipLoc: string, subClassID: number, dps: number, itemLevel: number, requiredLevel: number, observedAt = NOW - 5) => {
      const className = "Weapon";
      const values = [name, `|H${itemRef}|h[${name}]|h`, 1, itemLevel, requiredLevel, className, subClass, 1, equipLoc, 1, 0, 2, subClassID, 0, 0, null, false, ""];
      return { itemID: id, itemString: itemRef, name, itemInfoInstant: { api: "C_Item.GetItemInfoInstant", state: "OBSERVED_VALUE", returns: [id, className, subClass, equipLoc, 1, 2, subClassID].map((value) => ({ observation: observed(value) })) },
        isEquippableItem: { api: "C_Item.IsEquippableItem", state: "OBSERVED_VALUE", input: { itemString: itemRef }, observedAt, returns: [{ observation: observed(true) }] },
        itemInfo: { api: "C_Item.GetItemInfo", state: "OBSERVED_VALUE", returnCount: 18, observedAt, returns: values.map((value, index) => ({ index: index + 1, observation: value === null ? { state: "NIL", type: "nil" } : observed(value) })) },
        itemSpecInfo: { api: "C_Item.GetItemSpecInfo", state: "OBSERVED_VALUE", input: { itemString: itemRef }, observedAt, table: { state: "OBSERVED_TABLE", complete: true, entries: [{ key: "1", observation: observed(71) }] } },
        itemStats: { api: "C_Item.GetItemStats", state: "OBSERVED_VALUE", table: { state: "OBSERVED_TABLE", entryCount: 1, complete: true, entries: [{ keyType: "string", key: "ITEM_MOD_DAMAGE_PER_SECOND_SHORT", observation: observed(dps) }] } } };
    };
    const make = (name: string, guid: string, bags: unknown, facts?: unknown[], factsObservedAt = NOW - 5, skillLines?: unknown[], skillLinesObservedAt?: number, equipmentObservedAt?: number) => {
      const generatedAt = NOW - 5;
      const isReceiver = name === "Receiver" || name === "StaleEquipment";
      const raw = buildWowSyncExport({ generatedAt, character: { name, realm: "Classic Beta PvP 2", clientFamily: "Forever", clientVersion: "1.60.1", clientBuild: "70291", interface: "16001", class: isReceiver ? "MAGE" : "HUNTER", level: isReceiver ? 8 : 9 }, equipment: { slots: isReceiver ? [{ slot: 16, slotName: "Main Hand", itemRef: equippedRef, name: "Observed Knife", itemLevel: 5 }] : [] }, bags: { containers: [] }, bank: { unknown: true } });
      store.importSnapshot(raw, { foreverGearObservation: {
        clientProfile: "Forever:1.60.1:70291:16001", name, realm: "Classic Beta PvP 2", generatedAt, sourceCharacterGuid: guid,
        equipment: { observedAt: equipmentObservedAt ?? generatedAt, completeness: "complete", data: { slots: isReceiver ? { "16": { itemID: 900001, itemString: equippedRef, name: "Observed Knife", itemLevel: 5, requiredLevel: 1 } } : {} } },
        bags: { observedAt: generatedAt, completeness: "complete", data: bags },
        bank: { observedAt: generatedAt, completeness: "unknown", data: {} },
        ...(facts ? { itemEvidence: { observedAt: factsObservedAt, completeness: "complete", source: "synthetic 70291 exact-item API fixture", data: { sourceSections: { bags: { observedAt: generatedAt, state: "complete" } }, specialization: { capturedAt: generatedAt, activeIndex: { api: "C_SpecializationInfo.GetSpecialization", returns: [{ observation: observed(1) }] }, activeInfo: { api: "C_SpecializationInfo.GetSpecializationInfo", state: "OBSERVED_VALUE", returns: [{ observation: observed(71) }] } }, ...(skillLines ? { skillLines, ...(skillLinesObservedAt !== undefined ? { skillLinesObservedAt } : {}) } : {}), items: facts } } } : {}),
      } });
    };
    make("Carrier", "Player-1-CARRIER", { containers: [{ id: 0, slots: { "7": { itemID: 2901, itemString: carriedRef, count: 1, bound: false, bindingState: "OBSERVED_FALSE" } } }] }, [fact(2901, carriedRef, "Mining Pick", "Miscellaneous", "INVTYPE_WEAPONMAINHAND", 14, 1.5, 4, 1)], NOW - 5, [{ name: "Miscellaneous", rank: 1, maxRank: 1 }]);
    const staleRef = "item:2902::::::::8:1485::14:::::::";
    make("StaleCarrier", "Player-1-STALE", { containers: [{ id: 0, slots: { "2": { itemID: 2902, itemString: staleRef, count: 1 } } }] }, [fact(2902, staleRef, "Old Pick", "Miscellaneous", "INVTYPE_WEAPONMAINHAND", 14, 2.5, 4, 1, NOW - 4 * 24 * 60 * 60)], NOW - 4 * 24 * 60 * 60);
    const statsStaleRef = "item:2903::::::::8:1485::14:::::::";
    const statsStaleFact = fact(2903, statsStaleRef, "Stats Stale Pick", "Miscellaneous", "INVTYPE_WEAPONMAINHAND", 14, 2.75, 4, 1);
    (statsStaleFact.itemStats as { observedAt?: number }).observedAt = NOW - 4 * 24 * 60 * 60;
    make("StatsStaleCarrier", "Player-1-STATS-STALE", { containers: [{ id: 0, slots: { "3": { itemID: 2903, itemString: statsStaleRef, count: 1 } } }] }, [statsStaleFact]);
    const mismatchRef = "item:2904::::::::8:1485::14:::::::";
    const mismatchFact = fact(2904, mismatchRef, "Mismatch Pick", "Miscellaneous", "INVTYPE_WEAPONMAINHAND", 14, 2.9, 4, 1);
    const mismatchedLink = mismatchFact.itemInfo.returns[1].observation as { state: string; value?: unknown };
    mismatchedLink.value = "|Hitem:990004:wrong:variant|h[Mismatch Pick]|h";
    make("MismatchCarrier", "Player-1-MISMATCH", { containers: [{ id: 0, slots: { "4": { itemID: 2904, itemString: mismatchRef, count: 1 } } }] }, [mismatchFact]);
    make("Receiver", "Player-1-RECEIVER", { containers: [] }, [fact(900001, equippedRef, "Observed Knife", "Daggers", "INVTYPE_WEAPON", 15, 1.875, 5, 1)]);
    make("StaleEquipment", "Player-1-STALE-EQUIP", { containers: [] }, [fact(900001, equippedRef, "Observed Knife", "Daggers", "INVTYPE_WEAPON", 15, 1.875, 5, 1)], NOW - 5, undefined, undefined, NOW - 4 * 24 * 60 * 60);
    const result = new DashboardReadModel(store, () => NOW).getForeverGearAllocation({ version: "forever", name: "Receiver", realm: "Classic Beta PvP 2" });
    assert.equal(result.status, "FOUND");
    if (result.status !== "FOUND" || !result.value.data) return;
    const view = result.value.data;
    assert.equal(view.version, "forever");
    assert.equal(view.scope.accountMembership, "UNKNOWN");
    assert.equal(view.recipient.class?.value, "MAGE");
    assert.equal(view.recipient.level?.value, 8);
    assert.deepEqual(view.recipient.observedSkillLines, []);
    const carrierSelf = new DashboardReadModel(store, () => NOW).getForeverGearAllocation({ version: "forever", name: "Carrier", realm: "Classic Beta PvP 2" });
    assert.equal(carrierSelf.status, "FOUND");
    if (carrierSelf.status === "FOUND" && carrierSelf.value.data) {
      assert.equal(carrierSelf.value.data.recipient.observedSkillLines[0]?.provenance, "UNKNOWN", "fresh item facts cannot make a skill row with no skill-specific timestamp observed");
      assert.equal(carrierSelf.value.data.assessments[0]?.eligibilityChecks.weaponProficiency.state, "UNKNOWN", "untimestamped positive-rank skill rows cannot pass the proficiency hypothesis");
    }
    const carrier = view.candidateSources.find((source) => source.source.name === "Carrier");
    assert.equal(carrier?.candidates[0]?.itemRef, carriedRef);
    assert.equal(carrier?.candidates[0]?.locatedWith.locationScope, "CHARACTER_CARRIED_INVENTORY");
    assert.equal(carrier?.candidates[0]?.ownership.state, "UNKNOWN");
    assert.equal(carrier?.candidates[0]?.binding.value, false);
    assert.equal(carrier?.candidates[0]?.transferability, "UNKNOWN");
    assert.equal(carrier?.candidates[0]?.transferabilityEvidence.state, "UNKNOWN");
    assert.equal(view.assessments.length, 4);
    const currentAssessment = view.assessments.find((assessment) => assessment.candidate.itemRef === carriedRef);
    assert.equal(currentAssessment?.recipient.name, "Receiver");
    assert.equal(currentAssessment?.eligibility, "UNKNOWN");
    assert.equal(currentAssessment?.eligibilityChecks.requiredLevel.state, "MET");
    assert.equal(currentAssessment?.eligibilityChecks.requiredLevel.itemRequiredLevel, 1);
    assert.equal(currentAssessment?.eligibilityChecks.requiredLevel.recipientLevel, 8);
    assert.equal(currentAssessment?.eligibilityChecks.classRestriction.state, "UNKNOWN");
    assert.equal(currentAssessment?.eligibilityChecks.weaponProficiency.state, "UNKNOWN");
    assert.equal(currentAssessment?.playerCanUseSignal, "UNKNOWN", "synthetic older fixture does not invent a CanUseItem observation");
    assert.equal(currentAssessment?.bindingAssessment.state, "UNKNOWN", "generic bound=false does not establish a transfer route");
    assert.equal(currentAssessment?.eligibilityChecks.slotCompatibility.state, "MAPPED", "Forever equip-location mapping finds the occupied main-hand slot despite a different exact token");
    assert.equal(currentAssessment?.suitability, "OBSERVED_SPEC_TAG_MATCH", "synthetic exact-item and recipient specialization evidence only produces a suitability hint");
    assert.equal(currentAssessment?.upgradeStatus, "NO_RECORDED_STAT_GAIN");
    assert.deepEqual(currentAssessment?.rawStatComparisons[0]?.values.find((row) => row.key === "ITEM_MOD_DAMAGE_PER_SECOND_SHORT"), { key: "ITEM_MOD_DAMAGE_PER_SECOND_SHORT", candidate: 1.5, equipped: 1.875, delta: -0.375 });
    const staleAssessment = view.assessments.find((assessment) => assessment.candidate.itemRef === staleRef);
    assert.equal(staleAssessment?.eligibilityChecks.requiredLevel.state, "UNKNOWN", "stale item metadata cannot establish a current level gate");
    assert.deepEqual(staleAssessment?.rawStatComparisons, [], "stale item metadata cannot enter raw comparisons");
    const staleStatsAssessment = view.assessments.find((assessment) => assessment.candidate.itemRef === statsStaleRef);
    assert.equal(staleStatsAssessment?.eligibilityChecks.requiredLevel.state, "MET", "fresh GetItemInfo can support its separate level gate");
    assert.deepEqual(staleStatsAssessment?.rawStatComparisons, [], "stale GetItemStats cannot enter raw comparisons");
    const mismatchAssessment = view.assessments.find((assessment) => assessment.candidate.itemRef === mismatchRef);
    assert.equal(mismatchAssessment?.eligibilityChecks.requiredLevel.state, "UNKNOWN", "a variant mismatch invalidates selected tuple fields");
    assert.deepEqual(mismatchAssessment?.rawStatComparisons, [], "unvalidated exact-variant contracts cannot enter raw comparisons");
    assert.equal(currentAssessment?.transferability, "UNKNOWN");
    assert.equal(currentAssessment?.allocationPriority, "UNRANKED_UNKNOWN_SCOPE");
    assert.equal(currentAssessment?.decision, "NO_RECOMMENDATION");
    assert.match(currentAssessment?.missingEvidence.join(" ") ?? "", /account membership/);
    assert.equal(view.conclusion, "INSUFFICIENT_EVIDENCE");
    const rosterReview = view.recipientEvaluations.find((row) => row.itemRef === carriedRef && row.source.identityKey === carrier?.source.identityKey);
    assert.equal(rosterReview?.recipients.length, 6, "candidate is screened against each known Forever character only");
    assert.ok(rosterReview?.recipients.some((row) => row.name === "Receiver" && row.upgradeStatus === "NO_RECORDED_STAT_GAIN"));
    assert.ok(rosterReview?.recipients.some((row) => row.name === "StaleCarrier" && row.transferability === "UNKNOWN"));
    assert.ok(rosterReview?.recipients.every((row) => row.fit !== "LOCAL_REVIEW" || row.name === "Carrier"));
    const staleEquipmentView = new DashboardReadModel(store, () => NOW).getForeverGearAllocation({ version: "forever", name: "StaleEquipment", realm: "Classic Beta PvP 2" });
    assert.equal(staleEquipmentView.status, "FOUND");
    if (staleEquipmentView.status === "FOUND" && staleEquipmentView.value.data) {
      const staleComparison = staleEquipmentView.value.data.assessments.find((row) => row.candidate.itemRef === carriedRef);
      assert.deepEqual(staleComparison?.rawStatComparisons, [], "a recent item/delta call cannot refresh an older equipment snapshot");
      assert.equal(staleComparison?.upgradeStatus, "UNKNOWN");
    }
    const local = new DashboardReadModel(store, () => NOW).getForeverGearAllocation({ version: "forever", name: "Carrier", realm: "Classic Beta PvP 2" });
    assert.equal(local.status, "FOUND");
    if (local.status === "FOUND" && local.value.data) {
      const selfAssessment = local.value.data.assessments.find((assessment) => assessment.source.identityKey === local.value.data?.recipient.identityKey && assessment.candidate.itemRef === carriedRef);
      assert.equal(selfAssessment?.eligibility, "UNKNOWN", "the direct API signal does not prove full eligibility");
      assert.equal(selfAssessment?.playerApiSignal, "TRUE");
      assert.equal(selfAssessment?.eligibilityChecks.classRestriction.state, "UNKNOWN");
      assert.equal(selfAssessment?.suitability, "OBSERVED_SPEC_TAG_MATCH", "synthetic exact item tags and active specialization are joined only as a suitability hint");
      assert.equal(selfAssessment?.decision, "REVIEW_LOCAL_CANDIDATE");
      assert.notEqual(selfAssessment?.decision, "CONSIDER_EQUIPPING_ON_SOURCE");
    }
  } finally { store.close(); }
});

test("Retail candidate analysis integrates SQLite evidence, uppercase WoW class tokens, per-spec equipment, and provenance", () => {
  const store = new SqliteSnapshotStore(":memory:");
  const header = "candidateState\tlocationType\tcontainerID\tslot\titemID\titemString\titemGUID\tequipType\tcurrentItemLevel\trequiredLevel\tclassID\tsubclassID\tbaseEquipLocation\tisBound\tboundToAccountUntilEquip\titemBindToAccount\titemBindToAccountUntilEquip\ttooltipBindingType\ttooltipBindingRawValue\tcurrentCharacterCanUse\tobservationState";
  const row = ["EQUIPPABLE", "CONTAINER_SLOT", "0", "1", "500", "item:500", "?", "11", "120", "1", "4", "0", "INVTYPE_FINGER", "?", "?", "?", "?", "?", "?", "?", "OBSERVED"].join("\t");
  const candidateExport = buildWowSyncExport({ generatedAt: NOW - 1, character: { name: "Exporter", realm: "Cairne", clientFamily: "Retail", clientVersion: "12.1.0", class: "WARRIOR", level: 90 } }).replace("\n\n[END]", `\n\n[GEAR CANDIDATES]\nState: complete; observed=${NOW - 1}\nContractVersion: 1\n${header}\n${row}\n\n[END]`);
  try {
    store.importSnapshot(candidateExport);
    const identity = store.importSnapshot(buildWowSyncExport({ generatedAt: NOW - 20, character: { name: "Arms", realm: "Cairne", clientFamily: "Retail", clientVersion: "12.1.0", class: "WARRIOR", level: 90 } })).character.identityKey;
    for (const name of ["Exporter", "Arms"]) for (const [index, specID] of [71, 72, 73].entries()) {
      const observedAt = NOW - 10 + index;
      const tuple = { observedAt, capture: index + 1, revision: 1 };
      store.importSnapshot(buildWowSyncExport({ generatedAt: observedAt, character: { name, realm: "Cairne", clientFamily: "Retail", clientVersion: "12.1.0", class: "WARRIOR", level: 90 } }), {
        equipmentObservation: observation({ tuple, specID, slots: { "11": { itemID: 100, itemLevel: 100 }, "12": { itemID: 101, itemLevel: 105 } } }),
      });
    }
    const exporter = store.listCharacters("retail").find((character) => character.name === "Exporter")!;
    const sourceSnapshot = store.listSnapshots(exporter.identityKey).find((snapshot) => snapshot.parsed.gearCandidates !== undefined)!;
    const result = new DashboardReadModel(store, () => NOW).analyzeRetailGearCandidate({ version: "retail", exporterIdentityKey: exporter.identityKey, snapshotId: sourceSnapshot.id, rowOrdinal: 1 });
    assert.equal(result.status, "FOUND");
    if (result.status !== "FOUND") throw new Error("Expected candidate analysis");
    assert.equal(result.value.candidate.validity, "VALID_CANDIDATE");
    assert.equal(result.value.recommendation, "TIED_BEST_SUPPORTED_UPGRADE");
    assert.ok(result.value.assessments.every((assessment) => assessment.comparison === "UPGRADE_BY_ITEM_LEVEL" && assessment.deltaItemLevel === 20));
    assert.ok(result.value.assessments.every((assessment) => assessment.retained.state === "QUALIFIED" && assessment.retained.snapshotId > 0));
    assert.ok(result.value.assessments.some((assessment) => assessment.character.identityKey === identity));
    assert.ok(result.value.assessments.some((assessment) => assessment.character.name === "Exporter"));
  } finally { store.close(); }
});

test("unknown sections remain UNKNOWN rather than empty and profession coverage is DERIVED", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    store.importSnapshot(buildWowSyncExport({ character: { name: "Ghost", realm: "Era", clientVersion: "1.15.9" }, equipment: { unknown: true }, bags: { unknown: true }, professions: { unknown: true } }));
    const read = new DashboardReadModel(store, () => NOW);
    const equipment = read.getCharacterEquipment({ version: "classic-era", name: "Ghost", realm: "Era" });
    assert.equal(equipment.status, "FOUND");
    if (equipment.status === "FOUND") {
      assert.equal(equipment.value.provenance.state, "UNKNOWN");
      assert.equal(equipment.value.data, undefined);
    }
    const bags = read.getCharacterStorage({ version: "classic-era", name: "Ghost", realm: "Era", storage: "bags" });
    assert.equal(bags.status, "FOUND");
    if (bags.status === "FOUND") {
      assert.equal(bags.value.data?.sectionState, "UNKNOWN");
      assert.equal(bags.value.data?.itemsKnownEmpty, false);
      assert.equal(bags.value.data?.items, undefined);
    }
    const coverage = read.getProfessionCoverage({ version: "classic-era" });
    assert.equal(coverage.provenance.state, "DERIVED");
    assert.ok(coverage.data?.coverage.every((entry) => entry.coverageStatus === "unknown"));
  } finally { store.close(); }
});

test("observed-empty character storage remains distinct from UNKNOWN", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    store.importSnapshot(buildWowSyncExport({ character: { name: "Empty", realm: "Cairne", clientFamily: "Retail", clientVersion: "12.1.0" }, bags: { containers: [] } }));
    const result = new DashboardReadModel(store, () => NOW).getCharacterStorage({ version: "retail", name: "Empty", realm: "Cairne", storage: "bags" });
    assert.equal(result.status, "FOUND");
    if (result.status === "FOUND") {
      assert.equal(result.value.provenance.state, "OBSERVED");
      assert.equal(result.value.data?.itemsKnownEmpty, true);
      assert.deepEqual(result.value.data?.items, []);
    }
  } finally { store.close(); }
});

test("LAST_SEEN section provenance is retained as historical, never current", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    store.importSnapshot(buildWowSyncExport({ character: { name: "Historian", realm: "Era", clientVersion: "1.15.9" }, professions: { entries: [{ name: "Alchemy", skill: 1, maxSkill: 300 }] } }));
    const originalListSnapshots = store.listSnapshots.bind(store);
    store.listSnapshots = (identityKey) => originalListSnapshots(identityKey).map((snapshot) => ({ ...snapshot, parsed: { ...snapshot.parsed, professions: { ...snapshot.parsed.professions, status: { ...snapshot.parsed.professions.status, state: "LAST_SEEN" } } } }));
    const result = new DashboardReadModel(store, () => NOW).getCharacterProfessions({ version: "classic-era", name: "Historian", realm: "Era" });
    assert.equal(result.status, "FOUND");
    if (result.status === "FOUND") {
      assert.equal(result.value.provenance.state, "LAST_SEEN");
      assert.match(result.value.provenance.warning ?? "", /historical/i);
    }
  } finally { store.close(); }
});

test("gear candidate read preserves per-character snapshot provenance, row state, captured-empty and missing sidecars", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    const append = (raw: string, body: string) => raw.replace("\n\n[END]", `\n\n[GEAR CANDIDATES]\n${body}\n\n[END]`);
    const header = "candidateState\tlocationType\tcontainerID\tslot\titemID\titemString\titemGUID\tequipType\tcurrentItemLevel\trequiredLevel\tclassID\tsubclassID\tbaseEquipLocation\tisBound\tboundToAccountUntilEquip\titemBindToAccount\titemBindToAccountUntilEquip\ttooltipBindingType\ttooltipBindingRawValue\tcurrentCharacterCanUse\tobservationState";
    const raw = append(retail("Evidence", "Cairne"), `State: partial; observed=${NOW - 20}\nContractVersion: 1\n${header}\nEQUIPPABLE\tCONTAINER_SLOT\t0\t1\t123\titem:123\t?\t0\t0\t0\t4\t0\tINVTYPE_HEAD\tno\t?\tyes\tno\t?\t9\tno\tLAST_SEEN`);
    store.importSnapshot(raw);
    // Newer export lacks the optional sidecar; the latest captured sidecar remains explicitly historical.
    store.importSnapshot(retail("Evidence", "Cairne").replace("Generated: 1800000000", `Generated: ${NOW - 10}`));
    store.importSnapshot(retail("NoEvidence", "Cairne"));
    const result = new DashboardReadModel(store, () => NOW).getGearCandidateEvidence({ version: "retail" });
    assert.equal(result.provenance.state, "DERIVED");
    const evidence = result.data?.characters.find((entry) => entry.identity.name === "Evidence")!;
    assert.equal(evidence.captured, true);
    assert.equal(evidence.identity.identityKey, "retail::cairne::evidence");
    assert.equal(evidence.snapshot?.snapshotId, store.listSnapshots(evidence.identity.identityKey)[1]?.id);
    assert.equal(evidence.snapshot?.freshness, "stale", "snapshot freshness is computed separately from the row evidence state");
    assert.equal(evidence.snapshot?.candidateObservedAt, NOW - 20);
    assert.equal(evidence.snapshot?.candidateFreshness, "recent", "sidecar observation age is computed independently of snapshot import timing");
    assert.equal(evidence.sidecar?.rows[0]?.observationState, "LAST_SEEN");
    assert.equal(evidence.sidecar?.observedAt, NOW - 20);
    assert.deepEqual(evidence.sidecar?.rows[0]?.currentCharacterCanUse, { state: "KNOWN", value: false });
    assert.deepEqual(evidence.sidecar?.rows[0]?.isBound, { state: "KNOWN", value: false });
    assert.deepEqual(evidence.sidecar?.rows[0]?.boundToAccountUntilEquip, { state: "UNKNOWN" });
    assert.deepEqual(evidence.sidecar?.rows[0]?.itemBindToAccount, { state: "KNOWN", value: true });
    assert.deepEqual(evidence.sidecar?.rows[0]?.itemBindToAccountUntilEquip, { state: "KNOWN", value: false });
    assert.deepEqual(evidence.sidecar?.rows[0]?.tooltipBindingRawValue, { state: "KNOWN", value: 9 });
    const unavailable = result.data?.characters.find((entry) => entry.identity.name === "NoEvidence")!;
    assert.equal(unavailable.captured, false);
    assert.equal(unavailable.sidecar, undefined);
    const empty = append(retail("EmptyEvidence", "Cairne"), `State: complete; observed=0\nContractVersion: 1\n${header}\nCandidates: None observed`);
    store.importSnapshot(empty);
    const emptyResult = new DashboardReadModel(store, () => NOW).getGearCandidateEvidence({ version: "retail" }).data?.characters.find((entry) => entry.identity.name === "EmptyEvidence");
    assert.equal(emptyResult?.captured, true);
    assert.deepEqual(emptyResult?.sidecar?.rows, []);
    assert.equal(new DashboardReadModel(store, () => NOW).getGearCandidateEvidence({ version: "classic-era" }).provenance.state, "UNKNOWN");
  } finally { store.close(); }
});

test("Retail gear candidate recipient screen applies checked rules and preserves row occurrences", () => {
  const store = new SqliteSnapshotStore(":memory:");
  const header = "candidateState\tlocationType\tcontainerID\tslot\titemID\titemString\titemGUID\tequipType\tcurrentItemLevel\trequiredLevel\tclassID\tsubclassID\tbaseEquipLocation\tisBound\tboundToAccountUntilEquip\titemBindToAccount\titemBindToAccountUntilEquip\ttooltipBindingType\ttooltipBindingRawValue\tcurrentCharacterCanUse\tobservationState";
  const row = (requiredLevel: string, observationState = "OBSERVED", currentCanUse = "yes", bound = "no") => ["EQUIPPABLE", "CONTAINER_SLOT", "0", "1", "123", "item:123:variant", "guid-not-identity", "1", "0", requiredLevel, "4", "4", "INVTYPE_HEAD", bound, "?", "yes", "no", "?", "0", currentCanUse, observationState].join("\t");
  const exportWithCandidates = (name: string, realm: string, level: number, rows: string[], generatedAt: number) => {
    const raw = buildWowSyncExport({ generatedAt, character: { name, realm, clientFamily: "Retail", clientVersion: "12.1.0", level } });
    return raw.replace("\n\n[END]", `\n\n[GEAR CANDIDATES]\nState: partial; observed=${generatedAt}\nContractVersion: 1\n${header}\n${rows.length ? rows.join("\n") : "Candidates: None observed"}\n\n[END]`);
  };
  try {
    const exporterText = exportWithCandidates("Exporter", "Cairne", 90, [row("91", "OBSERVED", "no", "yes"), row("0", "OBSERVED", "no", "yes"), row("?", "LAST_SEEN"), row("91"), row("90")], NOW - 30);
    store.importSnapshot(exporterText);
    store.importSnapshot(buildWowSyncExport({ generatedAt: NOW - 5, character: { name: "Recipient", realm: "Cairne", clientFamily: "Retail", clientVersion: "12.1.0", level: 90 } }));
    const read = new DashboardReadModel(store, () => NOW);
    const result = read.getGearCandidateRecipientScreen({ version: "retail", exporterName: "Exporter", exporterRealm: "Cairne", recipientName: "Recipient", recipientRealm: "Cairne", offset: 0, limit: 10 });
    assert.equal(result.status, "FOUND");
    if (result.status !== "FOUND") return;
    const screen = result.value.data!;
    assert.equal(screen.accountMembership, "NOT_ESTABLISHED_BY_DASHBOARD_IDENTITY");
    assert.match(screen.accountMembershipCaveat, /does not establish/);
    assert.match(screen.uncheckedRestrictions, /native armor-family plausibility/);
    assert.equal(screen.exporter.name, "Exporter");
    assert.equal(screen.recipient.name, "Recipient");
    assert.equal(screen.candidateEvidence.captured, true);
    assert.equal(screen.candidateEvidence.totalCount, 5);
    assert.deepEqual(screen.candidateEvidence.rows?.map((entry) => [entry.rowOrdinal, entry.result]), [
      [1, "RULED_OUT"], [2, "NOT_RULED_OUT_BY_CHECKED_RULES"], [3, "UNKNOWN"], [4, "RULED_OUT"], [5, "NOT_RULED_OUT_BY_CHECKED_RULES"],
    ]);
    assert.match(screen.candidateEvidence.rows?.[0]?.reason ?? "", /required level 91.*recipient observed level 90/);
    assert.deepEqual(screen.candidateEvidence.rows?.[0]?.candidate.currentCharacterCanUse, { state: "KNOWN", value: false }, "exporter's false value is preserved and does not decide recipient screening");
    assert.deepEqual(screen.candidateEvidence.rows?.[0]?.candidate.boundToAccountUntilEquip, { state: "UNKNOWN" });
    assert.deepEqual(screen.candidateEvidence.rows?.[0]?.candidate.itemBindToAccount, { state: "KNOWN", value: true });
    assert.deepEqual(screen.candidateEvidence.rows?.[1]?.candidate.isBound, { state: "KNOWN", value: true });
    assert.equal(screen.candidateEvidence.rows?.[1]?.result, "NOT_RULED_OUT_BY_CHECKED_RULES", "binding evidence is not a required-level rule");
    assert.equal(screen.candidateEvidence.rows?.[0]?.observationState, "OBSERVED");
    assert.equal(screen.candidateEvidence.rows?.[2]?.observationState, "LAST_SEEN", "historical row state stays separate from age/freshness");
    assert.ok(screen.candidateEvidence.snapshot!.candidateFreshness);
    assert.ok(screen.candidateEvidence.snapshot!.freshness);
    assert.equal(screen.recipientLevel.evidence.state, "KNOWN");
    assert.equal(screen.recipientLevel.evidence.value, 90);
    assert.deepEqual(screen.recipientClass.evidence, { state: "KNOWN", value: "Warrior", normalizedClass: "WARRIOR", sectionState: "OBSERVED" });
    assert.equal(screen.recipientClass.snapshot?.snapshotId, screen.recipientLevel.snapshot?.snapshotId);
    assert.equal(screen.recipientLevel.snapshot?.snapshotId, store.listSnapshots("retail::cairne::recipient")[0]?.id);
    assert.equal("candidateId" in (screen.candidateEvidence.rows?.[0] ?? {}), false);
    assert.ok(screen.candidateEvidence.rows?.every((entry) => ["RULED_OUT", "NOT_RULED_OUT_BY_CHECKED_RULES", "UNKNOWN"].includes(entry.result)));
    for (const unsupportedField of ["canEquip", "upgrade", "transferable", "demand", "allocation", "surplus", "disposition"]) assert.equal(unsupportedField in screen, false);

    const duplicateRows = exportWithCandidates("DuplicateExporter", "Cairne", 90, [row("89"), row("89")], NOW - 10);
    store.importSnapshot(duplicateRows);
    const duplicate = read.getGearCandidateRecipientScreen({ version: "retail", exporterName: "DuplicateExporter", exporterRealm: "Cairne", recipientName: "Recipient", recipientRealm: "Cairne", offset: 1, limit: 1 });
    assert.equal(duplicate.status, "FOUND");
    if (duplicate.status === "FOUND") {
      assert.equal(duplicate.value.data?.candidateEvidence.totalCount, 2);
      assert.equal(duplicate.value.data?.candidateEvidence.rows?.[0]?.rowOrdinal, 2);
      assert.deepEqual(duplicate.value.data?.candidateEvidence.rows?.[0]?.candidate.itemString, { state: "KNOWN", value: "item:123:variant" });
      assert.deepEqual(duplicate.value.data?.candidateEvidence.rows?.[0]?.candidate.itemGUID, { state: "KNOWN", value: "guid-not-identity" });
      assert.deepEqual(duplicate.value.data?.candidateEvidence.rows?.[0]?.candidate.locationType, { state: "KNOWN", value: "CONTAINER_SLOT" });
    }

    const zeroLevelText = exportWithCandidates("ZeroCandidate", "Cairne", 90, [row("0")], NOW - 7);
    store.importSnapshot(zeroLevelText);
    const zeroCandidate = read.getGearCandidateRecipientScreen({ version: "retail", exporterName: "ZeroCandidate", exporterRealm: "Cairne", recipientName: "Recipient", recipientRealm: "Cairne" });
    assert.equal(zeroCandidate.status, "FOUND");
    if (zeroCandidate.status === "FOUND") assert.equal(zeroCandidate.value.data?.candidateEvidence.rows?.[0]?.result, "NOT_RULED_OUT_BY_CHECKED_RULES", "known requiredLevel zero remains a real passing value");

    const emptyText = exportWithCandidates("EmptyCandidate", "Cairne", 90, [], NOW - 3);
    store.importSnapshot(emptyText);
    const empty = read.getGearCandidateRecipientScreen({ version: "retail", exporterName: "EmptyCandidate", exporterRealm: "Cairne", recipientName: "Recipient", recipientRealm: "Cairne" });
    assert.equal(empty.status, "FOUND");
    if (empty.status === "FOUND") {
      assert.equal(empty.value.data?.candidateEvidence.captured, true);
      assert.deepEqual(empty.value.data?.candidateEvidence.rows, []);
      assert.equal(empty.value.data?.candidateEvidence.totalCount, 0);
    }

    const unavailable = read.getGearCandidateRecipientScreen({ version: "retail", exporterName: "Recipient", exporterRealm: "Cairne", recipientName: "Exporter", recipientRealm: "Cairne" });
    assert.equal(unavailable.status, "FOUND");
    if (unavailable.status === "FOUND") {
      assert.equal(unavailable.value.data?.candidateEvidence.captured, false);
      assert.equal(unavailable.value.data?.candidateEvidence.rows, undefined);
      assert.match(unavailable.value.data?.candidateEvidence.reason ?? "", /unavailable, not an empty/);
    }

    assert.equal(read.getGearCandidateRecipientScreen({ version: "classic-era", exporterName: "Exporter", exporterRealm: "Cairne", recipientName: "Recipient", recipientRealm: "Cairne" }).status, "UNSUPPORTED_VERSION");
    for (const version of ["tbc-anniversary", "forever", "unknown-version"] as const) {
      assert.equal(read.getGearCandidateRecipientScreen({ version, exporterName: "Exporter", exporterRealm: "Cairne", recipientName: "Recipient", recipientRealm: "Cairne" }).status, "UNSUPPORTED_VERSION", `${version} must remain outside the Retail-only recipient screen`);
    }
    assert.equal(read.getGearCandidateRecipientScreen({ version: "retail", exporterName: "missing", exporterRealm: "Cairne", recipientName: "Recipient", recipientRealm: "Cairne" }).status, "EXPORTER_NOT_FOUND");
    assert.equal(read.getGearCandidateRecipientScreen({ version: "retail", exporterName: "Exporter", exporterRealm: "Cairne", recipientName: "missing", recipientRealm: "Cairne" }).status, "RECIPIENT_NOT_FOUND");
  } finally { store.close(); }
});

test("recipient screen does not compare against a non-OBSERVED or UNKNOWN recipient level and never guesses ambiguous identity", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    const header = "candidateState\tlocationType\tcontainerID\tslot\titemID\titemString\titemGUID\tequipType\tcurrentItemLevel\trequiredLevel\tclassID\tsubclassID\tbaseEquipLocation\tisBound\tboundToAccountUntilEquip\titemBindToAccount\titemBindToAccountUntilEquip\ttooltipBindingType\ttooltipBindingRawValue\tcurrentCharacterCanUse\tobservationState";
    const row = "EQUIPPABLE\tCONTAINER_SLOT\t0\t1\t123\titem:123\t?\t1\t0\t91\t4\t4\tINVTYPE_HEAD\t?\t?\t?\t?\t?\t?\t?\tOBSERVED";
    const exporter = buildWowSyncExport({ generatedAt: NOW - 20, character: { name: "Exporter", realm: "Cairne", clientFamily: "Retail", clientVersion: "12.1.0", level: 90 } }).replace("\n\n[END]", `\n\n[GEAR CANDIDATES]\nState: complete; observed=${NOW - 20}\nContractVersion: 1\n${header}\n${row}\n\n[END]`);
    const recipient = buildWowSyncExport({ generatedAt: NOW - 10, character: { name: "Recipient", realm: "Cairne", clientFamily: "Retail", clientVersion: "12.1.0", level: 90 } });
    store.importSnapshot(exporter);
    store.importSnapshot(recipient);
    const originalSnapshots = store.listSnapshots.bind(store);
    store.listSnapshots = (identityKey) => originalSnapshots(identityKey).map((snapshot) => identityKey === "retail::cairne::recipient" ? { ...snapshot, parsed: { ...snapshot.parsed, character: { ...snapshot.parsed.character, status: { ...snapshot.parsed.character.status, state: "LAST_SEEN" } } } } : snapshot);
    const read = new DashboardReadModel(store, () => NOW);
    const historicalLevel = read.getGearCandidateRecipientScreen({ version: "retail", exporterName: "Exporter", exporterRealm: "Cairne", recipientName: "Recipient", recipientRealm: "Cairne" });
    assert.equal(historicalLevel.status, "FOUND");
    if (historicalLevel.status === "FOUND") {
      assert.deepEqual(historicalLevel.value.data?.recipientLevel.evidence, { state: "UNKNOWN", value: 90, sectionState: "LAST_SEEN", reason: "Recipient character level provenance is LAST_SEEN; only OBSERVED level evidence is used for this screen." });
      assert.equal(historicalLevel.value.data?.candidateEvidence.rows?.[0]?.result, "UNKNOWN");
    }
    store.listSnapshots = (identityKey) => originalSnapshots(identityKey).map((snapshot) => identityKey === "retail::cairne::recipient" ? { ...snapshot, parsed: { ...snapshot.parsed, character: { ...snapshot.parsed.character, level: undefined } } } : snapshot);
    const unknownLevel = read.getGearCandidateRecipientScreen({ version: "retail", exporterName: "Exporter", exporterRealm: "Cairne", recipientName: "Recipient", recipientRealm: "Cairne" });
    assert.equal(unknownLevel.status, "FOUND");
    if (unknownLevel.status === "FOUND") {
      assert.equal(unknownLevel.value.data?.recipientLevel.evidence.state, "UNKNOWN");
      assert.equal(unknownLevel.value.data?.candidateEvidence.rows?.[0]?.result, "UNKNOWN");
    }
    store.listSnapshots = originalSnapshots;
    const originals = store.listCharacters.bind(store);
    store.listCharacters = (version) => {
      const chars = originals(version);
      const duplicate = chars.find((character) => character.name === "Exporter")!;
      return [...chars, { ...duplicate, identityKey: `${duplicate.identityKey}::duplicate` }];
    };
    assert.equal(read.getGearCandidateRecipientScreen({ version: "retail", exporterName: "Exporter", exporterRealm: "Cairne", recipientName: "Recipient", recipientRealm: "Cairne" }).status, "EXPORTER_AMBIGUOUS");
    store.listCharacters = (version) => {
      const chars = originals(version);
      const duplicate = chars.find((character) => character.name === "Recipient")!;
      return [...chars, { ...duplicate, identityKey: `${duplicate.identityKey}::duplicate` }];
    };
    assert.equal(read.getGearCandidateRecipientScreen({ version: "retail", exporterName: "Exporter", exporterRealm: "Cairne", recipientName: "Recipient", recipientRealm: "Cairne" }).status, "RECIPIENT_AMBIGUOUS");
  } finally { store.close(); }
});

test("Retail recipient screen applies native armor-family checks only to coherent ordinary body armor", () => {
  const store = new SqliteSnapshotStore(":memory:");
  const header = "candidateState\tlocationType\tcontainerID\tslot\titemID\titemString\titemGUID\tequipType\tcurrentItemLevel\trequiredLevel\tclassID\tsubclassID\tbaseEquipLocation\tisBound\tboundToAccountUntilEquip\titemBindToAccount\titemBindToAccountUntilEquip\ttooltipBindingType\ttooltipBindingRawValue\tcurrentCharacterCanUse\tobservationState";
  const makeRow = (opts: { equipType: string; baseLocation: string; classID?: string; subclassID?: string; requiredLevel?: string; state?: string }) => [
    "EQUIPPABLE", "CONTAINER_SLOT", "0", "1", "123", "item:123", "?", opts.equipType, "0", opts.requiredLevel ?? "0", opts.classID ?? "4", opts.subclassID ?? "4", opts.baseLocation, "?", "?", "?", "?", "?", "?", "?", opts.state ?? "OBSERVED",
  ].join("\t");
  const familyRows = [
    makeRow({ equipType: "1", baseLocation: "INVTYPE_HEAD", subclassID: "1" }),
    makeRow({ equipType: "3", baseLocation: "INVTYPE_SHOULDER", subclassID: "2" }),
    makeRow({ equipType: "5", baseLocation: "INVTYPE_CHEST", subclassID: "3" }),
    makeRow({ equipType: "20", baseLocation: "INVTYPE_ROBE", subclassID: "4" }),
  ];
  const nonApplicableRows = [
    makeRow({ equipType: "2", baseLocation: "INVTYPE_NECK", subclassID: "0" }),
    makeRow({ equipType: "11", baseLocation: "INVTYPE_FINGER", subclassID: "0" }),
    makeRow({ equipType: "12", baseLocation: "INVTYPE_TRINKET", subclassID: "0" }),
    makeRow({ equipType: "16", baseLocation: "INVTYPE_CLOAK", subclassID: "0" }),
    makeRow({ equipType: "14", baseLocation: "INVTYPE_SHIELD", subclassID: "6" }),
    makeRow({ equipType: "23", baseLocation: "INVTYPE_HOLDABLE", subclassID: "0" }),
    makeRow({ equipType: "13", baseLocation: "INVTYPE_WEAPON", classID: "2", subclassID: "7" }),
    makeRow({ equipType: "4", baseLocation: "INVTYPE_BODY", subclassID: "0" }),
    makeRow({ equipType: "19", baseLocation: "INVTYPE_TABARD", subclassID: "0" }),
    makeRow({ equipType: "1", baseLocation: "INVTYPE_HEAD", subclassID: "5" }),
  ];
  const uncertainRows = [
    makeRow({ equipType: "1", baseLocation: "INVTYPE_HEAD", classID: "?", subclassID: "4" }),
    makeRow({ equipType: "1", baseLocation: "INVTYPE_HEAD", subclassID: "?" }),
    makeRow({ equipType: "?", baseLocation: "INVTYPE_HEAD", subclassID: "1" }),
    makeRow({ equipType: "1", baseLocation: "INVTYPE_FINGER", subclassID: "1" }),
    makeRow({ equipType: "999", baseLocation: "INVTYPE_HEAD", subclassID: "1" }),
    makeRow({ equipType: "11", baseLocation: "INVTYPE_NECK", subclassID: "1" }),
  ];
  const compositionRows = [
    makeRow({ equipType: "1", baseLocation: "INVTYPE_HEAD", classID: "?", subclassID: "?", requiredLevel: "91" }),
    makeRow({ equipType: "5", baseLocation: "INVTYPE_CHEST", subclassID: "3", requiredLevel: "?" }),
    makeRow({ equipType: "20", baseLocation: "INVTYPE_ROBE", subclassID: "4", requiredLevel: "0" }),
    makeRow({ equipType: "1", baseLocation: "INVTYPE_HEAD", subclassID: "?", requiredLevel: "?" }),
  ];
  const allRows = [...familyRows, ...nonApplicableRows, ...uncertainRows, ...compositionRows];
  const addCandidates = (name: string, realm: string, generatedAt: number, rows: string[]) => buildWowSyncExport({ generatedAt, character: { name, realm, clientFamily: "Retail", clientVersion: "12.1.0", class: "Warrior", level: 90 } })
    .replace("\n\n[END]", `\n\n[GEAR CANDIDATES]\nState: complete; observed=${generatedAt}\nContractVersion: 1\n${header}\n${rows.join("\n")}\n\n[END]`);
  const addRecipient = (name: string, cls: string, generatedAt: number) => store.importSnapshot(buildWowSyncExport({ generatedAt, character: { name, realm: "Cairne", clientFamily: "Retail", clientVersion: "12.1.0", class: cls, level: 90 } }));
  const screen = (recipientName: string) => {
    const result = new DashboardReadModel(store, () => NOW).getGearCandidateRecipientScreen({ version: "retail", exporterName: "ArmorExporter", exporterRealm: "Cairne", recipientName, recipientRealm: "Cairne", limit: 100 });
    assert.equal(result.status, "FOUND");
    if (result.status !== "FOUND") throw new Error("Expected recipient screen");
    return result.value.data!;
  };
  try {
    store.importSnapshot(addCandidates("ArmorExporter", "Cairne", NOW - 40, allRows));
    addRecipient("MageRecipient", "Mage", NOW - 30);
    addRecipient("RogueRecipient", "Rogue", NOW - 29);
    addRecipient("HunterRecipient", "Hunter", NOW - 28);
    addRecipient("WarriorRecipient", "Warrior", NOW - 27);

    const expected = [
      ["MageRecipient", "Cloth"], ["RogueRecipient", "Leather"], ["HunterRecipient", "Mail"], ["WarriorRecipient", "Plate"],
    ] as const;
    for (const [name, nativeFamily] of expected) {
      const result = screen(name);
      assert.deepEqual(result.recipientClass.evidence, { state: "KNOWN", value: name.replace("Recipient", ""), normalizedClass: name.replace("Recipient", "").toUpperCase(), sectionState: "OBSERVED" });
      const matchingRow = result.candidateEvidence.rows?.find((row) => row.armorCheck.candidateFamily === nativeFamily);
      assert.equal(matchingRow?.armorCheck.state, "PASS", `${name} should pass native ${nativeFamily}`);
    }
    const mageRows = screen("MageRecipient").candidateEvidence.rows!;
    const magePlate = mageRows[3]!;
    assert.equal(magePlate.result, "RULED_OUT");
    assert.equal(magePlate.armorCheck.state, "RULED_OUT");
    assert.match(magePlate.armorCheck.reason, /native armor-family mismatch/i);
    assert.doesNotMatch(magePlate.armorCheck.reason, /cannot equip|CanEquip=false|technically prohibited|unusable by client/i);
    const warriorRows = screen("WarriorRecipient").candidateEvidence.rows!;
    assert.equal(warriorRows[2]?.armorCheck.state, "RULED_OUT", "Warrior + Mail body armor is a native-family mismatch");
    const mageUnknownRows = screen("MageRecipient").candidateEvidence.rows!;
    assert.equal(mageUnknownRows[familyRows.length + nonApplicableRows.length + 5]?.armorCheck.state, "UNKNOWN", "a known ring inventory type that conflicts with necklace baseEquipLocation is not silently treated as non-applicable");

    const unknownClassExport = buildWowSyncExport({ generatedAt: NOW - 26, character: { name: "UnknownClassRecipient", realm: "Cairne", clientFamily: "Retail", clientVersion: "12.1.0", class: "Wizard", level: 90 } });
    store.importSnapshot(unknownClassExport);
    const unknownClass = screen("UnknownClassRecipient");
    assert.equal(unknownClass.recipientClass.evidence.state, "UNKNOWN");
    assert.equal(unknownClass.candidateEvidence.rows?.[0]?.armorCheck.state, "UNKNOWN");
    assert.equal(unknownClass.candidateEvidence.rows?.find((row) => row.candidate.classID.state === "KNOWN" && row.candidate.classID.value === 2)?.weaponProficiencyCheck.state, "UNKNOWN");

    const missingClassExport = buildWowSyncExport({ generatedAt: NOW - 25, character: { name: "MissingClassRecipient", realm: "Cairne", clientFamily: "Retail", clientVersion: "12.1.0", class: "Warrior", level: 90 } }).replace("Class: Warrior", "Class: ?");
    store.importSnapshot(missingClassExport);
    const missingClass = screen("MissingClassRecipient");
    assert.equal(missingClass.recipientClass.evidence.state, "UNKNOWN");
    assert.equal(missingClass.candidateEvidence.rows?.[0]?.armorCheck.state, "UNKNOWN");
    assert.equal(missingClass.candidateEvidence.rows?.find((row) => row.candidate.classID.state === "KNOWN" && row.candidate.classID.value === 2)?.weaponProficiencyCheck.state, "UNKNOWN");

    const originalListSnapshots = store.listSnapshots.bind(store);
    store.listSnapshots = (identityKey) => originalListSnapshots(identityKey).map((snapshot) => identityKey === "retail::cairne::warriorrecipient" ? { ...snapshot, parsed: { ...snapshot.parsed, character: { ...snapshot.parsed.character, status: { ...snapshot.parsed.character.status, state: "LAST_SEEN" } } } } : snapshot);
    const lastSeenClass = screen("WarriorRecipient");
    assert.equal(lastSeenClass.recipientClass.evidence.state, "UNKNOWN");
    assert.equal(lastSeenClass.recipientClass.evidence.sectionState, "LAST_SEEN");
    assert.equal(lastSeenClass.candidateEvidence.rows?.[0]?.armorCheck.state, "UNKNOWN");
    assert.equal(lastSeenClass.candidateEvidence.rows?.find((row) => row.candidate.classID.state === "KNOWN" && row.candidate.classID.value === 2)?.weaponProficiencyCheck.state, "UNKNOWN");
    store.listSnapshots = (identityKey) => originalListSnapshots(identityKey).map((snapshot) => identityKey === "retail::cairne::warriorrecipient" ? { ...snapshot, parsed: { ...snapshot.parsed, character: { status: { state: "UNKNOWN" } } } } : snapshot);
    const unknownSection = screen("WarriorRecipient");
    assert.equal(unknownSection.recipientClass.evidence.state, "UNKNOWN");
    assert.equal(unknownSection.recipientClass.evidence.sectionState, "UNKNOWN");
    assert.equal(unknownSection.candidateEvidence.rows?.[0]?.armorCheck.state, "UNKNOWN");
    assert.equal(unknownSection.candidateEvidence.rows?.find((row) => row.candidate.classID.state === "KNOWN" && row.candidate.classID.value === 2)?.weaponProficiencyCheck.state, "UNKNOWN");
    store.listSnapshots = originalListSnapshots;

    const missingClassNonArmor = addCandidates("NonArmorExporter", "Cairne", NOW - 24, nonApplicableRows);
    store.importSnapshot(missingClassNonArmor);
    const originalClasses = store.listSnapshots.bind(store);
    store.listSnapshots = (identityKey) => originalClasses(identityKey).map((snapshot) => identityKey === "retail::cairne::missingclassrecipient" ? { ...snapshot, parsed: { ...snapshot.parsed, character: { ...snapshot.parsed.character, class: undefined } } } : snapshot);
    const nonArmorResult = new DashboardReadModel(store, () => NOW).getGearCandidateRecipientScreen({ version: "retail", exporterName: "NonArmorExporter", exporterRealm: "Cairne", recipientName: "MissingClassRecipient", recipientRealm: "Cairne" });
    assert.equal(nonArmorResult.status, "FOUND");
    if (nonArmorResult.status === "FOUND") {
      const rows = nonArmorResult.value.data?.candidateEvidence.rows ?? [];
      const identifiedWeapon = rows.find((row) => row.candidate.classID.state === "KNOWN" && row.candidate.classID.value === 2);
      assert.equal(identifiedWeapon?.weaponProficiencyCheck.state, "UNKNOWN", "an identified weapon with unusable recipient class is not N/A");
      assert.ok(rows.filter((row) => row !== identifiedWeapon).every((row) => row.armorCheck.state === "NOT_APPLICABLE" && row.result === "NOT_RULED_OUT_BY_CHECKED_RULES"));
    }
    store.listSnapshots = originalClasses;

    const composeExporter = addCandidates("ComposeExporter", "Cairne", NOW - 23, compositionRows);
    store.importSnapshot(composeExporter);
    const compose = new DashboardReadModel(store, () => NOW).getGearCandidateRecipientScreen({ version: "retail", exporterName: "ComposeExporter", exporterRealm: "Cairne", recipientName: "WarriorRecipient", recipientRealm: "Cairne" });
    assert.equal(compose.status, "FOUND");
    if (compose.status === "FOUND") {
      assert.deepEqual(compose.value.data?.candidateEvidence.rows?.map((row) => [row.result, row.armorCheck.state]), [
        ["RULED_OUT", "UNKNOWN"], ["RULED_OUT", "RULED_OUT"], ["NOT_RULED_OUT_BY_CHECKED_RULES", "PASS"], ["UNKNOWN", "UNKNOWN"],
      ]);
    }
    assert.match(screen("WarriorRecipient").uncheckedRestrictions, /native-family mismatch is a plausibility-screen result/i);
    assert.match(screen("WarriorRecipient").uncheckedRestrictions, /class-level weapon proficiency\/access/);
    assert.match(screen("WarriorRecipient").uncheckedRestrictions, /Weapon PASS does not establish specialization suitability/);
    assert.match(screen("WarriorRecipient").uncheckedRestrictions, /allowed-class, race, faction, profession, unique\/equip/i);
  } finally { store.close(); }
});

test("Retail weapon proficiency screen covers the current class and supported subclass matrix", () => {
  const store = new SqliteSnapshotStore(":memory:");
  const header = "candidateState\tlocationType\tcontainerID\tslot\titemID\titemString\titemGUID\tequipType\tcurrentItemLevel\trequiredLevel\tclassID\tsubclassID\tbaseEquipLocation\tisBound\tboundToAccountUntilEquip\titemBindToAccount\titemBindToAccountUntilEquip\ttooltipBindingType\ttooltipBindingRawValue\tcurrentCharacterCanUse\tobservationState";
  const subclasses = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 13, 15, 18, 19];
  const passByClass: Record<string, number[]> = {
    DeathKnight: [0, 1, 4, 5, 6, 7, 8], DemonHunter: [0, 7, 9, 13, 15], Druid: [4, 5, 6, 10, 13, 15],
    Evoker: [0, 1, 4, 5, 7, 8, 10, 13, 15], Hunter: [1, 2, 3, 6, 8, 10, 18], Mage: [7, 10, 15, 19],
    Monk: [0, 4, 6, 7, 10, 13], Paladin: [0, 1, 4, 5, 6, 7, 8], Priest: [4, 10, 15, 19],
    Rogue: [0, 4, 7, 13, 15], Shaman: [0, 1, 4, 5, 10, 13, 15], Warlock: [7, 10, 15, 19],
    Warrior: [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 13, 15, 18],
  };
  const row = (subclass: string, options: { cls?: string; type?: string; location?: string; req?: string; usable?: string; bound?: string; candidateState?: string } = {}) => [
    options.candidateState ?? "EQUIPPABLE", "CONTAINER_SLOT", "0", "1", "123", "item:123", "?", options.type ?? "?", "0", options.req ?? "0", options.cls ?? "2", subclass,
    options.location ?? "?", options.bound ?? "?", "?", "?", "?", "?", "?", options.usable ?? "?", "OBSERVED",
  ].join("\t");
  const weaponRows = subclasses.map((subclass) => row(String(subclass)));
  const specialRows = [row("11"), row("12"), row("14"), row("16"), row("17"), row("20"), row("?"), row("999"), row("0", { cls: "4", type: "2", location: "INVTYPE_NECK" }), row("4", { cls: "4", type: "1", location: "INVTYPE_HEAD" }), row("7", { type: "17", location: "INVTYPE_2HWEAPON" }), row("1", { type: "13", location: "INVTYPE_WEAPON" }), row("7", { type: "13", location: "INVTYPE_WEAPONMAINHAND", usable: "yes", bound: "yes" }), row("7", { type: "13", location: "INVTYPE_WEAPON", usable: "no", bound: "no" }), row("7", { type: "13", location: "INVTYPE_2HWEAPON" }), row("7", { cls: "?", type: "13", location: "INVTYPE_WEAPON" }), row("7", { candidateState: "UNKNOWN" })];
  const allRows = [...weaponRows, ...specialRows];
  const addCandidates = () => buildWowSyncExport({ generatedAt: NOW - 40, character: { name: "WeaponExporter", realm: "Cairne", clientFamily: "Retail", clientVersion: "12.1.0", class: "Warrior", level: 90 } })
    .replace("\n\n[END]", `\n\n[GEAR CANDIDATES]\nState: complete; observed=${NOW - 40}\nContractVersion: 1\n${header}\n${allRows.join("\n")}\n\n[END]`);
  const addRecipient = (name: string, cls: string, generatedAt: number) => store.importSnapshot(buildWowSyncExport({ generatedAt, character: { name, realm: "Cairne", clientFamily: "Retail", clientVersion: "12.1.0", class: cls, level: 90 } }));
  const screen = (name: string) => {
    const result = new DashboardReadModel(store, () => NOW).getGearCandidateRecipientScreen({ version: "retail", exporterName: "WeaponExporter", exporterRealm: "Cairne", recipientName: name, recipientRealm: "Cairne", limit: 100 });
    assert.equal(result.status, "FOUND");
    if (result.status !== "FOUND") throw new Error("Expected recipient screen");
    return result.value.data!.candidateEvidence.rows!;
  };
  try {
    store.importSnapshot(addCandidates());
    let generatedAt = NOW - 30;
    for (const cls of Object.keys(passByClass)) { addRecipient(cls + "Recipient", cls, generatedAt++); }
    for (const [cls, passSubclasses] of Object.entries(passByClass)) {
      const rows = screen(cls + "Recipient");
      for (let index = 0; index < subclasses.length; index++) {
        const subclass = subclasses[index]!;
        const expected = cls === "Hunter" && [0, 7, 15].includes(subclass) ? "UNKNOWN" : passSubclasses.includes(subclass) ? "PASS" : "RULED_OUT";
        assert.equal(rows[index]?.weaponProficiencyCheck.state, expected, cls + " subclass " + subclass);
      }
    }
    const dhRows = screen("DemonHunterRecipient");
    assert.equal(dhRows[subclasses.indexOf(15)]?.weaponProficiencyCheck.state, "PASS", "Demon Hunter dagger is current Retail access");
    assert.equal(dhRows[subclasses.indexOf(9)]?.weaponProficiencyCheck.state, "PASS");
    const mageRows = screen("MageRecipient");
    assert.equal(mageRows[subclasses.indexOf(1)]?.weaponProficiencyCheck.state, "RULED_OUT", "Mage + two-handed axe mismatch");
    assert.equal(mageRows[subclasses.indexOf(9)]?.weaponProficiencyCheck.state, "RULED_OUT", "non-Demon-Hunter warglaive mismatch");
    assert.equal(mageRows[subclasses.indexOf(0)]?.weaponProficiencyCheck.state, "RULED_OUT", "subclass zero is a real one-handed axe");
    for (let index = weaponRows.length; index < weaponRows.length + 6; index++) { assert.equal(mageRows[index]?.weaponProficiencyCheck.state, "UNKNOWN", "unsupported weapon subclass row " + index); }
    assert.equal(mageRows[weaponRows.length + 6]?.weaponProficiencyCheck.state, "UNKNOWN", "unknown subclass");
    assert.equal(mageRows[weaponRows.length + 7]?.weaponProficiencyCheck.state, "UNKNOWN", "out-of-range subclass");
    assert.equal(mageRows[weaponRows.length + 8]?.weaponProficiencyCheck.state, "NOT_APPLICABLE", "known non-weapon class");
    assert.equal(mageRows[weaponRows.length + 9]?.weaponProficiencyCheck.state, "NOT_APPLICABLE", "armor coexists with armor check");
    assert.equal(mageRows[weaponRows.length + 10]?.weaponProficiencyCheck.state, "UNKNOWN", "one-handed family contradicts two-handed location");
    assert.equal(mageRows[weaponRows.length + 11]?.weaponProficiencyCheck.state, "UNKNOWN", "two-handed family contradicts ordinary weapon location");
    assert.equal(mageRows[weaponRows.length + 12]?.weaponProficiencyCheck.state, "PASS", "coherent location evidence does not alter result");
    assert.equal(mageRows[weaponRows.length + 13]?.weaponProficiencyCheck.state, "PASS", "currentCharacterCanUse and binding fields are irrelevant");
    assert.equal(mageRows[weaponRows.length + 14]?.weaponProficiencyCheck.state, "UNKNOWN", "contradictory equipType and baseEquipLocation");
    assert.equal(mageRows[weaponRows.length + 15]?.weaponProficiencyCheck.state, "UNKNOWN", "classID unknown is not inferred from slot evidence");
    assert.equal(mageRows[weaponRows.length + 16]?.weaponProficiencyCheck.state, "UNKNOWN", "candidate state unknown remains unresolved");
    for (const index of [subclasses.indexOf(0), subclasses.indexOf(7), subclasses.indexOf(15)]) {
      const check = screen("HunterRecipient")[index]!.weaponProficiencyCheck;
      assert.equal(check.state, "UNKNOWN");
      assert.match(check.reason, /specialization-dependent/i);
      assert.match(check.reason, /recipient specialization is not checked/i);
    }
    assert.equal(screen("HunterRecipient")[subclasses.indexOf(2)]?.weaponProficiencyCheck.state, "PASS", "Hunter bow pass");
    assert.equal(screen("HunterRecipient")[subclasses.indexOf(18)]?.weaponProficiencyCheck.state, "PASS", "Hunter crossbow pass");

    const composeRows = [
      row("1"), row("15", { req: "100" }), row("11", { req: "100" }), row("11"), row("4", { cls: "4", type: "11", location: "INVTYPE_FINGER" }),
    ];
    const composeExport = buildWowSyncExport({ generatedAt: NOW - 20, character: { name: "ComposeWeaponExporter", realm: "Cairne", clientFamily: "Retail", clientVersion: "12.1.0", class: "Warrior", level: 90 } })
      .replace("\n\n[END]", "\n\n[GEAR CANDIDATES]\nState: complete; observed=" + (NOW - 20) + "\nContractVersion: 1\n" + header + "\n" + composeRows.join("\n") + "\n\n[END]");
    store.importSnapshot(composeExport);
    const compose = new DashboardReadModel(store, () => NOW).getGearCandidateRecipientScreen({ version: "retail", exporterName: "ComposeWeaponExporter", exporterRealm: "Cairne", recipientName: "MageRecipient", recipientRealm: "Cairne", limit: 100 });
    assert.equal(compose.status, "FOUND");
    if (compose.status === "FOUND") {
      const rows = compose.value.data!.candidateEvidence.rows!;
      assert.deepEqual(rows.map((item) => [item.result, item.armorCheck.state, item.weaponProficiencyCheck.state]), [
        ["RULED_OUT", "NOT_APPLICABLE", "RULED_OUT"], ["RULED_OUT", "NOT_APPLICABLE", "PASS"], ["RULED_OUT", "NOT_APPLICABLE", "UNKNOWN"], ["UNKNOWN", "NOT_APPLICABLE", "UNKNOWN"], ["NOT_RULED_OUT_BY_CHECKED_RULES", "NOT_APPLICABLE", "NOT_APPLICABLE"],
      ]);
    }
    assert.match(screen("MageRecipient")[0]!.reason, /Weapon-proficiency check:/);
  } finally { store.close(); }
});

test("snapshot history is compact metadata and never leaks raw export text", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    store.importSnapshot(retail("Archivist", "Cairne", 123));
    const result = new DashboardReadModel(store, () => NOW).getCharacterSnapshotHistory({ version: "retail", name: "Archivist", realm: "Cairne" });
    assert.equal(result.status, "FOUND");
    if (result.status === "FOUND") {
      const history = result.value.data;
      assert.equal(result.value.provenance.state, "DERIVED");
      assert.equal(history?.items[0]?.moneyCopper, 123);
      assert.equal("parsed" in (history?.items[0] ?? {}), false);
      assert.equal("raw" in (history?.items[0] ?? {}), false);
    }
  } finally { store.close(); }
});

test("shared storage stays Retail-only and its projection is explicitly DERIVED", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    const read = new DashboardReadModel(store, () => NOW);
    assert.equal(read.getSharedStorage({ version: "classic-era" }).provenance.state, "UNKNOWN");
    const retailStorage = read.getSharedStorage({ version: "retail" });
    assert.equal(retailStorage.provenance.state, "DERIVED");
    assert.equal(retailStorage.data?.warband, null);
    assert.deepEqual(retailStorage.data?.guilds, []);
  } finally { store.close(); }
});

test("uncaptured Renown is explicitly UNKNOWN and separate from research", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    store.importSnapshot(retail("Virek", "Cairne"));
    const result = new DashboardReadModel(store, () => NOW).getRenown({ version: "retail", name: "Virek", realm: "Cairne" });
    assert.equal(result.status, "FOUND");
    if (result.status === "FOUND") {
      assert.equal(result.value.provenance.state, "UNKNOWN");
      assert.match(result.value.provenance.reason ?? "", /does not currently capture Renown/);
    }
  } finally { store.close(); }
});

test("bounded item and character-storage reads preserve version, section state, and metadata evidence", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    const captured = buildWowSyncExport({
      generatedAt: NOW - 10,
      character: { name: "Squashpot", realm: "Cairne", clientFamily: "Retail", clientVersion: "12.1.0" },
      bags: { containers: [{ id: 0, capacity: 20, free: 18, items: [{ itemRef: "item:12345", name: "Midnight Thread", qty: 2 }] }] },
      bank: { containers: [{ id: 1, capacity: 28, free: 27, items: [{ itemRef: "item:23456", name: "Moonlit Hide", qty: 1 }] }] },
    }) .replace(/\n\[END\]$/, "") + "\n\n[ITEM METADATA]\nbaseItemID\tclassID\tsubclassID\tbindType\texpansionID\tisCraftingReagent\n12345\t7\t5\t1\t11\tyes\n\n[END]";
    store.importSnapshot(captured);
    store.importSnapshot(buildWowSyncExport({ character: { name: "Squashpot", realm: "Era", clientVersion: "1.15.9" }, bags: { containers: [{ id: 0, capacity: 16, items: [{ itemRef: "item:12345", name: "Old Thread", qty: 7 }] }] } }));
    const read = new DashboardReadModel(store, () => NOW);
    const bags = read.getCharacterStorage({ version: "retail", name: "Squashpot", realm: "Cairne", storage: "bags" });
    assert.equal(bags.status, "FOUND");
    if (bags.status === "FOUND") {
      assert.equal(bags.value.provenance.state, "OBSERVED");
      assert.equal(bags.value.data?.items?.[0]?.name, "Midnight Thread");
      assert.equal(bags.value.data?.metadata[0]?.state, "KNOWN");
      assert.equal(bags.value.data?.metadata[0]?.value?.expansion.state, "KNOWN");
    }
    const bank = read.getCharacterStorage({ version: "retail", name: "Squashpot", realm: "Cairne", storage: "bank" });
    assert.equal(bank.status, "FOUND");
    if (bank.status === "FOUND") assert.equal(bank.value.data?.items?.[0]?.name, "Moonlit Hide");
    const retailSearch = read.searchItems({ version: "retail", query: "thread", limit: 1 });
    assert.equal(retailSearch.data?.items[0]?.item.name, "Midnight Thread");
    assert.equal(retailSearch.provenance.version, "retail");
    assert.equal(read.searchItems({ version: "classic-era", query: "thread" }).data?.items[0]?.item.name, "Old Thread");
    assert.deepEqual(read.getItemMetadata({ version: "retail", itemIds: [12345, 99999] }).data?.map((item) => item.state), ["KNOWN", "UNKNOWN"]);
    assert.throws(() => read.searchItems({ version: "retail", query: "thread", offset: -1 }), /offset/);
  } finally { store.close(); }
});

test("shared storage read slices preserve owner and historical carrier semantics", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    const fixture = new URL("./fixtures/sanitized/virek-warband-last-seen-1789965777.wowsync.txt", import.meta.url);
    store.importSnapshot(readFileSync(fixture, "utf8"));
    const read = new DashboardReadModel(store, () => NOW);
    const warband = read.getSharedStorageContents({ version: "retail", kind: "warband", limit: 2 });
    assert.equal(warband.provenance.state, "DERIVED");
    assert.equal(warband.data?.owners[0]?.owner.kind, "warband");
    assert.ok(warband.data?.owners[0]?.current?.content.truncated);
    assert.equal(warband.data?.owners[0]?.current?.liveAtExport, false);
    const guildFixture = new URL("./fixtures/derived/ezaller-shared-storage-1789478317.wowsync.txt", import.meta.url);
    store.importSnapshot(readFileSync(guildFixture, "utf8"));
    const guild = read.getSharedStorageContents({ version: "retail", kind: "guild", limit: 1 });
    assert.equal(guild.data?.owners[0]?.owner.kind, "guild");
    if (guild.data?.owners[0]?.owner.kind === "guild") {
      assert.equal(typeof guild.data.owners[0].owner.guildClubId, "string");
      assert.deepEqual(guild.data.owners[0].current?.coverage.inaccessibleTabs, [3]);
      assert.equal(guild.data.owners[0].current?.provenance.sources[0]?.carrierState, "OBSERVED");
    }
    assert.equal(read.getSharedStorageContents({ version: "classic-era", kind: "warband" }).provenance.state, "UNKNOWN");
  } finally { store.close(); }
});
