import type { ErpFulfillmentTriage, ErpFulfillmentTriageSignal } from "@wowsync-dashboard/core";
import { erpNeedAnchorId, erpWorkOrderAnchorId } from "./erpObservationChangeQueue.ts";

const labels: Record<ErpFulfillmentTriageSignal, string> = {
  CHANGED_OBSERVATION: "Rows with changed observations",
  UNWORKED_REQUIREMENT: "Requirements without a current work order",
  RESERVATION_REVIEW: "Rows with reservations needing review",
  OPEN_WORK_ORDER: "Rows linked to open manual work",
};

/** A single cross-project index into the existing evidence and planning detail. */
export function ErpFulfillmentTriagePanel({ triage, characterName }: { triage: ErpFulfillmentTriage; characterName: (identityKey?: string) => string }) {
  return <section className="erp-fulfillment-triage" aria-labelledby="erp-fulfillment-triage-title" data-testid="erp-fulfillment-triage">
    <h2 id="erp-fulfillment-triage-title">Fulfillment triage</h2>
    <p>One review index across changed observations, uncovered requirements, reservation conflicts, and open manual work. A requirement can have several signals. These are planning and evidence checks; they do not prove ownership, action cause, access, or completion.</p>
    <p>{triage.returnedCount} of {triage.totalCount} review rows across {triage.affectedProjectCount} project{triage.affectedProjectCount === 1 ? "" : "s"}.</p>
    <ul aria-label="Fulfillment triage totals">{(Object.keys(labels) as ErpFulfillmentTriageSignal[]).map((signal) => <li key={signal}>{labels[signal]}: {triage.counts[signal]}</li>)}</ul>
    {triage.items.length === 0 ? <p>No current fulfillment items need review in this version.</p> : <ol>
      {triage.items.map((item) => <li key={item.stableId}>
        <article>
          <h3>{item.projectTitle} <small>priority {item.projectPriority} · {item.projectStatus.toLowerCase()}</small></h3>
          {item.need ? <>
            <p><strong>{item.need.label}</strong> · {item.need.kind} <code>{item.need.resourceKey}</code> · planned quantity {item.need.requiredQuantity}</p>
            <p>Planned source: {item.need.sourceIdentityKey ? characterName(item.need.sourceIdentityKey) : item.need.sourceOwnerKey ? `explicit storage owner ${item.need.sourceOwnerKey}` : "UNKNOWN"} · intended recipient: {item.need.destinationIdentityKey ? characterName(item.need.destinationIdentityKey) : "unassigned"} · plan intent only</p>
            <p>Supply {item.need.evidenceState.replaceAll("_", " ")} · {item.need.observedQuantity === undefined ? "observed quantity UNKNOWN" : `${item.need.observedQuantity} observed`} · {item.need.freshness} freshness{item.need.observedAt !== undefined ? ` · seen ${new Date(item.need.observedAt * 1000).toLocaleString()}` : " · timestamp UNKNOWN"}</p>
            {item.need.observationChange?.comparisons.length ? <p>Since the previous comparable export: {item.need.observationChange.comparisons.map((change) => `${change.section} ${change.previousQuantity} → ${change.currentQuantity} (${change.delta > 0 ? "+" : ""}${change.delta}; latest ${new Date(change.currentObservedAt * 1000).toLocaleString()})`).join("; ")}. Cause UNKNOWN.</p> : null}
          </> : <p>This manual work order is not linked to a resource requirement.</p>}
          <ul aria-label="Reasons this project needs review">{item.signals.map((signal) => <li key={signal}>{labels[signal]}</li>)}</ul>
          {item.reservationReviews.map((review) => <p key={review.stableId}><strong>Reservation {review.state.replaceAll("_", " ")}:</strong> {review.reservedQuantity} planned{review.observedQuantity === undefined ? " · matching observed supply UNKNOWN" : ` · ${review.observedQuantity} observed`}. {review.reason}</p>)}
          {item.workOrders.map((order) => <p key={order.stableId}><strong>{order.title}</strong> · {order.status.replaceAll("_", " ")} · readiness {order.readinessState?.replaceAll("_", " ") ?? "UNKNOWN"} · progress {order.progressState?.replaceAll("_", " ") ?? "UNKNOWN"}</p>)}
          <p>{item.reason}</p>
          <a href={item.need ? `#${erpNeedAnchorId(item.projectId, item.need.stableId)}` : `#${erpWorkOrderAnchorId(item.projectId, item.workOrders[0]?.stableId ?? "")}`}>Open requirement and planning detail</a>
        </article>
      </li>)}
    </ol>}
    {triage.truncated && <p>Showing {triage.returnedCount} of {triage.totalCount} review items. Narrow the selected version or open project details to review the remaining items.</p>}
    <small>Interpretation: planning and evidence review only. No game action is recommended or executed from this index.</small>
  </section>;
}
