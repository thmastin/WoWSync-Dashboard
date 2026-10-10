import assert from "node:assert/strict";
import { test } from "node:test";
import { buildErpProcurementBuyerPortfolioReview } from "../src/erpProcurementBuyerPortfolio.ts";
import { buildAccountContext } from "../src/accountContext.ts";
import { DashboardReadModel } from "../src/readModel.ts";
import { SqliteSnapshotStore } from "../src/sqliteStore.ts";
import { buildWowSyncExport } from "./fixtureBuilder.ts";

test("cross-project buyer review totals only complete recent quotes against one later gold observation after explicit reservations", () => {
  const store = new SqliteSnapshotStore(":memory:");
  const at = Math.floor(Date.now() / 1000) - 30;
  try {
    const imported = store.importSnapshot(buildWowSyncExport({ generatedAt: at, character: { name: "Quote Buyer", realm: "Realm A", clientVersion: "11.2.7", clientBuild: "63854", clientFamily: "Retail", interface: "110207", moneyCopper: 12000 }, bags: { containers: [{ id: 0, capacity: 16, items: [] }] }, bank: { containers: [] } }));
    const buyer = imported.character.identityKey;
    const sourceImport = store.importSnapshot(buildWowSyncExport({ generatedAt: at, character: { name: "Observed Source", realm: "Realm A", clientVersion: "11.2.7", clientBuild: "63854", clientFamily: "Retail", interface: "110207" } }));
    const sourceIdentity = sourceImport.character.identityKey;
    for (const [projectId, itemId, needQty, budgetQty, reserveQty, ceiling, amount] of [
      ["gear-a", "1001", 3, 1000, 100, 700, 650],
      ["gear-b", "1001", 2, 12000, 150, 12000, 11200],
    ] as const) {
      store.createErpProject({ version: "retail", title: projectId, needs: [
        { stableId: `item-${projectId}`, kind: "ITEM_ID", resourceKey: itemId, label: `Item ${itemId}`, requiredQuantity: needQty, sourceIdentityKey: buyer, destinationIdentityKey: buyer },
        { stableId: `gold-${projectId}`, kind: "GOLD_COPPER", resourceKey: "copper", label: "Purchase budget", requiredQuantity: budgetQty, sourceIdentityKey: buyer, destinationIdentityKey: buyer },
      ], reservations: [{ stableId: `reserve-${projectId}`, needId: `gold-${projectId}`, sourceIdentityKey: buyer, quantity: reserveQty, status: "ACTIVE", createdAt: at, updatedAt: at }], workOrders: [
        { stableId: `purchase-${projectId}`, kind: "PURCHASE", status: "PLANNED", title: `Quote ${itemId}`, assignedIdentityKey: buyer, resourceNeedIds: [`item-${projectId}`, `gold-${projectId}`], dependsOn: [], procurementPlan: { targetNeedId: `item-${projectId}`, budgetNeedId: `gold-${projectId}`, spendingCeilingCopper: ceiling, playerQuote: { amountCopper: amount, quantity: needQty, recordedAt: at - 10 } } },
      ] });
    }
    store.createErpProject({ version: "retail", title: "Provision the third character", status: "ACTIVE", priority: 5, needs: [
      { stableId: "third-character-potion", kind: "ITEM_ID", resourceKey: "1001", label: "Provisioning stock", requiredQuantity: 4, sourceIdentityKey: sourceIdentity },
    ], workOrders: [{ stableId: "review-provisioning", kind: "PROVISION", status: "PLANNED", title: "Review the source before provisioning", resourceNeedIds: ["third-character-potion"], dependsOn: [], sourceIdentityKey: sourceIdentity, destinationIdentityKey: buyer }] });
    const projects = new DashboardReadModel(store).getErpProjects({ version: "retail" });
    const review = buildErpProcurementBuyerPortfolioReview(projects, "retail");
    assert.equal(review.totalBuyerCount, 1);
    const line = review.buyers[0]!;
    assert.equal(line.buyerIdentityKey, buyer);
    assert.equal(line.projectCount, 2);
    assert.equal(line.state, "QUOTES_EXCEED_RECORDED_REMAINDER");
    assert.equal(line.recentQuoteTotalCopper, 11850);
    assert.equal(line.observedGoldCopper, 12000);
    assert.equal(line.recordedReservationsCopper, 250);
    assert.equal(line.recordedRemainderCopper, 11750);
    assert.equal(review.unresolvedBuyerOrderCount, 0);
    assert.deepEqual(line.resourcePackages.map((entry) => [entry.kind, entry.resourceKey, entry.projectCount, entry.needCount, entry.state, entry.combinedObservedGapQuantity, entry.recentQuotedQuantity]), [
      ["ITEM_ID", "1001", 2, 2, "QUOTE_QUANTITY_COVERS_COMBINED_OBSERVED_GAPS", 5, 5],
    ], "the exact same item ID need is grouped without applying a generic item-level heuristic");
    const potentialSource = {
      sourceIdentityKey: sourceIdentity, sourceName: "Observed Source", sourceRealm: "Realm A", needId: "item-gear-a",
      kind: "ITEM_ID" as const, resourceKey: "1001", state: "OBSERVED" as const, observedQuantity: 1, activeReservationQuantity: 0,
      reservationState: "UNRESERVED" as const, availableObservedLowerBound: 1, freshness: "recent" as const, observedAt: at,
      locations: [
        { section: "bags" as const, state: "OBSERVED" as const, observedAt: at, completeness: "COMPLETE" as const, quantity: 1 },
        { section: "character bank" as const, state: "OBSERVED" as const, observedAt: at, completeness: "COMPLETE" as const, quantity: 0 },
      ],
      matchingItems: [{ itemRef: "item:1001:0:0:0:0:0:0:0", section: "bags" as const, state: "OBSERVED" as const, quantity: 1, observedAt: at }],
      unresolvedSections: [], accountMembership: "UNKNOWN" as const, access: "UNKNOWN" as const, transferability: "UNKNOWN" as const,
      reason: "Matching resource was observed on this character; route remains unknown.",
    };
    const withSourceReview = projects.map((project) => ({ ...project,
      resourceSourceScreens: project.needs.filter((need) => need.kind === "ITEM_ID" || need.kind === "ITEM_REF").map((need) => ({
        needId: need.stableId, destinationIdentityKey: need.destinationIdentityKey!, scannedCharacterCount: 2, unresolvedCharacterCount: 0, candidateCount: 1, candidatesTruncated: false,
        candidates: [{ ...potentialSource, needId: need.stableId }],
      })),
    }));
    const sourcedPackage = buildErpProcurementBuyerPortfolioReview(withSourceReview, "retail").buyers[0]!.resourcePackages[0]!;
    assert.equal(sourcedPackage.sourceReviewState, "OBSERVED_POTENTIAL_SOURCES");
    assert.equal(sourcedPackage.observedSources.length, 1, "identical observed character/location evidence is represented once across repeated needs");
    assert.equal(sourcedPackage.observedSources[0]!.needReferences.length, 2, "the deduplicated source retains links to every covered project need");
    const sourcedOrder = buildErpProcurementBuyerPortfolioReview(withSourceReview, "retail").buyers[0]!.orders[0]!;
    assert.equal(sourcedOrder.sourceReview.state, "OBSERVED_POTENTIAL_SOURCES", "the individual quote task retains its destination-specific source review even when the buyer has only one need package");
    assert.equal(sourcedOrder.sourceReview.sources.length, 1);
    assert.equal(sourcedOrder.sourceReview.sources[0]!.needReferences[0]!.needId, sourcedOrder.targetNeedId);
    assert.deepEqual(sourcedPackage.observedSources.map((source) => [source.sourceIdentityKey, source.access, source.transferability]), [
      [sourceIdentity, "UNKNOWN", "UNKNOWN"],
    ]);
    assert.equal(sourcedPackage.observedSources[0]!.matchingItems[0]!.itemRef, "item:1001:0:0:0:0:0:0:0", "exact item variant remains available for route review");
    assert.deepEqual(sourcedPackage.sourceCoverageReviews.map((entry) => [entry.sourceIdentityKey, entry.state, entry.availableObservedLowerBound, entry.combinedObservedGapQuantity]), [
      [sourceIdentity, "UNRESERVED_LOWER_BOUND_BELOW_REVIEWED_GAPS", 1, 5],
    ], "one complete matching source is screened against the current gaps without satisfying them");
    assert.equal(sourcedPackage.sourceCoverageReviews[0]!.kind, "ITEM_ID");
    assert.match(sourcedPackage.sourceCoverageReviews[0]!.reason, /access, transferability.*UNKNOWN/);
    assert.equal(sourcedPackage.sourceCoverageReviews[0]!.otherSourceScopedNeedCount, 1, "a separate active project naming this exact source and resource is shown for human review");
    assert.deepEqual(sourcedPackage.sourceCoverageReviews[0]!.otherSourceScopedNeeds.map((need) => [need.projectTitle, need.needId, need.requiredQuantity]), [["Provision the third character", "third-character-potion", 4]]);
    assert.deepEqual(sourcedPackage.sourceCoverageReviews[0]!.otherSourceScopedNeeds[0]!.linkedWorkOrders.map((order) => [order.workOrderId, order.kind, order.status]), [["review-provisioning", "PROVISION", "PLANNED"]], "the source review exposes existing player-authored work without treating it as a transfer");
    assert.equal(sourcedPackage.sourceCoverageReviews[0]!.availableObservedLowerBound, 1, "other project intent is not silently deducted from observed lower-bound quantity");
    assert.match(sourcedPackage.sourceCoverageReviews[0]!.reason, /other active or paused requirement/);
    const pausedOtherPlan = withSourceReview.map((project) => project.title === "Provision the third character" ? { ...project, status: "PAUSED" as const } : project);
    assert.equal(buildErpProcurementBuyerPortfolioReview(pausedOtherPlan, "retail").buyers[0]!.resourcePackages[0]!.sourceCoverageReviews[0]!.otherSourceScopedNeedCount, 1, "paused plans remain reviewable");
    const completedOtherPlan = withSourceReview.map((project) => project.title === "Provision the third character" ? { ...project, status: "COMPLETED" as const } : project);
    assert.equal(buildErpProcurementBuyerPortfolioReview(completedOtherPlan, "retail").buyers[0]!.resourcePackages[0]!.sourceCoverageReviews[0]!.otherSourceScopedNeedCount, 0, "completed plans are not shown as active source demand");
    const missingOtherNeedEvidence = withSourceReview.map((project) => project.title === "Provision the third character" ? { ...project, needEvidence: [] } : project);
    const unknownOtherNeed = buildErpProcurementBuyerPortfolioReview(missingOtherNeedEvidence, "retail").buyers[0]!.resourcePackages[0]!.sourceCoverageReviews[0]!.otherSourceScopedNeeds[0]!;
    assert.deepEqual([unknownOtherNeed.state, unknownOtherNeed.freshness, unknownOtherNeed.requiredQuantity], ["UNKNOWN", "unknown", 4], "missing evidence on a linked project stays explicitly unknown");
    assert.equal(sourcedPackage.combinedObservedGapQuantity, 5, "observed source leads do not reduce or satisfy destination needs");
    assert.equal(sourcedPackage.state, "QUOTE_QUANTITY_COVERS_COMBINED_OBSERVED_GAPS", "source location evidence does not replace quote coverage evidence");
    assert.deepEqual(sourcedPackage.needReviews.map((need) => [need.projectTitle, need.needId, need.state, need.requiredQuantity, need.observedQuantity, need.freshness]), [
      ["gear-a", "item-gear-a", "SHORTFALL_OBSERVED", 3, 0, "recent"],
      ["gear-b", "item-gear-b", "SHORTFALL_OBSERVED", 2, 0, "recent"],
    ], "the grouped resource view retains separate project requirements and their evidence rather than only a combined gap");
    assert.ok(sourcedPackage.needReviews.every((need) => need.linkedWorkOrders.some((order) => order.kind === "PURCHASE" && order.status === "PLANNED")), "the package shows the existing player-authored purchase work for each requirement");
    const incompleteSourceScreens = withSourceReview.map((project) => ({ ...project, resourceSourceScreens: project.resourceSourceScreens.map((screen) => ({ ...screen, unresolvedCharacterCount: 1, candidates: [] })) }));
    assert.equal(buildErpProcurementBuyerPortfolioReview(incompleteSourceScreens, "retail").buyers[0]!.resourcePackages[0]!.sourceReviewState, "SOURCE_SCAN_INCOMPLETE", "no source found in a partial roster scan is not reported as none available");
    const partialWithLead = withSourceReview.map((project) => ({ ...project, resourceSourceScreens: project.resourceSourceScreens.map((screen) => ({ ...screen, unresolvedCharacterCount: 1 })) }));
    assert.equal(buildErpProcurementBuyerPortfolioReview(partialWithLead, "retail").buyers[0]!.resourcePackages[0]!.sourceReviewState, "POTENTIAL_SOURCES_SCAN_INCOMPLETE", "a matching lead remains visible while the overall scan is identified as incomplete");
    assert.equal(buildErpProcurementBuyerPortfolioReview(partialWithLead, "retail").buyers[0]!.resourcePackages[0]!.sourceCoverageReviews[0]!.state, "UNRESERVED_LOWER_BOUND_BELOW_REVIEWED_GAPS", "an incomplete roster scan does not invalidate a complete exact source observation for the grouped requirements");
    const partialSource = withSourceReview.map((project) => ({
      ...project,
      resourceSourceScreens: project.resourceSourceScreens.map((screen) => ({
        ...screen,
        candidates: screen.candidates.map((candidate) => ({
          ...candidate,
          locations: candidate.locations.map((location, index) => index === 1 ? { ...location, completeness: "PARTIAL" } : location),
        })),
      })),
    }));
    assert.equal(buildErpProcurementBuyerPortfolioReview(partialSource, "retail").buyers[0]!.resourcePackages[0]!.sourceCoverageReviews[0]!.state, "SOURCE_OR_NEED_EVIDENCE_INCOMPLETE", "partial source storage coverage withholds combined source coverage");
    const enoughSource = withSourceReview.map((project) => ({ ...project, resourceSourceScreens: project.resourceSourceScreens.map((screen) => ({ ...screen, candidates: screen.candidates.map((candidate) => ({ ...candidate, observedQuantity: 6, availableObservedLowerBound: 6, locations: candidate.locations.map((location) => ({ ...location, quantity: 6 })), matchingItems: candidate.matchingItems.map((item) => ({ ...item, quantity: 6 })) })) })) }));
    const enoughSourcePackage = buildErpProcurementBuyerPortfolioReview(enoughSource, "retail").buyers[0]!.resourcePackages[0]!;
    assert.equal(enoughSourcePackage.sourceCoverageReviews[0]!.state, "UNRESERVED_LOWER_BOUND_COVERS_REVIEWED_GAPS");
    assert.match(enoughSourcePackage.sourceCoverageReviews[0]!.reason, /base item ID.*distinct itemString variants/);
    assert.equal(enoughSourcePackage.needReviews.every((need) => need.state === "SHORTFALL_OBSERVED"), true, "source coverage remains separate from each unmet buyer requirement");
    const noOtherCharacters = withSourceReview.map((project) => ({ ...project, resourceSourceScreens: project.resourceSourceScreens.map((screen) => ({ ...screen, scannedCharacterCount: 0, candidates: [], candidateCount: 0 })) }));
    const noOtherSourceReview = buildErpProcurementBuyerPortfolioReview(noOtherCharacters, "retail").buyers[0]!;
    assert.equal(noOtherSourceReview.resourcePackages[0]!.sourceReviewState, "NO_OTHER_CHARACTERS_TO_SCAN", "an empty roster source scan is not described as a completed scan with no matching stock");
    assert.equal(noOtherSourceReview.orders[0]!.sourceReview.state, "NO_OTHER_CHARACTERS_TO_SCAN");
    assert.equal(buildErpProcurementBuyerPortfolioReview(projects, "classic-era").totalBuyerCount, 0, "project quotes never cross versions");

    const conflictingGold = projects.map((project) => project.title === "gear-b" ? {
      ...project,
      workOrderReadiness: project.workOrderReadiness.map((entry) => entry.procurementAssessment ? {
        ...entry,
        procurementAssessment: {
          ...entry.procurementAssessment,
          budgetEvidence: { ...entry.procurementAssessment.budgetEvidence, observedCopper: 12001 },
        },
      } : entry),
    } : project);
    const conflict = buildErpProcurementBuyerPortfolioReview(conflictingGold, "retail").buyers[0]!;
    assert.equal(conflict.state, "GOLD_OBSERVATION_NOT_COMPARABLE", "different gross-gold observations cannot be combined across projects");
    assert.equal(conflict.recordedRemainderCopper, undefined, "conflicting evidence never yields a remainder");

    const staleQuotes = projects.map((project) => ({ ...project, workOrderReadiness: project.workOrderReadiness.map((entry) => entry.procurementAssessment?.playerQuote ? {
      ...entry,
      procurementAssessment: { ...entry.procurementAssessment, playerQuote: { ...entry.procurementAssessment.playerQuote, freshness: "stale" as const } },
    } : entry) }));
    const staleOnly = buildErpProcurementBuyerPortfolioReview(staleQuotes, "retail").buyers[0]!;
    assert.equal(staleOnly.state, "QUOTE_COVERAGE_INCOMPLETE");
    assert.equal(staleOnly.recentQuoteTotalCopper, undefined, "stale-only amounts are not presented as a zero recent subtotal");

    const staleGapProjects = projects.map((project) => ({ ...project, workOrderReadiness: project.workOrderReadiness.map((entry) => entry.procurementAssessment ? {
      ...entry,
      procurementAssessment: { ...entry.procurementAssessment, targetNeed: { ...entry.procurementAssessment.targetNeed, freshness: "stale" as const } },
    } : entry) }));
    const staleGapReview = buildErpProcurementBuyerPortfolioReview(staleGapProjects, "retail").buyers[0]!;
    assert.equal(staleGapReview.state, "QUOTE_COVERAGE_INCOMPLETE", "a stale SHORTFALL_OBSERVED value is not a current item gap");
    assert.equal(staleGapReview.orders[0]!.targetGap, "UNKNOWN");
    assert.equal(staleGapReview.resourcePackages[0]!.state, "EVIDENCE_INCOMPLETE");

    const firstProject = projects.find((project) => project.workOrders.some((order) => order.kind === "PURCHASE"))!;
    const originalOrder = firstProject.workOrders[0]!;
    const originalReadiness = firstProject.workOrderReadiness.find((entry) => entry.workOrderId === originalOrder.stableId)!;
    const duplicateOrder = { ...originalOrder, stableId: "duplicate-purchase", title: "Additional quote for the same need", procurementPlan: { ...originalOrder.procurementPlan!, playerQuote: { amountCopper: 100, quantity: 1, recordedAt: at - 5, sourceNote: "Second quote line" } } };
    const duplicateReadiness = { ...originalReadiness, workOrderId: duplicateOrder.stableId, procurementAssessment: { ...originalReadiness.procurementAssessment!, playerQuote: { ...originalReadiness.procurementAssessment!.playerQuote!, amountCopper: 100, quantity: 1, recordedAt: at - 5 } } };
    const duplicateOrderReview = buildErpProcurementBuyerPortfolioReview([
      { ...firstProject, workOrders: [...firstProject.workOrders, duplicateOrder], workOrderReadiness: [...firstProject.workOrderReadiness, duplicateReadiness] },
      ...projects.filter((project) => project.stableId !== firstProject.stableId),
    ], "retail").buyers[0]!;
    assert.deepEqual(duplicateOrderReview.resourcePackages.map((entry) => [entry.needCount, entry.combinedObservedGapQuantity, entry.recentQuotedQuantity]), [[2, 5, 6]], "multiple quotes for one need add quote quantity but count that need's observed gap only once");
  } finally { store.close(); }
});

test("AccountContext labels buyer quote aggregates as returned-page counts when the portfolio is truncated", () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    for (let index = 0; index < 201; index++) {
      const imported = store.importSnapshot(buildWowSyncExport({ generatedAt: Math.floor(Date.now() / 1000), character: { name: `Buyer${String(index).padStart(3, "0")}`, realm: "Fixture Realm", clientVersion: "11.2.7", clientBuild: "63854", clientFamily: "Retail", interface: "110207" } }));
      const buyer = imported.character.identityKey;
      store.createErpProject({ version: "retail", title: `Buyer project ${index}`, needs: [
        { stableId: "item", kind: "ITEM_ID", resourceKey: String(100000 + index), label: "Target", requiredQuantity: 1, sourceIdentityKey: buyer, destinationIdentityKey: buyer },
        { stableId: "gold", kind: "GOLD_COPPER", resourceKey: "copper", label: "Budget", requiredQuantity: 1, sourceIdentityKey: buyer, destinationIdentityKey: buyer },
      ], workOrders: [
        { stableId: "purchase", kind: "PURCHASE", status: "PLANNED", title: "Review purchase", assignedIdentityKey: buyer, resourceNeedIds: ["item", "gold"], dependsOn: [], procurementPlan: { targetNeedId: "item", budgetNeedId: "gold", spendingCeilingCopper: 1 } },
      ] });
    }
    const context = store.buildAccountContext();
    const review = context.planning.procurementBuyerReview.retail;
    assert.deepEqual(review, {
      buyerCount: 201,
      returnedBuyerCount: 200,
      returnedQuoteStates: { NO_PLAYER_QUOTES: 200 },
      returnedQuoteTotalsAboveRecordedRemainder: 0,
      returnedIncompleteQuoteCoverage: 0,
      returnedCrossProjectResourcePackageCount: 0,
      returnedPackagesWithObservedSourceLeads: 0,
      returnedPackagesWithIncompleteSourceReview: 0,
      returnedObservedSourceLeadRows: 0,
      returnedPackageNeedReviewCount: 0,
      returnedPackageNeedReviewStates: {},
      returnedPackagesWithOpenProvisioningReview: 0,
      returnedPackageSourceCoverageReviewCount: 0,
      returnedPackageSourceCoverageReviewStates: {},
      returnedSourceCoverageReviewsWithOtherProjectNeeds: 0,
      returnedOtherSourceScopedNeedCount: 0,
      unresolvedBuyerOrderCount: 0,
      truncated: true,
    });
  } finally { store.close(); }
});
