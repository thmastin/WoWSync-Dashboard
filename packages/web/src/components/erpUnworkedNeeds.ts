import type { ErpProjectView } from "@wowsync-dashboard/core";

export interface ErpUnworkedNeed {
  readonly project: ErpProjectView;
  readonly need: ErpProjectView["needs"][number];
  readonly evidence?: ErpProjectView["needEvidence"][number];
  readonly reason: string;
}

/** Find uncovered plan needs that have no open manual order to bring them back into the player's workflow. */
export function findErpUnworkedNeeds(projects: readonly ErpProjectView[]): ErpUnworkedNeed[] {
  return projects.flatMap((project) => {
    if (project.status === "CANCELLED") return [];
    const openNeedIds = new Set(project.workOrders.filter((order) => order.status !== "COMPLETED" && order.status !== "CANCELLED").flatMap((order) => order.resourceNeedIds));
    return project.needs.flatMap((need) => {
      if (openNeedIds.has(need.stableId)) return [];
      const evidence = project.needEvidence.find((entry) => entry.needId === need.stableId);
      if (evidence?.state === "COVERED_BY_OBSERVED" && evidence.freshness === "recent") return [];
      const reason = evidence?.state === "SHORTFALL_OBSERVED" && evidence.freshness === "recent"
        ? "A recent complete observation records a shortfall."
        : evidence?.state === "POTENTIAL_COVERAGE_LAST_SEEN"
          ? "Only historical possible coverage is available; current supply is not established."
          : evidence?.state === "UNSUPPORTED_EVIDENCE"
            ? "This resource type is not supported by current evidence."
            : "Current evidence is stale, incomplete, or unknown.";
      return [{ project, need, ...(evidence ? { evidence } : {}), reason }];
    });
  }).sort((a, b) => b.project.priority - a.project.priority || a.project.title.localeCompare(b.project.title) || a.need.label.localeCompare(b.need.label) || a.need.stableId.localeCompare(b.need.stableId));
}
