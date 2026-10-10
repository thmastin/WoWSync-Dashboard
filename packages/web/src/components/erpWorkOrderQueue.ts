import type { ErpProjectView } from "@wowsync-dashboard/core";

export type ErpQueueFilter = "ATTENTION" | "ALL_OPEN";

export interface ErpQueueEntry {
  readonly project: ErpProjectView;
  readonly order: ErpProjectView["workOrders"][number];
  readonly readiness?: ErpProjectView["workOrderReadiness"][number];
  readonly progress?: ErpProjectView["workOrderProgress"][number];
  readonly needsAttention: boolean;
}

const terminal = new Set(["COMPLETED", "CANCELLED"]);

/** Portfolio projection only: it groups the existing project assessments without changing them. */
export function buildErpWorkOrderQueue(projects: readonly ErpProjectView[], filter: ErpQueueFilter): ErpQueueEntry[] {
  const entries = projects.flatMap((project) => project.workOrders.flatMap((order) => {
    if ((project.status !== "ACTIVE" && project.status !== "COMPLETED") || terminal.has(order.status)) return [];
    const readiness = project.workOrderReadiness.find((entry) => entry.workOrderId === order.stableId);
    const progress = project.workOrderProgress.find((entry) => entry.workOrderId === order.stableId);
    const needsAttention = !readiness || readiness.state !== "READY_FOR_PLAYER_REVIEW"
      || (progress !== undefined && ["COMPLETION_CONFLICTS_WITH_LINKED_SHORTFALL", "CURRENT_LINKED_NEEDS_UNMET", "MIXED_LINKED_EVIDENCE", "OBSERVATION_CHANGED_CAUSE_UNKNOWN", "INSUFFICIENT_EVIDENCE", "RESOURCE_ALLOCATION_REQUIRES_REVIEW"].includes(progress.reconciliation));
    if (filter === "ATTENTION" && !needsAttention) return [];
    return [{ project, order, ...(readiness ? { readiness } : {}), ...(progress ? { progress } : {}), needsAttention }];
  }));
  return entries.sort((a, b) => Number(b.needsAttention) - Number(a.needsAttention)
    || b.project.priority - a.project.priority
    || a.project.title.localeCompare(b.project.title)
    || a.order.title.localeCompare(b.order.title)
    || a.order.stableId.localeCompare(b.order.stableId));
}
