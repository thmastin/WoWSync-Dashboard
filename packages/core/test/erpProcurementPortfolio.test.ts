import assert from "node:assert/strict";
import { test } from "node:test";
import { buildErpProcurementBudgetPortfolioReview } from "../src/erpProcurementPortfolio.ts";
import { DashboardReadModel } from "../src/readModel.ts";
import { SqliteSnapshotStore } from "../src/sqliteStore.ts";
import { buildWowSyncExport } from "./fixtureBuilder.ts";

test("purchase budget review aggregates open ceilings against explicit need intent and preserves observed gold separately", () => {
  const store = new SqliteSnapshotStore(":memory:");
  const at = Math.floor(Date.now() / 1000) - 30;
  try {
    const imported = store.importSnapshot(buildWowSyncExport({ generatedAt: at, character: { name: "Budget Buyer", realm: "Realm A", clientVersion: "1.15.7", clientBuild: "60927", moneyCopper: 12000 }, bags: { containers: [{ id: 0, capacity: 16, items: [{ itemRef: "item:159:0:0", name: "Rough Stone", qty: 1 }] }] }, bank: { containers: [] } }));
    const buyer = imported.character.identityKey;
    store.createErpProject({ version: "classic-era", title: "Provision two projects", needs: [
      { stableId: "stone", kind: "ITEM_REF", resourceKey: "item:159:0:0", label: "Rough Stone exact variant", requiredQuantity: 5, sourceIdentityKey: buyer, destinationIdentityKey: buyer },
      { stableId: "cloth", kind: "ITEM_ID", resourceKey: "2589", label: "Linen Cloth", requiredQuantity: 2, sourceIdentityKey: buyer, destinationIdentityKey: buyer },
      { stableId: "budget", kind: "GOLD_COPPER", resourceKey: "copper", label: "Provisioning budget", requiredQuantity: 1000, sourceIdentityKey: buyer, destinationIdentityKey: buyer },
    ], reservations: [{ stableId: "gold-hold", needId: "budget", sourceIdentityKey: buyer, quantity: 100, status: "ACTIVE", createdAt: at, updatedAt: at }], workOrders: [
      { stableId: "buy-stone", kind: "PURCHASE", status: "PLANNED", title: "Review stone quote", assignedIdentityKey: buyer, resourceNeedIds: ["stone", "budget"], dependsOn: [], procurementPlan: { targetNeedId: "stone", budgetNeedId: "budget", spendingCeilingCopper: 700 } },
      { stableId: "buy-cloth", kind: "PURCHASE", status: "IN_PROGRESS", title: "Review cloth quote", assignedIdentityKey: buyer, resourceNeedIds: ["cloth", "budget"], dependsOn: [], procurementPlan: { targetNeedId: "cloth", budgetNeedId: "budget", spendingCeilingCopper: 500 } },
      { stableId: "closed-order", kind: "PURCHASE", status: "COMPLETED", title: "Old completed plan", completionNote: "Player-recorded completion; spending is not verified.", assignedIdentityKey: buyer, resourceNeedIds: ["cloth", "budget"], dependsOn: [], procurementPlan: { targetNeedId: "cloth", budgetNeedId: "budget", spendingCeilingCopper: 9999 } },
    ] });
    store.createErpProject({ version: "classic-era", title: "Separate project budget", needs: [
      { stableId: "other-item", kind: "ITEM_ID", resourceKey: "2780", label: "Light Blazing Charm", requiredQuantity: 1, sourceIdentityKey: buyer, destinationIdentityKey: buyer },
      { stableId: "other-budget", kind: "GOLD_COPPER", resourceKey: "copper", label: "Separate budget", requiredQuantity: 500, sourceIdentityKey: buyer, destinationIdentityKey: buyer },
    ], workOrders: [{ stableId: "other-buy", kind: "PURCHASE", status: "PLANNED", title: "Review other quote", assignedIdentityKey: buyer, resourceNeedIds: ["other-item", "other-budget"], dependsOn: [], procurementPlan: { targetNeedId: "other-item", budgetNeedId: "other-budget", spendingCeilingCopper: 100 } }] });
    const projects = new DashboardReadModel(store).getErpProjects({ version: "classic-era" });
    const review = buildErpProcurementBudgetPortfolioReview(projects, "classic-era");
    assert.equal(review.totalLineCount, 2);
    assert.equal(review.linesOverPlannedBudget, 1);
    assert.equal(review.lines[0]?.openCeilingCopper, 1200, "unfinished plans aggregate; player-completed plans are not current ceilings");
    assert.equal(review.lines[0]?.plannedBudgetCopper, 1000);
    assert.equal(review.lines[0]?.remainingPlannedCopper, -200);
    assert.equal(review.lines[0]?.state, "CEILINGS_EXCEED_PLANNED_BUDGET");
    assert.equal(review.lines[0]?.quoteReview.state, "NO_PLAYER_QUOTES");
    assert.equal(review.lines[0]?.quoteReview.recentQuoteSubtotalCopper, undefined, "no quotes are not rendered as a zero-copper quote");
    assert.equal(review.lines[0]?.evidence.observedCopper, 12000, "gross observed money stays separate from planned ceilings");
    assert.equal(review.lines[0]?.evidence.projectLocalReservedCopper, 100, "reservations are shown as intent and are not subtracted twice");
    assert.deepEqual(review.lines[0]?.orders.map((order) => [order.targetNeedId, order.targetKind, order.targetResourceKey, order.spendingCeilingCopper]), [["stone", "ITEM_REF", "item:159:0:0", 700], ["cloth", "ITEM_ID", "2589", 500]]);
    assert.equal(buildErpProcurementBudgetPortfolioReview(projects, "classic-era", 1).truncated, true, "bounded output reports omitted project budgets");
    assert.equal(buildErpProcurementBudgetPortfolioReview(projects, "retail").totalLineCount, 0, "purchase plans are isolated by explicit game version");

    const base = projects.find((project) => project.title === "Provision two projects")!;
    const purchaseTemplate = base.workOrders.find((order) => order.kind === "PURCHASE" && order.status === "PLANNED")!;
    const overflowView = {
      ...base,
      workOrders: [purchaseTemplate, purchaseTemplate, purchaseTemplate].map((order, index) => ({
        ...order,
        stableId: `huge-ceiling-${index}`,
        procurementPlan: { ...order.procurementPlan!, spendingCeilingCopper: Number.MAX_SAFE_INTEGER },
      })),
      reservations: [0, 1, 2].map((index) => ({
        stableId: `huge-reservation-${index}`, needId: "budget", sourceIdentityKey: buyer,
        quantity: Number.MAX_SAFE_INTEGER, status: "ACTIVE" as const, createdAt: at, updatedAt: at,
      })),
    };
    const overflow = buildErpProcurementBudgetPortfolioReview([overflowView], "classic-era");
    assert.equal(overflow.lines[0]?.openCeilingCopper, undefined, "rounded aggregate is never exposed");
    assert.equal(overflow.lines[0]?.openCeilingExceedsSafeInteger, true);
    assert.equal(overflow.lines[0]?.exceedsPlannedBudget, true, "BigInt comparison still classifies the exact over-plan state");
    assert.equal(overflow.linesOverPlannedBudget, 1);
    assert.equal(overflow.lines[0]?.evidence.projectLocalReservedCopper, undefined);
    assert.equal(overflow.lines[0]?.evidence.reservedCopperExceedsSafeInteger, true);

    const quoteByOrder = new Map([["buy-stone", { amountCopper: 650, quantity: 4 }], ["buy-cloth", { amountCopper: 400, quantity: 2 }]]);
    const quotedProject = {
      ...base,
      workOrders: base.workOrders.map((order) => {
        const quote = quoteByOrder.get(order.stableId);
        return quote ? { ...order, procurementPlan: { ...order.procurementPlan!, playerQuote: { ...quote, recordedAt: at + 30 } } } : order;
      }),
      workOrderReadiness: base.workOrderReadiness.map((entry) => {
        const quote = quoteByOrder.get(entry.workOrderId);
        return quote && entry.procurementAssessment ? { ...entry, procurementAssessment: { ...entry.procurementAssessment, playerQuote: { ...quote, recordedAt: at + 30, freshness: "recent" as const, provenance: "PLAYER_REPORTED" as const } } } : entry;
      }),
    };
    const quoted = buildErpProcurementBudgetPortfolioReview([quotedProject], "classic-era");
    assert.equal(quoted.lines[0]?.quoteReview.state, "RECENT_QUOTES_COVER_OBSERVED_GAPS");
    assert.equal(quoted.lines[0]?.quoteReview.recentQuoteSubtotalCopper, 1050);
    assert.equal(quoted.lines[0]?.quoteReview.comparisonToPlannedBudget, "RECENT_QUOTES_ABOVE_PLANNED_BUDGET");
    const undercoveredProject = { ...quotedProject, workOrders: quotedProject.workOrders.map((order) => order.stableId === "buy-cloth" ? { ...order, procurementPlan: { ...order.procurementPlan!, playerQuote: { amountCopper: 400, quantity: 1, recordedAt: at + 30 } } } : order) };
    const undercovered = buildErpProcurementBudgetPortfolioReview([undercoveredProject], "classic-era");
    assert.equal(undercovered.lines[0]?.quoteReview.state, "INCOMPLETE_OR_STALE_QUOTES");
    assert.equal(undercovered.lines[0]?.quoteReview.quantityInsufficientNeedCount, 1, "quote total for fewer units cannot be compared with the entire need budget");
    assert.equal(undercovered.lines[0]?.quoteReview.comparisonToPlannedBudget, undefined);
  } finally { store.close(); }
});
