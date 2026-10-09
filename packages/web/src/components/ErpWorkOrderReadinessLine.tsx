import type { ErpWorkOrderReadiness } from "@wowsync-dashboard/core";

const LABELS: Record<ErpWorkOrderReadiness["state"], string> = {
  PROJECT_NOT_ACTIVE: "Project is not active",
  TERMINAL: "Work order is closed",
  BLOCKED_BY_DEPENDENCY: "Waiting for prerequisite work",
  OBSERVED_RESOURCE_SHORTFALL: "Observed resource shortfall",
  MANUAL_SUPPLY_STEP_RECOMMENDED: "Manual supply step can address an observed gap",
  RESOURCE_ALLOCATION_REQUIRES_REVIEW: "Linked resource needs require review",
  WAITING_FOR_EVIDENCE: "Waiting for current evidence",
  OBSERVATION_CHANGED_REQUIRES_REVIEW: "Observed change requires review",
  READY_FOR_PLAYER_REVIEW: "No recorded plan blockers; review manually",
};

export function ErpWorkOrderReadinessLine({ readiness }: { readiness?: ErpWorkOrderReadiness }) {
  if (!readiness) return <p className="erp-readiness">Plan readiness is unknown; no assessment is available.</p>;
  return <div className={`erp-readiness erp-readiness-${readiness.state.toLowerCase()}`}><p><strong>{LABELS[readiness.state]}:</strong> {readiness.reason}</p>{readiness.capabilityChecks?.length ? <ul aria-label="Crafting capability evidence">{readiness.capabilityChecks.map((check) => <li key={check.needId}><strong>{check.kind === "RECIPE" ? "Recipe" : "Profession skill"}:</strong> {check.reason}</li>)}</ul> : null}</div>;
}
