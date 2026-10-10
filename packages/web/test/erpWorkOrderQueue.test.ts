import assert from "node:assert/strict";
import { test } from "node:test";
import type { ErpProjectView } from "@wowsync-dashboard/core";
import { buildErpWorkOrderQueue } from "../src/components/erpWorkOrderQueue.ts";

function project(stableId: string, status: ErpProjectView["status"], priority: number, orderStatus: ErpProjectView["workOrders"][number]["status"], readinessState: string, reconciliation: string): ErpProjectView {
  const order = { stableId: `order-${stableId}`, kind: "INVESTIGATE", status: orderStatus, title: `Task ${stableId}`, resourceNeedIds: [], dependsOn: [] } as ErpProjectView["workOrders"][number];
  return {
    stableId, version: "retail", title: `Project ${stableId}`, status, priority, revision: 1, createdAt: 1, updatedAt: 1, needs: [], reservations: [], workOrders: [order], history: [], historyEventCount: 0, historyTruncated: false,
    needEvidence: [], resourceSourceScreens: [], workOrderReadiness: [{ workOrderId: order.stableId, state: readinessState as never, blockingWorkOrderIds: [], unresolvedNeedIds: [], actionTargetNeedIds: [], changedNeedIds: [], reason: `Readiness ${stableId}` }],
    workOrderProgress: [{ workOrderId: order.stableId, recordedStatus: orderStatus, completionRecorded: false, linkedNeedState: "NO_LINKED_NEEDS", observationChange: "UNKNOWN", reconciliation: reconciliation as never, coveredNeedIds: [], shortfallNeedIds: [], unresolvedNeedIds: [], allocationConflictNeedIds: [], changedNeedIds: [], reason: `Progress ${stableId}` }],
    reservationReview: [],
  } as ErpProjectView;
}

test("portfolio queue prioritizes unresolved work, respects project priority, excludes paused work, and surfaces unfinished tasks in completed projects", () => {
  const projects = [
    project("ready", "ACTIVE", 5, "IN_PROGRESS", "READY_FOR_PLAYER_REVIEW", "NO_LINKED_NEEDS"),
    project("unknown", "ACTIVE", 1, "PLANNED", "WAITING_FOR_EVIDENCE", "INSUFFICIENT_EVIDENCE"),
    project("conflict", "ACTIVE", 4, "IN_PROGRESS", "READY_FOR_PLAYER_REVIEW", "OBSERVATION_CHANGED_CAUSE_UNKNOWN"),
    project("paused", "PAUSED", 5, "PLANNED", "WAITING_FOR_EVIDENCE", "INSUFFICIENT_EVIDENCE"),
    project("completed_open", "COMPLETED", 5, "PLANNED", "PROJECT_NOT_ACTIVE", "INSUFFICIENT_EVIDENCE"),
    project("done", "ACTIVE", 5, "COMPLETED", "TERMINAL", "PLAYER_RECORDED_COMPLETE"),
  ];
  assert.deepEqual(buildErpWorkOrderQueue(projects, "ATTENTION").map((entry) => entry.project.stableId), ["completed_open", "conflict", "unknown"]);
  assert.deepEqual(buildErpWorkOrderQueue(projects, "ALL_OPEN").map((entry) => entry.project.stableId), ["completed_open", "conflict", "unknown", "ready"]);
});

test("manual supply recommendation remains visible as attention and absent assessments stay UNKNOWN", () => {
  const recommended = project("supply", "ACTIVE", 2, "PLANNED", "MANUAL_SUPPLY_STEP_RECOMMENDED", "CURRENT_LINKED_NEEDS_UNMET");
  const missing = project("missing", "ACTIVE", 1, "PLANNED", "WAITING_FOR_EVIDENCE", "INSUFFICIENT_EVIDENCE");
  const row = buildErpWorkOrderQueue([recommended, { ...missing, workOrderReadiness: [] }], "ATTENTION");
  assert.equal(row.length, 2);
  assert.equal(row.find((entry) => entry.project.stableId === "supply")?.needsAttention, true);
  assert.equal(row.find((entry) => entry.project.stableId === "missing")?.readiness, undefined);
});
