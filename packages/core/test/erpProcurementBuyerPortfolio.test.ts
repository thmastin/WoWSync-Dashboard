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
      ["gear-b", "1002", 2, 12000, 150, 12000, 11200],
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
      unresolvedBuyerOrderCount: 0,
      truncated: true,
    });
  } finally { store.close(); }
});
