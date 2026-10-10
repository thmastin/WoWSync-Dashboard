import assert from "node:assert/strict";
import { test } from "node:test";
import type { ErpProjectView } from "@wowsync-dashboard/core";
import { findErpUnworkedNeeds } from "../src/components/erpUnworkedNeeds.ts";

function project(status: ErpProjectView["status"], workStatus?: ErpProjectView["workOrders"][number]["status"], evidenceState: string = "SHORTFALL_OBSERVED", freshness: string = "recent"): ErpProjectView {
  const need = { stableId: "cloth", kind: "ITEM_REF", resourceKey: "item:2589:0", label: "Linen Cloth", requiredQuantity: 10 } as ErpProjectView["needs"][number];
  const workOrders = workStatus ? [{ stableId: "gather", kind: "GATHER", status: workStatus, title: "Gather", resourceNeedIds: [need.stableId], dependsOn: [] } as ErpProjectView["workOrders"][number]] : [];
  return {
    stableId: `project-${status}-${workStatus ?? "none"}-${evidenceState}-${freshness}`, version: "forever", title: "Provision character", status, priority: 3, revision: 1, createdAt: 1, updatedAt: 1, needs: [need], reservations: [], workOrders, history: [], historyEventCount: 0, historyTruncated: false,
    needEvidence: [{ needId: need.stableId, state: evidenceState as never, freshness: freshness as never, requiredQuantity: 10, observedQuantity: evidenceState === "SHORTFALL_OBSERVED" ? 2 : undefined, sourceSections: [], unresolvedSections: [], unknownQuantityRowCount: 0, reason: "fixture evidence" }],
    resourceSourceScreens: [], workOrderReadiness: [], workOrderProgress: [], reservationReview: [], fulfillment: { state: "EVIDENCE_REVIEW_REQUIRED", projectStatus: status, requirementCount: 1, currentObservedCoverageCount: 0, currentObservedShortfallCount: evidenceState === "SHORTFALL_OBSERVED" && freshness === "recent" ? 1 : 0, historicalOrStaleEvidenceCount: freshness === "stale" ? 1 : 0, unresolvedEvidenceCount: evidenceState === "UNKNOWN" || freshness === "unknown" ? 1 : 0, activeWorkOrderCount: workOrders.filter((order) => order.status !== "COMPLETED" && order.status !== "CANCELLED").length, reservationReviewStates: {}, changedObservationCauseUnknownCount: 0, interpretation: "OBSERVATIONS_AND_PLAN_SUMMARY_ONLY", reason: "fixture summary" },
  } as ErpProjectView;
}

test("unworked need view finds uncovered or stale needs but not needs covered by recent evidence", () => {
  const short = project("ACTIVE");
  const stale = project("ACTIVE", undefined, "COVERED_BY_OBSERVED", "stale");
  const covered = project("ACTIVE", undefined, "COVERED_BY_OBSERVED", "recent");
  const rows = findErpUnworkedNeeds([short, stale, covered]);
  assert.deepEqual(rows.map((entry) => entry.project.stableId), [short.stableId, stale.stableId]);
});

test("any non-terminal linked order suppresses an orphaned-need prompt; completed project gaps stay visible", () => {
  const planned = project("ACTIVE", "PLANNED");
  const inProgress = project("ACTIVE", "IN_PROGRESS");
  const completedProject = project("COMPLETED", "COMPLETED");
  const cancelled = project("CANCELLED");
  const rows = findErpUnworkedNeeds([planned, inProgress, completedProject, cancelled]);
  assert.deepEqual(rows.map((entry) => entry.project.stableId), [completedProject.stableId]);
  assert.match(rows[0]!.reason, /recent complete observation records a shortfall/);
});
