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

export function ErpWorkOrderProgressLine({ progress }: { progress?: ErpWorkOrderProgress }) {
  if (!progress) return <p className="erp-readiness">Progress reconciliation is unknown; no assessment is available.</p>;
  return <p className={`erp-readiness erp-progress-${progress.reconciliation.toLowerCase()}`}><strong>{LABELS[progress.reconciliation]}:</strong> {progress.reason}</p>;
}
