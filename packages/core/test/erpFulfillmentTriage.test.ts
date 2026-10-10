import assert from "node:assert/strict";
import { test } from "node:test";
import { buildWowSyncExport } from "./fixtureBuilder.ts";
import { SqliteSnapshotStore } from "../src/sqliteStore.ts";
import { DashboardReadModel } from "../src/readModel.ts";
import { buildErpFulfillmentTriage, buildErpNeedReviewSnapshot, buildErpPortfolioFulfillmentReview } from "../src/erpFulfillmentTriage.ts";

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

test("portfolio fulfillment review orders prerequisite evidence first and preserves unknowns, reservations, and version isolation", () => {
  const store = new SqliteSnapshotStore(":memory:");
  const now = Math.floor(Date.now() / 1000) - 200;
  try {
    const imported = store.importSnapshot(buildWowSyncExport({ generatedAt: now, character: { name: "Portfolio Crafter", realm: "Realm A", clientVersion: "1.15.7", clientBuild: "60927" }, bags: { containers: [{ id: 0, capacity: 16, items: [{ itemRef: "item:159:0:0", name: "Fixture Stone", qty: 5 }] }] }, bank: { containers: [] } }));
    const prerequisite = store.createErpProject({ version: "classic-era", title: "Gather ingredients", priority: 4, needs: [{ stableId: "shared", kind: "ITEM_REF", resourceKey: "item:159:0:0", label: "Stone supply", requiredQuantity: 5, sourceIdentityKey: imported.character.identityKey }] });
    store.createErpProject({ version: "classic-era", title: "Competing provision plan", priority: 3, needs: [{ stableId: "other-need", kind: "ITEM_REF", resourceKey: "item:159:0:0", label: "Other stone commitment", requiredQuantity: 2, sourceIdentityKey: imported.character.identityKey }], reservations: [{ stableId: "other-hold", needId: "other-need", sourceIdentityKey: imported.character.identityKey, quantity: 2, status: "ACTIVE", createdAt: now, updatedAt: now }] });
    const dependent = store.createErpProject({ version: "classic-era", title: "Craft package", priority: 5, needs: [{ stableId: "shared", kind: "ITEM_REF", resourceKey: "item:159:0:0", label: "Crafting reserve", requiredQuantity: 9, sourceIdentityKey: imported.character.identityKey }], reservations: [{ stableId: "held", needId: "shared", sourceIdentityKey: imported.character.identityKey, quantity: 1, status: "ACTIVE", createdAt: now, updatedAt: now }], workOrders: [{ stableId: "craft-review", kind: "CRAFT", status: "PLANNED", title: "Review craft", resourceNeedIds: ["shared"], dependsOn: [], portfolioPrerequisites: [{ projectId: prerequisite.stableId, needId: "shared" }] }] });
    const projects = new DashboardReadModel(store).getErpProjects({ version: "classic-era" });
    const portfolio = buildErpPortfolioFulfillmentReview(projects, "classic-era");
    assert.equal(portfolio.totalPackageCount, 1);
    assert.equal(portfolio.totalStepCount, 2);
    assert.equal(portfolio.stepsNeedingReview, 1);
    const packageView = portfolio.packages[0]!;
    assert.deepEqual(packageView.steps.map((step) => [step.projectId, step.needId]), [[prerequisite.stableId, "shared"], [dependent.stableId, "shared"]], "the DAG is ordered prerequisite first even when the dependent project has higher priority");
    assert.equal(packageView.steps[0]?.reviewState, "OBSERVED_NEED_MET");
    assert.equal(packageView.steps[0]?.prerequisiteGate.state, "NO_PREREQUISITES");
    assert.equal(packageView.steps[1]?.reviewState, "WORK_ORDER_REVIEW");
    assert.equal(packageView.steps[1]?.prerequisiteGate.state, "CURRENT_OBSERVED_EVIDENCE_MET");
    assert.deepEqual(packageView.steps[1]?.prerequisiteGate.blockers, []);
    assert.equal(packageView.steps[1]?.projectReservationIntentQuantity, 1, "this project's recorded reservation intent remains explicit");
    assert.equal(packageView.steps[1]?.reservationAssessment?.activeQuantity, 3, "shared source/resource assessment includes the overlapping commitment from the other project");
    assert.equal(packageView.steps[1]?.reservationAssessment?.state, "WITHIN_OBSERVED_SUPPLY");
    assert.equal(packageView.steps[1]?.workOrders[0]?.readinessState, "OBSERVED_RESOURCE_SHORTFALL", "the prerequisite is currently met, so the dependent step's own source shortfall controls readiness");
    assert.equal(packageView.nextReviewStepId, `${dependent.stableId}/shared`);
    assert.equal(packageView.interpretation, "PLAYER_AUTHORED_SEQUENCE_AND_EVIDENCE_REVIEW_ONLY");
    assert.equal(buildErpPortfolioFulfillmentReview(projects, "forever").totalPackageCount, 0, "version-scoped portfolio cannot leak Classic Era plans into Forever");
    assert.equal(buildErpPortfolioFulfillmentReview(projects, "unknown-version").totalPackageCount, 0);
    assert.equal(buildErpPortfolioFulfillmentReview(projects, "classic-era").packages[0]?.stableId, packageView.stableId, "stable output is deterministic");
    const dangling = projects.map((entry) => entry.stableId === dependent.stableId ? { ...entry, workOrders: entry.workOrders.map((order) => ({ ...order, portfolioPrerequisites: [{ projectId: "deleted-project", needId: "missing-need" }] })) } : entry);
    const missing = buildErpPortfolioFulfillmentReview(dangling, "classic-era").packages[0]!.steps.find((step) => step.projectId === "deleted-project");
    assert.equal(missing?.reviewState, "MISSING_NEED");
    const dependentOnMissing = buildErpPortfolioFulfillmentReview(dangling, "classic-era").packages[0]!.steps.find((step) => step.projectId === dependent.stableId && step.needId === "shared");
    assert.equal(dependentOnMissing?.prerequisiteGate.state, "MISSING_PREREQUISITE");
    assert.equal(missing?.requiredQuantity, undefined, "a dangling evidence link is UNKNOWN, not a fabricated zero requirement");
    assert.equal(missing?.projectReservationIntentQuantity, undefined, "a missing need does not claim zero project reservations");
    assert.equal(missing?.reservationAssessment, undefined, "a missing need does not claim zero source-scope commitments");
    assert.equal(dependent.version, "classic-era");
  } finally { store.close(); }
});
