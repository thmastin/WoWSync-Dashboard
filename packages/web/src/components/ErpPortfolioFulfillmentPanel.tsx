import type { ErpPortfolioFulfillmentReview, ErpSourceFulfillmentReview } from "@wowsync-dashboard/core";
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
function nextReviewLabel(state: ErpSourceFulfillmentReview["sources"][number]["nextReview"]): string {
  switch (state) {
    case "REVIEW_EVIDENCE": return "Review missing or stale evidence";
    case "REVIEW_RESERVATIONS": return "Review reservations";
    case "RECONCILE_OBSERVATIONS": return "Reconcile changed observations";
    case "PLAN_MANUAL_WORK": return "Plan a manual task";
    case "REVIEW_MANUAL_WORK": return "Review blocked manual work";
    case "REVIEW_SOURCE_AND_ACCESS": return "Review source and access";
  }
}

/** Shows portfolio dependency packages alongside needs grouped by an explicitly declared source/resource scope. */
export function ErpPortfolioFulfillmentPanel({ review, sourceReview, characterName }: { review: ErpPortfolioFulfillmentReview; sourceReview: ErpSourceFulfillmentReview; characterName: (identityKey?: string) => string }) {
  return <section className="erp-portfolio-fulfillment" aria-labelledby="erp-portfolio-fulfillment-title" data-testid="erp-portfolio-fulfillment">
    <h2 id="erp-portfolio-fulfillment-title">Portfolio fulfillment review</h2>
    <section aria-labelledby="erp-source-fulfillment-title" data-testid="erp-source-fulfillment">
      <h3 id="erp-source-fulfillment-title">Shared source and resource review</h3>
      <p>These rows join active and paused requirements that explicitly select the same source and exact resource identity, with each need&apos;s evidence, reservations, and linked task observations. This is not a route or availability calculation.</p>
      <p>{sourceReview.totalSourceCount} source/resource groups Â· {sourceReview.totalNeedCount} needs Â· {sourceReview.needsReviewCount} groups have a next review step.</p>
      {!sourceReview.sources.length ? <p>No active or paused needs explicitly select a source for this version.</p> : <ol>{sourceReview.sources.map((source) => <li key={source.stableId} data-testid={`erp-source-fulfillment-${encodeURIComponent(source.stableId)}`}>
        <h4>{source.sourceIdentityKey ? characterName(source.sourceIdentityKey) : `Shared owner ${source.sourceOwnerKey}`} Â· {source.label} (<code>{source.resourceKey}</code>) Â· {source.kind}</h4>
        <p><strong>Next review:</strong> {nextReviewLabel(source.nextReview)}. {source.reason}</p>
        <section aria-label="Other observed locations for this resource">
          <h5>Other observed location leads Â· {source.alternativeLocationReview.replaceAll("_", " ")}</h5>
          {source.alternativeLocations.length ? <ul>{source.alternativeLocations.map((location, index) => <li key={`${location.sourceIdentityKey}:${location.observedAt ?? "unknown"}:${index}`}>
            <strong>{location.sourceName}{location.sourceSurname ? ` ${location.sourceSurname}` : ""} Â· {location.sourceRealm}</strong> Â· {location.state} Â· {location.freshness}{location.observedAt !== undefined ? ` Â· seen ${new Date(location.observedAt * 1000).toLocaleString()}` : " Â· time UNKNOWN"}{location.observedQuantity !== undefined ? ` Â· ${location.observedQuantity} observed` : " Â· current quantity UNKNOWN"}{location.potentialQuantity !== undefined ? ` Â· ${location.potentialQuantity} LAST_SEEN` : ""}{location.availableObservedLowerBound !== undefined ? ` Â· at least ${location.availableObservedLowerBound} below recorded reservations` : " Â· available quantity UNKNOWN"}
            <ul>{location.matchingItems.map((item, itemIndex) => <li key={`${item.itemRef}:${item.section}:${itemIndex}`}><code>{item.itemRef}</code> Â· {item.section} Â· {item.state}{item.quantity !== undefined ? ` Â· ${item.quantity} units` : " Â· quantity UNKNOWN"}</li>)}</ul>
            <p>Membership: {location.accountMembership} Â· access: {location.access} Â· transferability: {location.transferability}. {location.reason}</p>
            {location.needReferences.map((reference) => <a key={`${reference.projectId}:${reference.needId}`} href={`#${erpNeedAnchorId(reference.projectId, reference.needId)}`}>Review location evidence for {reference.projectTitle}</a>)}
          </li>)}</ul> : <p>{source.alternativeLocationReview === "NO_MATCHING_LOCATION_OBSERVED" ? "The scanned same-version characters showed no matching alternative location." : source.alternativeLocationReview === "NO_OTHER_CHARACTERS_TO_SCAN" ? "No other same-version character was available to scan for this review. Other characters or locations may exist and are UNKNOWN." : source.alternativeLocationReview === "SOURCE_REVIEW_UNAVAILABLE" ? "Location review is unavailable for at least one linked need. This does not mean storage is empty." : "Potential locations are unavailable or the character scan was incomplete. This does not mean storage is empty."}</p>}
          {source.alternativeLocationsTruncated && <p role="note">Showing 25 of {source.alternativeLocationCount} location evidence rows.</p>}
          {source.alternativeLocationReview === "POTENTIAL_LOCATIONS_SCAN_INCOMPLETE" && <p role="note">Some potential locations were observed, but the character scan is incomplete. The displayed leads are not a complete list.</p>}
          <small>These rows are location leads. They do not establish account membership, access, ownership, transferability, or a retrieval route.</small>
        </section>
        <ul>{source.needs.map((need) => <li key={`${need.projectId}:${need.needId}`}>
          <strong>{need.projectTitle}</strong> Â· {need.projectStatus} Â· priority {need.projectPriority} Â· requires {need.requiredQuantity} Â· {need.state.replaceAll("_", " ")} Â· {need.freshness}{need.observedQuantity !== undefined ? ` Â· ${need.observedQuantity} OBSERVED` : " Â· current quantity UNKNOWN"}{need.potentialQuantity !== undefined ? ` Â· ${need.potentialQuantity} LAST_SEEN` : ""}{need.observedAt !== undefined ? ` Â· ${new Date(need.observedAt * 1000).toLocaleString()}` : " Â· timestamp UNKNOWN"}
          <p>Destination: {characterName(need.destinationIdentityKey)}. Sections: {need.sourceSections.length ? need.sourceSections.map((section) => `${section.section} ${section.state}${section.completeness ? ` (${section.completeness})` : ""}${section.observedAt !== undefined ? ` at ${new Date(section.observedAt * 1000).toLocaleString()}` : ""}`).join("; ") : "UNKNOWN"}. Reservations: {need.reservationAssessment ? `${need.reservationAssessment.activeQuantity} Â· ${need.reservationAssessment.state.replaceAll("_", " ")}` : "UNKNOWN"}. {need.unresolvedSections.length ? `Unresolved: ${need.unresolvedSections.join(", ")}. ` : ""}{need.reason}</p>
          {need.workOrders.length ? <ul aria-label={`Linked work for ${need.label}`}>{need.workOrders.map((order) => <li key={order.stableId}>{order.kind} Â· recorded status {order.status.replaceAll("_", " ")} Â· readiness {order.readinessState?.replaceAll("_", " ") ?? "UNKNOWN"}{order.progressState ? ` Â· progress ${order.progressState.replaceAll("_", " ")}` : ""}{order.observationStates.length ? ` Â· paired evidence ${order.observationStates.join(", ")}` : " Â· no comparable paired observation"}{order.capabilityChecks.length ? ` Â· capability evidence ${order.capabilityChecks.map((check) => `${check.kind} ${check.state}`).join(", ")}` : ""}{order.plannedOutputState ? ` Â· planned output observation ${order.plannedOutputState}` : ""}{order.procurement ? ` Â· purchase ${order.procurement.reviewState}, quote ${order.procurement.quoteState}${order.procurement.quote ? ` (${order.procurement.quote.amountCopper} copper for ${order.procurement.quote.quantity}, ${order.procurement.quote.freshness})` : ""}; market availability and affordability UNKNOWN` : ""}: {order.title}. {order.reason ?? ""}</li>)}</ul> : <p>No linked manual task is recorded for this need.</p>}
          <a href={`#${erpNeedAnchorId(need.projectId, need.needId)}`}>Open requirement, evidence, and manual task controls</a>
        </li>)}</ul>
        <p>Source scope is explicit player intent. It does not establish ownership, accessibility, a transfer/crafting/purchase route, or task completion.</p>
      </li>)}</ol>}
      {sourceReview.truncated && <p role="note">Showing {sourceReview.returnedSourceCount} of {sourceReview.totalSourceCount} source/resource groups; this review is incomplete.</p>}
      <small>Changed quantities and paired observations preserve cause UNKNOWN. Reservations remain commitments, not proof of possession.</small>
    </section>
    <h3>Player-authored dependency packages</h3>
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
            {step.workOrders.length ? <ul aria-label={`Manual work for ${step.needLabel}`}>{step.workOrders.map((order) => <li key={order.stableId}><a href={`#${erpNeedAnchorId(step.projectId, step.needId)}`}>{order.title}</a> · recorded status {order.status.replaceAll("_", " ")} · readiness {order.readinessState.replaceAll("_", " ")}{order.progressState ? ` · reconciliation ${order.progressState.replaceAll("_", " ")}` : ""}</li>)}</ul> : <p>No linked manual work order is recorded for this requirement.</p>}
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
