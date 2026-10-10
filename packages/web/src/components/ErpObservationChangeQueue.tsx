import type { ErpProjectView, WowVersion } from "@wowsync-dashboard/core";
import { buildErpNeedObservationChangeReview } from "@wowsync-dashboard/core/erpObservationChanges.ts";
import { erpNeedAnchorId } from "./erpObservationChangeQueue.ts";

export function ErpObservationChangeQueue({ projects, version, characterName, formatTime }: {
  readonly projects: readonly ErpProjectView[];
  readonly version: WowVersion;
  readonly characterName: (identityKey?: string) => string;
  readonly formatTime: (seconds?: number) => string;
}) {
  const review = buildErpNeedObservationChangeReview(projects, version);
  function openNeed(projectId: string, needId: string) {
    const target = document.getElementById(erpNeedAnchorId(projectId, needId));
    target?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "center" });
    target?.focus({ preventScroll: true });
  }

  return <section className="erp-observation-change-queue" aria-labelledby="erp-observation-change-title">
    <h2 id="erp-observation-change-title">Changed resource observations</h2>
    <p>Latest comparable snapshots for needs in active or paused projects. A quantity change does not establish which game action caused it, whether a task was completed, or whether current supply is still available.</p>
    {review.items.length ? <ol>{review.items.map((entry) => {
      const comparisons = entry.comparisons;
      return <li key={`${entry.projectId}:${entry.needId}`}>
        <div><strong>{entry.needLabel}</strong> <span className="erp-status">{entry.needKind} · {entry.resourceKey}</span>
          <p>{entry.projectTitle} · {entry.projectStatus.toLowerCase()} project · priority {entry.projectPriority}</p>
          <p>{comparisons.map((comparison) => `${comparison.section}: ${comparison.previousQuantity} → ${comparison.currentQuantity} (${comparison.delta > 0 ? "+" : ""}${comparison.delta})`).join("; ")}</p>
          <small>Source: {entry.sourceOwnerKey ? `shared owner ${entry.sourceOwnerKey}` : characterName(entry.sourceIdentityKey)} · latest observed quantity {entry.observedQuantity ?? "UNKNOWN"} · {entry.evidenceState} evidence · {entry.freshness} freshness · prior {comparisons.map((comparison) => formatTime(comparison.previousObservedAt)).join(", ")} · latest observation {comparisons.map((comparison) => formatTime(comparison.currentObservedAt)).join(", ")}</small>
          <p>{entry.reason} The cause remains unknown.</p>
        </div>
        <button type="button" aria-label={`Review ${entry.needLabel} in ${entry.projectTitle}`} onClick={() => openNeed(entry.projectId, entry.needId)}>Review requirement</button>
      </li>;
    })}</ol> : <p>No changed comparable resource observations for this version’s active or paused projects.</p>}
  </section>;
}
