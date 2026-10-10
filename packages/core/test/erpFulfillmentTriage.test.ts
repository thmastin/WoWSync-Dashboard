import assert from "node:assert/strict";
import { test } from "node:test";
import { buildWowSyncExport } from "./fixtureBuilder.ts";
import { SqliteSnapshotStore } from "../src/sqliteStore.ts";
import { DashboardReadModel } from "../src/readModel.ts";
import { buildErpFulfillmentTriage, buildErpNeedReviewSnapshot, buildErpPortfolioFulfillmentReview, buildErpSourceFulfillmentReview, buildErpPortfolioNextActionReview } from "../src/erpFulfillmentTriage.ts";

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
    const nextActions = buildErpPortfolioNextActionReview(views, "classic-era");
    const stoneAction = nextActions.items.find((entry) => entry.resource?.resourceKey === "item:159:0:0");
    assert.equal(stoneAction?.action, "REVIEW_RESERVATIONS", "shared source review determines the next step when competing commitments need review");
    assert.equal(stoneAction?.source?.identityKey, first.character.identityKey);
    assert.deepEqual(stoneAction?.signals, ["CHANGED_OBSERVATION", "OPEN_WORK_ORDER", "RESERVATION_REVIEW"]);
    assert.equal(stoneAction?.needReferences.length, 1);
    const clothAction = nextActions.items.find((entry) => entry.resource?.resourceKey === "2589");
    assert.equal(clothAction?.action, "REVIEW_UNSCOPED_ITEM");
    assert.equal(clothAction?.source, undefined, "a missing selected source remains UNKNOWN and is not grouped");
    assert.equal(clothAction?.needReferences[0]?.freshness, "unknown");
    assert.equal(buildErpPortfolioNextActionReview(views, "forever").totalCount, 0, "the portfolio queue is version isolated");
    assert.equal(buildErpPortfolioNextActionReview(views, "classic-era", 1).truncated, true);
  } finally { store.close(); }
});

test("portfolio next actions aggregate only an exact selected source and exact resource across projects", () => {
  const store = new SqliteSnapshotStore(":memory:");
  const now = Math.floor(Date.now() / 1000) - 200;
  try {
    const imported = store.importSnapshot(buildWowSyncExport({ generatedAt: now, character: { name: "Multi Need", realm: "Realm A", clientVersion: "1.15.7", clientBuild: "60927" }, bags: { containers: [{ id: 0, capacity: 16, items: [{ itemRef: "item:159:0:0", name: "Fixture Stone", qty: 3 }] }] }, bank: { containers: [] } }));
    const needs = ["crafting", "provisioning"].map((title, index) => store.createErpProject({ version: "classic-era", title, priority: 5 - index, needs: [{ stableId: `need-${index}`, kind: "ITEM_REF", resourceKey: "item:159:0:0", label: "Fixture Stone", requiredQuantity: index + 2, sourceIdentityKey: imported.character.identityKey }] }));
    const projects = new DashboardReadModel(store).getErpProjects({ version: "classic-era" });
    const review = buildErpPortfolioNextActionReview(projects, "classic-era");
    const shared = review.items.find((entry) => entry.resource?.resourceKey === "item:159:0:0");
    assert.equal(review.totalCount, 1);
    assert.equal(shared?.source?.identityKey, imported.character.identityKey);
    assert.deepEqual(shared?.needReferences.map((entry) => entry.projectId).sort(), needs.map((entry) => entry.stableId).sort());
    assert.deepEqual(shared?.needReferences.map((entry) => entry.freshness), ["recent", "recent"]);
    assert.equal(shared?.action, "REVIEW_SOURCE_AND_ACCESS", "shortfall still requires source/access review before selecting a player task");
    assert.match(shared?.reason ?? "", /accessible|allocated|resolved/i);
  } finally { store.close(); }
});

test("portfolio next actions retain high-volume totals and disclose the returned-row cap", () => {
  const store = new SqliteSnapshotStore(":memory:");
  const now = Math.floor(Date.now() / 1000) - 200;
  try {
    const imported = store.importSnapshot(buildWowSyncExport({ generatedAt: now, character: { name: "Portfolio Queue", realm: "Realm A", clientVersion: "1.15.7", clientBuild: "60927" }, bags: { containers: [{ id: 0, capacity: 16, items: [] }] }, bank: { containers: [{ id: -1, capacity: 28, items: [{ itemRef: "item:159:0:0", name: "Fixture Stone", qty: 5 }] }] } }));
    for (let index = 0; index < 205; index++) store.createErpProject({ version: "classic-era", title: `Need ${index}`, needs: [{ stableId: `need-${index}`, kind: index === 204 ? "ITEM_REF" : "ITEM_ID", resourceKey: index === 204 ? "item:159:0:0" : String(990000 + index), label: `Resource ${index}`, requiredQuantity: index === 204 ? 5 : 1, sourceIdentityKey: imported.character.identityKey }] });
    const projects = new DashboardReadModel(store).getErpProjects({ version: "classic-era" });
    const review = buildErpPortfolioNextActionReview(projects, "classic-era", 50);
    assert.equal(review.totalCount, 205);
    assert.equal(review.returnedCount, 50);
    assert.equal(review.truncated, true);
    assert.equal(review.sourceReviewTruncated, false);
    assert.equal(review.triageTruncated, false);
    assert.equal(Object.values(review.counts).reduce((sum, count) => sum + count, 0), 205);
    const bankTriage = buildErpFulfillmentTriage(projects, "classic-era", 10_000).items.find((entry) => entry.need?.stableId === "need-204");
    assert.ok(bankTriage?.signals.includes("UNWORKED_REQUIREMENT"), "the retrieval pathway beyond the first 200 source groups still reaches triage and portfolio review");
  } finally { store.close(); }
});

test("portfolio next actions preserve explicitly recorded but ungroupable source references", () => {
  const store = new SqliteSnapshotStore(":memory:");
  const now = Math.floor(Date.now() / 1000) - 200;
  try {
    store.importSnapshot(buildWowSyncExport({ generatedAt: now, character: { name: "Scope Review", realm: "Realm A", clientVersion: "1.15.7", clientBuild: "60927" }, bags: { containers: [] }, bank: { containers: [] } }));
    store.createErpProject({ version: "classic-era", title: "Conflicting source scope", needs: [{ stableId: "need", kind: "ITEM_ID", resourceKey: "991001", label: "Scope check", requiredQuantity: 1 }] });
    const projects = new DashboardReadModel(store).getErpProjects({ version: "classic-era" });
    const contradictory = projects.map((project) => ({ ...project, needs: project.needs.map((need) => ({ ...need, sourceIdentityKey: "retail::realm::character", sourceOwnerKey: "guild:unknown" })) }));
    const row = buildErpPortfolioNextActionReview(contradictory, "classic-era").items[0]!;
    assert.equal(row.source, undefined);
    assert.equal(row.recordedSourceIdentity, "retail::realm::character");
    assert.deepEqual(row.recordedSourceScope, { sourceIdentityKey: "retail::realm::character", sourceOwnerKey: "guild:unknown" });
    assert.equal(row.sourceScopeIssue, "CONFLICTING_SOURCE_FIELDS");
    assert.match(row.reason, /conflicting or incompatible/i);
    assert.doesNotMatch(row.reason, /No source identity was recorded/);
  } finally { store.close(); }
});

test("portfolio fulfillment review orders prerequisite evidence first and preserves unknowns, reservations, and version isolation", () => {
  const store = new SqliteSnapshotStore(":memory:");
  const now = Math.floor(Date.now() / 1000) - 200;
  try {
    const imported = store.importSnapshot(buildWowSyncExport({ generatedAt: now, character: { name: "Portfolio Crafter", realm: "Realm A", clientVersion: "1.15.7", clientBuild: "60927" }, bags: { containers: [{ id: 0, capacity: 16, items: [{ itemRef: "item:159:0:0", name: "Fixture Stone", qty: 5 }] }] }, bank: { containers: [] } }));
    const alternate = store.importSnapshot(buildWowSyncExport({ generatedAt: now, character: { name: "Alternate Crafter", realm: "Realm A", clientVersion: "1.15.7", clientBuild: "60927" }, bags: { containers: [{ id: 0, capacity: 16, items: [{ itemRef: "item:159:0:0", name: "Fixture Stone", qty: 5 }] }] }, bank: { containers: [] } }));
    const prerequisite = store.createErpProject({ version: "classic-era", title: "Gather ingredients", priority: 4, needs: [{ stableId: "shared", kind: "ITEM_REF", resourceKey: "item:159:0:0", label: "Stone supply", requiredQuantity: 5, sourceIdentityKey: imported.character.identityKey, destinationIdentityKey: imported.character.identityKey }], reservations: [{ stableId: "alternate-source-hold", needId: "shared", sourceIdentityKey: alternate.character.identityKey, quantity: 5, status: "ACTIVE", createdAt: now, updatedAt: now }], workOrders: [{ stableId: "alternate-provision", kind: "PROVISION", status: "PLANNED", title: "Review alternate source", resourceNeedIds: ["shared"], sourceIdentityKey: alternate.character.identityKey, destinationIdentityKey: imported.character.identityKey, dependsOn: [] }] });
    const competing = store.createErpProject({ version: "classic-era", title: "Competing provision plan", priority: 3, needs: [{ stableId: "other-need", kind: "ITEM_REF", resourceKey: "item:159:0:0", label: "Other stone commitment", requiredQuantity: 2, sourceIdentityKey: imported.character.identityKey }], reservations: [{ stableId: "other-hold", needId: "other-need", sourceIdentityKey: imported.character.identityKey, quantity: 2, status: "ACTIVE", createdAt: now, updatedAt: now }] });
    const dependent = store.createErpProject({ version: "classic-era", title: "Craft package", priority: 5, needs: [{ stableId: "shared", kind: "ITEM_REF", resourceKey: "item:159:0:0", label: "Crafting reserve", requiredQuantity: 9, sourceIdentityKey: imported.character.identityKey }], reservations: [{ stableId: "held", needId: "shared", sourceIdentityKey: imported.character.identityKey, quantity: 1, status: "ACTIVE", createdAt: now, updatedAt: now }], workOrders: [{ stableId: "craft-review", kind: "CRAFT", status: "PLANNED", title: "Review craft", resourceNeedIds: ["shared"], dependsOn: [], portfolioPrerequisites: [{ projectId: prerequisite.stableId, needId: "shared" }] }] });
    const projects = new DashboardReadModel(store).getErpProjects({ version: "classic-era" });
    const portfolio = buildErpPortfolioFulfillmentReview(projects, "classic-era");
    assert.equal(portfolio.totalPackageCount, 1);
    assert.equal(portfolio.totalStepCount, 2);
    assert.equal(portfolio.stepsNeedingReview, 2, "the source need is reviewable because cross-project reservations leave less uncommitted stock than its requirement");
    const packageView = portfolio.packages[0]!;
    assert.deepEqual(packageView.steps.map((step) => [step.projectId, step.needId]), [[prerequisite.stableId, "shared"], [dependent.stableId, "shared"]], "the DAG is ordered prerequisite first even when the dependent project has higher priority");
    assert.equal(packageView.steps[0]?.reviewState, "RESERVATION_REVIEW", "raw observed coverage does not hide competing reservations that leave an insufficient available lower bound");
    assert.equal(packageView.steps[0]?.projectReservationIntentQuantity, 5, "the alternate-source reservation remains visible as intent attached to this need");
    assert.equal(packageView.steps[0]?.prerequisiteGate.state, "NO_PREREQUISITES");
    assert.equal(packageView.steps[1]?.reviewState, "WORK_ORDER_REVIEW");
    assert.equal(packageView.steps[1]?.prerequisiteGate.state, "PREREQUISITE_EVIDENCE_REVIEW");
    assert.equal(packageView.steps[1]?.prerequisiteGate.blockers[0]?.reservationState, "WITHIN_OBSERVED_SUPPLY");
    assert.equal(packageView.steps[1]?.prerequisiteGate.blockers[0]?.availableObservedLowerBound, 2);
    assert.match(packageView.steps[1]?.prerequisiteGate.blockers[0]?.reason ?? "", /competing reservations/);
    assert.equal(packageView.steps[1]?.projectReservationIntentQuantity, 1, "this project's recorded reservation intent remains explicit");
    assert.equal(packageView.steps[1]?.reservationAssessment?.activeQuantity, 3, "shared source/resource assessment includes the overlapping commitment from the other project");
    assert.equal(packageView.steps[1]?.reservationAssessment?.state, "WITHIN_OBSERVED_SUPPLY");
    const sourcePathways = buildErpSourceFulfillmentReview(projects, "classic-era").sources.flatMap((source) => source.needs).find((need) => need.projectId === prerequisite.stableId && need.needId === "shared")?.fulfillmentPathways;
    assert.deepEqual(packageView.steps[0]?.fulfillmentPathways, sourcePathways, "dependency-first package embeds the exact pathway review derived for the same need, without recomputing or strengthening it");
    assert.equal(packageView.steps[0]?.projectStatus, "ACTIVE");

    const reservationUnknownProjects = projects.map((entry) => ({ ...entry, needEvidence: entry.needEvidence.map((evidence) => { const { reservationAssessment: _reservationAssessment, ...withoutAssessment } = evidence; return withoutAssessment; }) }));
    const reservationUnknownPortfolio = buildErpPortfolioFulfillmentReview(reservationUnknownProjects, "classic-era").packages[0]!;
    assert.equal(reservationUnknownPortfolio.steps[0]?.fulfillmentPathways?.state, "EVIDENCE_REVIEW_REQUIRED", "a missing reservation assessment is UNKNOWN rather than proof that observed stock is unreserved");
    assert.equal(reservationUnknownPortfolio.steps[1]?.prerequisiteGate.state, "PREREQUISITE_EVIDENCE_REVIEW", "a dependent task cannot pass a prerequisite gate without reservation assessment evidence");

    assert.equal(packageView.steps[0]?.fulfillmentPathways?.state, "EVIDENCE_REVIEW_REQUIRED", "source pathway does not claim available coverage when the reservations leave an inadequate lower bound");
    assert.equal(packageView.steps[1]?.workOrders[0]?.readinessState, "OBSERVED_RESOURCE_SHORTFALL", "the prerequisite is currently met, so the dependent step's own source shortfall controls readiness");
    assert.equal(packageView.nextReviewStepId, `${prerequisite.stableId}/shared`, "the next review points to the upstream reservation conflict");
    assert.equal(packageView.interpretation, "PLAYER_AUTHORED_SEQUENCE_AND_EVIDENCE_REVIEW_ONLY");
    assert.equal(portfolio.pathwayReviewTruncated, false);
    assert.equal(buildErpPortfolioFulfillmentReview(projects, "forever").totalPackageCount, 0, "version-scoped portfolio cannot leak Classic Era plans into Forever");
    assert.equal(buildErpPortfolioFulfillmentReview(projects, "unknown-version").totalPackageCount, 0);
    assert.equal(buildErpPortfolioFulfillmentReview(projects, "classic-era").packages[0]?.stableId, packageView.stableId, "stable output is deterministic");
    const competingNow = store.getErpProject(competing.stableId); const dependentNow = store.getErpProject(dependent.stableId);
    assert.ok(competingNow && dependentNow);
    store.updateErpProject({ ...competingNow, reservations: competingNow.reservations.map((reservation) => ({ ...reservation, status: "RELEASED" as const })) }, competingNow.revision);
    store.updateErpProject({ ...dependentNow, reservations: dependentNow.reservations.map((reservation) => ({ ...reservation, status: "RELEASED" as const })) }, dependentNow.revision);
    const replanned = buildErpPortfolioFulfillmentReview(new DashboardReadModel(store).getErpProjects({ version: "classic-era" }), "classic-era").packages[0]!;
    assert.equal(replanned.steps[0]?.reviewState, "WORK_ORDER_REVIEW", "the open alternate-source provisioning order remains reviewable after the source conflict is resolved");
    assert.equal(replanned.steps[0]?.fulfillmentPathways?.state, "CURRENT_SOURCE_COVERAGE", "after the source-A conflict is released, only source-A coverage is reevaluated and the separate source-B order remains manual work");
    assert.match(replanned.steps[0]?.reason ?? "", /after accounting for this need's explicit reservation intent/, "a reservation at another source is not added to the selected source's observed lower bound");
    assert.equal(replanned.steps[1]?.prerequisiteGate.state, "CURRENT_OBSERVED_EVIDENCE_MET", "the downstream evidence gate recovers from current source evidence after the conflict is resolved");
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

test("source fulfillment review joins exact source/resource needs, reservations, and paired craft/provision evidence without selecting a route", () => {
  const store = new SqliteSnapshotStore(":memory:");
  const now = Math.floor(Date.now() / 1000) - 200;
  const makeExport = (at: number, characterName: string) => buildWowSyncExport({ generatedAt: at, character: { name: characterName, realm: "Source Realm", clientVersion: "1.15.7", clientBuild: "60927" }, bags: { containers: [{ id: 0, capacity: 16, items: [{ itemRef: "item:159:0:0", name: "Fixture Stone", qty: 5 }, { itemRef: "item:159:0:1", name: "Fixture Stone variant", qty: 2 }] }] }, bank: { containers: [] } });
  try {
    const source = store.importSnapshot(makeExport(now, "Crafter"));
    store.importSnapshot(makeExport(now + 20, "Crafter"));
    const otherSource = store.importSnapshot(makeExport(now + 20, "Alt Crafter"));
    const recipient = store.importSnapshot(buildWowSyncExport({ generatedAt: now + 20, character: { name: "Recipient", realm: "Source Realm", clientVersion: "1.15.7", clientBuild: "60927" }, bags: { containers: [{ id: 0, capacity: 16, items: [] }] }, bank: { containers: [] } }));
    store.createErpProject({ version: "classic-era", title: "Craft and provision", priority: 5, needs: [
      { stableId: "stone-input", kind: "ITEM_REF", resourceKey: "item:159:0:0", label: "Exact stone input", requiredQuantity: 3, sourceIdentityKey: source.character.identityKey, destinationIdentityKey: recipient.character.identityKey },
      { stableId: "variant-input", kind: "ITEM_REF", resourceKey: "item:159:0:1", label: "Distinct variant", requiredQuantity: 1, sourceIdentityKey: source.character.identityKey },
    ], reservations: [{ stableId: "stone-hold", needId: "stone-input", sourceIdentityKey: source.character.identityKey, quantity: 1, status: "ACTIVE", createdAt: now, updatedAt: now + 20 }], workOrders: [
      { stableId: "craft-stone", kind: "CRAFT", status: "PLANNED", title: "Review craft inputs", assignedIdentityKey: source.character.identityKey, sourceIdentityKey: source.character.identityKey, destinationIdentityKey: recipient.character.identityKey, resourceNeedIds: ["stone-input"], dependsOn: [], plannedOutput: { kind: "ITEM_REF", resourceKey: "item:200:0:0", label: "Planned result", quantity: 1 } },
      { stableId: "provision-stone", kind: "PROVISION", status: "IN_PROGRESS", title: "Review provision pair", sourceIdentityKey: otherSource.character.identityKey, destinationIdentityKey: recipient.character.identityKey, resourceNeedIds: ["stone-input"], dependsOn: [] },
    ] });
    store.createErpProject({ version: "classic-era", status: "PAUSED", title: "Separate source plan", priority: 2, needs: [{ stableId: "same-resource", kind: "ITEM_REF", resourceKey: "item:159:0:0", label: "Another need", requiredQuantity: 8, sourceIdentityKey: source.character.identityKey }] });
    store.createErpProject({ version: "classic-era", title: "Different character source", priority: 2, needs: [{ stableId: "other-source-need", kind: "ITEM_REF", resourceKey: "item:159:0:0", label: "Other crafter", requiredQuantity: 1, sourceIdentityKey: otherSource.character.identityKey }] });
    const projects = new DashboardReadModel(store).getErpProjects({ version: "classic-era" });
    const review = buildErpSourceFulfillmentReview(projects, "classic-era");
    const exactSource = review.sources.find((entry) => entry.sourceIdentityKey === source.character.identityKey && entry.resourceKey === "item:159:0:0");
    assert.ok(exactSource);
    assert.equal(exactSource.needs.length, 2, "only exact source + kind + resource needs are grouped across active and paused projects");
    assert.equal(exactSource.projectCount, 2);
    assert.equal(exactSource.alternativeLocationReview, "POTENTIAL_LOCATIONS_SCAN_INCOMPLETE", "candidate leads remain visible while one missing per-need scan keeps the grouped location review explicitly incomplete");
    assert.ok(exactSource.alternativeLocations.every((location) => location.sourceIdentityKey !== source.character.identityKey && location.accountMembership === "UNKNOWN" && location.access === "UNKNOWN" && location.transferability === "UNKNOWN"), "returned alternatives exclude the selected source and never imply membership, access, or a route");
    const plannedAlternative = exactSource.alternativeLocations.find((location) => location.sourceIdentityKey === otherSource.character.identityKey)!;
    assert.equal(plannedAlternative.selectedProvisioningPlanCount, 1, "an exact alternative source with an open selected-source plan is surfaced beside its current location evidence");
    assert.deepEqual(plannedAlternative.selectedProvisioningPlans.map((order) => [order.projectId, order.needId, order.workOrderId, order.destinationIdentityKey]), [[review.sources.find((entry) => entry.resourceKey === "item:159:0:0")?.needs.find((need) => need.needId === "stone-input")?.projectId, "stone-input", "provision-stone", recipient.character.identityKey]]);
    assert.equal(review.openProvisioningPlanCount, 1, "the root count reports open manual plans without treating them as reservations");
    assert.ok(exactSource.needs.some((need) => need.projectStatus === "PAUSED"));
    assert.equal(exactSource.needs[0]?.reservationAssessment?.activeQuantity, 1, "reservation intent stays on the related need");
    const craft = exactSource.needs.flatMap((need) => need.workOrders).find((order) => order.stableId === "craft-stone");
    const provision = exactSource.needs.flatMap((need) => need.workOrders).find((order) => order.stableId === "provision-stone");
    assert.ok(craft);
    assert.ok(provision);
    assert.ok(craft.observationStates.includes("UNCHANGED"), "paired crafter input observations flow into the source review without claiming consumption or output");
    assert.ok(provision.observationStates.includes("NO_COMPARABLE_CHANGE") || provision.observationStates.includes("EVIDENCE_UNKNOWN"), "provisioning pair remains its existing qualified review");
    assert.equal(exactSource.needs[0]?.sourceSections.some((section) => section.section === "bags"), true);
    assert.equal(exactSource.nextReview, "REVIEW_MANUAL_WORK", "task readiness is surfaced before route assessment");
    assert.match(exactSource.reason, /Inspect its readiness/);
    assert.equal(review.sources.filter((entry) => entry.sourceIdentityKey === source.character.identityKey && entry.kind === "ITEM_REF").length, 2, "itemString variants stay in distinct source groups");
    assert.ok(!exactSource.needs.some((need) => need.needId === "other-source-need"), "a different source character is never combined into this source row");
    assert.ok(review.sources.some((entry) => entry.sourceIdentityKey === otherSource.character.identityKey && entry.needs.some((need) => need.needId === "other-source-need")), "the other character retains its own separate source row");
    assert.equal(review.totalNeedCount, 4);
    assert.equal(review.interpretation, "EXPLICIT_SOURCE_SCOPE_AND_MANUAL_REVIEW_ONLY");
    const zeroRoster = projects.map((project) => ({ ...project, resourceSourceScreens: project.resourceSourceScreens.map((screen) => screen.needId === "stone-input" ? { ...screen, scannedCharacterCount: 0, unresolvedCharacterCount: 0, candidateCount: 0, candidates: [] } : screen) }));
    const zeroRosterGroup = buildErpSourceFulfillmentReview(zeroRoster, "classic-era").sources.find((entry) => entry.sourceIdentityKey === source.character.identityKey && entry.resourceKey === "item:159:0:0");
    assert.equal(zeroRosterGroup?.alternativeLocationReview, "NO_OTHER_CHARACTERS_TO_SCAN", "an empty roster scan does not claim a clean negative match");
    const partialRoster = projects.map((project) => ({ ...project, resourceSourceScreens: project.resourceSourceScreens.map((screen) => screen.needId === "stone-input" ? { ...screen, scannedCharacterCount: 1, unresolvedCharacterCount: 1, candidateCount: 1, candidates: [{ sourceIdentityKey: otherSource.character.identityKey, sourceName: "Alt Crafter", sourceRealm: "Source Realm", needId: "stone-input", kind: "ITEM_REF" as const, resourceKey: "item:159:0:0", state: "OBSERVED" as const, observedQuantity: 5, activeReservationQuantity: 0, reservationState: "UNRESERVED" as const, freshness: "recent" as const, observedAt: now + 20, locations: [{ section: "bags" as const, state: "OBSERVED" as const, observedAt: now + 20, completeness: "complete", quantity: 5 }], matchingItems: [{ itemRef: "item:159:0:0", section: "bags" as const, state: "OBSERVED" as const, quantity: 5, observedAt: now + 20 }], unresolvedSections: [], accountMembership: "UNKNOWN" as const, access: "UNKNOWN" as const, transferability: "UNKNOWN" as const, reason: "Observed source lead only." }] } : screen) }));
    const partialRosterReview = buildErpSourceFulfillmentReview(partialRoster, "classic-era");
    const partialRosterGroup = partialRosterReview.sources.find((entry) => entry.sourceIdentityKey === source.character.identityKey && entry.resourceKey === "item:159:0:0");
    assert.equal(partialRosterGroup?.alternativeLocationReview, "POTENTIAL_LOCATIONS_SCAN_INCOMPLETE", "found leads remain qualified when some characters could not be resolved");
    assert.equal(partialRosterGroup?.alternativeLocations[0]?.sourceIdentityKey, otherSource.character.identityKey, "the matching lead remains visible during incomplete scanning");
    assert.ok(partialRosterReview.groupsWithIncompleteSourceScan >= 1, "the summary counts incomplete scans even when a lead was found");
    assert.equal(buildErpSourceFulfillmentReview(projects, "tbc-anniversary").sources.length, 0, "version filtering prevents cross-version project leakage");
    assert.equal(buildErpSourceFulfillmentReview(projects, "unknown-version").totalSourceCount, 0);
    assert.equal(buildErpSourceFulfillmentReview(projects, "classic-era", 1).truncated, true);
  } finally { store.close(); }
});

test("per-need fulfillment pathways distinguish observed bank retrieval, player plans, location leads, and incomplete evidence", () => {
  const store = new SqliteSnapshotStore(":memory:");
  const now = Math.floor(Date.now() / 1000) - 200;
  const make = (name: string, at: number, bagCount: number, bankCount: number, partialBank = false) => buildWowSyncExport({
    generatedAt: at,
    character: { name, realm: "Pathway Realm", clientVersion: "1.15.7", clientBuild: "60927" },
    bags: { containers: [{ id: 0, capacity: 16, items: bagCount ? [{ itemRef: "item:159:0:0", name: "Fixture Stone", qty: bagCount }] : [] }] },
    bank: { containers: [{ id: -1, capacity: 28, items: bankCount ? [{ itemRef: "item:159:0:0", name: "Fixture Stone", qty: bankCount }] : [] }], partial: partialBank },
  });
  try {
    const source = store.importSnapshot(make("Pathway Crafter", now, 1, 5));
    store.importSnapshot(make("Pathway Alternate", now + 10, 2, 0));
    const destination = store.importSnapshot(buildWowSyncExport({ generatedAt: now + 10, character: { name: "Pathway Recipient", realm: "Pathway Realm", clientVersion: "1.15.7", clientBuild: "60927" }, bags: { containers: [{ id: 0, capacity: 16, items: [] }] }, bank: { containers: [] } }));
    const created = store.createErpProject({ version: "classic-era", title: "Pathway review", needs: [{ stableId: "exact-stone", kind: "ITEM_REF", resourceKey: "item:159:0:0", label: "Exact stone", requiredQuantity: 4, sourceIdentityKey: source.character.identityKey, destinationIdentityKey: destination.character.identityKey }], reservations: [], workOrders: [{ stableId: "craft-plan", kind: "CRAFT", status: "PLANNED", title: "Player-declared craft review", resourceNeedIds: ["exact-stone"], assignedIdentityKey: source.character.identityKey, dependsOn: [] }] });
    assert.ok(created);
    const projects = new DashboardReadModel(store).getErpProjects({ version: "classic-era" });
    const review = buildErpSourceFulfillmentReview(projects, "classic-era");
    const need = review.sources.flatMap((line) => line.needs).find((entry) => entry.needId === "exact-stone")!;
    assert.equal(need.fulfillmentPathways.state, "CURRENT_SOURCE_COVERAGE", "selected-source coverage is distinct from delivery to the separate recipient");
    assert.match(need.fulfillmentPathways.reason, /does not mean a different destination has received/);
    const retrieval = need.fulfillmentPathways.options.find((option) => option.kind === "REVIEW_PERSONAL_BANK_RETRIEVAL");
    assert.deepEqual(retrieval?.observedLocation, { section: "character bank", quantity: 5, observedAt: now, itemRef: "item:159:0:0" }, "retrieval option preserves exact variant and section timestamp");
    assert.ok(need.fulfillmentPathways.options.some((option) => option.kind === "FOLLOW_EXISTING_MANUAL_PLAN" && option.workOrderIds?.includes("craft-plan")), "an existing player-declared craft task is shown independently");
    const alternate = need.fulfillmentPathways.options.find((option) => option.kind === "INVESTIGATE_OTHER_CHARACTER_LOCATION");
    const alternateLocation = alternate?.candidateLocations?.find((location) => location.characterName === "Pathway Alternate");
    assert.equal(alternateLocation?.provenance, "OBSERVED", "a current location lead retains observed provenance");
    assert.equal(alternateLocation?.freshness, "recent");
    assert.equal(alternateLocation?.observedAt, now + 10);
    assert.match(alternate!.reason, /does not establish account membership, ownership, access|None of these leads establishes account membership, ownership, access/);

    const staleAt = now - 8 * 24 * 60 * 60;
    const historicalViews = projects.map((project) => ({ ...project, resourceSourceScreens: project.resourceSourceScreens.map((screen) => screen.needId === "exact-stone" ? { ...screen, candidates: [...screen.candidates, { ...screen.candidates[0]!, sourceIdentityKey: "classic-era::pathway realm::historical alternate", sourceName: "Historical Alternate", sourceRealm: "Pathway Realm", state: "LAST_SEEN" as const, freshness: "stale" as const, observedAt: staleAt }] } : screen) }));
    const historicalNeed = buildErpSourceFulfillmentReview(historicalViews, "classic-era").sources.flatMap((line) => line.needs).find((entry) => entry.needId === "exact-stone")!;
    const historicalLead = historicalNeed.fulfillmentPathways.options.find((option) => option.kind === "INVESTIGATE_OTHER_CHARACTER_LOCATION")?.candidateLocations?.find((location) => location.characterName === "Historical Alternate");
    assert.equal(historicalLead?.provenance, "LAST_SEEN", "a location whose source is only historical stays LAST_SEEN");
    assert.equal(historicalLead?.freshness, "stale");
    assert.equal(historicalLead?.observedAt, staleAt);

    const sharedOwnerProjects = projects.map((project) => ({
      ...project,
      needs: project.needs.map((entry) => entry.stableId === "exact-stone" ? { ...entry, sourceIdentityKey: undefined, sourceOwnerKey: "owner:fixture-bank" } : entry),
      needEvidence: project.needEvidence.map((entry) => entry.needId === "exact-stone" ? { ...entry, state: "COVERED_BY_OBSERVED" as const, freshness: "recent" as const, observedQuantity: 5, unresolvedSections: [], unknownQuantityRowCount: 0 } : entry),
      resourceSourceScreens: [],
    }));
    const ownerNeed = buildErpSourceFulfillmentReview(sharedOwnerProjects, "classic-era").sources.flatMap((line) => line.needs).find((entry) => entry.needId === "exact-stone")!;
    assert.equal(ownerNeed.fulfillmentPathways.state, "CURRENT_SOURCE_COVERAGE", "shared-owner quantity is labeled as source coverage, not destination fulfillment");
    assert.match(ownerNeed.fulfillmentPathways.reason, /does not mean a different destination has received/);

    store.importSnapshot(make("Pathway Crafter", now + 20, 1, 5, true));
    const partialViews = new DashboardReadModel(store).getErpProjects({ version: "classic-era" });
    const partialNeed = buildErpSourceFulfillmentReview(partialViews, "classic-era").sources.flatMap((line) => line.needs).find((entry) => entry.needId === "exact-stone")!;
    assert.equal(partialNeed.fulfillmentPathways.state, "EVIDENCE_REVIEW_REQUIRED", "partial storage evidence cannot produce a definite path");
    assert.equal(partialNeed.fulfillmentPathways.options.some((option) => option.kind === "REVIEW_PERSONAL_BANK_RETRIEVAL"), false, "partial bank data is not presented as a usable retrieval pathway");
    assert.ok(partialNeed.fulfillmentPathways.options.some((option) => option.kind === "REFRESH_OR_CLARIFY_EVIDENCE" && option.provenance === "UNKNOWN"));
    assert.equal(buildErpSourceFulfillmentReview(partialViews, "forever").totalNeedCount, 0, "pathways remain version isolated");
  } finally { store.close(); }
});
