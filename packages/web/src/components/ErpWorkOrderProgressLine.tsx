import type { ErpProcurementObservationReview, ErpWorkOrderProgress } from "@wowsync-dashboard/core";

const LABELS: Record<ErpWorkOrderProgress["reconciliation"], string> = {
  PLAYER_RECORDED_COMPLETE: "Player recorded complete",
  COMPLETION_CONFLICTS_WITH_LINKED_SHORTFALL: "Completion note conflicts with a linked shortfall",
  CURRENT_LINKED_NEEDS_MET: "Linked resource needs currently covered",
  CURRENT_LINKED_NEEDS_UNMET: "Current linked resource shortfall",
  MIXED_LINKED_EVIDENCE: "Mixed linked resource evidence",
  OBSERVATION_CHANGED_CAUSE_UNKNOWN: "Observed resource change; cause unknown",
  INSUFFICIENT_EVIDENCE: "Progress evidence is stale, incomplete, or unknown",
  NO_LINKED_NEEDS: "No linked resource evidence",
  RESOURCE_ALLOCATION_REQUIRES_REVIEW: "Resource allocation requires review",
};
const OUTPUT_LABELS: Record<NonNullable<ErpWorkOrderProgress["plannedOutputAssessment"]>["state"], string> = {
  COVERED_BY_OBSERVED: "the recorded observation covers the planned quantity",
  SHORTFALL_OBSERVED: "complete observation shows less than planned",
  POTENTIAL_COVERAGE_LAST_SEEN: "historical possible quantity only",
  UNKNOWN: "current quantity unknown",
  UNSUPPORTED_EVIDENCE: "evidence type unsupported",
};

export function ErpWorkOrderProgressLine({ progress, characterName }: { progress?: ErpWorkOrderProgress; characterName?: (identityKey?: string) => string }) {
  if (!progress) return <p className="erp-readiness">Progress reconciliation is unknown; no assessment is available.</p>;
  const name = characterName ?? ((identityKey?: string) => identityKey ?? "Unspecified character");
  const reviews = progress.transferObservationReviews ?? [];
  const provisioning = progress.provisioningObservationReviews ?? [];
  const retrievals = progress.retrievalObservationReviews ?? [];
  const output = progress.plannedOutputAssessment;
  return <div className={`erp-readiness erp-progress-${progress.reconciliation.toLowerCase()}`}><p><strong>{LABELS[progress.reconciliation]}:</strong> {progress.reason}</p>{reviews.length > 0 && <details className="erp-transfer-observation-review"><summary>Compare planned source and destination observations (relationship unknown)</summary><ul>{reviews.map((review) => <li key={review.needId}>
    <strong>{review.kind} {review.resourceKey} · {review.state.replaceAll("_", " ")}</strong>
    <p>Source — {name(review.source.identityKey)}: {sideDescription(review.source)}</p>
    <p>Destination — {name(review.destination.identityKey)}: {sideDescription(review.destination)}</p>
    <p>{review.reason} The comparison does not establish account membership, ownership, access, transferability, or that the planned action caused either change.</p>
  </li>)}</ul></details>}{provisioning.length > 0 && <details className="erp-provisioning-observation-review" aria-label="Provisioning observation review"><summary>Compare planned provisioning source and recipient observations (relationship unknown)</summary><ul>{provisioning.map((review) => <li key={review.needId}><strong>{review.kind} {review.resourceKey} | {review.state.replaceAll("_", " ")}</strong><p>Source: {name(review.source.identityKey)}: {sideDescription(review.source)}</p><p>Recipient: {name(review.destination.identityKey)}: {sideDescription(review.destination)}</p><p>{review.reason} The evidence does not establish that the resources moved, that either character can access the other, or that this provisioning step caused either change.</p></li>)}</ul></details>}{retrievals.length > 0 && <details className="erp-retrieval-observation-review" aria-label="Retrieval observation review"><summary>Compare planned personal or shared-storage retrieval observations (cause unknown)</summary><ul>{retrievals.map((review) => <li key={review.needId}><strong>{review.kind} {review.resourceKey} | {review.state.replaceAll("_", " ")}</strong>{review.sourceOwnerKey ? <p>Source owner: {review.ownerScope ?? "UNKNOWN"} ({review.sourceOwnerKey}) | {review.freshness} freshness | snapshot carriers: {(review.carrierCharacterKeys ?? []).map((identityKey) => name(identityKey)).join(", ") || "UNKNOWN"}</p> : <p>Character: {name(review.characterIdentityKey)} | {review.freshness} freshness</p>}{review.comparisons.map((comparison) => <p key={comparison.section}>{comparison.section}: {comparison.previousQuantity} to {comparison.currentQuantity} ({comparison.delta > 0 ? "+" : ""}{comparison.delta}); {new Date(comparison.previousObservedAt * 1000).toLocaleString()} to {new Date(comparison.currentObservedAt * 1000).toLocaleString()}</p>)}{review.unresolvedSections.length > 0 && <p>Not comparable: {review.unresolvedSections.join(", ")}</p>}<p>{review.reason} This does not prove who moved an item or that retrieval occurred.</p></li>)}</ul></details>}{progress.procurementObservationReview && <ProcurementObservationReviewView review={progress.procurementObservationReview} characterName={name} />}{output && <section className="erp-craft-output" aria-label="Planned craft output evidence"><h4>Planned craft output (intent only)</h4><p><strong>{output.plannedOutput.label}</strong>  |  <code>{output.plannedOutput.resourceKey}</code>  |  {output.plannedOutput.quantity} planned</p><p>Checked character: {name(output.recipientIdentityKey)}  |  {OUTPUT_LABELS[output.state]}  |  {output.freshness} freshness{output.observedAt ? `  |  evidence ${new Date(output.observedAt * 1000).toLocaleString()}` : ""}</p>{output.observedQuantity !== undefined && <p>Quantity in recorded evidence: {output.observedQuantity}</p>}{output.potentialQuantity !== undefined && <p>Historical possible quantity: {output.potentialQuantity} (LAST_SEEN)</p>}{output.unresolvedSections.length > 0 && <p>Unresolved: {output.unresolvedSections.join(", ")}</p>}<p>{output.reason}</p><p>Output observation changes are non-causal and do not verify this craft or complete the work order.</p></section>}</div>;
}

function ProcurementObservationReviewView({ review, characterName }: { review: ErpProcurementObservationReview; characterName: (identityKey?: string) => string }) {
  const comparison = review.comparison;
  return <section className="erp-procurement-observation-review" aria-label="Procurement change review">
    <h4>Procurement change review (cause unknown)</h4>
    <p>Buyer: {characterName(review.buyerIdentityKey)} · {review.state.replaceAll("_", " ")} · {review.freshness} latest evidence{review.previousFreshness ? ` · ${review.previousFreshness} earlier evidence` : ""}</p>
    {comparison && <p>Observed gold: {comparison.previousQuantity} → {comparison.currentQuantity} copper ({comparison.delta > 0 ? "+" : ""}{comparison.delta}); earlier {new Date(comparison.previousObservedAt * 1000).toLocaleString()}, later {new Date(comparison.currentObservedAt * 1000).toLocaleString()}.</p>}
    {review.targetItem && <div><strong>Linked item target {review.targetItem.state.replaceAll("_", " ")} · {review.targetItem.freshness} latest evidence{review.targetItem.previousFreshness ? ` · ${review.targetItem.previousFreshness} earlier evidence` : ""}</strong><p><code>{review.targetItem.resourceKey}</code>{review.targetItem.comparisons.length > 0 ? ` · ${review.targetItem.comparisons.map((entry) => `${entry.section}: ${entry.previousQuantity} → ${entry.currentQuantity} (${entry.delta > 0 ? "+" : ""}${entry.delta}), ${new Date(entry.previousObservedAt * 1000).toLocaleString()} → ${new Date(entry.currentObservedAt * 1000).toLocaleString()}`).join("; ")}` : " · no comparable section delta"}</p><p>{review.targetItem.reason}</p></div>}
    <p>{review.reason} Gold and item changes are separate observations; neither proves a purchase or attributes either change to this work order.</p>
  </section>;
}

function sideDescription(side: NonNullable<ErpWorkOrderProgress["transferObservationReviews"]>[number]["source"]): string {
  const changes = side.comparisons.map((comparison) => `${comparison.section}: ${comparison.previousQuantity} → ${comparison.currentQuantity} (${comparison.delta > 0 ? "+" : ""}${comparison.delta})`).join("; ");
  const state = side.state === "COMPARABLE_CHANGED" ? "recent comparable quantity change"
    : side.state === "COMPARABLE_UNCHANGED" ? "no change in recent comparable observations"
    : "comparison UNKNOWN";
  return `${state} · ${side.freshness} freshness${side.observedAt ? ` · evidence ${new Date(side.observedAt * 1000).toLocaleString()}` : ""}${changes ? ` · ${changes}` : ""}. ${side.reason}`;
}
