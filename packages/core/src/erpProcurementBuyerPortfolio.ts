import type { ErpProjectView } from "./erpProjects.ts";
import type { VersionOrUnknown, WowVersion } from "./types.ts";

export interface ErpProcurementBuyerOrder {
  readonly projectId: string;
  readonly projectTitle: string;
  readonly workOrderId: string;
  readonly targetNeedId: string;
  readonly targetLabel: string;
  readonly targetResourceKey: string;
  readonly quote?: { readonly amountCopper: number; readonly quantity: number; readonly recordedAt: number; readonly freshness: string };
  readonly targetGap: "OBSERVED_GAP" | "UNKNOWN";
}

export interface ErpProcurementBuyerResourcePackage {
  readonly kind: "ITEM_ID" | "ITEM_REF";
  readonly resourceKey: string;
  readonly projectCount: number;
  readonly needCount: number;
  readonly state: "QUOTE_QUANTITY_COVERS_COMBINED_OBSERVED_GAPS" | "QUOTE_QUANTITY_BELOW_COMBINED_OBSERVED_GAPS" | "EVIDENCE_INCOMPLETE" | "AGGREGATE_EXCEEDS_SAFE_INTEGER";
  readonly combinedObservedGapQuantity?: number;
  readonly recentQuotedQuantity?: number;
  readonly recentQuoteTotalCopper?: number;
  readonly reason: string;
  readonly orders: readonly ErpProcurementBuyerOrder[];
}

export interface ErpProcurementBuyerLine {
  readonly version: WowVersion;
  readonly buyerIdentityKey: string;
  readonly projectCount: number;
  readonly orderCount: number;
  readonly quoteCount: number;
  readonly state: "NO_PLAYER_QUOTES" | "QUOTE_COVERAGE_INCOMPLETE" | "GOLD_OBSERVATION_NOT_COMPARABLE" | "GOLD_SNAPSHOT_NOT_LATER_THAN_QUOTES" | "RECORDED_RESERVATIONS_EXCEED_OBSERVED_GOLD" | "QUOTES_AT_OR_BELOW_RECORDED_REMAINDER" | "QUOTES_EXCEED_RECORDED_REMAINDER" | "AGGREGATE_EXCEEDS_SAFE_INTEGER";
  readonly recentQuoteTotalCopper?: number;
  readonly observedGoldCopper?: number;
  readonly observedGoldAt?: number;
  readonly recordedReservationsCopper?: number;
  readonly recordedRemainderCopper?: number;
  readonly reason: string;
  readonly orders: readonly ErpProcurementBuyerOrder[];
  /** Exact resource matches shared by this buyer's needs in multiple projects; variants are never collapsed. */
  readonly resourcePackages: readonly ErpProcurementBuyerResourcePackage[];
}

export interface ErpProcurementBuyerPortfolioReview {
  readonly version: VersionOrUnknown;
  readonly buyers: readonly ErpProcurementBuyerLine[];
  readonly totalBuyerCount: number;
  readonly returnedBuyerCount: number;
  readonly unresolvedBuyerOrderCount: number;
  readonly truncated: boolean;
}

interface Candidate {
  projectId: string;
  projectTitle: string;
  workOrderId: string;
  targetNeedId: string;
  targetKind: "ITEM_ID" | "ITEM_REF";
  targetLabel: string;
  targetResourceKey: string;
  buyerIdentityKey: string;
  amount?: number;
  quantity?: number;
  recordedAt?: number;
  quoteFreshness?: string;
  targetGap?: "OBSERVED_GAP" | "UNKNOWN";
  requiredQuantity?: number;
  observedQuantity?: number;
  observedGold?: number;
  observedGoldAt?: number;
  goldFreshness?: string;
  reservationTotal?: number;
  reservationState?: string;
}

/** Compares complete player-entered purchase plans only when one buyer's dated gold and reservation evidence is consistent. */
export function buildErpProcurementBuyerPortfolioReview(
  projects: readonly ErpProjectView[],
  version: VersionOrUnknown,
  limit = 100,
): ErpProcurementBuyerPortfolioReview {
  if (version === "unknown-version") return { version, buyers: [], totalBuyerCount: 0, returnedBuyerCount: 0, unresolvedBuyerOrderCount: 0, truncated: false };
  const grouped = new Map<string, Candidate[]>();
  let unresolvedBuyerOrderCount = 0;
  for (const project of projects) {
    if (project.version !== version || project.status === "CANCELLED") continue;
    for (const order of project.workOrders) {
      if (order.kind !== "PURCHASE" || order.status === "COMPLETED" || order.status === "CANCELLED" || !order.procurementPlan?.budgetNeedId || !order.procurementPlan.targetNeedId) continue;
      const budget = project.needs.find((need) => need.stableId === order.procurementPlan!.budgetNeedId && need.kind === "GOLD_COPPER");
      const buyer = order.assignedIdentityKey;
      if (!budget || !buyer || budget.sourceIdentityKey !== buyer || budget.destinationIdentityKey !== buyer) { unresolvedBuyerOrderCount++; continue; }
      const target = project.needs.find((need) => need.stableId === order.procurementPlan!.targetNeedId && (need.kind === "ITEM_ID" || need.kind === "ITEM_REF"));
      const assessment = project.workOrderReadiness.find((entry) => entry.workOrderId === order.stableId)?.procurementAssessment;
      if (!target || !assessment || assessment.buyerIdentityKey !== buyer) { unresolvedBuyerOrderCount++; continue; }
      const quote = order.procurementPlan.playerQuote;
      const targetNeed = assessment.targetNeed;
      const entry: Candidate = {
        projectId: project.stableId, projectTitle: project.title, workOrderId: order.stableId,
        targetNeedId: target.stableId, targetLabel: target.label, targetResourceKey: target.resourceKey,
        targetKind: target.kind as "ITEM_ID" | "ITEM_REF",
        buyerIdentityKey: buyer,
        ...(quote ? { amount: quote.amountCopper, quantity: quote.quantity, recordedAt: quote.recordedAt, quoteFreshness: assessment.playerQuote?.freshness ?? "unknown" } : {}),
        targetGap: targetNeed.freshness === "recent" && targetNeed.state === "SHORTFALL_OBSERVED" && targetNeed.observedQuantity !== undefined ? "OBSERVED_GAP" : "UNKNOWN",
        requiredQuantity: targetNeed.requiredQuantity,
        ...(targetNeed.observedQuantity !== undefined ? { observedQuantity: targetNeed.observedQuantity } : {}),
        ...(assessment.budgetEvidence.observedCopper !== undefined ? { observedGold: assessment.budgetEvidence.observedCopper } : {}),
        ...(assessment.budgetEvidence.observedAt !== undefined ? { observedGoldAt: assessment.budgetEvidence.observedAt } : {}),
        goldFreshness: assessment.budgetEvidence.freshness,
        reservationTotal: assessment.recordedGoldReservationsCopper,
        reservationState: assessment.recordedGoldReservationState,
      };
      const list = grouped.get(buyer) ?? [];
      list.push(entry);
      grouped.set(buyer, list);
    }
  }

  const buyers: ErpProcurementBuyerLine[] = [...grouped].map(([buyerIdentityKey, entries]) => {
    const quoteEntries = entries.filter((entry) => entry.amount !== undefined);
    const recent = quoteEntries.filter((entry) => entry.quoteFreshness === "recent");
    const quotesComplete = entries.length > 0 && quoteEntries.length === entries.length && recent.length === entries.length;
    const quantitiesByNeed = new Map<string, bigint>();
    for (const entry of recent) {
      const key = `${entry.projectId}\u0000${entry.targetNeedId}`;
      quantitiesByNeed.set(key, (quantitiesByNeed.get(key) ?? 0n) + BigInt(entry.quantity!));
    }
    const needGroups = new Map<string, Candidate[]>();
    for (const entry of entries) {
      const key = `${entry.projectId}\u0000${entry.targetNeedId}`;
      needGroups.set(key, [...(needGroups.get(key) ?? []), entry]);
    }
    const gapsCovered = [...needGroups].every(([key, needEntries]) => {
      const target = needEntries[0]!;
      if (target.targetGap !== "OBSERVED_GAP" || target.observedQuantity === undefined || target.requiredQuantity === undefined) return false;
      return (quantitiesByNeed.get(key) ?? 0n) >= BigInt(Math.max(0, target.requiredQuantity - target.observedQuantity));
    });
    const recentQuoteTotal = recent.reduce((sum, entry) => sum + BigInt(entry.amount!), 0n);
    const quoteTotalUnsafe = recentQuoteTotal > BigInt(Number.MAX_SAFE_INTEGER);
    const goldFacts = entries.map((entry) => `${entry.observedGold ?? "?"}:${entry.observedGoldAt ?? "?"}:${entry.goldFreshness ?? "unknown"}`);
    const reservationFacts = entries.map((entry) => `${entry.reservationTotal ?? "?"}:${entry.reservationState ?? "unknown"}`);
    const oneGoldSnapshot = new Set(goldFacts).size === 1 && entries[0]?.observedGold !== undefined && entries[0]?.observedGoldAt !== undefined && entries[0]?.goldFreshness === "recent";
    const oneReservationAssessment = new Set(reservationFacts).size === 1 && entries[0]?.reservationTotal !== undefined && ["NO_RECORDED_RESERVATIONS", "RECENT_GROSS_GOLD_COVERS_RECORDED_RESERVATIONS", "RECENT_GROSS_GOLD_BELOW_RECORDED_RESERVATIONS"].includes(entries[0]?.reservationState ?? "");
    const allQuotesPostdateGold = entries.every((entry) => entry.amount !== undefined && entry.quoteFreshness === "recent" && entry.recordedAt !== undefined && entry.observedGoldAt !== undefined && entry.observedGoldAt > entry.recordedAt);
    const allReservationsFit = entries[0]?.reservationState !== "RECENT_GROSS_GOLD_BELOW_RECORDED_RESERVATIONS";
    let state: ErpProcurementBuyerLine["state"];
    let reason: string;
    let recordedRemainderCopper: number | undefined;
    if (quoteEntries.length === 0) { state = "NO_PLAYER_QUOTES"; reason = "No player-reported quotes are recorded for this buyer's open, explicitly budget-linked purchases."; }
    else if (!quotesComplete || !gapsCovered) { state = "QUOTE_COVERAGE_INCOMPLETE"; reason = "Every open purchase needs a recent player quote whose recorded quantity covers its current observed item gap before combined comparison."; }
    else if (!oneGoldSnapshot || !oneReservationAssessment || !allQuotesPostdateGold) { state = "GOLD_OBSERVATION_NOT_COMPARABLE"; reason = "Buyer gold observations, timestamps, freshness, or same-version reservation assessments do not establish one consistent snapshot later than every quote."; }
    else if (!allReservationsFit) { state = "RECORDED_RESERVATIONS_EXCEED_OBSERVED_GOLD"; reason = "Explicit buyer-scoped reservations exceed the consistent observed gross-gold snapshot; no remainder or affordability is inferred."; }
    else {
      const gold = BigInt(entries[0]!.observedGold!);
      const reserved = BigInt(entries[0]!.reservationTotal!);
      const remainder = gold - reserved;
      if (quoteTotalUnsafe || remainder > BigInt(Number.MAX_SAFE_INTEGER)) { state = "AGGREGATE_EXCEEDS_SAFE_INTEGER"; reason = "An exact quote or recorded remainder exceeds the safe display range; aggregate comparison is withheld."; }
      else {
        recordedRemainderCopper = Number(remainder);
        state = recentQuoteTotal > remainder ? "QUOTES_EXCEED_RECORDED_REMAINDER" : "QUOTES_AT_OR_BELOW_RECORDED_REMAINDER";
        reason = "This compares recent player-reported quote totals with one later gross-gold snapshot after explicitly recorded same-buyer reservations. It is not an affordability result or a complete obligations ledger.";
      }
    }
    const projectCount = new Set(entries.map((entry) => entry.projectId)).size;
    const resourceGroups = new Map<string, Candidate[]>();
    for (const entry of entries) {
      const key = `${entry.targetKind}\u0000${entry.targetResourceKey}`;
      resourceGroups.set(key, [...(resourceGroups.get(key) ?? []), entry]);
    }
    const resourcePackages: ErpProcurementBuyerResourcePackage[] = [...resourceGroups.values()].flatMap((group) => {
      const packageProjectCount = new Set(group.map((entry) => entry.projectId)).size;
      if (packageProjectCount < 2) return [];
      const uniqueNeeds = [...new Map(group.map((entry) => [`${entry.projectId}\u0000${entry.targetNeedId}`, entry])).values()];
      const completeGaps = uniqueNeeds.every((entry) => entry.targetGap === "OBSERVED_GAP" && entry.requiredQuantity !== undefined && entry.observedQuantity !== undefined);
      const gapTotal = uniqueNeeds.reduce((sum, entry) => sum + (entry.requiredQuantity !== undefined && entry.observedQuantity !== undefined ? BigInt(Math.max(0, entry.requiredQuantity - entry.observedQuantity)) : 0n), 0n);
      const packageQuotes = group.filter((entry) => entry.amount !== undefined && entry.quoteFreshness === "recent");
      const quotesComplete = packageQuotes.length === group.length;
      const quoteQuantity = packageQuotes.reduce((sum, entry) => sum + BigInt(entry.quantity!), 0n);
      const quoteTotal = packageQuotes.reduce((sum, entry) => sum + BigInt(entry.amount!), 0n);
      const unsafe = gapTotal > BigInt(Number.MAX_SAFE_INTEGER) || quoteQuantity > BigInt(Number.MAX_SAFE_INTEGER) || quoteTotal > BigInt(Number.MAX_SAFE_INTEGER);
      const first = group[0]!;
      const state: ErpProcurementBuyerResourcePackage["state"] = unsafe ? "AGGREGATE_EXCEEDS_SAFE_INTEGER"
        : !completeGaps || !quotesComplete ? "EVIDENCE_INCOMPLETE"
          : quoteQuantity >= gapTotal ? "QUOTE_QUANTITY_COVERS_COMBINED_OBSERVED_GAPS"
            : "QUOTE_QUANTITY_BELOW_COMBINED_OBSERVED_GAPS";
      return [{
        kind: first.targetKind, resourceKey: first.targetResourceKey, projectCount: packageProjectCount, needCount: uniqueNeeds.length, state,
        ...(!unsafe && completeGaps ? { combinedObservedGapQuantity: Number(gapTotal) } : {}),
        ...(!unsafe && packageQuotes.length ? { recentQuotedQuantity: Number(quoteQuantity), recentQuoteTotalCopper: Number(quoteTotal) } : {}),
        reason: unsafe ? "An exact quantity or quote aggregate exceeds the safe display range; package comparison is withheld."
          : !completeGaps || !quotesComplete ? "Every matching project need needs a current observed gap and recent player quote before combined quantity coverage can be assessed."
            : quoteQuantity >= gapTotal ? "Recent player-entered quote quantities cover the sum of currently observed gaps for this exact resource identity. This groups review only; no purchase, ownership, or allocation is inferred."
              : "Recent player-entered quote quantities are below the sum of currently observed gaps for this exact resource identity.",
        orders: group.map((entry) => ({ projectId: entry.projectId, projectTitle: entry.projectTitle, workOrderId: entry.workOrderId, targetNeedId: entry.targetNeedId, targetLabel: entry.targetLabel, targetResourceKey: entry.targetResourceKey, targetGap: entry.targetGap ?? "UNKNOWN", ...(entry.amount !== undefined ? { quote: { amountCopper: entry.amount, quantity: entry.quantity!, recordedAt: entry.recordedAt!, freshness: entry.quoteFreshness! } } : {}) })),
      }];
    }).sort((a, b) => a.kind.localeCompare(b.kind) || a.resourceKey.localeCompare(b.resourceKey));
    return {
      version, buyerIdentityKey, projectCount, orderCount: entries.length, quoteCount: quoteEntries.length, state,
      ...(!quoteTotalUnsafe && recent.length ? { recentQuoteTotalCopper: Number(recentQuoteTotal) } : {}),
      ...(oneGoldSnapshot ? { observedGoldCopper: entries[0]!.observedGold, observedGoldAt: entries[0]!.observedGoldAt } : {}),
      ...(oneReservationAssessment ? { recordedReservationsCopper: entries[0]!.reservationTotal } : {}),
      ...(recordedRemainderCopper !== undefined ? { recordedRemainderCopper } : {}), reason,
      orders: entries.map((entry) => ({ projectId: entry.projectId, projectTitle: entry.projectTitle, workOrderId: entry.workOrderId, targetNeedId: entry.targetNeedId, targetLabel: entry.targetLabel, targetResourceKey: entry.targetResourceKey, targetGap: entry.targetGap ?? "UNKNOWN", ...(entry.amount !== undefined ? { quote: { amountCopper: entry.amount, quantity: entry.quantity!, recordedAt: entry.recordedAt!, freshness: entry.quoteFreshness! } } : {}) })),
      resourcePackages,
    };
  }).sort((a, b) => a.buyerIdentityKey.localeCompare(b.buyerIdentityKey));
  const safeLimit = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 500) : 100;
  const returned = buyers.slice(0, safeLimit);
  return { version, buyers: returned, totalBuyerCount: buyers.length, returnedBuyerCount: returned.length, unresolvedBuyerOrderCount, truncated: returned.length < buyers.length };
}
