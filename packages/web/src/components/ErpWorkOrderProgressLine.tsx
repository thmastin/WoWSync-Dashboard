import type { ErpWorkOrderProgress } from "@wowsync-dashboard/core";

const LABELS: Record<ErpWorkOrderProgress["reconciliation"], string> = {
  PLAYER_RECORDED_COMPLETE: "Player recorded complete",
  COMPLETION_CONFLICTS_WITH_LINKED_SHORTFALL: "Completion note conflicts with a linked shortfall",
  CURRENT_LINKED_NEEDS_MET: "Linked resource needs currently covered",
  CURRENT_LINKED_NEEDS_UNMET: "Current linked resource shortfall",
  MIXED_LINKED_EVIDENCE: "Mixed linked resource evidence",
  OBSERVATION_CHANGED_CAUSE_UNKNOWN: "Observed resource change; cause unknown",
  INSUFFICIENT_EVIDENCE: "Progress evidence is stale, incomplete, or unknown",
  NO_LINKED_NEEDS: "No linked resource evidence",
  RESOURCE_ALLOCATION_REQUIRES_REVIEW: "Resource allocation requires review",
};

export function ErpWorkOrderProgressLine({ progress, characterName }: { progress?: ErpWorkOrderProgress; characterName?: (identityKey?: string) => string }) {
  if (!progress) return <p className="erp-readiness">Progress reconciliation is unknown; no assessment is available.</p>;
  const name = characterName ?? ((identityKey?: string) => identityKey ?? "Unspecified character");
  const reviews = progress.transferObservationReviews ?? [];
  return <div className={`erp-readiness erp-progress-${progress.reconciliation.toLowerCase()}`}><p><strong>{LABELS[progress.reconciliation]}:</strong> {progress.reason}</p>{reviews.length > 0 && <details className="erp-transfer-observation-review"><summary>Compare planned source and destination observations (relationship unknown)</summary><ul>{reviews.map((review) => <li key={review.needId}>
    <strong>{review.kind} {review.resourceKey} · {review.state.replaceAll("_", " ")}</strong>
    <p>Source — {name(review.source.identityKey)}: {sideDescription(review.source)}</p>
    <p>Destination — {name(review.destination.identityKey)}: {sideDescription(review.destination)}</p>
    <p>{review.reason} The comparison does not establish account membership, ownership, access, transferability, or that the planned action caused either change.</p>
  </li>)}</ul></details>}</div>;
}

function sideDescription(side: NonNullable<ErpWorkOrderProgress["transferObservationReviews"]>[number]["source"]): string {
  const changes = side.comparisons.map((comparison) => `${comparison.section}: ${comparison.previousQuantity} → ${comparison.currentQuantity} (${comparison.delta > 0 ? "+" : ""}${comparison.delta})`).join("; ");
  const state = side.state === "COMPARABLE_CHANGED" ? "recent comparable quantity change"
    : side.state === "COMPARABLE_UNCHANGED" ? "no change in recent comparable observations"
    : "comparison UNKNOWN";
  return `${state} · ${side.freshness} freshness${side.observedAt ? ` · evidence ${new Date(side.observedAt * 1000).toLocaleString()}` : ""}${changes ? ` · ${changes}` : ""}. ${side.reason}`;
}
