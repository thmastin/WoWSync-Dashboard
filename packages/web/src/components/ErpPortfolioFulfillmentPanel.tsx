import type { ErpPortfolioFulfillmentReview } from "@wowsync-dashboard/core";
import { erpNeedAnchorId } from "./erpObservationChangeQueue.ts";

function prerequisiteGateLabel(state: ErpPortfolioFulfillmentReview["packages"][number]["steps"][number]["prerequisiteGate"]["state"]): string {
  switch (state) {
    case "NO_PREREQUISITES": return "No prerequisite evidence gate is linked.";
    case "CURRENT_OBSERVED_EVIDENCE_MET": return "All linked prerequisite needs have recent timestamped observed coverage. This satisfies the evidence gate only; it does not prove a manual action was completed.";
    case "PREREQUISITE_EVIDENCE_REVIEW": return "A linked prerequisite is stale, partial, unknown, or short of its requirement. Review upstream evidence before relying on this step.";
    case "MISSING_PREREQUISITE": return "A saved prerequisite reference is unavailable. Its evidence is UNKNOWN and the link needs repair.";
    case "CYCLE_REVIEW": return "The package contains a cycle. Review its saved links before using the sequence.";
  }
}

/** Shows only player-authored dependency chains and their shared evidence/readiness projection. */
export function ErpPortfolioFulfillmentPanel({ review, characterName }: { review: ErpPortfolioFulfillmentReview; characterName: (identityKey?: string) => string }) {
  return <section className="erp-portfolio-fulfillment" aria-labelledby="erp-portfolio-fulfillment-title" data-testid="erp-portfolio-fulfillment">
    <h2 id="erp-portfolio-fulfillment-title">Portfolio fulfillment packages</h2>
    <p>These sequences follow prerequisites the player linked across projects. Steps are ordered by those links; this does not select a crafting, purchase, or transfer route or claim any task was performed.</p>
    <p>{review.totalPackageCount} package{review.totalPackageCount === 1 ? "" : "s"} · {review.totalStepCount} linked requirement steps · {review.stepsNeedingReview} step{review.stepsNeedingReview === 1 ? "" : "s"} need review.</p>
    {!review.packages.length ? <p>No cross-project fulfillment packages have been linked for this version.</p> : <ol>
      {review.packages.map((item) => <li key={item.stableId}>
        <article>
          <h3>Player-authored package · {item.steps.length} steps</h3>
          {item.cycleDetected && <p role="alert">A cycle was found in stored package links. Review the saved links before using their order.</p>}
          <ol>{item.steps.map((step, index) => <li key={`${step.projectId}/${step.needId}`}>
            <h4>{index + 1}. {step.projectTitle}: {step.needLabel}</h4>
            <p><code>{step.resourceKey}</code> · requires {step.requiredQuantity ?? "UNKNOWN"} · evidence {step.evidenceState.replaceAll("_", " ")} · {step.freshness} freshness{step.observedQuantity !== undefined ? ` · ${step.observedQuantity} observed` : " · quantity UNKNOWN"}{step.observedAt !== undefined ? ` · seen ${new Date(step.observedAt * 1000).toLocaleString()}` : " · timestamp UNKNOWN"}</p>
            <p>Planned source: {step.sourceIdentityKey ? characterName(step.sourceIdentityKey) : step.sourceOwnerKey ? `explicit owner ${step.sourceOwnerKey}` : "UNKNOWN"} · intended recipient: {step.destinationIdentityKey ? characterName(step.destinationIdentityKey) : "unassigned"} · this project’s reservation intent: {step.projectReservationIntentQuantity ?? "UNKNOWN"} · same-source resource commitments across projects: {step.reservationAssessment ? `${step.reservationAssessment.activeQuantity} (${step.reservationAssessment.state.replaceAll("_", " ")})` : "UNKNOWN"}</p>
            {step.reservationAssessment && <p>{step.reservationAssessment.reason} These are recorded commitments, not observed free stock or availability.</p>}
            {step.prerequisiteNeedIds.length > 0 && <p>Waits on: {step.prerequisiteNeedIds.map((dependency) => `${dependency.projectId}/${dependency.needId}`).join(", ")}</p>}
            <p><strong>Prerequisite evidence gate:</strong> {prerequisiteGateLabel(step.prerequisiteGate.state)}{step.prerequisiteGate.blockers.length > 0 && <> Review: {step.prerequisiteGate.blockers.map((blocker) => <span key={`${blocker.projectId}/${blocker.needId}`}> <a href={`#${erpNeedAnchorId(blocker.projectId, blocker.needId)}`}>{blocker.projectId}/{blocker.needId}</a> ({blocker.evidenceState.replaceAll("_", " ")}, {blocker.freshness})</span>)}</>}</p>
            {step.workOrders.length ? <ul aria-label={`Manual work for ${step.needLabel}`}>{step.workOrders.map((order) => <li key={order.stableId}><a href={`#${erpNeedAnchorId(step.projectId, step.needId)}`}>{order.title}</a> · {order.status.replaceAll("_", " ")} · readiness {order.readinessState.replaceAll("_", " ")}{order.progressState ? ` · reconciliation ${order.progressState.replaceAll("_", " ")}` : ""}</li>)}</ul> : <p>No linked manual work order is recorded for this requirement.</p>}
            <p>{step.reason}</p>
            <a href={`#${erpNeedAnchorId(step.projectId, step.needId)}`}>Open this project requirement</a>
          </li>)}</ol>
          {item.nextReviewStepId && <p><strong>Next player review:</strong> {item.nextReviewStepId}</p>}
        </article>
      </li>)}
    </ol>}
    {review.truncated && <p>Showing {review.returnedPackageCount} of {review.totalPackageCount} packages. Narrow the version's project list to review all packages.</p>}
    <small>Observed resource changes remain non-causal. Reservations and work orders describe saved intent, not possession, free stock, availability, or execution.</small>
  </section>;
}
