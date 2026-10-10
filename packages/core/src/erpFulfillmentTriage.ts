import type { ErpProjectView, ErpResourceNeed } from "./erpProjects.ts";
import type { VersionOrUnknown, WowVersion } from "./types.ts";
import type { Freshness } from "./freshness.ts";

export type ErpFulfillmentTriageSignal = "CHANGED_OBSERVATION" | "UNWORKED_REQUIREMENT" | "RESERVATION_REVIEW" | "OPEN_WORK_ORDER";

export interface ErpFulfillmentTriageItem {
  readonly stableId: string;
  readonly version: WowVersion;
  readonly projectId: string;
  readonly projectTitle: string;
  readonly projectStatus: ErpProjectView["status"];
  readonly projectPriority: number;
  readonly need?: Pick<ErpResourceNeed, "stableId" | "kind" | "resourceKey" | "label" | "requiredQuantity" | "sourceIdentityKey" | "sourceOwnerKey" | "destinationIdentityKey"> & {
    readonly evidenceState: ErpProjectView["needEvidence"][number]["state"];
    readonly observedQuantity?: number;
    readonly potentialQuantity?: number;
    readonly observedAt?: number;
    readonly observationChange?: ErpProjectView["needEvidence"][number]["observationChange"];
    readonly freshness: Freshness;
  };
  readonly workOrders: readonly { readonly stableId: string; readonly title: string; readonly status: string; readonly readinessState?: string; readonly progressState?: string }[];
  readonly reservationReviews: readonly { readonly stableId: string; readonly state: string; readonly reservedQuantity: number; readonly observedQuantity?: number; readonly reason: string }[];
  readonly signals: readonly ErpFulfillmentTriageSignal[];
  readonly reason: string;
}

export interface ErpFulfillmentTriage {
  readonly version: VersionOrUnknown;
  readonly items: readonly ErpFulfillmentTriageItem[];
  readonly totalCount: number;
  readonly returnedCount: number;
  readonly affectedProjectCount: number;
  /** Signal-bearing row counts across all candidates before the display cap; a linked order counts once per affected need row. */
  readonly counts: Readonly<Record<ErpFulfillmentTriageSignal, number>>;
  readonly truncated: boolean;
  readonly interpretation: "PLANNING_AND_EVIDENCE_REVIEW_ONLY";
}

const emptyCounts = (): Record<ErpFulfillmentTriageSignal, number> => ({ CHANGED_OBSERVATION: 0, UNWORKED_REQUIREMENT: 0, RESERVATION_REVIEW: 0, OPEN_WORK_ORDER: 0 });

/** Groups existing version-scoped evaluations by project requirement without ranking fulfillment routes or inferring action cause. */
export function buildErpFulfillmentTriage(projects: readonly ErpProjectView[], version: VersionOrUnknown, limit = 200): ErpFulfillmentTriage {
  const counts = emptyCounts();
  if (version === "unknown-version") return { version, items: [], totalCount: 0, returnedCount: 0, affectedProjectCount: 0, counts, truncated: false, interpretation: "PLANNING_AND_EVIDENCE_REVIEW_ONLY" };
  const entries: ErpFulfillmentTriageItem[] = [];
  for (const project of projects) {
    if (project.version !== version || project.status === "CANCELLED") continue;
    const openOrders = project.workOrders.filter((order) => order.status !== "COMPLETED" && order.status !== "CANCELLED");
    const addNeed = (need: ErpResourceNeed) => {
      const evidence = project.needEvidence.find((entry) => entry.needId === need.stableId);
      const linkedOrders = openOrders.filter((order) => order.resourceNeedIds.includes(need.stableId));
      const reservations = project.reservations.filter((reservation) => reservation.status === "ACTIVE" && reservation.needId === need.stableId).flatMap((reservation) => {
        const assessment = project.reservationReview.find((entry) => entry.reservationId === reservation.stableId);
        return assessment && assessment.state !== "WITHIN_OBSERVED_SUPPLY" ? [{ stableId: assessment.reservationId, state: assessment.state, reservedQuantity: assessment.reservedQuantity, ...(assessment.observedQuantity !== undefined ? { observedQuantity: assessment.observedQuantity } : {}), reason: assessment.reason }] : [];
      });
      const signals: ErpFulfillmentTriageSignal[] = [];
      if (evidence?.observationChange?.state === "CHANGED" && evidence.observationChange.comparisons.some((comparison) => comparison.delta !== 0)) signals.push("CHANGED_OBSERVATION");
      if (!linkedOrders.length && !(evidence?.state === "COVERED_BY_OBSERVED" && evidence.freshness === "recent")) signals.push("UNWORKED_REQUIREMENT");
      if (reservations.length) signals.push("RESERVATION_REVIEW");
      if (linkedOrders.length) signals.push("OPEN_WORK_ORDER");
      if (!signals.length) return;
      for (const signal of signals) counts[signal]++;
      const orders = linkedOrders.map((order) => ({ stableId: order.stableId, title: order.title, status: order.status,
        ...(project.workOrderReadiness.find((entry) => entry.workOrderId === order.stableId) ? { readinessState: project.workOrderReadiness.find((entry) => entry.workOrderId === order.stableId)!.state } : {}),
        ...(project.workOrderProgress.find((entry) => entry.workOrderId === order.stableId) ? { progressState: project.workOrderProgress.find((entry) => entry.workOrderId === order.stableId)!.reconciliation } : {}),
      }));
      entries.push({ stableId: `${project.stableId}:${need.stableId}`, version, projectId: project.stableId, projectTitle: project.title, projectStatus: project.status, projectPriority: project.priority,
        need: { stableId: need.stableId, kind: need.kind, resourceKey: need.resourceKey, label: need.label, requiredQuantity: need.requiredQuantity, ...(need.sourceIdentityKey ? { sourceIdentityKey: need.sourceIdentityKey } : {}), ...(need.sourceOwnerKey ? { sourceOwnerKey: need.sourceOwnerKey } : {}), ...(need.destinationIdentityKey ? { destinationIdentityKey: need.destinationIdentityKey } : {}), evidenceState: evidence?.state ?? "UNKNOWN", ...(evidence?.observedQuantity !== undefined ? { observedQuantity: evidence.observedQuantity } : {}), ...(evidence?.potentialQuantity !== undefined ? { potentialQuantity: evidence.potentialQuantity } : {}), ...(evidence?.observedAt !== undefined ? { observedAt: evidence.observedAt } : {}), ...(evidence?.observationChange ? { observationChange: evidence.observationChange } : {}), freshness: evidence?.freshness ?? "unknown" },
        workOrders: orders, reservationReviews: reservations, signals,
        reason: [evidence?.reason, ...reservations.map((entry) => entry.reason), ...orders.map((order) => `${order.title}: ${order.readinessState ?? "readiness UNKNOWN"}; ${order.progressState ?? "progress UNKNOWN"}`)].filter(Boolean).join(" ") || "Evidence and saved planning intent require review.",
      });
    };
    for (const need of project.needs) addNeed(need);
    for (const order of openOrders.filter((entry) => entry.resourceNeedIds.length === 0)) {
      counts.OPEN_WORK_ORDER++;
      const readiness = project.workOrderReadiness.find((entry) => entry.workOrderId === order.stableId);
      const progress = project.workOrderProgress.find((entry) => entry.workOrderId === order.stableId);
      entries.push({ stableId: `${project.stableId}:${order.stableId}`, version, projectId: project.stableId, projectTitle: project.title, projectStatus: project.status, projectPriority: project.priority,
        workOrders: [{ stableId: order.stableId, title: order.title, status: order.status, ...(readiness ? { readinessState: readiness.state } : {}), ...(progress ? { progressState: progress.reconciliation } : {}) }], reservationReviews: [], signals: ["OPEN_WORK_ORDER"], reason: readiness?.reason ?? progress?.reason ?? "This unfinished manual order has no linked resource requirement.",
      });
    }
  }
  const signalOrder: Record<ErpFulfillmentTriageSignal, number> = { RESERVATION_REVIEW: 0, CHANGED_OBSERVATION: 1, UNWORKED_REQUIREMENT: 2, OPEN_WORK_ORDER: 3 };
  entries.sort((a, b) => Math.min(...a.signals.map((signal) => signalOrder[signal])) - Math.min(...b.signals.map((signal) => signalOrder[signal])) || b.projectPriority - a.projectPriority || a.projectTitle.localeCompare(b.projectTitle) || (a.need?.label ?? a.workOrders[0]?.title ?? "").localeCompare(b.need?.label ?? b.workOrders[0]?.title ?? "") || a.stableId.localeCompare(b.stableId));
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(200, Math.floor(limit))) : 200;
  const items = entries.slice(0, safeLimit);
  return { version, items, totalCount: entries.length, returnedCount: items.length, affectedProjectCount: new Set(entries.map((entry) => entry.projectId)).size, counts, truncated: items.length < entries.length, interpretation: "PLANNING_AND_EVIDENCE_REVIEW_ONLY" };
}
