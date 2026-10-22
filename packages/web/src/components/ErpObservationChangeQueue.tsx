import { useState } from "react";
import type { ErpProjectView, WowVersion } from "@wowsync-dashboard/core";
import { buildErpNeedObservationChangeReview } from "@wowsync-dashboard/core/erpObservationChanges.ts";
import { erpNeedAnchorId } from "./erpObservationChangeQueue.ts";

export function ErpObservationChangeQueue({ projects, version, characterName, formatTime, busy = false, onPlanInvestigation }: {
  readonly projects: readonly ErpProjectView[];
  readonly version: WowVersion;
  readonly characterName: (identityKey?: string) => string;
  readonly formatTime: (seconds?: number) => string;
  readonly busy?: boolean;
  readonly onPlanInvestigation?: (project: ErpProjectView, needIds: readonly string[]) => Promise<boolean>;
}) {
  const [selectionByProject, setSelectionByProject] = useState<Record<string, readonly string[]>>({});
  const review = buildErpNeedObservationChangeReview(projects, version);
  function selectableNeedIds(projectId: string): Set<string> {
    const project = projects.find((candidate) => candidate.stableId === projectId && candidate.version === version && candidate.status === "ACTIVE");
    if (!project) return new Set();
    return new Set(review.items.filter((entry) => entry.projectId === projectId && !project.workOrders.some((order) => order.status !== "COMPLETED" && order.status !== "CANCELLED" && order.resourceNeedIds.includes(entry.needId))).map((entry) => entry.needId));
  }
  function openNeed(projectId: string, needId: string) {
    const target = document.getElementById(erpNeedAnchorId(projectId, needId));
    target?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "center" });
    target?.focus({ preventScroll: true });
  }
  function select(projectId: string, needId: string, checked: boolean) {
    setSelectionByProject((previous) => {
      const allowed = selectableNeedIds(projectId);
      const current = (previous[projectId] ?? []).filter((id) => allowed.has(id));
      const selected = checked ? [...current, needId].slice(0, 4) : current.filter((id) => id !== needId);
      return { ...previous, [projectId]: selected };
    });
  }
  async function createReview(project: ErpProjectView, needIds: readonly string[]) {
    if (!onPlanInvestigation || await onPlanInvestigation(project, needIds)) {
      setSelectionByProject((previous) => ({ ...previous, [project.stableId]: [] }));
    }
  }

  return <section className="erp-observation-change-queue" aria-labelledby="erp-observation-change-title">
    <h2 id="erp-observation-change-title">Changed resource observations</h2>
    <p>Latest comparable snapshots for needs in active or paused projects. A quantity change does not establish which game action caused it, whether a task was completed, or whether current supply is still available.</p>
    {review.items.length ? <ol>{review.items.map((entry) => {
      const comparisons = entry.comparisons;
      const project = projects.find((candidate) => candidate.stableId === entry.projectId && candidate.version === version);
      const openOrder = project?.workOrders.some((order) => order.status !== "COMPLETED" && order.status !== "CANCELLED" && order.resourceNeedIds.includes(entry.needId)) ?? false;
      const canSelect = Boolean(onPlanInvestigation && project?.status === "ACTIVE" && !openOrder);
      const selected = (selectionByProject[entry.projectId] ?? []).filter((id) => selectableNeedIds(entry.projectId).has(id));
      return <li key={`${entry.projectId}:${entry.needId}`}>
        <div><strong>{entry.needLabel}</strong> <span className="erp-status">{entry.needKind} · {entry.resourceKey}</span>
          <p>{entry.projectTitle} · {entry.projectStatus.toLowerCase()} project · priority {entry.projectPriority}</p>
          <p>{comparisons.map((comparison) => `${comparison.section}: ${comparison.previousQuantity} → ${comparison.currentQuantity} (${comparison.delta > 0 ? "+" : ""}${comparison.delta})`).join("; ")}</p>
          <small>Source: {entry.sourceOwnerKey ? `shared owner ${entry.sourceOwnerKey}` : characterName(entry.sourceIdentityKey)} · latest observed quantity {entry.observedQuantity ?? "UNKNOWN"} · {entry.evidenceState} evidence · {entry.freshness} freshness · prior {comparisons.map((comparison) => formatTime(comparison.previousObservedAt)).join(", ")} · latest observation {comparisons.map((comparison) => formatTime(comparison.currentObservedAt)).join(", ")}</small>
          <p>{entry.reason} The cause remains unknown.</p>
        </div>
        <div className="erp-observation-change-actions">
          {canSelect && <label><input type="checkbox" aria-label={`Include ${entry.needLabel} in grouped review`} checked={selected.includes(entry.needId)} disabled={busy || (!selected.includes(entry.needId) && selected.length >= 4)} onChange={(event) => select(entry.projectId, entry.needId, event.currentTarget.checked)} /> Include in a grouped review</label>}
          {openOrder && <small>An unfinished manual work order already covers this need.</small>}
          {project?.status === "PAUSED" && <small>Resume this project before adding another review step.</small>}
          <button type="button" aria-label={`Review ${entry.needLabel} in ${entry.projectTitle}`} onClick={() => openNeed(entry.projectId, entry.needId)}>Review requirement</button>
        </div>
      </li>;
    })}</ol> : <p>No changed comparable resource observations for this version’s active or paused projects.</p>}
    {onPlanInvestigation && Object.entries(selectionByProject).flatMap(([projectId, needIds]) => {
      if (!needIds.length) return [];
      const project = projects.find((candidate) => candidate.stableId === projectId && candidate.version === version);
      if (!project) return [];
      const selectable = selectableNeedIds(projectId);
      const currentNeedIds = needIds.filter((id) => selectable.has(id));
      if (!currentNeedIds.length) return [];
      return [<div className="erp-observation-change-group" key={projectId}>
        {currentNeedIds.length < 2 ? <small>Select one more changed need in {project.title} to make a grouped review.</small> : <button type="button" disabled={busy} onClick={() => void createReview(project, currentNeedIds)}>Save a planned review for {currentNeedIds.length} changed needs in {project.title}</button>}
      </div>];
    })}
    {onPlanInvestigation && <small>A grouped review records a player-authored plan for selected changed needs. It copies the evidence snapshot and does not mark a task complete or infer what caused the change.</small>}
  </section>;
}
