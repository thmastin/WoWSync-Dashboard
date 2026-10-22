import type { ErpProjectStatus, ErpProjectView, ErpWorkOrder, ErpWorkOrderReadiness } from "@wowsync-dashboard/core";

export type PlayerStepState = "READY" | "WAITING" | "NEEDS_EVIDENCE" | "COMPLETED" | "CANCELLED";

export function playerProjectStatusLabel(status: ErpProjectStatus): string {
  return status === "ACTIVE" ? "Active" : status === "PAUSED" ? "Paused" : status === "COMPLETED" ? "Completed" : "Closed";
}

export function playerStepState(order: ErpWorkOrder, readiness?: ErpWorkOrderReadiness): PlayerStepState {
  if (order.status === "COMPLETED") return "COMPLETED";
  if (order.status === "CANCELLED") return "CANCELLED";
  if (order.status === "WAITING_FOR_EVIDENCE" || readiness?.state === "WAITING_FOR_EVIDENCE" || readiness?.state === "OBSERVATION_CHANGED_REQUIRES_REVIEW") return "NEEDS_EVIDENCE";
  if (readiness?.state === "BLOCKED_BY_DEPENDENCY" || readiness?.state === "WAITING_FOR_PORTFOLIO_PREREQUISITE" || readiness?.state === "RESOURCE_ALLOCATION_REQUIRES_REVIEW" || readiness?.state === "OBSERVED_RESOURCE_SHORTFALL" || readiness?.state === "PROJECT_NOT_ACTIVE") return "WAITING";
  return "READY";
}

export function nextPlayerWorkOrder(project: ErpProjectView): ErpWorkOrder | undefined {
  const open = project.workOrders.filter((order) => order.status !== "COMPLETED" && order.status !== "CANCELLED");
  if (!open.length) return undefined;
  const byId = new Map(project.workOrderReadiness.map((entry) => [entry.workOrderId, entry]));
  return open.find((order) => order.status === "IN_PROGRESS")
    ?? open.find((order) => {
      const state = byId.get(order.stableId)?.state;
      return state !== "BLOCKED_BY_DEPENDENCY" && state !== "WAITING_FOR_PORTFOLIO_PREREQUISITE" && state !== "PROJECT_NOT_ACTIVE";
    })
    ?? open[0];
}

export function playerActionText(order: ErpWorkOrder, characterName: (key?: string) => string): string {
  const assigned = characterName(order.assignedIdentityKey);
  if (/profession/i.test(`${order.title} ${order.instructions ?? ""}`) && /evidence|verify|unknown|refresh/i.test(`${order.title} ${order.instructions ?? ""}`)) {
    const firstName = assigned.split(" — ")[0] ?? "the assigned character";
    return `Refresh ${firstName}'s Forever export, then check whether Mining and Blacksmithing are already recorded. The current profession state needs verification; the plan does not assume either is missing.`;
  }
  return order.instructions?.trim() || `Review “${order.title}” for ${assigned}, then record your progress here.`;
}

export function projectSelection(projects: readonly ErpProjectView[], savedId?: string): ErpProjectView | undefined {
  return projects.find((project) => project.stableId === savedId)
    ?? projects.find((project) => project.status === "ACTIVE")
    ?? projects[0];
}

export function playerObjectiveText(objective?: string): string | undefined {
  const firstLine = objective?.split(/\r?\n/, 1)[0]?.trim();
  if (!firstLine) return undefined;
  return firstLine.replace(/^Player goal:\s*/i, "");
}
