import assert from "node:assert/strict";
import { test } from "node:test";
import type { ErpProjectView } from "@wowsync-dashboard/core";
import { buildFulfillmentReviewWorkOrder } from "../src/components/erpFulfillmentReview.ts";

const view = (overrides: Partial<ErpProjectView> = {}) => ({
  stableId: "project-a", version: "forever", title: "Provision two characters", status: "ACTIVE", priority: 3,
  createdAt: 100, updatedAt: 200, revision: 1,
  needs: [
    { stableId: "ore", kind: "ITEM_REF", resourceKey: "item:2770:0:0:0:0:0:0:0", label: "Copper Ore", requiredQuantity: 8, sourceIdentityKey: "forever::realm::miner" },
    { stableId: "herb", kind: "ITEM_ID", resourceKey: "2447", label: "Peacebloom", requiredQuantity: 4 },
  ], reservations: [], workOrders: [],
  needEvidence: [
    { needId: "ore", state: "SHORTFALL_OBSERVED", sourceIdentityKey: "forever::realm::miner", observedQuantity: 3, requiredQuantity: 8, observedAt: 190, freshness: "recent", sourceSections: [], unresolvedSections: [], unknownQuantityRowCount: 0, reservationAssessment: { state: "UNRESERVED", activeQuantity: 0, availableObservedLowerBound: 3, reason: "3 unreserved observed" }, reason: "Observed 3 against 8 required." },
    { needId: "herb", state: "UNKNOWN", requiredQuantity: 4, freshness: "unknown", sourceSections: [], unresolvedSections: ["bags"], unknownQuantityRowCount: 0, reason: "No explicit source was selected." },
  ],
  resourceSourceScreens: [], workOrderReadiness: [], workOrderProgress: [], reservationReview: [],
  fulfillment: { state: "EVIDENCE_REVIEW_REQUIRED", projectStatus: "ACTIVE", requirementCount: 2, currentObservedCoverageCount: 0, currentObservedShortfallCount: 1, historicalOrStaleEvidenceCount: 0, unresolvedEvidenceCount: 1, activeWorkOrderCount: 0, reservationReviewStates: {}, changedObservationCauseUnknownCount: 0, interpretation: "OBSERVATIONS_AND_PLAN_SUMMARY_ONLY", reason: "review" },
  history: [], historyEventCount: 0, historyTruncated: false,
  ...overrides,
}) as unknown as ErpProjectView;

test("grouped fulfillment review preserves each linked need's evidence and explicit unknowns", () => {
  const order = buildFulfillmentReviewWorkOrder(view(), { stableId: "review-1", needIds: ["ore", "herb", "ore"], recordedAt: 200, assignedIdentityKey: "forever::realm::miner" });
  assert.equal(order.kind, "INVESTIGATE");
  assert.equal(order.status, "PLANNED");
  assert.deepEqual(order.resourceNeedIds, ["ore", "herb"]);
  assert.match(order.instructions ?? "", /ore — Copper Ore \(ITEM_REF, need 8\)/);
  assert.match(order.instructions ?? "", /SHORTFALL_OBSERVED\/recent, evidence timestamp 1970-01-01T00:03:10\.000Z; 3 observed; 0 reserved, at least 3 unreserved observed/);
  assert.match(order.instructions ?? "", /UNKNOWN\/unknown, evidence time UNKNOWN; observed quantity UNKNOWN; reservation state UNKNOWN/);
  assert.match(order.instructions ?? "", /summary was generated 1970-01-01T00:03:20\.000Z; its freshness does not update/);
  assert.match(order.instructions ?? "", /does not reserve or move resources/);
});

test("grouped fulfillment review rejects stale selection, existing open work, wrong-version assignment, and oversized batches", () => {
  assert.throws(() => buildFulfillmentReviewWorkOrder(view(), { stableId: "x", needIds: ["ore"], recordedAt: 200 }), /at least two/);
  assert.throws(() => buildFulfillmentReviewWorkOrder(view(), { stableId: "x", needIds: ["ore", "missing"], recordedAt: 200 }), /no longer exists/);
  const open = { stableId: "existing", kind: "INVESTIGATE", status: "PLANNED", title: "Existing", resourceNeedIds: ["ore"], dependsOn: [] } as const;
  assert.throws(() => buildFulfillmentReviewWorkOrder(view({ workOrders: [open] }), { stableId: "x", needIds: ["ore", "herb"], recordedAt: 200 }), /already has an open work order/);
  assert.throws(() => buildFulfillmentReviewWorkOrder(view(), { stableId: "x", needIds: ["ore", "herb"], recordedAt: 200, assignedIdentityKey: "retail::realm::character" }), /game version/);
  const many = Array.from({ length: 5 }, (_, index) => `need-${index}`);
  const manyView = view({ needs: many.map((stableId) => ({ stableId, kind: "ITEM_ID", resourceKey: "1", label: stableId, requiredQuantity: 1 })) as ErpProjectView["needs"] });
  assert.throws(() => buildFulfillmentReviewWorkOrder(manyView, { stableId: "x", needIds: many, recordedAt: 200 }), /at most 4/);
});

test("grouped fulfillment review only accepts open same-project dependencies", () => {
  const open = { stableId: "open-step", kind: "GATHER", status: "PLANNED", title: "Observe gathering plan", resourceNeedIds: [], dependsOn: [] } as const;
  const closed = { stableId: "done-step", kind: "GATHER", status: "COMPLETED", title: "Prior step", resourceNeedIds: [], dependsOn: [] } as const;
  const project = view({ workOrders: [open, closed] });
  assert.deepEqual(buildFulfillmentReviewWorkOrder(project, { stableId: "x", needIds: ["ore", "herb"], recordedAt: 200, dependsOn: ["open-step"] }).dependsOn, ["open-step"]);
  assert.throws(() => buildFulfillmentReviewWorkOrder(project, { stableId: "x", needIds: ["ore", "herb"], recordedAt: 200, dependsOn: ["done-step"] }), /no longer open/);
});

test("maximum-size grouped review keeps its safety explanation intact", () => {
  const needs = Array.from({ length: 4 }, (_, index) => ({ stableId: `need-${index}`.padEnd(120, "x"), kind: "ITEM_REF" as const, resourceKey: `item:${index + 1}:${"variant:".repeat(50)}`, label: `Need ${index} ${"long label ".repeat(12)}`, requiredQuantity: 1, sourceIdentityKey: `forever::${"long-realm".repeat(12)}::character` }));
  const large = view({ needs: needs as ErpProjectView["needs"], needEvidence: needs.map((need) => ({ needId: need.stableId, state: "UNKNOWN" as const, sourceIdentityKey: need.sourceIdentityKey, requiredQuantity: 1, freshness: "unknown" as const, sourceSections: [], unresolvedSections: ["bags"], unknownQuantityRowCount: 0, reason: "A missing observation cannot establish this requirement. ".repeat(10) })) });
  const order = buildFulfillmentReviewWorkOrder(large, { stableId: "long-review", needIds: needs.map((need) => need.stableId), recordedAt: 200 });
  assert.ok((order.instructions?.length ?? Infinity) < 3900);
  assert.match(order.instructions ?? "", /UNKNOWN and LAST_SEEN remain unresolved until new evidence is recorded\.$/);
});

test("out-of-range timestamps remain explicit UNKNOWN text instead of throwing", () => {
  const project = view({ needEvidence: [
    { needId: "ore", state: "UNKNOWN", requiredQuantity: 8, observedAt: Number.MAX_SAFE_INTEGER, freshness: "unknown", sourceSections: [], unresolvedSections: [], unknownQuantityRowCount: 0, reason: "Timestamp cannot be rendered." },
    { needId: "herb", state: "UNKNOWN", requiredQuantity: 4, freshness: "unknown", sourceSections: [], unresolvedSections: [], unknownQuantityRowCount: 0, reason: "No evidence." },
  ] });
  const order = buildFulfillmentReviewWorkOrder(project, { stableId: "timestamp-review", needIds: ["ore", "herb"], recordedAt: Number.MAX_SAFE_INTEGER });
  assert.match(order.instructions ?? "", /summary was generated UNKNOWN \(timestamp is outside the supported date range\)/);
  assert.match(order.instructions ?? "", /evidence timestamp UNKNOWN \(timestamp is outside the supported date range\)/);
});
