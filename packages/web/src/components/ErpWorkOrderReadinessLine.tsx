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
const NEED_STATES: Record<string, string> = {
  COVERED_BY_OBSERVED: "Observed quantity covers the plan",
  SHORTFALL_OBSERVED: "Observed quantity is below the plan",
  POTENTIAL_COVERAGE_LAST_SEEN: "Historical quantity may cover the plan",
  UNKNOWN: "Quantity unknown",
  UNSUPPORTED_EVIDENCE: "Evidence unsupported for this resource",
};
const RESERVATION_STATES: Record<string, string> = {
  UNRESERVED: "unreserved", WITHIN_OBSERVED_SUPPLY: "within observed supply", OVER_RESERVED: "over-reserved", UNKNOWN: "availability unknown",
};

export function ErpWorkOrderReadinessLine({ readiness, characterName }: { readiness?: ErpWorkOrderReadiness; characterName?: (identityKey?: string) => string }) {
  if (!readiness) return <p className="erp-readiness">Plan readiness is unknown; no assessment is available.</p>;
  const name = characterName ?? ((identityKey?: string) => identityKey ?? "Not selected");
  const linkedNeeds = readiness.linkedNeeds ?? [];
  return <div className={`erp-readiness erp-readiness-${readiness.state.toLowerCase()}`}><p><strong>{LABELS[readiness.state]}:</strong> {readiness.reason}</p>{readiness.capabilityChecks?.length ? <ul aria-label="Crafting capability evidence">{readiness.capabilityChecks.map((check) => <li key={check.needId}><strong>{check.kind === "RECIPE" ? "Recipe" : "Profession skill"}:</strong> {check.reason}</li>)}</ul> : null}{linkedNeeds.length ? <details className="erp-work-order-inputs"><summary>Linked inputs and evidence ({linkedNeeds.length})</summary><ul>{linkedNeeds.map((need) => <li key={need.needId}>
    <strong>{need.label}</strong> <span>({need.kind}: {need.resourceKey})</span>
    <p>{NEED_STATES[need.state] ?? "Quantity unknown"} · required {need.requiredQuantity}{need.observedQuantity !== undefined ? ` · observed ${need.observedQuantity}` : " · observed quantity unknown"}{need.potentialQuantity !== undefined ? ` · historical potential ${need.potentialQuantity}` : ""}</p>
    <small>Source: {need.sourceIdentityKey ? name(need.sourceIdentityKey) : need.sourceOwnerKey ? `shared owner ${need.sourceOwnerKey}` : "not selected"} · {need.freshness} freshness{need.observedAt !== undefined ? ` · evidence ${new Date(need.observedAt * 1000).toLocaleString()}` : ""}{need.reservationState ? ` · ${need.activeReservationQuantity ?? 0} reserved (${RESERVATION_STATES[need.reservationState] ?? "availability unknown"})` : ""}</small>
    <ul>{need.sourceSections.map((section, index) => <li key={`${need.needId}-${section.section}-${index}`}>{section.section}: {section.state}{section.completeness ? ` · ${section.completeness}` : ""}{section.observedAt !== undefined ? ` · ${new Date(section.observedAt * 1000).toLocaleString()}` : ""}</li>)}</ul>
    <p>{need.reason}{need.unresolvedSections.length ? ` Unresolved: ${need.unresolvedSections.join(", ")}.` : ""}</p>
  </li>)}</ul></details> : null}</div>;
}
