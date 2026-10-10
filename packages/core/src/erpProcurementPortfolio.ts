import type { ErpProjectView } from "./erpProjects.ts";
import type { VersionOrUnknown, WowVersion } from "./types.ts";

export interface ErpProcurementBudgetOrder {
  readonly workOrderId: string;
  readonly title: string;
  readonly targetNeedId: string;
  readonly targetLabel: string;
  readonly targetKind: "ITEM_ID" | "ITEM_REF";
  readonly targetResourceKey: string;
  readonly spendingCeilingCopper: number;
}

export interface ErpProcurementBudgetLine {
  readonly version: WowVersion;
  readonly projectId: string;
  readonly projectTitle: string;
  readonly budgetNeedId: string;
  readonly budgetLabel: string;
  readonly buyerIdentityKey?: string;
  readonly plannedBudgetCopper: number;
  readonly openCeilingCopper?: number;
  readonly remainingPlannedCopper?: number;
  readonly openCeilingExceedsSafeInteger: boolean;
  readonly exceedsPlannedBudget: boolean;
  readonly state: "WITHIN_PLANNED_BUDGET" | "CEILINGS_EXCEED_PLANNED_BUDGET";
  readonly evidence: {
    readonly state: string;
    readonly freshness: string;
    readonly observedCopper?: number;
    readonly observedAt?: number;
    readonly projectLocalReservedCopper?: number;
    readonly reservedCopperExceedsSafeInteger?: boolean;
    readonly reason: string;
  };
  readonly orders: readonly ErpProcurementBudgetOrder[];
}

export interface ErpProcurementBudgetPortfolioReview {
  readonly version: VersionOrUnknown;
  readonly lines: readonly ErpProcurementBudgetLine[];
  readonly totalLineCount: number;
  readonly returnedLineCount: number;
  readonly linesOverPlannedBudget: number;
  readonly truncated: boolean;
}

/** Aggregates only open, explicitly budget-linked purchase ceilings inside the same project and version. */
export function buildErpProcurementBudgetPortfolioReview(
  projects: readonly ErpProjectView[],
  version: VersionOrUnknown,
  limit = 100,
): ErpProcurementBudgetPortfolioReview {
  if (version === "unknown-version") return { version, lines: [], totalLineCount: 0, returnedLineCount: 0, linesOverPlannedBudget: 0, truncated: false };
  const lines: ErpProcurementBudgetLine[] = [];
  for (const project of projects) {
    if (project.version !== version || project.status === "CANCELLED") continue;
    const openPurchases = project.workOrders.filter((order) =>
      order.kind === "PURCHASE" && order.status !== "COMPLETED" && order.status !== "CANCELLED" &&
      order.procurementPlan?.budgetNeedId && order.procurementPlan.targetNeedId && Number.isSafeInteger(order.procurementPlan.spendingCeilingCopper),
    );
    const budgetIds = [...new Set(openPurchases.map((order) => order.procurementPlan!.budgetNeedId!))];
    for (const budgetNeedId of budgetIds) {
      const budget = project.needs.find((need) => need.stableId === budgetNeedId && need.kind === "GOLD_COPPER");
      if (!budget) continue;
      const orders = openPurchases.filter((order) => order.procurementPlan?.budgetNeedId === budgetNeedId);
      const openCeilingTotal = orders.reduce((sum, order) => sum + BigInt(order.procurementPlan!.spendingCeilingCopper), 0n);
      const evidence = project.needEvidence.find((entry) => entry.needId === budgetNeedId);
      const activeReservations = project.reservations.filter((entry) => entry.needId === budgetNeedId && entry.status === "ACTIVE");
      const reservedTotal = activeReservations.reduce((sum, entry) => sum + BigInt(entry.quantity), 0n);
      const exceedsPlannedBudget = openCeilingTotal > BigInt(budget.requiredQuantity);
      const openCeilingExceedsSafeInteger = openCeilingTotal > BigInt(Number.MAX_SAFE_INTEGER);
      const remainingPlannedTotal = BigInt(budget.requiredQuantity) - openCeilingTotal;
      const remainingPlannedCopper = remainingPlannedTotal >= BigInt(Number.MIN_SAFE_INTEGER) && remainingPlannedTotal <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(remainingPlannedTotal) : undefined;
      const reservedCopper = reservedTotal <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(reservedTotal) : undefined;
      lines.push({
        version, projectId: project.stableId, projectTitle: project.title, budgetNeedId, budgetLabel: budget.label,
        ...(budget.sourceIdentityKey ?? budget.destinationIdentityKey ? { buyerIdentityKey: budget.sourceIdentityKey ?? budget.destinationIdentityKey } : {}),
        plannedBudgetCopper: budget.requiredQuantity,
        ...(openCeilingExceedsSafeInteger ? {} : { openCeilingCopper: Number(openCeilingTotal) }),
        ...(remainingPlannedCopper !== undefined ? { remainingPlannedCopper } : {}),
        openCeilingExceedsSafeInteger, exceedsPlannedBudget,
        state: exceedsPlannedBudget ? "CEILINGS_EXCEED_PLANNED_BUDGET" : "WITHIN_PLANNED_BUDGET",
        evidence: {
          state: evidence?.state ?? "UNKNOWN", freshness: evidence?.freshness ?? "unknown",
          ...(evidence?.observedQuantity !== undefined ? { observedCopper: evidence.observedQuantity } : {}),
          ...(evidence?.observedAt !== undefined ? { observedAt: evidence.observedAt } : {}),
          ...(activeReservations.length && reservedCopper !== undefined ? { projectLocalReservedCopper: reservedCopper } : {}),
          ...(activeReservations.length && reservedCopper === undefined ? { reservedCopperExceedsSafeInteger: true } : {}),
          reason: evidence?.reason ?? "No current budget observation is available.",
        },
        orders: orders.flatMap((order) => {
          const target = project.needs.find((need) => need.stableId === order.procurementPlan!.targetNeedId);
          if (!target || (target.kind !== "ITEM_ID" && target.kind !== "ITEM_REF")) return [];
          return [{
            workOrderId: order.stableId, title: order.title, targetNeedId: target.stableId, targetLabel: target.label,
            targetKind: target.kind, targetResourceKey: target.resourceKey, spendingCeilingCopper: order.procurementPlan!.spendingCeilingCopper,
          }];
        }),
      });
    }
  }
  lines.sort((a, b) => Number(b.state === "CEILINGS_EXCEED_PLANNED_BUDGET") - Number(a.state === "CEILINGS_EXCEED_PLANNED_BUDGET") || b.projectTitle.localeCompare(a.projectTitle) || a.budgetLabel.localeCompare(b.budgetLabel));
  const safeLimit = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 500) : 100;
  const returned = lines.slice(0, safeLimit);
  return {
    version, lines: returned, totalLineCount: lines.length, returnedLineCount: returned.length,
    linesOverPlannedBudget: lines.filter((line) => line.exceedsPlannedBudget).length,
    truncated: returned.length < lines.length,
  };
}
