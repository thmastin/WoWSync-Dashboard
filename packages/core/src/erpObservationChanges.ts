import type { ErpNeedEvidence, ErpProjectView, ErpResourceNeed, NeedSupplyState } from "./erpProjects.ts";
import type { WowVersion } from "./types.ts";
import type { Freshness } from "./freshness.ts";

export interface ErpNeedObservationChangeEntry {
  readonly projectId: string;
  readonly projectTitle: string;
  readonly projectStatus: "ACTIVE" | "PAUSED";
  readonly projectPriority: number;
  readonly version: WowVersion;
  readonly needId: string;
  readonly needLabel: string;
  readonly needKind: ErpResourceNeed["kind"];
  readonly resourceKey: string;
  readonly requiredQuantity: number;
  readonly sourceIdentityKey?: string;
  readonly sourceOwnerKey?: string;
  /** Assessment of the latest comparable snapshot, which may be stale. */
  readonly evidenceState: NeedSupplyState;
  readonly observedQuantity?: number;
  readonly potentialQuantity?: number;
  readonly observedAt?: number;
  readonly freshness: Freshness;
  readonly comparisons: readonly NonNullable<ErpNeedEvidence["observationChange"]>["comparisons"][number][];
  readonly reason: string;
}

export interface ErpNeedObservationChangeReview {
  readonly items: readonly ErpNeedObservationChangeEntry[];
  readonly totalCount: number;
  readonly returnedCount: number;
  readonly affectedProjectCount: number;
  readonly truncated: boolean;
}

/** Latest comparable changed need evidence for active/paused projects; no action cause or completion is inferred. */
export function buildErpNeedObservationChangeReview(projects: readonly ErpProjectView[], version: WowVersion, limit = 100): ErpNeedObservationChangeReview {
  const entries = projects.flatMap((project): ErpNeedObservationChangeEntry[] => {
    if (project.version !== version || (project.status !== "ACTIVE" && project.status !== "PAUSED")) return [];
    return project.needEvidence.flatMap((evidence): ErpNeedObservationChangeEntry[] => {
      const change = evidence.observationChange;
      if (change?.state !== "CHANGED") return [];
      const comparisons = change.comparisons.filter((comparison) => comparison.delta !== 0);
      if (!comparisons.length) return [];
      const need = project.needs.find((entry) => entry.stableId === evidence.needId);
      if (!need) return [];
      return [{
        projectId: project.stableId, projectTitle: project.title, projectStatus: project.status as "ACTIVE" | "PAUSED", projectPriority: project.priority, version,
        needId: need.stableId, needLabel: need.label, needKind: need.kind, resourceKey: need.resourceKey, requiredQuantity: need.requiredQuantity,
        ...(need.sourceIdentityKey ? { sourceIdentityKey: need.sourceIdentityKey } : {}), ...(need.sourceOwnerKey ? { sourceOwnerKey: need.sourceOwnerKey } : {}),
        evidenceState: evidence.state, ...(evidence.observedQuantity !== undefined ? { observedQuantity: evidence.observedQuantity } : {}),
        ...(evidence.potentialQuantity !== undefined ? { potentialQuantity: evidence.potentialQuantity } : {}), ...(evidence.observedAt !== undefined ? { observedAt: evidence.observedAt } : {}),
        freshness: evidence.freshness, comparisons, reason: change.reason,
      }];
    });
  }).sort((a, b) => b.projectPriority - a.projectPriority
    || Math.max(...b.comparisons.map((entry) => entry.currentObservedAt)) - Math.max(...a.comparisons.map((entry) => entry.currentObservedAt))
    || a.projectTitle.localeCompare(b.projectTitle) || a.needLabel.localeCompare(b.needLabel) || a.needId.localeCompare(b.needId));
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(200, Math.floor(limit))) : 100;
  const items = entries.slice(0, safeLimit);
  return { items, totalCount: entries.length, returnedCount: items.length, affectedProjectCount: new Set(entries.map((entry) => entry.projectId)).size, truncated: items.length < entries.length };
}
