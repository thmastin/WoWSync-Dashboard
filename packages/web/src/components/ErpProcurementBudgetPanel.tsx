import type { ErpProcurementBudgetPortfolioReview } from "@wowsync-dashboard/core";

export function ErpProcurementBudgetPanel({ review, characterName, onOpenProject }: {
  review: ErpProcurementBudgetPortfolioReview;
  characterName: (identityKey?: string) => string;
  onOpenProject: (projectId: string) => void;
}) {
  return <section className="erp-procurement-budget-review" aria-labelledby="erp-procurement-budget-title" data-testid="erp-procurement-budget-review">
    <h2 id="erp-procurement-budget-title">Purchase budget review</h2>
    <p>Open purchase ceilings are summed only when they reference the same explicit planned gold need in this {review.version} project. A ceiling is the player's maximum intent, not predicted spend, a quote, or a purchase. Planned room and observed gold remain separate; neither establishes affordability.</p>
    {review.truncated && <p role="note">Showing {review.returnedLineCount} of {review.totalLineCount} linked budget plans.</p>}
    {review.lines.length ? <ol>{review.lines.map((line) => <li key={`${line.projectId}:${line.budgetNeedId}`} data-testid={`erp-procurement-budget-${line.projectId}-${line.budgetNeedId}`}>
      <h3>{line.projectTitle}: {line.budgetLabel}</h3>
      <p>Buyer: {characterName(line.buyerIdentityKey)} · {line.state.replaceAll("_", " ")}</p>
      <p>{line.openCeilingCopper !== undefined ? `${line.openCeilingCopper} copper` : "An exact numeric total is unavailable because the aggregate exceeds JavaScript's safe display range"} across {line.orders.length} unfinished purchase {line.orders.length === 1 ? "plan" : "plans"} against {line.plannedBudgetCopper} copper explicitly planned. {line.exceedsPlannedBudget ? line.remainingPlannedCopper !== undefined ? `Ceilings exceed the planned amount by ${Math.abs(line.remainingPlannedCopper)} copper.` : "The exact aggregate exceeds the planned amount; its difference is outside the safe numeric display range." : line.remainingPlannedCopper === 0 ? "No planned amount remains beneath these ceilings." : line.remainingPlannedCopper !== undefined ? `${line.remainingPlannedCopper} copper remains beneath the recorded ceilings.` : "The remaining planned amount exceeds the safe numeric display range."}</p>
      <p>Gold evidence: {line.evidence.state.replaceAll("_", " ")} · {line.evidence.freshness} freshness{line.evidence.observedCopper !== undefined ? ` · ${line.evidence.observedCopper} copper observed` : " · observed gold UNKNOWN"}{line.evidence.projectLocalReservedCopper !== undefined ? ` · ${line.evidence.projectLocalReservedCopper} copper reserved as intent in this project only; other project commitments are not included` : line.evidence.reservedCopperExceedsSafeInteger ? " · this project's exact reservation total exceeds the safe numeric display range; other project commitments are not included" : " · project-local reservation amount UNKNOWN"}{line.evidence.observedAt !== undefined ? ` · ${new Date(line.evidence.observedAt * 1000).toLocaleString()}` : " · observation time UNKNOWN"}. {line.evidence.reason}</p>
      <ul>{line.orders.map((order) => <li key={order.workOrderId}>{order.title} · {order.targetLabel} (<code>{order.targetKind} {order.targetResourceKey}</code>) · ceiling {order.spendingCeilingCopper} copper</li>)}</ul>
      <button type="button" onClick={() => onOpenProject(line.projectId)}>Review project plans</button>
    </li>)}</ol> : <p>No unfinished purchase plans are linked to explicit gold budget needs for this version.</p>}
    <small>This is a review of linked plans and recorded evidence. It does not net reservations into spendable funds, infer other obligations, verify current prices, or execute purchases.</small>
  </section>;
}
