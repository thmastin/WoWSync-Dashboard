import type { ErpProcurementBuyerPortfolioReview, ErpProcurementSourceReview, ErpProcurementSourceLead } from "@wowsync-dashboard/core";

function sourceEvidence(review: ErpProcurementSourceReview, onReviewNeed: (projectId: string, needId: string) => void, planSourcePackage?: (source: ErpProcurementSourceLead) => void) {
  const emptyText = review.state === "NO_MATCHING_SOURCE_OBSERVED"
    ? "The completed source scan found no matching character inventory location."
    : review.state === "NO_OTHER_CHARACTERS_TO_SCAN"
      ? "No other same-version character is currently represented in Dashboard source scans. Other characters may not have been imported; source availability is UNKNOWN."
    : review.state === "SOURCE_SCAN_INCOMPLETE" || review.state === "POTENTIAL_SOURCES_SCAN_INCOMPLETE"
      ? "The character source scan is incomplete; other matching locations may be missing."
      : "Source-location review is unavailable for this need.";
  return <details><summary>Other observed locations ({review.sources.length}) · {review.state.replaceAll("_", " ")}</summary>
    {review.sources.length ? <ul>{review.sources.map((source) => <li key={`${source.sourceIdentityKey}:${source.state}:${source.observedAt ?? "unknown"}:${source.reservationState}:${source.activeReservationQuantity}`}>
      <strong>{source.sourceName}{source.sourceSurname ? ` ${source.sourceSurname}` : ""} · {source.sourceRealm}</strong> · {source.state} · {source.freshness} evidence
      {source.observedAt !== undefined ? ` at ${new Date(source.observedAt * 1000).toLocaleString()}` : " · timestamp UNKNOWN"}
      {source.observedQuantity !== undefined ? ` · ${source.observedQuantity} observed` : " · current quantity UNKNOWN"}
      {source.availableObservedLowerBound !== undefined ? ` · at least ${source.availableObservedLowerBound} unreserved` : " · unreserved quantity UNKNOWN"}
      <ul>{source.matchingItems.map((item, index) => <li key={`${item.itemRef}:${item.section}:${index}`}><code>{item.itemRef}</code> · {item.section} · {item.state}{item.quantity !== undefined ? ` · ${item.quantity} units` : " · quantity UNKNOWN"}</li>)}</ul>
      <p>Account membership: UNKNOWN · access: UNKNOWN · transferability: UNKNOWN. This is a location lead; review access and route before changing the purchase plan. {source.reason}</p>
      {source.needReferences.map((reference) => <button key={`${reference.projectId}:${reference.needId}`} type="button" onClick={() => onReviewNeed(reference.projectId, reference.needId)}>Open {reference.projectTitle} source review</button>)}
      {planSourcePackage && source.needReferences.length > 1 && <button type="button" onClick={() => planSourcePackage(source)}>Plan manual source reviews for {source.needReferences.length} linked requirements</button>}
    </li>)}</ul> : <p>{emptyText}</p>}
  </details>;
}

export function ErpProcurementBuyerPanel({ review, characterName, onReviewOrder, onReviewNeed, onPlanSourcePackage }: {
  review: ErpProcurementBuyerPortfolioReview;
  characterName: (identityKey: string) => string;
  onReviewOrder: (projectId: string, workOrderId: string) => void;
  onReviewNeed: (projectId: string, needId: string) => void;
  onPlanSourcePackage: (buyerIdentityKey: string, resourceKey: string, source: ErpProcurementSourceLead) => void;
}) {
  return <section className="erp-procurement-buyer-review" aria-labelledby="erp-procurement-buyer-title" data-testid="erp-procurement-buyer-review">
    <h2 id="erp-procurement-buyer-title">Cross-project buyer quote review</h2>
    <p>For a character with explicitly buyer-scoped purchase plans, recent quotes are combined only when each recorded quantity covers its current observed gap. A comparison requires one consistent recent gold snapshot later than every quote and the same explicit reservation assessment across this version&apos;s projects. This is a comparison of recorded plans, not affordability or a complete obligations ledger.</p>
    {review.truncated && <p role="note">Showing {review.returnedBuyerCount} of {review.totalBuyerCount} buyers; review is incomplete.</p>}
    {review.unresolvedBuyerOrderCount > 0 && <p role="note">{review.unresolvedBuyerOrderCount} open budget-linked purchase plans have missing or conflicting buyer scope and were not combined.</p>}
    {review.buyers.length ? <ol>{review.buyers.map((line) => <li key={line.buyerIdentityKey} data-testid={`erp-procurement-buyer-${encodeURIComponent(line.buyerIdentityKey)}`}>
      <h3>{characterName(line.buyerIdentityKey)} · {line.state.replaceAll("_", " ")}</h3>
      <p>{line.projectCount} project(s), {line.orderCount} open purchase plan(s), {line.quoteCount} player quote(s). {line.reason}</p>
      <p>{line.recentQuoteTotalCopper !== undefined ? `${line.recentQuoteTotalCopper} copper in recent quotes` : "Combined recent quote total UNKNOWN"}{line.observedGoldCopper !== undefined ? ` · ${line.observedGoldCopper} copper observed at ${line.observedGoldAt ? new Date(line.observedGoldAt * 1000).toLocaleString() : "unknown time"}` : " · observed gold UNKNOWN"}{line.recordedReservationsCopper !== undefined ? ` · ${line.recordedReservationsCopper} copper explicitly reserved` : " · reservation total UNKNOWN"}{line.recordedRemainderCopper !== undefined ? ` · ${line.recordedRemainderCopper} copper after recorded reservations` : " · recorded remainder UNKNOWN"}. These figures do not establish spendable funds.</p>
      {line.resourcePackages.length > 0 && <section aria-label="Repeated exact item needs across projects"><h4>Repeated exact item needs across projects</h4><ul>{line.resourcePackages.map((resourcePackage) => <li key={`${resourcePackage.kind}:${resourcePackage.resourceKey}`} data-testid={`erp-procurement-resource-package-${encodeURIComponent(line.buyerIdentityKey)}-${encodeURIComponent(resourcePackage.resourceKey)}`}><strong>{resourcePackage.state.replaceAll("_", " ")}</strong> · <code>{resourcePackage.resourceKey}</code> · {resourcePackage.projectCount} projects, {resourcePackage.needCount} needs{resourcePackage.combinedObservedGapQuantity !== undefined ? ` · ${resourcePackage.combinedObservedGapQuantity} combined observed gap units` : " · combined gap UNKNOWN"}{resourcePackage.recentQuotedQuantity !== undefined ? ` · ${resourcePackage.recentQuotedQuantity} recent quoted units for ${resourcePackage.recentQuoteTotalCopper} copper` : " · recent quoted quantity UNKNOWN"}. {resourcePackage.reason}
        <section aria-label="Project requirements and existing work"><h5>Project requirements and existing work</h5><ul>{resourcePackage.needReviews.map((need) => <li key={`${need.projectId}:${need.needId}`} data-testid={`erp-procurement-need-review-${need.projectId}-${need.needId}`}><strong>{need.projectTitle}</strong> · {need.projectStatus} · priority {need.projectPriority} · {need.label} · {need.state.replaceAll("_", " ")} · requires {need.requiredQuantity}{need.observedQuantity !== undefined ? ` · ${need.observedQuantity} observed` : " · current quantity UNKNOWN"}{need.potentialQuantity !== undefined ? ` · ${need.potentialQuantity} LAST_SEEN` : ""} · {need.freshness}{need.observedAt !== undefined ? ` at ${new Date(need.observedAt * 1000).toLocaleString()}` : " · timestamp UNKNOWN"}{need.reservationState ? ` · reservation ${need.reservationState} (${need.activeReservationQuantity ?? "quantity UNKNOWN"})` : " · reservation evidence UNKNOWN"}. {need.unresolvedSections.length ? `Unresolved: ${need.unresolvedSections.join(", ")}. ` : ""}{need.reason} <button type="button" onClick={() => onReviewNeed(need.projectId, need.needId)}>Review requirement</button><small>Source sections: {need.sourceSections.length ? need.sourceSections.map((section) => `${section.section} ${section.state} · ${section.completeness ?? "completeness UNKNOWN"}${section.observedAt !== undefined ? ` · ${new Date(section.observedAt * 1000).toLocaleString()}` : " · timestamp UNKNOWN"}`).join("; ") : "UNKNOWN"}</small>{need.linkedWorkOrders.length ? <ul>{need.linkedWorkOrders.map((order) => <li key={order.workOrderId}>{order.kind} · {order.status} · {order.readinessState?.replaceAll("_", " ") ?? "readiness UNKNOWN"}{order.progressState ? ` · ${order.progressState.replaceAll("_", " ")}` : ""}: {order.title}. {order.reason ?? ""} <button type="button" onClick={() => onReviewOrder(need.projectId, order.workOrderId)}>Review linked work</button></li>)}</ul> : <p>No work order is linked to this requirement.</p>}</li>)}</ul></section>
        {sourceEvidence({ state: resourcePackage.sourceReviewState, sources: resourcePackage.observedSources }, onReviewNeed, (source) => onPlanSourcePackage(line.buyerIdentityKey, resourcePackage.resourceKey, source))}
        {resourcePackage.orders.map((order) => <button key={`${order.projectId}:${order.workOrderId}`} type="button" onClick={() => onReviewOrder(order.projectId, order.workOrderId)}>Review {order.projectTitle}</button>)}</li>)}</ul></section>}
      <ul>{line.orders.map((order) => {
        const groupedInPackage = line.resourcePackages.some((resourcePackage) => resourcePackage.orders.some((packagedOrder) => packagedOrder.projectId === order.projectId && packagedOrder.workOrderId === order.workOrderId));
        return <li key={`${order.projectId}:${order.workOrderId}`}>{order.projectTitle} · {order.targetLabel} (<code>{order.targetResourceKey}</code>) · {order.targetGap.replaceAll("_", " ")}{order.quote ? ` · ${order.quote.amountCopper} copper for ${order.quote.quantity} units · ${order.quote.freshness} quote` : " · quote UNKNOWN"} <button type="button" onClick={() => onReviewOrder(order.projectId, order.workOrderId)}>Review quote task</button>{!groupedInPackage && sourceEvidence(order.sourceReview, onReviewNeed)}</li>;
      })}</ul>
    </li>)}</ol> : <p>No explicitly scoped, open procurement plans are available for this buyer review.</p>}
    <small>Observed locations are version-scoped planning evidence only. Character co-location does not establish shared ownership, access, transferability, or a valid retrieval route.</small>
  </section>;
}
