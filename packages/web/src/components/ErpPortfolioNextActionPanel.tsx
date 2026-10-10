import type { ErpPortfolioNextActionReview } from "@wowsync-dashboard/core";
import { erpNeedAnchorId, erpWorkOrderAnchorId } from "./erpObservationChangeQueue.ts";

const labels: Record<ErpPortfolioNextActionReview["items"][number]["action"], string> = {
  REVIEW_EVIDENCE: "Review incomplete or stale evidence",
  REVIEW_RESERVATIONS: "Resolve reservation review",
  RECONCILE_OBSERVATIONS: "Compare new observations",
  REVIEW_MANUAL_WORK: "Review player-authored work",
  PLAN_MANUAL_WORK: "Choose a manual fulfillment step",
  REVIEW_SOURCE_AND_ACCESS: "Review source and access",
  REVIEW_UNSCOPED_ITEM: "Requirement source is unknown",
};

/** Portfolio entry queue: a shared-core review projection, never a selected route or action executor. */
export function ErpPortfolioNextActionPanel({ review }: { review: ErpPortfolioNextActionReview }) {
  return <section className="erp-fulfillment-triage" aria-labelledby="erp-next-actions-title" data-testid="erp-portfolio-next-actions">
    <h2 id="erp-next-actions-title">Portfolio next actions</h2>
    <p>Start here for requirements that need attention across projects. Rows combine only requirements with the same explicitly selected source and exact resource identity. Missing source identity remains separate and UNKNOWN.</p>
    <p>{review.returnedCount} of {review.totalCount} review items in {review.version}.</p>
    <ul aria-label="Portfolio next action counts">{Object.entries(review.counts).filter(([, count]) => count > 0).map(([action, count]) => <li key={action}>{labels[action as keyof typeof labels]}: {count}</li>)}</ul>
    {review.items.length === 0 ? <p>No current portfolio review items.</p> : <ol>{review.items.map((item) => <li key={item.stableId}><article>
      <h3>{labels[item.action]}{item.resource ? ` · ${item.resource.label}` : ""}</h3>
      {item.resource && <p>{item.resource.kind} <code>{item.resource.resourceKey}</code>{item.source ? ` · source ${item.source.scope === "CHARACTER" ? item.source.identityKey : `shared owner ${item.source.identityKey}`}` : " · source UNKNOWN; this row was not combined with other requirements"}</p>}
      {item.recordedSourceIdentity && !item.source && <p>Recorded source reference, retained verbatim but not groupable: {item.recordedSourceScope?.sourceIdentityKey && <><code>{item.recordedSourceScope.sourceIdentityKey}</code>{item.recordedSourceScope.sourceOwnerKey && " · "}</>}{item.recordedSourceScope?.sourceOwnerKey && <code>{item.recordedSourceScope.sourceOwnerKey}</code>} · {item.sourceScopeIssue?.replaceAll("_", " ")}</p>}
      {item.needReferences.length > 0 && <ul aria-label="Requirements in this review item">{item.needReferences.map((need) => <li key={`${need.projectId}:${need.needId}`}><a href={`#${erpNeedAnchorId(need.projectId, need.needId)}`}>{need.projectTitle}: {need.needId}</a> · priority {need.projectPriority} · need {need.requiredQuantity} · {need.evidenceState.replaceAll("_", " ")} · {need.freshness} freshness{need.observedAt === undefined ? " · timestamp UNKNOWN" : ` · observed ${new Date(need.observedAt * 1000).toLocaleString()}`}{need.observationChanges?.length ? ` · ${need.observationChanges.map((change) => `${change.section} ${change.previousQuantity} → ${change.currentQuantity} (${change.delta > 0 ? "+" : ""}${change.delta}; cause UNKNOWN)`).join("; ")}` : ""}</li>)}</ul>}
      {item.signals.length > 0 && <p>Related findings: {item.signals.map((signal) => signal.replaceAll("_", " ").toLowerCase()).join(", ")}.</p>}
      {item.workOrders.length > 0 && <p>Open work orders: {item.workOrders.map((order) => <a key={`${order.projectId}:${order.stableId}`} href={`#${erpWorkOrderAnchorId(order.projectId, order.stableId)}`}>{order.stableId}</a>)}</p>}
      <p>{item.reason}</p>
    </article></li>)}</ol>}
    {review.truncated && <p>Showing {review.returnedCount} of {review.totalCount} known review items. {review.sourceReviewTruncated && "The source review exceeded its internal scan limit. "}{review.triageTruncated && "The project triage exceeded its internal scan limit. "}Open linked project requirements to review the rest; counts may be incomplete.</p>}
    <small>Planning review only: no route, access, ownership, action cause, or completion is inferred, and no game action is executed.</small>
  </section>;
}
