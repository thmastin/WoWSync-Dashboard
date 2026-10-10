import type { ErpProjectView, ErpWorkOrder } from "@wowsync-dashboard/core";

export interface FulfillmentReviewDraft {
  readonly stableId: string;
  readonly needIds: readonly string[];
  readonly recordedAt: number;
  readonly assignedIdentityKey?: string;
  readonly dependsOn?: readonly string[];
}

const terminal = new Set(["COMPLETED", "CANCELLED"]);
function isoTimestamp(seconds: number): string {
  const date = new Date(seconds * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "UNKNOWN (timestamp is outside the supported date range)";
}

/** Creates one player-authored review step for several explicit needs. It records no resource movement. */
export function buildFulfillmentReviewWorkOrder(project: ErpProjectView, draft: FulfillmentReviewDraft): ErpWorkOrder {
  if (project.status !== "ACTIVE") throw new Error("Only an active project can receive a new fulfillment review step.");
  if (!draft.stableId.trim()) throw new Error("A stable work-order ID is required.");
  if (!Number.isSafeInteger(draft.recordedAt) || draft.recordedAt < 0) throw new Error("A valid plan-time timestamp is required.");
  const needIds = [...new Set(draft.needIds)];
  if (needIds.length < 2) throw new Error("Select at least two distinct resource needs for a multi-need review.");
  if (needIds.length > 4) throw new Error("A single review can link at most 4 needs so every evidence note stays readable. Split larger plans into separate reviews.");
  const needById = new Map(project.needs.map((need) => [need.stableId, need]));
  const selected = needIds.map((needId) => {
    const need = needById.get(needId);
    if (!need) throw new Error("A selected resource need no longer exists. Refresh the project and try again.");
    const alreadyOpen = project.workOrders.some((order) => !terminal.has(order.status) && order.resourceNeedIds.includes(needId));
    if (alreadyOpen) throw new Error(`“${need.label}” already has an open work order. Refresh the project before planning it again.`);
    return need;
  });
  const prefix = `${project.version}::`;
  if (draft.assignedIdentityKey && !draft.assignedIdentityKey.startsWith(prefix)) throw new Error("The assigned character must belong to the project's game version.");
  const orderIds = [...new Set(draft.dependsOn ?? [])];
  if (orderIds.some((orderId) => !project.workOrders.some((order) => order.stableId === orderId && !terminal.has(order.status)))) {
    throw new Error("A prerequisite work order is no longer open in this project. Refresh before saving.");
  }
  const lines = selected.map((need) => {
    const evidence = project.needEvidence.find((entry) => entry.needId === need.stableId);
    const source = (need.sourceIdentityKey ?? need.sourceOwnerKey ?? "UNKNOWN source").slice(0, 160);
    const state = evidence?.state ?? "UNKNOWN";
    const freshness = evidence?.freshness ?? "unknown";
    const evidenceTime = evidence?.observedAt === undefined ? "evidence time UNKNOWN" : `evidence timestamp ${isoTimestamp(evidence.observedAt)}`;
    const observed = evidence?.observedQuantity === undefined ? "observed quantity UNKNOWN" : `${evidence.observedQuantity} observed`;
    const historical = evidence?.potentialQuantity ? `; ${evidence.potentialQuantity} LAST_SEEN possible` : "";
    const reserved = evidence?.reservationAssessment
      ? `; ${evidence.reservationAssessment.activeQuantity} reserved, ${evidence.reservationAssessment.availableObservedLowerBound === undefined ? "remaining supply UNKNOWN" : `at least ${evidence.reservationAssessment.availableObservedLowerBound} unreserved observed`}`
      : "; reservation state UNKNOWN";
    const reason = (evidence?.reason ?? "No current assessment is available.").slice(0, 160);
    return `• ${need.stableId} — ${need.label} (${need.kind}, need ${need.requiredQuantity}); source ${source}; ${state}/${freshness}, ${evidenceTime}; ${observed}${historical}${reserved}. ${reason}`.slice(0, 620);
  });
  const planTime = isoTimestamp(draft.recordedAt);
  const instructions = [
    `Player-created grouped review of the linked resource requirements. This saved evidence summary was generated ${planTime}; its freshness does not update. Open each linked need for its full resource identity and current evidence, then decide the appropriate manual next step.`,
    ...lines,
    "This review step does not reserve or move resources and does not assert access, ownership, recipe inputs, procurement availability, craftability, or action completion. UNKNOWN and LAST_SEEN remain unresolved until new evidence is recorded.",
  ].join("\n").slice(0, 3900);
  return {
    stableId: draft.stableId,
    kind: "INVESTIGATE",
    status: "PLANNED",
    title: `Review fulfillment for ${selected.length} requirements`,
    instructions,
    resourceNeedIds: needIds,
    dependsOn: orderIds,
    ...(draft.assignedIdentityKey ? { assignedIdentityKey: draft.assignedIdentityKey } : {}),
  };
}
