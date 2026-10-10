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
      sourceIdentityKey: "retail::source-character::realm-a", sourceName: "Observed Source", sourceRealm: "Realm A", needId: "item-gear-a",
      kind: "ITEM_ID" as const, resourceKey: "1001", state: "OBSERVED" as const, observedQuantity: 1, activeReservationQuantity: 0,
      reservationState: "UNRESERVED" as const, availableObservedLowerBound: 1, freshness: "recent" as const, observedAt: at,
      locations: [{ section: "bags" as const, state: "OBSERVED" as const, observedAt: at, completeness: "COMPLETE" as const, quantity: 1 }],
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
      ["retail::source-character::realm-a", "UNKNOWN", "UNKNOWN"],
    ]);
    assert.equal(sourcedPackage.observedSources[0]!.matchingItems[0]!.itemRef, "item:1001:0:0:0:0:0:0:0", "exact item variant remains available for route review");
    assert.equal(sourcedPackage.combinedObservedGapQuantity, 5, "observed source leads do not reduce or satisfy destination needs");
    assert.equal(sourcedPackage.state, "QUOTE_QUANTITY_COVERS_COMBINED_OBSERVED_GAPS", "source location evidence does not replace quote coverage evidence");
    const incompleteSourceScreens = withSourceReview.map((project) => ({ ...project, resourceSourceScreens: project.resourceSourceScreens.map((screen) => ({ ...screen, unresolvedCharacterCount: 1, candidates: [] })) }));
    assert.equal(buildErpProcurementBuyerPortfolioReview(incompleteSourceScreens, "retail").buyers[0]!.resourcePackages[0]!.sourceReviewState, "SOURCE_SCAN_INCOMPLETE", "no source found in a partial roster scan is not reported as none available");
    const partialWithLead = withSourceReview.map((project) => ({ ...project, resourceSourceScreens: project.resourceSourceScreens.map((screen) => ({ ...screen, unresolvedCharacterCount: 1 })) }));
    assert.equal(buildErpProcurementBuyerPortfolioReview(partialWithLead, "retail").buyers[0]!.resourcePackages[0]!.sourceReviewState, "POTENTIAL_SOURCES_SCAN_INCOMPLETE", "a matching lead remains visible while the overall scan is identified as incomplete");
    const noOtherCharacters = withSourceReview.map((project) => ({ ...project, resourceSourceScreens: project.resourceSourceScreens.map((screen) => ({ ...screen, scannedCharacterCount: 0, candidates: [], candidateCount: 0 })) }));
    const noOtherSourceReview = buildErpProcurementBuyerPortfolioReview(noOtherCharacters, "retail").buyers[0]!;
    assert.equal(noOtherSourceReview.resourcePackages[0]!.sourceReviewState, "NO_OTHER_CHARACTERS_TO_SCAN", "an empty roster source scan is not described as a completed scan with no matching stock");
    assert.equal(noOtherSourceReview.orders[0]!.sourceReview.state, "NO_OTHER_CHARACTERS_TO_SCAN");
    assert.equal(buildErpProcurementBuyerPortfolioReview(projects, "classic-era").totalBuyerCount, 0, "project quotes never cross versions");

    const conflictingGold = projects.map((project, index) => index === 1 ? {
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

    const firstProject = projects[0]!;
    const originalOrder = firstProject.workOrders[0]!;
    const originalReadiness = firstProject.workOrderReadiness.find((entry) => entry.workOrderId === originalOrder.stableId)!;
    const duplicateOrder = { ...originalOrder, stableId: "duplicate-purchase", title: "Additional quote for the same need", procurementPlan: { ...originalOrder.procurementPlan!, playerQuote: { amountCopper: 100, quantity: 1, recordedAt: at - 5, sourceNote: "Second quote line" } } };
    const duplicateReadiness = { ...originalReadiness, workOrderId: duplicateOrder.stableId, procurementAssessment: { ...originalReadiness.procurementAssessment!, playerQuote: { ...originalReadiness.procurementAssessment!.playerQuote!, amountCopper: 100, quantity: 1, recordedAt: at - 5 } } };
    const duplicateOrderReview = buildErpProcurementBuyerPortfolioReview([
      { ...firstProject, workOrders: [...firstProject.workOrders, duplicateOrder], workOrderReadiness: [...firstProject.workOrderReadiness, duplicateReadiness] },
      ...projects.slice(1),
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
      unresolvedBuyerOrderCount: 0,
      truncated: true,
    });
  } finally { store.close(); }
});
