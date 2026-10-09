import type { ErpWorkOrderReadiness } from "@wowsync-dashboard/core";

const LABELS: Record<ErpWorkOrderReadiness["state"], string> = {
  PROJECT_NOT_ACTIVE: "Project is not active",
  TERMINAL: "Work order is closed",
  BLOCKED_BY_DEPENDENCY: "Waiting for prerequisite work",
  OBSERVED_RESOURCE_SHORTFALL: "Observed resource shortfall",
  WAITING_FOR_EVIDENCE: "Waiting for current evidence",
  READY_FOR_PLAYER_REVIEW: "No recorded plan blockers; review manually",
};

export function ErpWorkOrderReadinessLine({ readiness }: { readiness?: ErpWorkOrderReadiness }) {
  if (!readiness) return <p className="erp-readiness">Plan readiness is unknown; no assessment is available.</p>;
  return <p className={`erp-readiness erp-readiness-${readiness.state.toLowerCase()}`}><strong>{LABELS[readiness.state]}:</strong> {readiness.reason}</p>;
}
