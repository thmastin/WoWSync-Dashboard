import type { ErpProcurementBuyerPortfolioReview } from "@wowsync-dashboard/core";

export function ErpProcurementBuyerPanel({ review, characterName, onReviewOrder }: {
  review: ErpProcurementBuyerPortfolioReview;
  characterName: (identityKey: string) => string;
  onReviewOrder: (projectId: string, workOrderId: string) => void;
}) {
  return <section className="erp-procurement-buyer-review" aria-labelledby="erp-procurement-buyer-title" data-testid="erp-procurement-buyer-review">
    <h2 id="erp-procurement-buyer-title">Cross-project buyer quote review</h2>
    <p>For a character with explicitly buyer-scoped purchase plans, recent quotes are combined only when each recorded quantity covers its current observed gap. A comparison requires one consistent recent gold snapshot later than every quote and the same explicit reservation assessment across this version's projects. This is a comparison of recorded plans, not affordability or a complete obligations ledger.</p>
    {review.truncated && <p role="note">Showing {review.returnedBuyerCount} of {review.totalBuyerCount} buyers; review is incomplete.</p>}
    {review.unresolvedBuyerOrderCount > 0 && <p role="note">{review.unresolvedBuyerOrderCount} open budget-linked purchase plans have missing or conflicting buyer scope and were not combined.</p>}
    {review.buyers.length ? <ol>{review.buyers.map((line) => <li key={line.buyerIdentityKey} data-testid={`erp-procurement-buyer-${encodeURIComponent(line.buyerIdentityKey)}`}>
      <h3>{characterName(line.buyerIdentityKey)} · {line.state.replaceAll("_", " ")}</h3>
      <p>{line.projectCount} project(s), {line.orderCount} open purchase plan(s), {line.quoteCount} player quote(s). {line.reason}</p>
      <p>{line.recentQuoteTotalCopper !== undefined ? `${line.recentQuoteTotalCopper} copper in recent quotes` : "Combined recent quote total UNKNOWN"}{line.observedGoldCopper !== undefined ? ` · ${line.observedGoldCopper} copper observed at ${line.observedGoldAt ? new Date(line.observedGoldAt * 1000).toLocaleString() : "unknown time"}` : " · observed gold UNKNOWN"}{line.recordedReservationsCopper !== undefined ? ` · ${line.recordedReservationsCopper} copper explicitly reserved` : " · reservation total UNKNOWN"}{line.recordedRemainderCopper !== undefined ? ` · ${line.recordedRemainderCopper} copper after recorded reservations` : " · recorded remainder UNKNOWN"}. These figures do not establish spendable funds.</p>
      <ul>{line.orders.map((order) => <li key={`${order.projectId}:${order.workOrderId}`}>{order.projectTitle} · {order.targetLabel} (<code>{order.targetResourceKey}</code>) · {order.targetGap.replaceAll("_", " ")}{order.quote ? ` · ${order.quote.amountCopper} copper for ${order.quote.quantity} units · ${order.quote.freshness} quote` : " · quote UNKNOWN"} <button type="button" onClick={() => onReviewOrder(order.projectId, order.workOrderId)}>Review quote task</button></li>)}</ul>
    </li>)}</ol> : <p>No explicitly scoped, open procurement plans are available for this buyer review.</p>}
  </section>;
}
