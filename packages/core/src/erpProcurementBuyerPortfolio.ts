import type { ErpNeedEvidence, ErpProjectStatus, ErpProjectView, ErpWorkOrder, ErpWorkOrderStatus } from "./erpProjects.ts";
import type { VersionOrUnknown, WowVersion } from "./types.ts";

export type ErpProcurementSourceReviewState = "OBSERVED_POTENTIAL_SOURCES" | "POTENTIAL_SOURCES_SCAN_INCOMPLETE" | "NO_MATCHING_SOURCE_OBSERVED" | "NO_OTHER_CHARACTERS_TO_SCAN" | "SOURCE_SCAN_INCOMPLETE" | "SOURCE_REVIEW_UNAVAILABLE";

export interface ErpProcurementSourceLead {
  readonly needReferences: readonly { readonly projectId: string; readonly projectTitle: string; readonly needId: string }[];
  readonly sourceIdentityKey: string;
  readonly sourceName: string;
  readonly sourceSurname?: string;
  readonly sourceRealm: string;
  readonly state: "OBSERVED" | "LAST_SEEN";
  readonly observedQuantity?: number;
  readonly potentialQuantity?: number;
  readonly activeReservationQuantity: number;
  readonly reservationState: "UNRESERVED" | "WITHIN_OBSERVED_SUPPLY" | "OVER_RESERVED" | "UNKNOWN";
  readonly availableObservedLowerBound?: number;
  readonly freshness: string;
  readonly observedAt?: number;
  readonly locations: readonly { readonly section: "bags" | "character bank"; readonly state: "OBSERVED" | "LAST_SEEN" | "UNKNOWN"; readonly observedAt?: number; readonly completeness?: string; readonly quantity?: number; readonly knownLowerBound?: number }[];
  readonly matchingItems: readonly { readonly itemRef: string; readonly section: "bags" | "character bank"; readonly state: "OBSERVED" | "LAST_SEEN"; readonly quantity?: number; readonly knownLowerBound?: number; readonly observedAt?: number }[];
  readonly accountMembership: "UNKNOWN";
  readonly access: "UNKNOWN";
  readonly transferability: "UNKNOWN";
  readonly reason: string;
}

export interface ErpProcurementSourceReview {
  readonly state: ErpProcurementSourceReviewState;
  readonly sources: readonly ErpProcurementSourceLead[];
}

export interface ErpProcurementBuyerOrder {
  readonly projectId: string;
  readonly projectTitle: string;
  readonly workOrderId: string;
  readonly targetNeedId: string;
  readonly targetLabel: string;
  readonly targetResourceKey: string;
  readonly quote?: { readonly amountCopper: number; readonly quantity: number; readonly recordedAt: number; readonly freshness: string };
  readonly targetGap: "OBSERVED_GAP" | "UNKNOWN";
  readonly sourceReview: ErpProcurementSourceReview;
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
  /** Exact-resource character locations already found by per-need source screening. These are leads to review, not accessible supply. */
  readonly sourceReviewState: ErpProcurementSourceReviewState;
  readonly observedSources: readonly ErpProcurementSourceLead[];
  /** Compares one consistent same-version source observation with the sum of this package's current needs; this is location screening, never a transfer/allocation claim. */
  readonly sourceCoverageReviews: readonly {
    readonly sourceIdentityKey: string;
    readonly sourceName: string;
    readonly kind: "ITEM_ID" | "ITEM_REF";
    readonly state: "UNRESERVED_LOWER_BOUND_COVERS_REVIEWED_GAPS" | "UNRESERVED_LOWER_BOUND_BELOW_REVIEWED_GAPS" | "SOURCE_OR_NEED_EVIDENCE_INCOMPLETE";
    readonly needCount: number;
    readonly expectedNeedCount: number;
    readonly availableObservedLowerBound?: number;
    readonly combinedObservedGapQuantity?: number;
    readonly observedAt?: number;
    readonly freshness: string;
    /** Other explicit same-source project intent; shown as competing plans, not deducted unless already represented by reservations. */
    readonly otherSourceScopedNeedCount: number;
    readonly otherSourceScopedNeedsTruncated: boolean;
    readonly otherSourceScopedNeeds: readonly {
      readonly projectId: string;
      readonly projectTitle: string;
      readonly projectStatus: ErpProjectStatus;
      readonly projectPriority: number;
      readonly needId: string;
      readonly label: string;
      readonly state: ErpNeedEvidence["state"];
      readonly freshness: ErpNeedEvidence["freshness"];
      readonly requiredQuantity: number;
      readonly observedQuantity?: number;
      readonly activeReservationQuantity?: number;
      readonly observedAt?: number;
      readonly reason: string;
      readonly linkedWorkOrders: readonly {
        readonly workOrderId: string;
        readonly kind: ErpWorkOrder["kind"];
        readonly status: ErpWorkOrderStatus;
        readonly title: string;
        readonly readinessState?: ErpProjectView["workOrderReadiness"][number]["state"];
        readonly progressState?: ErpProjectView["workOrderProgress"][number]["reconciliation"];
        readonly reason?: string;
      }[];
    }[];
    readonly reason: string;
  }[];
  /** Per-project demand and existing-work context; requirements are never merged merely because item identity matches. */
  readonly needReviews: readonly {
    readonly projectId: string;
    readonly projectTitle: string;
    readonly projectStatus: ErpProjectStatus;
    readonly projectRevision: number;
    readonly projectPriority: number;
    readonly needId: string;
    readonly label: string;
    readonly state: ErpNeedEvidence["state"];
    readonly requiredQuantity: number;
    readonly observedQuantity?: number;
    readonly potentialQuantity?: number;
    readonly observedAt?: number;
    readonly freshness: ErpNeedEvidence["freshness"];
    readonly reservationState?: NonNullable<ErpNeedEvidence["reservationAssessment"]>["state"];
    readonly activeReservationQuantity?: number;
    readonly sourceSections: ErpNeedEvidence["sourceSections"];
    readonly unresolvedSections: ErpNeedEvidence["unresolvedSections"];
    readonly reason: string;
    readonly linkedWorkOrders: readonly {
      readonly workOrderId: string;
      readonly kind: ErpWorkOrder["kind"];
      readonly status: ErpWorkOrderStatus;
      readonly title: string;
      readonly readinessState?: ErpProjectView["workOrderReadiness"][number]["state"];
      readonly progressState?: ErpProjectView["workOrderProgress"][number]["reconciliation"];
      readonly reason?: string;
    }[];
  }[];
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
  needReview: ErpProcurementBuyerResourcePackage["needReviews"][number];
}

function reviewSources(project: ErpProjectView | undefined, needId: string, kind: "ITEM_ID" | "ITEM_REF", resourceKey: string): ErpProcurementSourceReview {
  const screen = project?.resourceSourceScreens.find((entry) => entry.needId === needId);
  if (!project || !screen) return { state: "SOURCE_REVIEW_UNAVAILABLE", sources: [] };
  const incomplete = screen.unresolvedCharacterCount > 0 || screen.candidatesTruncated;
  const sources: ErpProcurementSourceLead[] = screen.candidates.filter((candidate) => candidate.kind === kind && candidate.resourceKey === resourceKey).map((candidate) => ({
    needReferences: [{ projectId: project.stableId, projectTitle: project.title, needId }], sourceIdentityKey: candidate.sourceIdentityKey, sourceName: candidate.sourceName,
    ...(candidate.sourceSurname ? { sourceSurname: candidate.sourceSurname } : {}), sourceRealm: candidate.sourceRealm, state: candidate.state,
    ...(candidate.observedQuantity !== undefined ? { observedQuantity: candidate.observedQuantity } : {}), ...(candidate.potentialQuantity !== undefined ? { potentialQuantity: candidate.potentialQuantity } : {}),
    activeReservationQuantity: candidate.activeReservationQuantity, reservationState: candidate.reservationState,
    ...(candidate.availableObservedLowerBound !== undefined ? { availableObservedLowerBound: candidate.availableObservedLowerBound } : {}), freshness: candidate.freshness,
    ...(candidate.observedAt !== undefined ? { observedAt: candidate.observedAt } : {}), locations: candidate.locations, matchingItems: candidate.matchingItems,
    accountMembership: candidate.accountMembership, access: candidate.access, transferability: candidate.transferability, reason: candidate.reason,
  }));
  return { state: sources.length ? incomplete ? "POTENTIAL_SOURCES_SCAN_INCOMPLETE" : "OBSERVED_POTENTIAL_SOURCES" : incomplete ? "SOURCE_SCAN_INCOMPLETE" : screen.scannedCharacterCount === 0 ? "NO_OTHER_CHARACTERS_TO_SCAN" : "NO_MATCHING_SOURCE_OBSERVED", sources };
}

/** Compares complete player-entered purchase plans only when one buyer's dated gold and reservation evidence is consistent. */
export function buildErpProcurementBuyerPortfolioReview(
  projects: readonly ErpProjectView[],
  version: VersionOrUnknown,
  limit = 100,
): ErpProcurementBuyerPortfolioReview {
  if (version === "unknown-version") return { version, buyers: [], totalBuyerCount: 0, returnedBuyerCount: 0, unresolvedBuyerOrderCount: 0, truncated: false };
  const projectsById = new Map(projects.filter((project) => project.version === version).map((project) => [project.stableId, project]));
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
      const linkedWorkOrders = project.workOrders.filter((candidate) => candidate.resourceNeedIds.includes(target.stableId)).map((candidate) => {
        const readiness = project.workOrderReadiness.find((entry) => entry.workOrderId === candidate.stableId);
        const progress = project.workOrderProgress.find((entry) => entry.workOrderId === candidate.stableId);
        return { workOrderId: candidate.stableId, kind: candidate.kind, status: candidate.status, title: candidate.title, ...(readiness ? { readinessState: readiness.state } : {}), ...(progress ? { progressState: progress.reconciliation, reason: progress.reason } : readiness ? { reason: readiness.reason } : {}) };
      });
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
        needReview: { projectId: project.stableId, projectTitle: project.title, projectStatus: project.status, projectRevision: project.revision, projectPriority: project.priority, needId: target.stableId, label: target.label, state: targetNeed.state, requiredQuantity: targetNeed.requiredQuantity, ...(targetNeed.observedQuantity !== undefined ? { observedQuantity: targetNeed.observedQuantity } : {}), ...(targetNeed.potentialQuantity !== undefined ? { potentialQuantity: targetNeed.potentialQuantity } : {}), ...(targetNeed.observedAt !== undefined ? { observedAt: targetNeed.observedAt } : {}), freshness: targetNeed.freshness, ...(targetNeed.reservationState ? { reservationState: targetNeed.reservationState } : {}), ...(targetNeed.activeReservationQuantity !== undefined ? { activeReservationQuantity: targetNeed.activeReservationQuantity } : {}), sourceSections: targetNeed.sourceSections, unresolvedSections: targetNeed.unresolvedSections, reason: targetNeed.reason, linkedWorkOrders },
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
      const needReviews = [...new Map(group.map((entry) => [`${entry.projectId}\u0000${entry.targetNeedId}`, entry.needReview])).values()].sort((a, b) => b.projectPriority - a.projectPriority || a.projectTitle.localeCompare(b.projectTitle) || a.needId.localeCompare(b.needId));
      const sourceReviewRows = uniqueNeeds.flatMap((entry) => {
        const project = projectsById.get(entry.projectId);
        const screen = project?.resourceSourceScreens.find((candidate) => candidate.needId === entry.targetNeedId);
        return (screen?.candidates ?? []).filter((candidate) => candidate.kind === entry.targetKind && candidate.resourceKey === entry.targetResourceKey).map((candidate) => ({
          needReferences: [{ projectId: entry.projectId, projectTitle: entry.projectTitle, needId: entry.targetNeedId }],
          sourceIdentityKey: candidate.sourceIdentityKey, sourceName: candidate.sourceName, ...(candidate.sourceSurname ? { sourceSurname: candidate.sourceSurname } : {}), sourceRealm: candidate.sourceRealm,
          state: candidate.state, ...(candidate.observedQuantity !== undefined ? { observedQuantity: candidate.observedQuantity } : {}), ...(candidate.potentialQuantity !== undefined ? { potentialQuantity: candidate.potentialQuantity } : {}),
          activeReservationQuantity: candidate.activeReservationQuantity, reservationState: candidate.reservationState,
          ...(candidate.availableObservedLowerBound !== undefined ? { availableObservedLowerBound: candidate.availableObservedLowerBound } : {}), freshness: candidate.freshness,
          ...(candidate.observedAt !== undefined ? { observedAt: candidate.observedAt } : {}), locations: candidate.locations, matchingItems: candidate.matchingItems,
          accountMembership: candidate.accountMembership, access: candidate.access, transferability: candidate.transferability, reason: candidate.reason,
        }));
      }).sort((a, b) => a.sourceName.localeCompare(b.sourceName) || a.sourceIdentityKey.localeCompare(b.sourceIdentityKey));
      const sourceReviewsByEvidence = new Map<string, (typeof sourceReviewRows)[number]>();
      for (const source of sourceReviewRows) {
        const key = JSON.stringify([source.sourceIdentityKey, first.targetKind, first.targetResourceKey, source.state, source.observedQuantity, source.potentialQuantity, source.reservationState, source.activeReservationQuantity, source.availableObservedLowerBound, source.freshness, source.observedAt, source.locations, source.matchingItems]);
        const existing = sourceReviewsByEvidence.get(key);
        if (existing) sourceReviewsByEvidence.set(key, { ...existing, needReferences: [...existing.needReferences, ...source.needReferences] });
        else sourceReviewsByEvidence.set(key, source);
      }
      const sourceReviews = [...sourceReviewsByEvidence.values()].map((source) => ({ ...source, needReferences: source.needReferences.sort((a, b) => a.projectTitle.localeCompare(b.projectTitle) || a.needId.localeCompare(b.needId)) }));
      const sourceCoverageReviews: ErpProcurementBuyerResourcePackage["sourceCoverageReviews"] = [...new Set(sourceReviews.map((source) => source.sourceIdentityKey))].sort().map((sourceIdentityKey) => {
        const candidates = sourceReviews.filter((source) => source.sourceIdentityKey === sourceIdentityKey);
        const source = candidates[0]!;
        const needKeys = new Set(uniqueNeeds.map((entry) => `${entry.projectId}\u0000${entry.targetNeedId}`));
        const referencedNeedKeys = new Set(candidates.flatMap((candidate) => candidate.needReferences.map((reference) => `${reference.projectId}\u0000${reference.needId}`)));
        const relatedNeeds = needReviews.filter((need) => needKeys.has(`${need.projectId}\u0000${need.needId}`));
        const gapsKnown = relatedNeeds.length === uniqueNeeds.length && relatedNeeds.every((need) => need.freshness === "recent" && need.state === "SHORTFALL_OBSERVED" && need.observedQuantity !== undefined && need.requiredQuantity >= need.observedQuantity && need.unresolvedSections.length === 0);
        const gap = gapsKnown ? relatedNeeds.reduce((sum, need) => sum + BigInt(need.requiredQuantity - need.observedQuantity!), 0n) : undefined;
        const locationsComplete = source.locations.length === 2 && source.locations.every((location) => location.state === "OBSERVED" && location.quantity !== undefined && location.completeness?.toLowerCase() === "complete");
        const sourceConsistent = candidates.length === 1 && source.state === "OBSERVED" && source.freshness === "recent" && source.availableObservedLowerBound !== undefined && source.reservationState !== "UNKNOWN" && source.reservationState !== "OVER_RESERVED" && locationsComplete && referencedNeedKeys.size === needKeys.size && [...needKeys].every((key) => referencedNeedKeys.has(key));
        const otherSourceScopedNeeds = projects.filter((project) => project.version === version && (project.status === "ACTIVE" || project.status === "PAUSED")).flatMap((project) => project.needs.filter((need) => need.kind === first.targetKind && need.resourceKey === first.targetResourceKey && need.sourceIdentityKey === sourceIdentityKey && !needKeys.has(`${project.stableId}\u0000${need.stableId}`)).flatMap((need) => {
          const evidence = project.needEvidence.find((entry) => entry.needId === need.stableId);
          const linkedWorkOrders = project.workOrders.filter((order) => order.resourceNeedIds.includes(need.stableId)).map((order) => {
            const readiness = project.workOrderReadiness.find((entry) => entry.workOrderId === order.stableId);
            const progress = project.workOrderProgress.find((entry) => entry.workOrderId === order.stableId);
            return { workOrderId: order.stableId, kind: order.kind, status: order.status, title: order.title, ...(readiness ? { readinessState: readiness.state } : {}), ...(progress ? { progressState: progress.reconciliation } : {}), ...(readiness?.reason ?? progress?.reason ? { reason: readiness?.reason ?? progress?.reason } : {}) };
          });
          const context = { linkedWorkOrders };
          if (!evidence) return [{ projectId: project.stableId, projectTitle: project.title, projectStatus: project.status, projectPriority: project.priority, needId: need.stableId, label: need.label, state: "UNKNOWN" as const, freshness: "unknown" as const, requiredQuantity: need.requiredQuantity, reason: "Need assessment is unavailable; this explicit source-scoped plan needs review.", ...context }];
          return [{ projectId: project.stableId, projectTitle: project.title, projectStatus: project.status, projectPriority: project.priority, needId: need.stableId, label: need.label, state: evidence.state, freshness: evidence.freshness, requiredQuantity: evidence.requiredQuantity, ...(evidence.observedQuantity !== undefined ? { observedQuantity: evidence.observedQuantity } : {}), ...(evidence.reservationAssessment ? { activeReservationQuantity: evidence.reservationAssessment.activeQuantity } : {}), ...(evidence.observedAt !== undefined ? { observedAt: evidence.observedAt } : {}), reason: evidence.reason, ...context }];
        })).sort((a, b) => b.projectPriority - a.projectPriority || a.projectTitle.localeCompare(b.projectTitle) || a.needId.localeCompare(b.needId));
        const safeGap = gap !== undefined && gap <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(gap) : undefined;
        const complete = sourceConsistent && gapsKnown && safeGap !== undefined && !unsafe;
        const state: ErpProcurementBuyerResourcePackage["sourceCoverageReviews"][number]["state"] = complete
          ? source.availableObservedLowerBound! >= safeGap! ? "UNRESERVED_LOWER_BOUND_COVERS_REVIEWED_GAPS" : "UNRESERVED_LOWER_BOUND_BELOW_REVIEWED_GAPS"
          : "SOURCE_OR_NEED_EVIDENCE_INCOMPLETE";
        return {
          sourceIdentityKey, sourceName: source.sourceName, kind: first.targetKind, state, needCount: referencedNeedKeys.size, expectedNeedCount: uniqueNeeds.length,
          ...(sourceConsistent ? { availableObservedLowerBound: source.availableObservedLowerBound } : {}),
          ...(safeGap !== undefined && !unsafe ? { combinedObservedGapQuantity: safeGap } : {}),
          ...(source.observedAt !== undefined ? { observedAt: source.observedAt } : {}), freshness: source.freshness,
          otherSourceScopedNeedCount: otherSourceScopedNeeds.length, otherSourceScopedNeedsTruncated: otherSourceScopedNeeds.length > 20, otherSourceScopedNeeds: otherSourceScopedNeeds.slice(0, 20),
          reason: complete
            ? state === "UNRESERVED_LOWER_BOUND_COVERS_REVIEWED_GAPS" ? `One recent, complete observed character source has an unreserved lower bound at least as large as these separately recorded current gaps${first.targetKind === "ITEM_ID" ? ". This quantity is matched by base item ID and can include distinct itemString variants; variant interchangeability and suitability are not established" : ""}${otherSourceScopedNeeds.length ? `, but ${otherSourceScopedNeeds.length} other active or paused requirement(s) explicitly plan to draw on this exact source/resource and must be reviewed separately` : ""}. This is only a location and quantity lead; account membership, access, transferability, recipient eligibility, and allocation remain UNKNOWN.`
              : `The one recent, complete observed character source has fewer unreserved lower-bound units than the combined current gaps${otherSourceScopedNeeds.length ? `; ${otherSourceScopedNeeds.length} other active or paused requirement(s) explicitly plan to draw on this exact source/resource and require separate review` : ""}. Review these needs separately; account membership, access, transferability, recipient eligibility, and allocation remain UNKNOWN; no transfer is inferred.`
            : "A current complete source snapshot, consistent same-source evidence across every grouped need, or recent complete shortfall evidence is missing. Combined source coverage is UNKNOWN; inspect the per-need evidence and location leads.",
        };
      });
      const sourceScreens = uniqueNeeds.map((entry) => projectsById.get(entry.projectId)?.resourceSourceScreens.find((screen) => screen.needId === entry.targetNeedId));
      const sourceReviewUnavailable = sourceScreens.some((screen) => !screen);
      const sourceScanIncomplete = sourceScreens.some((screen) => !!screen && (screen.unresolvedCharacterCount > 0 || screen.candidatesTruncated));
      const sourceReviewState: ErpProcurementBuyerResourcePackage["sourceReviewState"] = sourceReviewUnavailable ? "SOURCE_REVIEW_UNAVAILABLE"
        : sourceReviews.length ? sourceScanIncomplete ? "POTENTIAL_SOURCES_SCAN_INCOMPLETE" : "OBSERVED_POTENTIAL_SOURCES"
          : sourceScanIncomplete ? "SOURCE_SCAN_INCOMPLETE" : sourceScreens.every((screen) => screen?.scannedCharacterCount === 0) ? "NO_OTHER_CHARACTERS_TO_SCAN" : "NO_MATCHING_SOURCE_OBSERVED";
      const state: ErpProcurementBuyerResourcePackage["state"] = unsafe ? "AGGREGATE_EXCEEDS_SAFE_INTEGER"
        : !completeGaps || !quotesComplete ? "EVIDENCE_INCOMPLETE"
          : quoteQuantity >= gapTotal ? "QUOTE_QUANTITY_COVERS_COMBINED_OBSERVED_GAPS"
            : "QUOTE_QUANTITY_BELOW_COMBINED_OBSERVED_GAPS";
      return [{
        kind: first.targetKind, resourceKey: first.targetResourceKey, projectCount: packageProjectCount, needCount: uniqueNeeds.length, state,
        sourceReviewState, observedSources: sourceReviews, sourceCoverageReviews, needReviews,
        ...(!unsafe && completeGaps ? { combinedObservedGapQuantity: Number(gapTotal) } : {}),
        ...(!unsafe && packageQuotes.length ? { recentQuotedQuantity: Number(quoteQuantity), recentQuoteTotalCopper: Number(quoteTotal) } : {}),
        reason: unsafe ? "An exact quantity or quote aggregate exceeds the safe display range; package comparison is withheld."
          : !completeGaps || !quotesComplete ? "Every matching project need needs a current observed gap and recent player quote before combined quantity coverage can be assessed."
            : quoteQuantity >= gapTotal ? "Recent player-entered quote quantities cover the sum of currently observed gaps for this exact resource identity. This groups review only; no purchase, ownership, or allocation is inferred."
              : "Recent player-entered quote quantities are below the sum of currently observed gaps for this exact resource identity.",
        orders: group.map((entry) => ({ projectId: entry.projectId, projectTitle: entry.projectTitle, workOrderId: entry.workOrderId, targetNeedId: entry.targetNeedId, targetLabel: entry.targetLabel, targetResourceKey: entry.targetResourceKey, targetGap: entry.targetGap ?? "UNKNOWN", sourceReview: reviewSources(projectsById.get(entry.projectId), entry.targetNeedId, entry.targetKind, entry.targetResourceKey), ...(entry.amount !== undefined ? { quote: { amountCopper: entry.amount, quantity: entry.quantity!, recordedAt: entry.recordedAt!, freshness: entry.quoteFreshness! } } : {}) })),
      }];
    }).sort((a, b) => a.kind.localeCompare(b.kind) || a.resourceKey.localeCompare(b.resourceKey));
    return {
      version, buyerIdentityKey, projectCount, orderCount: entries.length, quoteCount: quoteEntries.length, state,
      ...(!quoteTotalUnsafe && recent.length ? { recentQuoteTotalCopper: Number(recentQuoteTotal) } : {}),
      ...(oneGoldSnapshot ? { observedGoldCopper: entries[0]!.observedGold, observedGoldAt: entries[0]!.observedGoldAt } : {}),
      ...(oneReservationAssessment ? { recordedReservationsCopper: entries[0]!.reservationTotal } : {}),
      ...(recordedRemainderCopper !== undefined ? { recordedRemainderCopper } : {}), reason,
      orders: entries.map((entry) => ({ projectId: entry.projectId, projectTitle: entry.projectTitle, workOrderId: entry.workOrderId, targetNeedId: entry.targetNeedId, targetLabel: entry.targetLabel, targetResourceKey: entry.targetResourceKey, targetGap: entry.targetGap ?? "UNKNOWN", sourceReview: reviewSources(projectsById.get(entry.projectId), entry.targetNeedId, entry.targetKind, entry.targetResourceKey), ...(entry.amount !== undefined ? { quote: { amountCopper: entry.amount, quantity: entry.quantity!, recordedAt: entry.recordedAt!, freshness: entry.quoteFreshness! } } : {}) })),
      resourcePackages,
    };
  }).sort((a, b) => a.buyerIdentityKey.localeCompare(b.buyerIdentityKey));
  const safeLimit = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 500) : 100;
  const returned = buyers.slice(0, safeLimit);
  return { version, buyers: returned, totalBuyerCount: buyers.length, returnedBuyerCount: returned.length, unresolvedBuyerOrderCount, truncated: returned.length < buyers.length };
}
