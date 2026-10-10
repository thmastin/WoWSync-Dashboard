import assert from "node:assert/strict";
import { test } from "node:test";
import { buildWowSyncExport } from "./fixtureBuilder.ts";
import { SqliteSnapshotStore } from "../src/sqliteStore.ts";
import { DashboardReadModel } from "../src/readModel.ts";
import { buildErpFulfillmentTriage, buildErpNeedReviewSnapshot } from "../src/erpFulfillmentTriage.ts";

test("fulfillment triage joins changed evidence, reservation review, and manual work without inferring cause", () => {
  const store = new SqliteSnapshotStore(":memory:");
  const now = Math.floor(Date.now() / 1000) - 200;
  const capture = (at: number, quantity: number) => buildWowSyncExport({ generatedAt: at, character: { name: "Triage Crafter", realm: "Realm A", clientVersion: "1.15.7", clientBuild: "60927" }, bags: { containers: [{ id: 0, capacity: 16, items: [{ itemRef: "item:159:0:0", name: "Fixture Stone", qty: quantity }] }] }, bank: { containers: [] } });
  try {
    const first = store.importSnapshot(capture(now, 2));
    store.importSnapshot(capture(now + 20, 1));
    const project = store.createErpProject({ version: "classic-era", title: "Three-resource provisioning", priority: 4, needs: [
      { stableId: "stone", kind: "ITEM_REF", resourceKey: "item:159:0:0", label: "Fixture Stone exact variant", requiredQuantity: 5, sourceIdentityKey: first.character.identityKey },
      { stableId: "cloth", kind: "ITEM_ID", resourceKey: "2589", label: "Cloth", requiredQuantity: 4 },
    ], reservations: [{ stableId: "stone-hold", needId: "stone", sourceIdentityKey: first.character.identityKey, quantity: 4, status: "ACTIVE", createdAt: now, updatedAt: now }], workOrders: [
      { stableId: "review-stone", kind: "INVESTIGATE", status: "PLANNED", title: "Check changed stone quantity", resourceNeedIds: ["stone"], dependsOn: [] },
      { stableId: "unlinked", kind: "OTHER", status: "IN_PROGRESS", title: "Confirm carried supplies", resourceNeedIds: [], dependsOn: [] },
    ] });
    const views = new DashboardReadModel(store).getErpProjects({ version: "classic-era" });
    const snapshot = buildErpNeedReviewSnapshot(views[0]!, "stone");
    assert.equal(snapshot?.projectId, project.stableId);
    assert.equal(snapshot?.projectRevision, project.revision);
    assert.equal(snapshot?.version, "classic-era");
    assert.equal(snapshot?.need.resourceKey, "item:159:0:0");
    assert.equal(snapshot?.evidence?.observedQuantity, 1, "review binds the exact normalized evidence presented to the player");
    const triage = buildErpFulfillmentTriage(views, "classic-era");
    const stone = triage.items.find((entry) => entry.need?.stableId === "stone");
    assert.ok(stone);
    assert.equal(stone.need?.resourceKey, "item:159:0:0", "exact variants survive triage");
    assert.ok(stone.signals.includes("CHANGED_OBSERVATION"));
    assert.ok(stone.signals.includes("RESERVATION_REVIEW"));
    assert.ok(stone.signals.includes("OPEN_WORK_ORDER"));
    assert.equal(stone.workOrders[0]?.stableId, "review-stone");
    assert.equal(stone.need?.observedQuantity, 1);
    assert.deepEqual(stone.need?.observationChange?.comparisons.map((entry) => [entry.section, entry.previousQuantity, entry.currentQuantity, entry.delta]), [["bags", 2, 1, -1], ["character bank", 0, 0, 0]], "the comparison preserves unchanged complete sections beside the changed one");
    assert.equal(triage.interpretation, "PLANNING_AND_EVIDENCE_REVIEW_ONLY", "changed quantities are not presented as action completion");
    assert.ok(triage.items.some((entry) => entry.need?.stableId === "cloth" && entry.signals.includes("UNWORKED_REQUIREMENT")));
    assert.ok(triage.items.some((entry) => entry.workOrders[0]?.stableId === "unlinked" && entry.signals[0] === "OPEN_WORK_ORDER"));
    assert.equal(triage.counts.CHANGED_OBSERVATION, 1);
    assert.equal(triage.counts.RESERVATION_REVIEW, 1);
    assert.equal(triage.counts.OPEN_WORK_ORDER, 2, "one linked order and one order-only row are both discoverable");
    assert.equal(triage.interpretation, "PLANNING_AND_EVIDENCE_REVIEW_ONLY");
    assert.equal(buildErpFulfillmentTriage(views, "forever").totalCount, 0, "triage never crosses version buckets");
    assert.deepEqual(buildErpFulfillmentTriage(views, "unknown-version").items, []);
    assert.equal(buildErpFulfillmentTriage(views, "classic-era", 1).truncated, true);
    assert.equal(buildErpFulfillmentTriage(views, "classic-era", 1).returnedCount, 1);
    assert.equal(triage.affectedProjectCount, 1);
  } finally { store.close(); }
});
