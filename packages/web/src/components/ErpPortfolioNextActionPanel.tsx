import { useState } from "react";
import type { ErpPortfolioNextActionReview, ErpResourceCommitmentSummary, ErpSourceFulfillmentReview } from "@wowsync-dashboard/core";
import { erpNeedAnchorId, erpReservationScopeAnchorId, erpSavedNeedHistoryAnchorId, erpSourceFulfillmentAnchorId, erpWorkOrderAnchorId } from "./erpObservationChangeQueue.ts";

const labels: Record<ErpPortfolioNextActionReview["items"][number]["action"], string> = {
  REVIEW_EVIDENCE: "Review incomplete or stale evidence",
  REVIEW_RESERVATIONS: "Resolve reservation review",
  RECONCILE_OBSERVATIONS: "Compare new observations",
  REVIEW_MANUAL_WORK: "Review player-authored work",
  PLAN_MANUAL_WORK: "Choose a manual fulfillment step",
  REVIEW_SOURCE_AND_ACCESS: "Review source and access",
  REVIEW_UNSCOPED_ITEM: "Requirement source is unknown",
};

function focusReviewTarget(event: React.MouseEvent<HTMLAnchorElement>, id: string) {
  event.preventDefault();
  const target = document.getElementById(id);
  target?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "center" });
  target?.focus({ preventScroll: true });
}

/** Portfolio entry queue: a shared-core review projection, never a selected route or action executor. */
type NeedRef = { projectId: string; needId: string };
export function ErpPortfolioNextActionPanel({ review, commitments, sourceReview, busy = false, onPlanNeeds, onReviewSavedHistory }: { review: ErpPortfolioNextActionReview; commitments?: ErpResourceCommitmentSummary; sourceReview?: ErpSourceFulfillmentReview; busy?: boolean; onPlanNeeds?: (needs: readonly NeedRef[]) => void; onReviewSavedHistory?: (need: NeedRef & { batchId: string }) => void }) {
  const [selected, setSelected] = useState<NeedRef[]>([]);
  const isSelected = (need: NeedRef) => selected.some((entry) => entry.projectId === need.projectId && entry.needId === need.needId);
  const toggle = (need: NeedRef) => setSelected((current) => isSelected(need)
    ? current.filter((entry) => entry.projectId !== need.projectId || entry.needId !== need.needId)
    : current.length < 20 ? [...current, need] : current);
  return <section className="erp-fulfillment-triage" aria-labelledby="erp-next-actions-title" data-testid="erp-portfolio-next-actions">
    <h2 id="erp-next-actions-title">Portfolio next actions</h2>
    <p>Start here for requirements that need attention across projects. Rows combine only requirements with the same explicitly selected source and exact resource identity. Missing source identity remains separate and UNKNOWN.</p>
    <p>{review.returnedCount} of {review.totalCount} review items in {review.version}.</p>
    <ul aria-label="Portfolio next action counts">{Object.entries(review.counts).filter(([, count]) => count > 0).map(([action, count]) => <li key={action}>{labels[action as keyof typeof labels]}: {count}</li>)}</ul>
    {onPlanNeeds && selected.length > 0 && <button type="button" disabled={busy} onClick={() => { onPlanNeeds(selected); setSelected([]); }}>Add {selected.length} selected requirements to grouped planning</button>}
    {review.items.length === 0 ? <p>No current portfolio review items.</p> : <ol>{review.items.map((item) => {
      const sourceTarget = item.action === "REVIEW_SOURCE_AND_ACCESS" && item.source && item.resource ? sourceReview?.sources.find((source) => source.kind === item.resource!.kind && source.resourceKey === item.resource!.resourceKey && source.sourceScope === item.source!.scope && (source.sourceIdentityKey ?? source.sourceOwnerKey) === item.source!.identityKey) : undefined;
      const reservationTarget = item.action === "REVIEW_RESERVATIONS" && item.source && item.resource ? commitments?.items.find((line) => line.kind === item.resource!.kind && line.resourceKey === item.resource!.resourceKey && line.sourceScope === item.source!.scope && (line.sourceIdentityKey ?? line.sourceOwnerKey) === item.source!.identityKey && (line.reservationState === "OVER_RESERVED" || (line.reservationState === "UNKNOWN" && (line.overlappingReservationQuantity ?? 0) > 0 && line.overlappingReservations.length > 0))) : undefined;
      return <li key={item.stableId}><article>
      <h3>{labels[item.action]}{item.resource ? ` · ${item.resource.label}` : ""}</h3>
      {item.resource && <p>{item.resource.kind} <code>{item.resource.resourceKey}</code>{item.source ? ` · source ${item.source.scope === "CHARACTER" ? item.source.identityKey : `shared owner ${item.source.identityKey}`}` : " · source UNKNOWN; this row was not combined with other requirements"}</p>}
      {item.recordedSourceIdentity && !item.source && <p>Recorded source reference, retained verbatim but not groupable: {item.recordedSourceScope?.sourceIdentityKey && <><code>{item.recordedSourceScope.sourceIdentityKey}</code>{item.recordedSourceScope.sourceOwnerKey && " · "}</>}{item.recordedSourceScope?.sourceOwnerKey && <code>{item.recordedSourceScope.sourceOwnerKey}</code>} · {item.sourceScopeIssue?.replaceAll("_", " ")}</p>}
      {item.needReferences.length > 0 && <ul aria-label="Requirements in this review item">{item.needReferences.map((need) => <li key={`${need.projectId}:${need.needId}`}>
        {item.action === "PLAN_MANUAL_WORK" && onPlanNeeds && <label><input type="checkbox" checked={isSelected(need)} disabled={busy || (!isSelected(need) && selected.length >= 20)} onChange={() => toggle(need)} /> Select for grouped planning </label>}
        <a href={`#${erpNeedAnchorId(need.projectId, need.needId)}`}>{need.projectTitle}: {need.needId}</a> · priority {need.projectPriority} · need {need.requiredQuantity} · {need.evidenceState.replaceAll("_", " ")} · {need.freshness} freshness{need.observedAt === undefined ? " · timestamp UNKNOWN" : ` · observed ${new Date(need.observedAt * 1000).toLocaleString()}`}{need.observationChanges?.length ? ` · ${need.observationChanges.map((change) => `${change.section} ${change.previousQuantity} → ${change.currentQuantity} (${change.delta > 0 ? "+" : ""}${change.delta}; cause UNKNOWN)`).join("; ")}` : ""}
        {need.savedHistoryReview && <p>Saved plan history records intervening quantity variation in {need.savedHistoryReview.batchIdsWithVariation.length} generation(s), most recently reviewed {new Date(need.savedHistoryReview.latestReviewedAt * 1000).toLocaleString()}. <a href={`#${erpSavedNeedHistoryAnchorId(need.projectId, need.needId)}`}>Open timestamped saved evidence history</a>. Cause remains UNKNOWN. {onReviewSavedHistory && need.savedHistoryReview.batchIdsWithVariation.length > 0 && <button type="button" disabled={busy} data-testid={`erp-next-action-review-history-${encodeURIComponent(need.projectId)}-${encodeURIComponent(need.needId)}`} onClick={() => onReviewSavedHistory({ projectId: need.projectId, needId: need.needId, batchId: need.savedHistoryReview!.batchIdsWithVariation.at(-1)! })}>Prepare follow-up from the changed saved review</button>}</p>}
      </li>)}</ul>}
      {item.signals.length > 0 && <p>Related findings: {item.signals.map((signal) => signal === "INTERVENING_HISTORY_VARIATION" ? "intervening saved-plan quantity variation" : signal.replaceAll("_", " ").toLowerCase()).join(", ")}.</p>}
      {item.action === "REVIEW_RESERVATIONS" && (reservationTarget ? <p><a href={`#${erpReservationScopeAnchorId(reservationTarget)}`} onClick={(event) => focusReviewTarget(event, erpReservationScopeAnchorId(reservationTarget))}>Open this exact source/resource reservation review</a></p> : <p role="note">The exact reservation review is outside the returned commitment window or no longer matches this row. Open the linked requirement and reload before changing a reservation.</p>)}
      {item.action === "REVIEW_SOURCE_AND_ACCESS" && (sourceTarget ? <p><a href={`#${erpSourceFulfillmentAnchorId(sourceTarget.stableId)}`} onClick={(event) => focusReviewTarget(event, erpSourceFulfillmentAnchorId(sourceTarget.stableId))}>Open this exact source and access review</a></p> : <p role="note">The exact source review is outside the returned source window or no longer matches this row. Open the linked requirement; source, access, and route remain UNKNOWN.</p>)}
      {item.workOrders.length > 0 && <p>Open work orders: {item.workOrders.map((order) => <a key={`${order.projectId}:${order.stableId}`} href={`#${erpWorkOrderAnchorId(order.projectId, order.stableId)}`}>{order.stableId}</a>)}</p>}
      <p>{item.reason}</p>
    </article></li>})}</ol>}
    {review.truncated && <p>Showing {review.returnedCount} of {review.totalCount} known review items. {review.sourceReviewTruncated && "The source review exceeded its internal scan limit. "}{review.triageTruncated && "The project triage exceeded its internal scan limit. "}{review.savedHistoryReviewTruncated && "Saved requirement history exceeded its internal scan limit. "}Open linked project requirements to review the rest; counts may be incomplete.</p>}
    <small>Planning review only: no route, access, ownership, action cause, or completion is inferred, and no game action is executed.</small>
  </section>;
}
