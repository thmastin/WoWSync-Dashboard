import type { ErpNeedEvidence, ErpProjectView, ErpResourceNeed, ErpResourceSourceCandidate, ErpResourceSourceScreen, ErpWorkOrder } from "./erpProjects.ts";
import type { VersionOrUnknown, WowVersion } from "./types.ts";
import type { Freshness } from "./freshness.ts";

const MAX_ERP_REVIEW_ROWS = 1_000;

export type ErpFulfillmentTriageSignal = "CHANGED_OBSERVATION" | "UNWORKED_REQUIREMENT" | "RESERVATION_REVIEW" | "OPEN_WORK_ORDER";

export interface ErpFulfillmentTriageItem {
  readonly stableId: string;
  readonly version: WowVersion;
  readonly projectId: string;
  readonly projectTitle: string;
  readonly projectStatus: ErpProjectView["status"];
  readonly projectPriority: number;
  readonly need?: Pick<ErpResourceNeed, "stableId" | "kind" | "resourceKey" | "label" | "requiredQuantity" | "sourceIdentityKey" | "sourceOwnerKey" | "destinationIdentityKey"> & {
    readonly evidenceState: ErpProjectView["needEvidence"][number]["state"];
    readonly observedQuantity?: number;
    readonly potentialQuantity?: number;
    readonly observedAt?: number;
    readonly observationChange?: ErpProjectView["needEvidence"][number]["observationChange"];
    readonly freshness: Freshness;
  };
  readonly workOrders: readonly { readonly stableId: string; readonly title: string; readonly status: string; readonly readinessState?: string; readonly progressState?: string }[];
  readonly reservationReviews: readonly { readonly stableId: string; readonly state: string; readonly reservedQuantity: number; readonly observedQuantity?: number; readonly reason: string }[];
  readonly signals: readonly ErpFulfillmentTriageSignal[];
  readonly reason: string;
}

export interface ErpFulfillmentTriage {
  readonly version: VersionOrUnknown;
  readonly items: readonly ErpFulfillmentTriageItem[];
  readonly totalCount: number;
  readonly returnedCount: number;
  readonly affectedProjectCount: number;
  /** Signal-bearing row counts across all candidates before the display cap; a linked order counts once per affected need row. */
  readonly counts: Readonly<Record<ErpFulfillmentTriageSignal, number>>;
  readonly truncated: boolean;
  readonly interpretation: "PLANNING_AND_EVIDENCE_REVIEW_ONLY";
}

export interface ErpPortfolioFulfillmentStep {
  readonly projectId: string;
  readonly projectTitle: string;
  readonly projectStatus?: ErpProjectView["status"];
  readonly projectPriority: number;
  readonly needId: string;
  readonly needLabel: string;
  readonly resourceKey: string;
  readonly requiredQuantity?: number;
  readonly sourceIdentityKey?: string;
  readonly sourceOwnerKey?: string;
  readonly destinationIdentityKey?: string;
  readonly evidenceState: ErpProjectView["needEvidence"][number]["state"];
  readonly freshness: Freshness;
  readonly observedQuantity?: number;
  readonly observedAt?: number;
  /** Active reservation intent attached to this project requirement only. */
  readonly projectReservationIntentQuantity?: number;
  /** Existing source/resource-scope assessment, including overlapping same-version project commitments. Never an availability figure. */
  readonly reservationAssessment?: ErpNeedEvidence["reservationAssessment"];
  readonly prerequisiteNeedIds: readonly { readonly projectId: string; readonly needId: string }[];
  /** Same evidence-qualified pathway options shown in source review, embedded beside the ordered prerequisite step. */
  readonly fulfillmentPathways?: ErpNeedFulfillmentPathwayReview;
  /** Re-evaluated from the referenced requirements' current observations; it is not a game-action or work-order completion claim. */
  readonly prerequisiteGate: {
    readonly state: "NO_PREREQUISITES" | "CURRENT_OBSERVED_EVIDENCE_MET" | "PREREQUISITE_EVIDENCE_REVIEW" | "MISSING_PREREQUISITE" | "CYCLE_REVIEW";
    readonly blockers: readonly { readonly projectId: string; readonly needId: string; readonly evidenceState: ErpProjectView["needEvidence"][number]["state"]; readonly freshness: Freshness; readonly observedAt?: number; readonly reservationState?: NonNullable<ErpNeedEvidence["reservationAssessment"]>["state"]; readonly availableObservedLowerBound?: number; readonly reason: string }[];
  };
  readonly workOrders: readonly { readonly stableId: string; readonly title: string; readonly status: string; readonly readinessState: string; readonly progressState?: string }[];
  readonly reviewState: "OBSERVED_NEED_MET" | "NEED_EVIDENCE_REVIEW" | "RESERVATION_REVIEW" | "WORK_ORDER_REVIEW" | "MISSING_NEED";
  readonly reason: string;
}

/** A raw covered quantity is insufficient when other explicit plans reserve the same source scope. */
function hasReservationAdjustedCoverage(project: ErpProjectView | undefined, need: ErpResourceNeed | undefined, evidence: ErpNeedEvidence | undefined): boolean {
  if (!project || !need || evidence?.state !== "COVERED_BY_OBSERVED" || evidence.freshness !== "recent" || evidence.observedAt === undefined || evidence.unresolvedSections.length > 0 || evidence.unknownQuantityRowCount > 0) return false;
  const assessment = evidence.reservationAssessment;
  if (assessment?.state === "UNRESERVED" && assessment.activeQuantity === 0) return true;
  if (assessment?.state !== "WITHIN_OBSERVED_SUPPLY" || assessment.availableObservedLowerBound === undefined) return false;
  const ownReservationQuantity = reservationQuantityAtNeedSource(project, need);
  return assessment.availableObservedLowerBound + ownReservationQuantity >= need.requiredQuantity;
}

/** Only reservations at the need's selected source are included in its source-specific lower bound. */
function reservationQuantityAtNeedSource(project: ErpProjectView, need: ErpResourceNeed): number {
  return project.reservations.filter((reservation) => reservation.status === "ACTIVE" && reservation.needId === need.stableId && reservation.sourceIdentityKey === need.sourceIdentityKey && reservation.sourceOwnerKey === need.sourceOwnerKey).reduce((total, reservation) => total + reservation.quantity, 0);
}

export interface ErpPortfolioFulfillmentPackage {
  readonly stableId: string;
  readonly version: WowVersion;
  readonly steps: readonly ErpPortfolioFulfillmentStep[];
  readonly crossProjectDependencyCount: number;
  readonly nextReviewStepId?: string;
  readonly cycleDetected: boolean;
  readonly interpretation: "PLAYER_AUTHORED_SEQUENCE_AND_EVIDENCE_REVIEW_ONLY";
}

export interface ErpPortfolioFulfillmentReview {
  readonly version: VersionOrUnknown;
  readonly packages: readonly ErpPortfolioFulfillmentPackage[];
  /** Atomic player-authored batches after save, compared with current need evidence without attributing an action. */
  readonly savedPlanningBatches: readonly ErpSavedPlanningBatch[];
  readonly totalSavedPlanningBatchCount: number;
  readonly returnedSavedPlanningBatchCount: number;
  readonly savedPlanningBatchesTruncated: boolean;
  readonly totalPackageCount: number;
  readonly returnedPackageCount: number;
  readonly totalStepCount: number;
  readonly stepsNeedingReview: number;
  readonly stepsWithPrerequisiteReview: number;
  /** True when the shared source-pathway review was capped and some package steps may have no embedded pathway detail. */
  readonly pathwayReviewTruncated: boolean;
  readonly truncated: boolean;
  readonly interpretation: "PLAYER_AUTHORED_SEQUENCE_AND_EVIDENCE_REVIEW_ONLY";
}

export interface ErpSavedPlanningBatch {
  readonly stableId: string;
  readonly version: WowVersion;
  readonly reviewedAt: number;
  readonly state: "AWAITING_NEW_OBSERVATION" | "NEWER_OBSERVATION_REVIEW" | "CURRENT_EVIDENCE_REVIEW" | "CONFLICTING_BATCH_CONTEXT";
  readonly steps: readonly {
    readonly projectId: string;
    readonly projectTitle: string;
    readonly needId: string;
    readonly needLabel: string;
    readonly resourceKey: string;
    readonly workOrderId: string;
    readonly workOrderTitle: string;
    readonly workOrderKind: ErpWorkOrder["kind"];
    readonly workOrderStatus: ErpWorkOrder["status"];
    readonly evidenceReview: "NO_NEWER_OBSERVATION" | "NEWER_OBSERVATION_QUANTITY_CHANGED" | "NEWER_OBSERVATION_UNCHANGED" | "NEWER_OBSERVATION_NO_BASELINE" | "CURRENT_EVIDENCE_STALE_OR_UNKNOWN" | "NEED_IDENTITY_CHANGED" | "NEED_IDENTITY_UNKNOWN";
    readonly currentEvidenceState: ErpNeedEvidence["state"];
    readonly currentFreshness: Freshness;
    readonly reviewedQuantity?: number;
    readonly currentQuantity?: number;
    readonly currentObservedAt?: number;
    readonly activeReservationQuantity: number;
    readonly actionCausality: "UNKNOWN";
  }[];
  readonly openTaskCount: number;
  readonly terminalTaskCount: number;
  readonly newerObservationReviewCount: number;
  readonly interpretation: "SAVED_PLAYER_INTENT_AND_CURRENT_EVIDENCE_REVIEW_ONLY";
}

export interface ErpSavedPlanningBatchReview {
  readonly version: VersionOrUnknown;
  readonly batches: readonly ErpSavedPlanningBatch[];
  readonly totalCount: number;
  readonly returnedCount: number;
  readonly truncated: boolean;
}

/** Reconciles saved grouped plans with later evidence; inventory movement and task causality remain UNKNOWN. */
export function buildErpSavedPlanningBatchReview(projects: readonly ErpProjectView[], version: VersionOrUnknown, limit = 50): ErpSavedPlanningBatchReview {
  if (version === "unknown-version") return { version, batches: [], totalCount: 0, returnedCount: 0, truncated: false };
  const grouped = new Map<string, Array<{ project: ErpProjectView; order: ErpWorkOrder }>>();
  for (const project of projects) if (project.version === version) for (const order of project.workOrders) {
    if (!order.planningBatch || order.planningBatch.version !== version) continue;
    const key = JSON.stringify([version, order.planningBatch.stableId]);
    grouped.set(key, [...(grouped.get(key) ?? []), { project, order }]);
  }
  const batches = [...grouped.values()].map((entries): ErpSavedPlanningBatch => {
    const first = entries[0]!;
    const context = first.order.planningBatch!;
    const conflictingContext = entries.some(({ order }) => order.planningBatch!.reviewedAt !== context.reviewedAt || order.planningBatch!.version !== context.version);
    const steps = entries.flatMap(({ project, order }) => order.resourceNeedIds.flatMap((needId) => {
      const need = project.needs.find((candidate) => candidate.stableId === needId);
      if (!need) return [];
      const evidence = project.needEvidence.find((candidate) => candidate.needId === needId);
      const baseline = order.planningBatch?.needEvidence;
      const newer = evidence?.observedAt !== undefined && evidence.observedAt > context.reviewedAt;
      const identityKnown = baseline?.resourceKind !== undefined && baseline.resourceKey !== undefined;
      const identityChanged = identityKnown && (baseline.resourceKind !== need.kind || baseline.resourceKey !== need.resourceKey);
      const evidenceReview: ErpSavedPlanningBatch["steps"][number]["evidenceReview"] = identityChanged
        ? "NEED_IDENTITY_CHANGED"
        : !identityKnown ? "NEED_IDENTITY_UNKNOWN"
          : !evidence || evidence.freshness !== "recent" || evidence.observedAt === undefined ? "CURRENT_EVIDENCE_STALE_OR_UNKNOWN"
            : !newer ? "NO_NEWER_OBSERVATION"
              : baseline?.observedQuantity === undefined || evidence.observedQuantity === undefined ? "NEWER_OBSERVATION_NO_BASELINE"
                : baseline.observedQuantity === evidence.observedQuantity ? "NEWER_OBSERVATION_UNCHANGED" : "NEWER_OBSERVATION_QUANTITY_CHANGED";
      const activeReservationQuantity = project.reservations.filter((reservation) => reservation.status === "ACTIVE" && reservation.needId === needId).reduce((sum, reservation) => sum + reservation.quantity, 0);
      return [{ projectId: project.stableId, projectTitle: project.title, needId, needLabel: need.label, resourceKey: need.resourceKey, workOrderId: order.stableId, workOrderTitle: order.title, workOrderKind: order.kind, workOrderStatus: order.status, evidenceReview, currentEvidenceState: evidence?.state ?? "UNKNOWN", currentFreshness: evidence?.freshness ?? "unknown", ...(baseline?.observedQuantity !== undefined ? { reviewedQuantity: baseline.observedQuantity } : {}), ...(evidence?.observedQuantity !== undefined ? { currentQuantity: evidence.observedQuantity } : {}), ...(evidence?.observedAt !== undefined ? { currentObservedAt: evidence.observedAt } : {}), activeReservationQuantity, actionCausality: "UNKNOWN" as const }];
    }));
    const newerObservationReviewCount = steps.filter((step) => step.evidenceReview.startsWith("NEWER_OBSERVATION_")).length;
    const state: ErpSavedPlanningBatch["state"] = conflictingContext || steps.some((step) => step.evidenceReview === "NEED_IDENTITY_CHANGED") ? "CONFLICTING_BATCH_CONTEXT" : newerObservationReviewCount ? "NEWER_OBSERVATION_REVIEW" : steps.some((step) => step.evidenceReview === "CURRENT_EVIDENCE_STALE_OR_UNKNOWN" || step.evidenceReview === "NEED_IDENTITY_UNKNOWN") ? "CURRENT_EVIDENCE_REVIEW" : "AWAITING_NEW_OBSERVATION";
    return { stableId: context.stableId, version, reviewedAt: context.reviewedAt, state, steps, openTaskCount: steps.filter((step) => step.workOrderStatus !== "COMPLETED" && step.workOrderStatus !== "CANCELLED").length, terminalTaskCount: steps.filter((step) => step.workOrderStatus === "COMPLETED" || step.workOrderStatus === "CANCELLED").length, newerObservationReviewCount, interpretation: "SAVED_PLAYER_INTENT_AND_CURRENT_EVIDENCE_REVIEW_ONLY" };
  }).sort((a, b) => b.reviewedAt - a.reviewedAt || a.stableId.localeCompare(b.stableId));
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(100, Math.floor(limit))) : 50;
  const selected = batches.slice(0, safeLimit);
  return { version, batches: selected, totalCount: batches.length, returnedCount: selected.length, truncated: selected.length < batches.length };
}

export type ErpSourceFulfillmentNextReview = "REVIEW_EVIDENCE" | "REVIEW_RESERVATIONS" | "RECONCILE_OBSERVATIONS" | "PLAN_MANUAL_WORK" | "REVIEW_MANUAL_WORK" | "REVIEW_SOURCE_AND_ACCESS";

export const ERP_NEED_FULFILLMENT_OPTION_KINDS = ["CURRENT_OBSERVED_COVERAGE", "REVIEW_PERSONAL_BANK_RETRIEVAL", "FOLLOW_EXISTING_MANUAL_PLAN", "INVESTIGATE_OTHER_CHARACTER_LOCATION", "CHOOSE_MANUAL_SUPPLY_PLAN", "REFRESH_OR_CLARIFY_EVIDENCE"] as const;
export type ErpNeedFulfillmentOptionKind = typeof ERP_NEED_FULFILLMENT_OPTION_KINDS[number];
export interface ErpNeedFulfillmentOption {
  readonly kind: ErpNeedFulfillmentOptionKind;
  readonly provenance: "OBSERVED" | "DERIVED" | "UNKNOWN";
  readonly workOrderIds?: readonly string[];
  readonly observedLocation?: { readonly section: "bags" | "character bank"; readonly quantity: number; readonly observedAt: number; readonly itemRef?: string };
  readonly candidateLocations?: readonly { readonly characterKey: string; readonly characterName: string; readonly realm: string; readonly provenance: "OBSERVED" | "LAST_SEEN"; readonly freshness: Freshness; readonly observedAt?: number }[];
  readonly reason: string;
}
export interface ErpNeedFulfillmentPathwayReview {
  readonly needId: string;
  /** State describes only the selected source evidence, never delivery to a destination. */
  readonly state: "CURRENT_SOURCE_COVERAGE" | "CURRENT_SOURCE_SHORTFALL" | "EVIDENCE_REVIEW_REQUIRED";
  readonly options: readonly ErpNeedFulfillmentOption[];
  readonly reason: string;
}

/** One exact, explicitly selected source/resource scope across active portfolio needs. This is a review queue, not a supply or route solver. */
export interface ErpSourceFulfillmentLine {
  readonly stableId: string;
  readonly version: WowVersion;
  readonly sourceScope: "CHARACTER" | "SHARED_OWNER";
  readonly sourceIdentityKey?: string;
  readonly sourceOwnerKey?: string;
  readonly kind: ErpResourceNeed["kind"];
  readonly resourceKey: string;
  readonly label: string;
  readonly projectCount: number;
  readonly nextReview: ErpSourceFulfillmentNextReview;
  readonly reason: string;
  readonly alternativeLocationReview: "OBSERVED_POTENTIAL_LOCATIONS" | "POTENTIAL_LOCATIONS_SCAN_INCOMPLETE" | "NO_MATCHING_LOCATION_OBSERVED" | "NO_OTHER_CHARACTERS_TO_SCAN" | "SOURCE_SCAN_INCOMPLETE" | "SOURCE_REVIEW_UNAVAILABLE";
  readonly alternativeLocations: readonly (Pick<ErpResourceSourceCandidate, "sourceIdentityKey" | "sourceName" | "sourceSurname" | "sourceRealm" | "state" | "observedQuantity" | "potentialQuantity" | "activeReservationQuantity" | "reservationState" | "availableObservedLowerBound" | "freshness" | "observedAt" | "locations" | "matchingItems" | "accountMembership" | "access" | "transferability" | "reason"> & { readonly needReferences: readonly { readonly projectId: string; readonly projectTitle: string; readonly needId: string }[]; readonly selectedProvisioningPlanCount: number; readonly selectedProvisioningPlansTruncated: boolean; readonly selectedProvisioningPlans: readonly { readonly projectId: string; readonly projectTitle: string; readonly needId: string; readonly needLabel: string; readonly workOrderId: string; readonly workOrderTitle: string; readonly workOrderStatus: string; readonly destinationIdentityKey?: string; readonly reconciliationState?: ErpProjectView["workOrderProgress"][number]["reconciliation"] }[] })[];
  readonly alternativeLocationCount: number;
  readonly alternativeLocationsTruncated: boolean;
  readonly needs: readonly {
    readonly projectId: string;
    readonly projectTitle: string;
    readonly projectStatus: ErpProjectView["status"];
    readonly projectPriority: number;
    readonly needId: string;
    readonly label: string;
    readonly requiredQuantity: number;
    readonly destinationIdentityKey?: string;
    readonly state: ErpProjectView["needEvidence"][number]["state"];
    readonly freshness: Freshness;
    readonly observedQuantity?: number;
    readonly potentialQuantity?: number;
    readonly observedAt?: number;
    readonly sourceSections: ErpProjectView["needEvidence"][number]["sourceSections"];
    readonly unresolvedSections: readonly string[];
    readonly reservationAssessment?: ErpNeedEvidence["reservationAssessment"];
    /** Evidence-backed manual pathway leads. These are alternatives for player review, never selected or executed routes. */
    readonly fulfillmentPathways: ErpNeedFulfillmentPathwayReview;
    readonly reason: string;
    readonly workOrders: readonly {
      readonly stableId: string;
      readonly kind: string;
      readonly title: string;
      readonly status: string;
      readonly readinessState?: string;
      readonly progressState?: string;
      readonly observationStates: readonly string[];
      readonly capabilityChecks: readonly { readonly kind: string; readonly state: string; readonly reason: string }[];
      readonly plannedOutputState?: string;
      readonly pathwayContext?: ErpWorkOrder["pathwayContext"];
      readonly procurement?: { readonly reviewState: string; readonly quoteState: string; readonly quote?: { readonly amountCopper: number; readonly quantity: number; readonly recordedAt: number; readonly freshness: Freshness }; readonly affordability: "UNKNOWN"; readonly marketAvailability: "UNKNOWN" };
      readonly reason?: string;
    }[];
  }[];
}

export interface ErpSourceFulfillmentReview {
  readonly version: VersionOrUnknown;
  readonly sources: readonly ErpSourceFulfillmentLine[];
  readonly totalSourceCount: number;
  readonly returnedSourceCount: number;
  readonly totalNeedCount: number;
  readonly needsReviewCount: number;
  readonly nextReviewCounts: Readonly<Record<ErpSourceFulfillmentNextReview, number>>;
  readonly groupsWithAlternativeLocations: number;
  readonly alternativeLocationCount: number;
  readonly groupsWithIncompleteSourceScan: number;
  /** Open player-authored PROVISION orders across active/paused projects; not a stock reservation or resource quantity. */
  readonly openProvisioningPlanCount: number;
  readonly truncated: boolean;
  readonly interpretation: "EXPLICIT_SOURCE_SCOPE_AND_MANUAL_REVIEW_ONLY";
}

export type ErpPortfolioNextAction = "REVIEW_EVIDENCE" | "REVIEW_RESERVATIONS" | "RECONCILE_OBSERVATIONS" | "REVIEW_MANUAL_WORK" | "PLAN_MANUAL_WORK" | "REVIEW_SOURCE_AND_ACCESS" | "REVIEW_UNSCOPED_ITEM";
export interface ErpPortfolioNextActionItem {
  readonly stableId: string;
  readonly version: WowVersion;
  readonly action: ErpPortfolioNextAction;
  readonly resource?: { readonly kind: ErpResourceNeed["kind"]; readonly resourceKey: string; readonly label: string };
  /** Only present when an exact selected source was explicitly supplied by the plan. */
  readonly source?: { readonly scope: "CHARACTER" | "SHARED_OWNER"; readonly identityKey: string };
  readonly recordedSourceIdentity?: string;
  readonly recordedSourceScope?: { readonly sourceIdentityKey?: string; readonly sourceOwnerKey?: string };
  readonly sourceScopeIssue?: "MISSING_SOURCE" | "CONFLICTING_SOURCE_FIELDS" | "VERSION_MISMATCH";
  readonly needReferences: readonly { readonly projectId: string; readonly projectTitle: string; readonly projectPriority: number; readonly needId: string; readonly requiredQuantity: number; readonly evidenceState: string; readonly freshness: Freshness; readonly observedAt?: number; readonly observationChanges?: NonNullable<NonNullable<ErpFulfillmentTriageItem["need"]>["observationChange"]>["comparisons"] }[];
  readonly signals: readonly ErpFulfillmentTriageSignal[];
  readonly workOrders: readonly { readonly projectId: string; readonly stableId: string }[];
  readonly reason: string;
}
export interface ErpPortfolioNextActionReview {
  readonly version: VersionOrUnknown;
  readonly items: readonly ErpPortfolioNextActionItem[];
  readonly totalCount: number;
  readonly returnedCount: number;
  readonly counts: Readonly<Record<ErpPortfolioNextAction, number>>;
  readonly sourceReviewTruncated: boolean;
  readonly triageTruncated: boolean;
  readonly truncated: boolean;
  readonly interpretation: "DETERMINISTIC_PLAYER_REVIEW_QUEUE_ONLY";
}

function buildNeedFulfillmentPathways(need: ErpResourceNeed, evidence: ErpNeedEvidence | undefined, workOrders: readonly { stableId: string; status: string }[], sourceSections: ErpNeedEvidence["sourceSections"], candidateLocations: ErpNeedFulfillmentOption["candidateLocations"], ownReservationQuantity = 0): ErpNeedFulfillmentPathwayReview {
  const options: ErpNeedFulfillmentOption[] = [];
  const completeCurrent = evidence?.freshness === "recent" && evidence.unresolvedSections.length === 0 && evidence.unknownQuantityRowCount === 0;
  const reservation = evidence?.reservationAssessment;
  const reservationClear = (reservation?.state === "UNRESERVED" && reservation.activeQuantity === 0) || (reservation?.state === "WITHIN_OBSERVED_SUPPLY" && reservation.availableObservedLowerBound !== undefined && reservation.availableObservedLowerBound + ownReservationQuantity >= need.requiredQuantity);
  if (completeCurrent && reservationClear && evidence?.state === "COVERED_BY_OBSERVED") options.push({ kind: "CURRENT_OBSERVED_COVERAGE", provenance: "DERIVED", reason: `${evidence.observedQuantity ?? "An unknown quantity"} observed against ${need.requiredQuantity} required. This reports selected-source coverage only; reservation, access, and action outcome remain separate.` });

  const bags = sourceSections.find((section) => section.section === "bags");
  const bank = sourceSections.find((section) => section.section === "character bank");
  const completeObservedSection = (section: typeof bags) => section?.state === "OBSERVED" && section.completeness?.toLowerCase() === "complete" && section.observedAt !== undefined && section.matchingQuantity !== undefined;
  if (need.sourceIdentityKey && (need.kind === "ITEM_REF" || need.kind === "ITEM_ID") && evidence?.freshness === "recent" && completeObservedSection(bags) && completeObservedSection(bank) && bank?.matchingQuantity !== undefined && bags?.matchingQuantity !== undefined && bank.matchingQuantity > 0 && bags.matchingQuantity < need.requiredQuantity) {
    options.push({ kind: "REVIEW_PERSONAL_BANK_RETRIEVAL", provenance: "OBSERVED", observedLocation: { section: "character bank", quantity: bank!.matchingQuantity!, observedAt: bank!.observedAt!, ...(need.kind === "ITEM_REF" ? { itemRef: need.resourceKey } : {}) }, reason: `This same character's complete recent bags scan has ${bags!.matchingQuantity} matching units and personal bank scan has ${bank!.matchingQuantity}. Review a manual retrieval in game; the export does not establish current access or that retrieval occurred.` });
  }

  const openWorkOrderIds = workOrders.filter((order) => order.status !== "COMPLETED" && order.status !== "CANCELLED").map((order) => order.stableId);
  if (openWorkOrderIds.length) options.push({ kind: "FOLLOW_EXISTING_MANUAL_PLAN", provenance: "DERIVED", workOrderIds: openWorkOrderIds, reason: `There are ${openWorkOrderIds.length} open player-authored work order(s) linked to this need. Check each order's current readiness, prerequisites, and observation review before continuing; no action is executed.` });
  if (candidateLocations?.length) options.push({ kind: "INVESTIGATE_OTHER_CHARACTER_LOCATION", provenance: "DERIVED", candidateLocations, reason: `${candidateLocations.length} same-version character location lead(s) are listed with their individual provenance, freshness, and observation time. Historical or stale evidence is not a current location. None of these leads establishes account membership, ownership, access, binding, transferability, or a route.` });
  if (completeCurrent && reservationClear && evidence?.state === "SHORTFALL_OBSERVED" && openWorkOrderIds.length === 0) options.push({ kind: "CHOOSE_MANUAL_SUPPLY_PLAN", provenance: "DERIVED", reason: `Complete recent selected-source evidence shows ${evidence.observedQuantity ?? "an unknown quantity"} against ${need.requiredQuantity} required. The player must choose and record a supported manual step; no gathering route, recipe, purchase availability, price, or transfer is inferred.` });

  const evidenceNeedsReview = !completeCurrent || !reservationClear || !evidence || (evidence.state !== "COVERED_BY_OBSERVED" && evidence.state !== "SHORTFALL_OBSERVED");
  if (evidenceNeedsReview) options.push({ kind: "REFRESH_OR_CLARIFY_EVIDENCE", provenance: "UNKNOWN", reason: `${evidence?.reason ?? "Need evidence is unavailable."}${evidence?.reservationAssessment && !reservationClear ? ` Reservation assessment is ${evidence.reservationAssessment.state}; resolve it before treating supply as available.` : ""}` });
  const state: ErpNeedFulfillmentPathwayReview["state"] = evidenceNeedsReview ? "EVIDENCE_REVIEW_REQUIRED" : evidence?.state === "COVERED_BY_OBSERVED" ? "CURRENT_SOURCE_COVERAGE" : "CURRENT_SOURCE_SHORTFALL";
  const reason = state === "CURRENT_SOURCE_COVERAGE" ? "Current selected-source observations cover the recorded quantity. This does not mean a different destination has received the resource; review retrieval, access, and player-controlled work separately."
    : state === "CURRENT_SOURCE_SHORTFALL" ? "Current complete selected-source evidence identifies a shortfall and lists only evidence-supported review options. The system does not choose or execute a supply route."
      : "Current evidence, reservation state, or completeness is insufficient for a definite fulfillment path; UNKNOWN and historical quantities remain unresolved.";
  return { needId: need.stableId, state, options, reason };
}

/** Review state frozen by the Dashboard before a grouped manual plan is saved. It is a stale-review guard, not a signed or trusted claim. */
export interface ErpNeedReviewSnapshot {
  readonly projectId: string;
  readonly projectRevision: number;
  readonly version: WowVersion;
  readonly need: ErpResourceNeed;
  readonly evidence?: ErpNeedEvidence;
  readonly resourceSourceScreen?: ErpResourceSourceScreen;
}

export function buildErpNeedReviewSnapshot(project: ErpProjectView, needId: string): ErpNeedReviewSnapshot | undefined {
  const need = project.needs.find((entry) => entry.stableId === needId);
  if (!need) return undefined;
  const evidence = project.needEvidence.find((entry) => entry.needId === needId);
  const resourceSourceScreen = project.resourceSourceScreens.find((entry) => entry.needId === needId);
  return { projectId: project.stableId, projectRevision: project.revision, version: project.version, need,
    ...(evidence ? { evidence } : {}), ...(resourceSourceScreen ? { resourceSourceScreen } : {}) };
}

const emptyCounts = (): Record<ErpFulfillmentTriageSignal, number> => ({ CHANGED_OBSERVATION: 0, UNWORKED_REQUIREMENT: 0, RESERVATION_REVIEW: 0, OPEN_WORK_ORDER: 0 });

/** Groups existing version-scoped evaluations by project requirement without ranking fulfillment routes or inferring action cause. */
export function buildErpFulfillmentTriage(projects: readonly ErpProjectView[], version: VersionOrUnknown, limit = 200): ErpFulfillmentTriage {
  const counts = emptyCounts();
  if (version === "unknown-version") return { version, items: [], totalCount: 0, returnedCount: 0, affectedProjectCount: 0, counts, truncated: false, interpretation: "PLANNING_AND_EVIDENCE_REVIEW_ONLY" };
  const entries: ErpFulfillmentTriageItem[] = [];
  const sourceReview = buildErpSourceFulfillmentReview(projects, version, MAX_ERP_REVIEW_ROWS);
  const retrievalPathways = new Set(sourceReview.sources.flatMap((source) => source.needs.filter((need) => need.fulfillmentPathways.options.some((option) => option.kind === "REVIEW_PERSONAL_BANK_RETRIEVAL") && !need.workOrders.some((order) => order.status !== "COMPLETED" && order.status !== "CANCELLED")).map((need) => `${need.projectId}\0${need.needId}`)));
  for (const project of projects) {
    if (project.version !== version || project.status === "CANCELLED") continue;
    const openOrders = project.workOrders.filter((order) => order.status !== "COMPLETED" && order.status !== "CANCELLED");
    const addNeed = (need: ErpResourceNeed) => {
      const evidence = project.needEvidence.find((entry) => entry.needId === need.stableId);
      const linkedOrders = openOrders.filter((order) => order.resourceNeedIds.includes(need.stableId));
      const reservations = project.reservations.filter((reservation) => reservation.status === "ACTIVE" && reservation.needId === need.stableId).flatMap((reservation) => {
        const assessment = project.reservationReview.find((entry) => entry.reservationId === reservation.stableId);
        return assessment && assessment.state !== "WITHIN_OBSERVED_SUPPLY" ? [{ stableId: assessment.reservationId, state: assessment.state, reservedQuantity: assessment.reservedQuantity, ...(assessment.observedQuantity !== undefined ? { observedQuantity: assessment.observedQuantity } : {}), reason: assessment.reason }] : [];
      });
      const signals: ErpFulfillmentTriageSignal[] = [];
      if (evidence?.observationChange?.state === "CHANGED" && evidence.observationChange.comparisons.some((comparison) => comparison.delta !== 0)) signals.push("CHANGED_OBSERVATION");
      const bankRetrievalReview = retrievalPathways.has(`${project.stableId}\0${need.stableId}`);
      if (!linkedOrders.length && (!(evidence?.state === "COVERED_BY_OBSERVED" && evidence.freshness === "recent") || bankRetrievalReview)) signals.push("UNWORKED_REQUIREMENT");
      if (reservations.length) signals.push("RESERVATION_REVIEW");
      if (linkedOrders.length) signals.push("OPEN_WORK_ORDER");
      if (!signals.length) return;
      for (const signal of signals) counts[signal]++;
      const orders = linkedOrders.map((order) => ({ stableId: order.stableId, title: order.title, status: order.status,
        ...(project.workOrderReadiness.find((entry) => entry.workOrderId === order.stableId) ? { readinessState: project.workOrderReadiness.find((entry) => entry.workOrderId === order.stableId)!.state } : {}),
        ...(project.workOrderProgress.find((entry) => entry.workOrderId === order.stableId) ? { progressState: project.workOrderProgress.find((entry) => entry.workOrderId === order.stableId)!.reconciliation } : {}),
      }));
      entries.push({ stableId: `${project.stableId}:${need.stableId}`, version, projectId: project.stableId, projectTitle: project.title, projectStatus: project.status, projectPriority: project.priority,
        need: { stableId: need.stableId, kind: need.kind, resourceKey: need.resourceKey, label: need.label, requiredQuantity: need.requiredQuantity, ...(need.sourceIdentityKey ? { sourceIdentityKey: need.sourceIdentityKey } : {}), ...(need.sourceOwnerKey ? { sourceOwnerKey: need.sourceOwnerKey } : {}), ...(need.destinationIdentityKey ? { destinationIdentityKey: need.destinationIdentityKey } : {}), evidenceState: evidence?.state ?? "UNKNOWN", ...(evidence?.observedQuantity !== undefined ? { observedQuantity: evidence.observedQuantity } : {}), ...(evidence?.potentialQuantity !== undefined ? { potentialQuantity: evidence.potentialQuantity } : {}), ...(evidence?.observedAt !== undefined ? { observedAt: evidence.observedAt } : {}), ...(evidence?.observationChange ? { observationChange: evidence.observationChange } : {}), freshness: evidence?.freshness ?? "unknown" },
        workOrders: orders, reservationReviews: reservations, signals,
        reason: [bankRetrievalReview ? "A current personal-bank location is recorded for this need, but no manual retrieval review is linked; observed aggregate coverage does not establish that the resource is in the usable destination." : evidence?.reason, ...reservations.map((entry) => entry.reason), ...orders.map((order) => `${order.title}: ${order.readinessState ?? "readiness UNKNOWN"}; ${order.progressState ?? "progress UNKNOWN"}`)].filter(Boolean).join(" ") || "Evidence and saved planning intent require review.",
      });
    };
    for (const need of project.needs) addNeed(need);
    for (const order of openOrders.filter((entry) => entry.resourceNeedIds.length === 0)) {
      counts.OPEN_WORK_ORDER++;
      const readiness = project.workOrderReadiness.find((entry) => entry.workOrderId === order.stableId);
      const progress = project.workOrderProgress.find((entry) => entry.workOrderId === order.stableId);
      entries.push({ stableId: `${project.stableId}:${order.stableId}`, version, projectId: project.stableId, projectTitle: project.title, projectStatus: project.status, projectPriority: project.priority,
        workOrders: [{ stableId: order.stableId, title: order.title, status: order.status, ...(readiness ? { readinessState: readiness.state } : {}), ...(progress ? { progressState: progress.reconciliation } : {}) }], reservationReviews: [], signals: ["OPEN_WORK_ORDER"], reason: readiness?.reason ?? progress?.reason ?? "This unfinished manual order has no linked resource requirement.",
      });
    }
  }
  const signalOrder: Record<ErpFulfillmentTriageSignal, number> = { RESERVATION_REVIEW: 0, CHANGED_OBSERVATION: 1, UNWORKED_REQUIREMENT: 2, OPEN_WORK_ORDER: 3 };
  entries.sort((a, b) => Math.min(...a.signals.map((signal) => signalOrder[signal])) - Math.min(...b.signals.map((signal) => signalOrder[signal])) || b.projectPriority - a.projectPriority || a.projectTitle.localeCompare(b.projectTitle) || (a.need?.label ?? a.workOrders[0]?.title ?? "").localeCompare(b.need?.label ?? b.workOrders[0]?.title ?? "") || a.stableId.localeCompare(b.stableId));
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(MAX_ERP_REVIEW_ROWS, Math.floor(limit))) : 200;
  const items = entries.slice(0, safeLimit);
  return { version, items, totalCount: entries.length, returnedCount: items.length, affectedProjectCount: new Set(entries.map((entry) => entry.projectId)).size, counts, truncated: items.length < entries.length, interpretation: "PLANNING_AND_EVIDENCE_REVIEW_ONLY" };
}

/** Builds a compact, dependency-first view of player-authored cross-project packages. It never selects routes or attributes actions. */
export function buildErpPortfolioFulfillmentReview(projects: readonly ErpProjectView[], version: VersionOrUnknown, limit = 50): ErpPortfolioFulfillmentReview {
  if (version === "unknown-version") return { version, packages: [], totalPackageCount: 0, returnedPackageCount: 0, savedPlanningBatches: [], totalSavedPlanningBatchCount: 0, returnedSavedPlanningBatchCount: 0, savedPlanningBatchesTruncated: false, totalStepCount: 0, stepsNeedingReview: 0, stepsWithPrerequisiteReview: 0, pathwayReviewTruncated: false, truncated: false, interpretation: "PLAYER_AUTHORED_SEQUENCE_AND_EVIDENCE_REVIEW_ONLY" };
  const savedPlanningBatchReview = buildErpSavedPlanningBatchReview(projects, version, limit);
  const projectById = new Map(projects.filter((project) => project.version === version && project.status !== "CANCELLED").map((project) => [project.stableId, project]));
  const sourceReview = buildErpSourceFulfillmentReview(projects, version);
  const pathwayByNeed = new Map(sourceReview.sources.flatMap((source) => source.needs.map((need) => [`${need.projectId}\u0000${need.needId}`, need.fulfillmentPathways] as const)));
  const nodeKey = (projectId: string, needId: string) => JSON.stringify([projectId, needId]);
  const nodes = new Map<string, { projectId: string; needId: string }>();
  const edges = new Map<string, Set<string>>();
  for (const project of projectById.values()) for (const order of project.workOrders) for (const needId of order.resourceNeedIds) {
    const key = nodeKey(project.stableId, needId);
    nodes.set(key, { projectId: project.stableId, needId });
    for (const reference of order.portfolioPrerequisites ?? []) {
      if (reference.projectId === project.stableId && reference.needId === needId) continue;
      const dependencyKey = nodeKey(reference.projectId, reference.needId);
      nodes.set(dependencyKey, { projectId: reference.projectId, needId: reference.needId });
      const dependencies = edges.get(key) ?? new Set<string>(); dependencies.add(dependencyKey); edges.set(key, dependencies);
    }
  }
  const adjacency = new Map<string, Set<string>>();
  for (const [key, dependencies] of edges) for (const dependency of dependencies) {
    const left = adjacency.get(key) ?? new Set<string>(); left.add(dependency); adjacency.set(key, left);
    const right = adjacency.get(dependency) ?? new Set<string>(); right.add(key); adjacency.set(dependency, right);
  }
  const compareNode = (a: string, b: string) => {
    const left = nodes.get(a)!; const right = nodes.get(b)!;
    const lp = projectById.get(left.projectId); const rp = projectById.get(right.projectId);
    return (rp?.priority ?? 0) - (lp?.priority ?? 0) || (lp?.title ?? left.projectId).localeCompare(rp?.title ?? right.projectId) || left.needId.localeCompare(right.needId) || a.localeCompare(b);
  };
  const seen = new Set<string>();
  const packages: ErpPortfolioFulfillmentPackage[] = [];
  for (const start of [...adjacency.keys()].sort(compareNode)) {
    if (seen.has(start)) continue;
    const component: string[] = []; const stack = [start]; seen.add(start);
    while (stack.length) { const current = stack.pop()!; component.push(current); for (const next of adjacency.get(current) ?? []) if (!seen.has(next)) { seen.add(next); stack.push(next); } }
    if (component.length < 2) continue;
    const componentSet = new Set(component);
    const indegree = new Map(component.map((key) => [key, 0]));
    for (const key of component) for (const dependency of edges.get(key) ?? []) if (componentSet.has(dependency)) indegree.set(key, (indegree.get(key) ?? 0) + 1);
    const ready = component.filter((key) => indegree.get(key) === 0).sort(compareNode);
    const ordered: string[] = [];
    while (ready.length) {
      const current = ready.shift()!; ordered.push(current);
      for (const dependent of component) if (edges.get(dependent)?.has(current)) {
        const nextDegree = (indegree.get(dependent) ?? 0) - 1; indegree.set(dependent, nextDegree);
        if (nextDegree === 0) { ready.push(dependent); ready.sort(compareNode); }
      }
    }
    const cycleDetected = ordered.length !== component.length;
    if (cycleDetected) ordered.push(...component.filter((key) => !ordered.includes(key)).sort(compareNode));
    const steps: ErpPortfolioFulfillmentStep[] = ordered.map((key) => {
      const reference = nodes.get(key)!; const project = projectById.get(reference.projectId);
      const need = project?.needs.find((entry) => entry.stableId === reference.needId);
      const evidence = project?.needEvidence.find((entry) => entry.needId === reference.needId);
      const workOrders = project?.workOrders.filter((order) => order.resourceNeedIds.includes(reference.needId)) ?? [];
      const orderReadiness = workOrders.map((order) => project!.workOrderReadiness.find((entry) => entry.workOrderId === order.stableId)?.state ?? "UNKNOWN");
      const projectReservationIntentQuantity = need ? project!.reservations.filter((reservation) => reservation.status === "ACTIVE" && reservation.needId === reference.needId).reduce((total, reservation) => total + reservation.quantity, 0) : undefined;
      const prerequisites = [...(edges.get(key) ?? [])].map((dependency) => nodes.get(dependency)!).sort((a, b) => compareNode(nodeKey(a.projectId, a.needId), nodeKey(b.projectId, b.needId)));
      const prerequisiteEvidence = prerequisites.map((dependency) => {
        const prerequisiteProject = projectById.get(dependency.projectId);
        const prerequisiteNeed = prerequisiteProject?.needs.find((entry) => entry.stableId === dependency.needId);
        const prerequisite = prerequisiteProject?.needEvidence.find((entry) => entry.needId === dependency.needId);
        const isMet = hasReservationAdjustedCoverage(prerequisiteProject, prerequisiteNeed, prerequisite);
        const prerequisiteReservation = prerequisite?.reservationAssessment;
        const reservationAdjustedCoverage = prerequisiteNeed && prerequisite && prerequisite.state === "COVERED_BY_OBSERVED" && prerequisite.freshness === "recent" && !isMet;
        const reason = reservationAdjustedCoverage
          ? `Observed quantity ${prerequisite.observedQuantity ?? "UNKNOWN"} is covered before reservations at the selected source, but only ${prerequisiteReservation?.availableObservedLowerBound ?? "UNKNOWN"} is observed outside same-source commitments and this need's same-source reservation intent is ${prerequisiteProject ? reservationQuantityAtNeedSource(prerequisiteProject, prerequisiteNeed) : 0}; review competing reservations before treating the prerequisite as covered.`
          : !prerequisiteNeed ? "The referenced prerequisite need is unavailable; evidence is UNKNOWN."
            : !isMet ? prerequisite?.reason ?? "Current timestamped observed coverage is unavailable."
              : "Recent observed coverage satisfies this evidence gate only.";
        return { projectId: dependency.projectId, needId: dependency.needId, evidenceState: prerequisite?.state ?? "UNKNOWN" as const, freshness: prerequisite?.freshness ?? "unknown" as const, ...(prerequisite?.observedAt !== undefined ? { observedAt: prerequisite.observedAt } : {}), ...(prerequisiteReservation ? { reservationState: prerequisiteReservation.state, ...(prerequisiteReservation.availableObservedLowerBound !== undefined ? { availableObservedLowerBound: prerequisiteReservation.availableObservedLowerBound } : {}) } : {}), reason, exists: !!prerequisiteNeed, isMet };
      });
      const evidenceMet = evidence?.state === "COVERED_BY_OBSERVED" && evidence.freshness === "recent" && evidence.observedAt !== undefined && evidence.unresolvedSections.length === 0 && evidence.unknownQuantityRowCount === 0;
      const reservationAdjustedCoverageMet = hasReservationAdjustedCoverage(project, need, evidence);
      const reservationBlocksCoverage = evidenceMet && !reservationAdjustedCoverageMet && (evidence?.reservationAssessment?.activeQuantity ?? 0) > 0;
      const hasOpenWork = workOrders.some((order) => order.status !== "COMPLETED" && order.status !== "CANCELLED");
      const reviewState: ErpPortfolioFulfillmentStep["reviewState"] = !need || !project ? "MISSING_NEED" : reservationBlocksCoverage ? "RESERVATION_REVIEW" : hasOpenWork ? "WORK_ORDER_REVIEW" : reservationAdjustedCoverageMet ? "OBSERVED_NEED_MET" : "NEED_EVIDENCE_REVIEW";
      const reason = !project || !need ? "The referenced same-version requirement is unavailable; evidence is UNKNOWN and the saved link requires review."
        : reservationBlocksCoverage ? `Raw observed coverage reports ${evidence?.observedQuantity ?? "quantity UNKNOWN"} against ${need.requiredQuantity} required, but reservations leave ${evidence?.reservationAssessment?.availableObservedLowerBound ?? "an UNKNOWN amount"} outside other commitments. Review competing reservations; observed inventory and reservations have not changed.`
          : reservationAdjustedCoverageMet ? `Recent observed coverage reports ${evidence?.observedQuantity ?? "quantity UNKNOWN"} against ${need.requiredQuantity} required after accounting for this need's explicit reservation intent and same-source commitments. This confirms only source coverage; it does not establish which action occurred.`
          : evidenceMet ? `Recent observed coverage reports ${evidence?.observedQuantity ?? "quantity UNKNOWN"} against ${need.requiredQuantity} required, but reservation-adjusted coverage is not established. ${evidence?.reservationAssessment?.reason ?? "Review the reservation evidence."}`
          : `${evidence?.state.replaceAll("_", " ") ?? "Evidence UNKNOWN"} with ${evidence?.freshness ?? "unknown"} freshness${workOrders.length ? `; ${workOrders.length} linked manual work order(s) require review` : "; no linked manual work order exists"}.`;
      const missingPrerequisite = prerequisiteEvidence.some((entry) => !entry.exists);
      const allPrerequisitesMet = prerequisiteEvidence.length > 0 && prerequisiteEvidence.every((entry) => entry.isMet);
      const prerequisiteGate: ErpPortfolioFulfillmentStep["prerequisiteGate"] = prerequisiteEvidence.length === 0
        ? { state: "NO_PREREQUISITES", blockers: [] }
        : cycleDetected ? { state: "CYCLE_REVIEW", blockers: prerequisiteEvidence.filter((entry) => !entry.isMet).map(({ projectId, needId, evidenceState, freshness, observedAt, reservationState, availableObservedLowerBound, reason }) => ({ projectId, needId, evidenceState, freshness, ...(observedAt !== undefined ? { observedAt } : {}), ...(reservationState ? { reservationState } : {}), ...(availableObservedLowerBound !== undefined ? { availableObservedLowerBound } : {}), reason })) }
        : missingPrerequisite ? { state: "MISSING_PREREQUISITE", blockers: prerequisiteEvidence.filter((entry) => !entry.exists).map(({ projectId, needId, evidenceState, freshness, observedAt, reason }) => ({ projectId, needId, evidenceState, freshness, ...(observedAt !== undefined ? { observedAt } : {}), reason })) }
            : allPrerequisitesMet ? { state: "CURRENT_OBSERVED_EVIDENCE_MET", blockers: [] }
              : { state: cycleDetected ? "CYCLE_REVIEW" : "PREREQUISITE_EVIDENCE_REVIEW", blockers: prerequisiteEvidence.filter((entry) => !entry.isMet).map(({ projectId, needId, evidenceState, freshness, observedAt, reservationState, availableObservedLowerBound, reason }) => ({ projectId, needId, evidenceState, freshness, ...(observedAt !== undefined ? { observedAt } : {}), ...(reservationState ? { reservationState } : {}), ...(availableObservedLowerBound !== undefined ? { availableObservedLowerBound } : {}), reason })) };
      return { projectId: reference.projectId, projectTitle: project?.title ?? "Unavailable project", ...(project ? { projectStatus: project.status } : {}), projectPriority: project?.priority ?? 0, needId: reference.needId, needLabel: need?.label ?? reference.needId, resourceKey: need?.resourceKey ?? "UNKNOWN", ...(need ? { requiredQuantity: need.requiredQuantity } : {}), ...(need?.sourceIdentityKey ? { sourceIdentityKey: need.sourceIdentityKey } : {}), ...(need?.sourceOwnerKey ? { sourceOwnerKey: need.sourceOwnerKey } : {}), ...(need?.destinationIdentityKey ? { destinationIdentityKey: need.destinationIdentityKey } : {}), evidenceState: evidence?.state ?? "UNKNOWN", freshness: evidence?.freshness ?? "unknown", ...(evidence?.observedQuantity !== undefined ? { observedQuantity: evidence.observedQuantity } : {}), ...(evidence?.observedAt !== undefined ? { observedAt: evidence.observedAt } : {}), ...(projectReservationIntentQuantity !== undefined ? { projectReservationIntentQuantity } : {}), ...(evidence?.reservationAssessment ? { reservationAssessment: evidence.reservationAssessment } : {}), ...(pathwayByNeed.get(`${reference.projectId}\u0000${reference.needId}`) ? { fulfillmentPathways: pathwayByNeed.get(`${reference.projectId}\u0000${reference.needId}`)! } : {}), prerequisiteNeedIds: prerequisites, prerequisiteGate, workOrders: workOrders.map((order, index) => ({ stableId: order.stableId, title: order.title, status: order.status, readinessState: orderReadiness[index]!, ...(project?.workOrderProgress.find((entry) => entry.workOrderId === order.stableId) ? { progressState: project.workOrderProgress.find((entry) => entry.workOrderId === order.stableId)!.reconciliation } : {}) })), reviewState, reason };
    });
    const stableId = `portfolio:${JSON.stringify([version, component.map((key) => { const node = nodes.get(key)!; return [node.projectId, node.needId]; }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))])}`;
    const crossProjectDependencyCount = component.reduce((count, key) => count + [...(edges.get(key) ?? [])].filter((dependency) => nodes.get(dependency)!.projectId !== nodes.get(key)!.projectId).length, 0);
    const nextReview = steps.find((step) => step.reviewState !== "OBSERVED_NEED_MET");
    packages.push({ stableId, version, steps, crossProjectDependencyCount, ...(nextReview ? { nextReviewStepId: `${nextReview.projectId}/${nextReview.needId}` } : {}), cycleDetected, interpretation: "PLAYER_AUTHORED_SEQUENCE_AND_EVIDENCE_REVIEW_ONLY" });
  }
  packages.sort((a, b) => a.steps[0]!.projectTitle.localeCompare(b.steps[0]!.projectTitle) || a.stableId.localeCompare(b.stableId));
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(100, Math.floor(limit))) : 50;
  const selected = packages.slice(0, safeLimit);
  return { version, packages: selected, totalPackageCount: packages.length, returnedPackageCount: selected.length, savedPlanningBatches: savedPlanningBatchReview.batches, totalSavedPlanningBatchCount: savedPlanningBatchReview.totalCount, returnedSavedPlanningBatchCount: savedPlanningBatchReview.returnedCount, savedPlanningBatchesTruncated: savedPlanningBatchReview.truncated, totalStepCount: packages.reduce((sum, item) => sum + item.steps.length, 0), stepsNeedingReview: packages.reduce((sum, item) => sum + item.steps.filter((step) => step.reviewState !== "OBSERVED_NEED_MET").length, 0), stepsWithPrerequisiteReview: packages.reduce((sum, item) => sum + item.steps.filter((step) => step.prerequisiteGate.state !== "NO_PREREQUISITES" && step.prerequisiteGate.state !== "CURRENT_OBSERVED_EVIDENCE_MET").length, 0), pathwayReviewTruncated: sourceReview.truncated, truncated: selected.length < packages.length, interpretation: "PLAYER_AUTHORED_SEQUENCE_AND_EVIDENCE_REVIEW_ONLY" };
}

/** Groups explicitly source-scoped active/paused requirements with their already-derived evidence and linked manual-work observations. */
export function buildErpSourceFulfillmentReview(projects: readonly ErpProjectView[], version: VersionOrUnknown, limit = 100): ErpSourceFulfillmentReview {
  const emptyCounts = (): Record<ErpSourceFulfillmentNextReview, number> => ({ REVIEW_EVIDENCE: 0, REVIEW_RESERVATIONS: 0, RECONCILE_OBSERVATIONS: 0, PLAN_MANUAL_WORK: 0, REVIEW_MANUAL_WORK: 0, REVIEW_SOURCE_AND_ACCESS: 0 });
  const nextReviewCounts = emptyCounts();
  if (version === "unknown-version") return { version, sources: [], totalSourceCount: 0, returnedSourceCount: 0, totalNeedCount: 0, needsReviewCount: 0, nextReviewCounts, groupsWithAlternativeLocations: 0, alternativeLocationCount: 0, groupsWithIncompleteSourceScan: 0, openProvisioningPlanCount: 0, truncated: false, interpretation: "EXPLICIT_SOURCE_SCOPE_AND_MANUAL_REVIEW_ONLY" };
  const projectById = new Map(projects.filter((project) => project.version === version && (project.status === "ACTIVE" || project.status === "PAUSED")).map((project) => [project.stableId, project]));
  type Entry = { project: ErpProjectView; need: ErpResourceNeed; evidence?: ErpProjectView["needEvidence"][number] };
  const grouped = new Map<string, Entry[]>();
  for (const project of projectById.values()) for (const need of project.needs) {
    if (Boolean(need.sourceIdentityKey) === Boolean(need.sourceOwnerKey)) continue;
    const sourceScope = need.sourceIdentityKey ? "CHARACTER" : "SHARED_OWNER";
    const sourceId = need.sourceIdentityKey ?? need.sourceOwnerKey!;
    if (need.sourceIdentityKey && !need.sourceIdentityKey.startsWith(`${version}::`)) continue;
    const key = JSON.stringify([sourceScope, sourceId, need.kind, need.resourceKey]);
    grouped.set(key, [...(grouped.get(key) ?? []), { project, need, evidence: project.needEvidence.find((candidate) => candidate.needId === need.stableId) }]);
  }
  const lines: ErpSourceFulfillmentLine[] = [...grouped.entries()].map(([key, entries]) => {
    const first = [...entries].sort((a, b) => b.project.priority - a.project.priority || a.project.title.localeCompare(b.project.title) || a.need.stableId.localeCompare(b.need.stableId))[0]!;
    const sourceIdentityKey = first.need.sourceIdentityKey;
    const sourceOwnerKey = first.need.sourceOwnerKey;
    let sourceReviewCount = 0;
    let sourceScanIncomplete = false;
    let nonEmptyRosterScanCount = 0;
    const alternativeEvidence = new Map<string, { evidence: Omit<ErpResourceSourceCandidate, "needId" | "kind" | "resourceKey">; needReferences: { projectId: string; projectTitle: string; needId: string }[] }>();
    for (const entry of entries) {
      const screen = entry.project.resourceSourceScreens.find((candidate) => candidate.needId === entry.need.stableId);
      if (!screen) { sourceScanIncomplete = true; continue; }
      sourceReviewCount++;
      if (screen.scannedCharacterCount === 0) sourceScanIncomplete = true;
      else nonEmptyRosterScanCount++;
      if (screen.unresolvedCharacterCount > 0 || screen.candidatesTruncated) sourceScanIncomplete = true;
      for (const candidate of screen.candidates) {
        if (candidate.kind !== entry.need.kind || candidate.resourceKey !== entry.need.resourceKey || candidate.sourceIdentityKey === sourceIdentityKey) continue;
        const { needId: _needId, kind: _kind, resourceKey: _resourceKey, ...evidence } = candidate;
        const evidenceKey = JSON.stringify(evidence);
        const previous = alternativeEvidence.get(evidenceKey);
        const reference = { projectId: entry.project.stableId, projectTitle: entry.project.title, needId: entry.need.stableId };
        alternativeEvidence.set(evidenceKey, { evidence, needReferences: previous ? [...previous.needReferences, reference] : [reference] });
      }
    }
    const alternativeLocations = [...alternativeEvidence.values()].map(({ evidence, needReferences }) => {
      const planned = [...projectById.values()].flatMap((project) => project.needs.flatMap((need) => {
        if (need.kind !== first.need.kind || need.resourceKey !== first.need.resourceKey) return [];
        return project.workOrders.filter((order) => order.kind === "PROVISION" && order.status !== "COMPLETED" && order.status !== "CANCELLED" && order.sourceIdentityKey === evidence.sourceIdentityKey && order.resourceNeedIds.includes(need.stableId)).map((order) => ({ projectId: project.stableId, projectTitle: project.title, needId: need.stableId, needLabel: need.label, workOrderId: order.stableId, workOrderTitle: order.title, workOrderStatus: order.status, ...(order.destinationIdentityKey ? { destinationIdentityKey: order.destinationIdentityKey } : {}), ...(project.workOrderProgress.find((entry) => entry.workOrderId === order.stableId) ? { reconciliationState: project.workOrderProgress.find((entry) => entry.workOrderId === order.stableId)!.reconciliation } : {}) }));
      })).sort((a, b) => a.projectTitle.localeCompare(b.projectTitle) || a.needLabel.localeCompare(b.needLabel) || a.workOrderId.localeCompare(b.workOrderId));
      return { ...evidence, needReferences: needReferences.sort((a, b) => a.projectTitle.localeCompare(b.projectTitle) || a.needId.localeCompare(b.needId)), selectedProvisioningPlanCount: planned.length, selectedProvisioningPlansTruncated: planned.length > 25, selectedProvisioningPlans: planned.slice(0, 25) };
    }).sort((a, b) => a.sourceName.localeCompare(b.sourceName) || a.sourceRealm.localeCompare(b.sourceRealm) || a.sourceIdentityKey.localeCompare(b.sourceIdentityKey) || (a.observedAt ?? 0) - (b.observedAt ?? 0));
    const alternativeLocationReview: ErpSourceFulfillmentLine["alternativeLocationReview"] = sourceReviewCount === 0 ? "SOURCE_REVIEW_UNAVAILABLE" : alternativeLocations.length && sourceScanIncomplete ? "POTENTIAL_LOCATIONS_SCAN_INCOMPLETE" : alternativeLocations.length ? "OBSERVED_POTENTIAL_LOCATIONS" : nonEmptyRosterScanCount === 0 ? "NO_OTHER_CHARACTERS_TO_SCAN" : sourceScanIncomplete ? "SOURCE_SCAN_INCOMPLETE" : "NO_MATCHING_LOCATION_OBSERVED";
    const needs = entries.map(({ project, need, evidence }) => {
      const workOrders = project.workOrders.filter((order) => order.resourceNeedIds.includes(need.stableId)).sort((a, b) => a.stableId.localeCompare(b.stableId)).map((order) => {
        const readiness = project.workOrderReadiness.find((entry) => entry.workOrderId === order.stableId);
        const progress = project.workOrderProgress.find((entry) => entry.workOrderId === order.stableId);
        const observationStates = [
          ...(progress?.retrievalObservationReviews ?? []).filter((entry) => entry.needId === need.stableId).flatMap((entry) => [entry.state, ...(entry.pairedObservationPattern ? [entry.pairedObservationPattern.state] : []), ...(entry.recipientBagObservation ? [entry.recipientBagObservation.state] : [])]),
          ...(progress?.transferObservationReviews ?? []).filter((entry) => entry.needId === need.stableId).map((entry) => entry.state),
          ...(progress?.provisioningObservationReviews ?? []).filter((entry) => entry.needId === need.stableId).map((entry) => entry.state),
          ...(progress?.craftInputObservationReviews ?? []).filter((entry) => entry.needId === need.stableId).map((entry) => entry.state),
          ...(progress?.gatherObservationReviews ?? []).filter((entry) => entry.needId === need.stableId).map((entry) => entry.state),
          ...(progress?.sellObservationReviews ?? []).filter((entry) => entry.resourceKey === need.resourceKey).map((entry) => entry.state),
          ...(progress?.procurementObservationReview?.targetItem?.needId === need.stableId ? [progress.procurementObservationReview.state, progress.procurementObservationReview.targetItem.state] : []),
        ];
        const procurement = readiness?.procurementAssessment;
        return { stableId: order.stableId, kind: order.kind, title: order.title, status: order.status, ...(readiness ? { readinessState: readiness.state } : {}), ...(progress ? { progressState: progress.reconciliation } : {}), observationStates: [...new Set(observationStates)], capabilityChecks: (readiness?.capabilityChecks ?? []).map((check) => ({ kind: check.kind, state: check.state, reason: check.reason })), ...(progress?.plannedOutputAssessment ? { plannedOutputState: progress.plannedOutputAssessment.state } : {}), ...(order.pathwayContext?.needId === need.stableId ? { pathwayContext: order.pathwayContext } : {}), ...(procurement ? { procurement: { reviewState: procurement.reviewState, quoteState: procurement.quoteState, ...(procurement.playerQuote ? { quote: { amountCopper: procurement.playerQuote.amountCopper, quantity: procurement.playerQuote.quantity, recordedAt: procurement.playerQuote.recordedAt, freshness: procurement.playerQuote.freshness } } : {}), affordability: procurement.affordability, marketAvailability: procurement.marketAvailability } } : {}), ...(readiness?.reason || progress?.reason ? { reason: readiness?.reason ?? progress?.reason } : {}) };
      });
      const sourceSections = evidence?.sourceSections ?? [];
      const candidateLocations = alternativeLocations.filter((location) => location.needReferences.some((reference) => reference.projectId === project.stableId && reference.needId === need.stableId)).map((location) => ({ characterKey: location.sourceIdentityKey, characterName: `${location.sourceName}${location.sourceSurname ? ` ${location.sourceSurname}` : ""}`, realm: location.sourceRealm, provenance: location.state, freshness: location.freshness, ...(location.observedAt !== undefined ? { observedAt: location.observedAt } : {}) }));
      const ownReservationQuantity = reservationQuantityAtNeedSource(project, need);
      const fulfillmentPathways = buildNeedFulfillmentPathways(need, evidence, workOrders, sourceSections, candidateLocations, ownReservationQuantity);
      return { projectId: project.stableId, projectTitle: project.title, projectStatus: project.status, projectPriority: project.priority, needId: need.stableId, label: need.label, requiredQuantity: need.requiredQuantity, ...(need.destinationIdentityKey ? { destinationIdentityKey: need.destinationIdentityKey } : {}), state: evidence?.state ?? "UNKNOWN", freshness: evidence?.freshness ?? "unknown", ...(evidence?.observedQuantity !== undefined ? { observedQuantity: evidence.observedQuantity } : {}), ...(evidence?.potentialQuantity !== undefined ? { potentialQuantity: evidence.potentialQuantity } : {}), ...(evidence?.observedAt !== undefined ? { observedAt: evidence.observedAt } : {}), sourceSections, unresolvedSections: evidence?.unresolvedSections ?? ["need evidence"], ...(evidence?.reservationAssessment ? { reservationAssessment: evidence.reservationAssessment } : {}), fulfillmentPathways, reason: evidence?.reason ?? "No current need assessment is available; evidence is UNKNOWN.", workOrders };
    }).sort((a, b) => b.projectPriority - a.projectPriority || a.projectTitle.localeCompare(b.projectTitle) || a.needId.localeCompare(b.needId));
    const allEvidenceCurrent = needs.every((need) => need.state === "COVERED_BY_OBSERVED" || need.state === "SHORTFALL_OBSERVED") && needs.every((need) => need.freshness === "recent" && need.unresolvedSections.length === 0);
    const reservationReview = needs.some((need) => !need.reservationAssessment || need.reservationAssessment.state === "UNKNOWN" || need.reservationAssessment.state === "OVER_RESERVED");
    const changedObservationStates = new Set(["CHANGED", "BAGS_AND_BANK_CHANGED", "BANK_ONLY_CHANGED", "BAGS_ONLY_CHANGED", "SHARED_OWNER_CONTENT_CHANGED", "BOTH_SIDES_CHANGED", "SOURCE_ONLY_CHANGED", "DESTINATION_ONLY_CHANGED", "COMPARABLE_CHANGED", "ITEM_CHANGED", "RESOURCE_INCREASED", "RESOURCE_DECREASED", "GOLD_DECREASED", "GOLD_INCREASED"]);
    const changed = needs.some((need) => need.workOrders.some((order) => order.progressState === "OBSERVATION_CHANGED_CAUSE_UNKNOWN" || order.observationStates.some((state) => changedObservationStates.has(state))));
    const openOrders = needs.flatMap((need) => need.workOrders).filter((order) => order.status !== "COMPLETED" && order.status !== "CANCELLED");
    const hasObservedShortfall = needs.some((need) => need.state === "SHORTFALL_OBSERVED");
    const nextReview: ErpSourceFulfillmentNextReview = !allEvidenceCurrent ? "REVIEW_EVIDENCE" : reservationReview ? "REVIEW_RESERVATIONS" : changed ? "RECONCILE_OBSERVATIONS" : openOrders.length > 0 ? "REVIEW_MANUAL_WORK" : hasObservedShortfall ? "PLAN_MANUAL_WORK" : "REVIEW_SOURCE_AND_ACCESS";
    nextReviewCounts[nextReview]++;
    const reason = nextReview === "REVIEW_EVIDENCE" ? "At least one explicitly scoped need has stale, partial, unresolved, or unknown evidence. Review its source sections before planning against a current quantity."
      : nextReview === "REVIEW_RESERVATIONS" ? "A source-scoped reservation is unknown or exceeds its reviewed supply; inspect commitments before treating any quantity as available."
      : nextReview === "RECONCILE_OBSERVATIONS" ? "A linked manual task has comparable changed evidence. The change is not attributed to the task; review both observations before updating project progress."
      : nextReview === "PLAN_MANUAL_WORK" ? "Current evidence is present but no open linked work order exists. Choose a manual task only after confirming source access and a valid route."
      : nextReview === "REVIEW_MANUAL_WORK" ? "A linked manual task is already recorded. Inspect its readiness, capability/quote evidence, and paired observations before deciding what to do."
      : "Current evidence is present, but the selected source does not establish that it is accessible, allocated, or resolved for this need.";
    return { stableId: key, version, sourceScope: sourceIdentityKey ? "CHARACTER" : "SHARED_OWNER", ...(sourceIdentityKey ? { sourceIdentityKey } : {}), ...(sourceOwnerKey ? { sourceOwnerKey } : {}), kind: first.need.kind, resourceKey: first.need.resourceKey, label: first.need.label, projectCount: new Set(entries.map((entry) => entry.project.stableId)).size, nextReview, reason, alternativeLocationReview, alternativeLocations: alternativeLocations.slice(0, 25), alternativeLocationCount: alternativeLocations.length, alternativeLocationsTruncated: alternativeLocations.length > 25, needs };
  });
  // Review priority is explicit and independent of per-state counts.
  const order: Record<ErpSourceFulfillmentNextReview, number> = { REVIEW_EVIDENCE: 0, REVIEW_RESERVATIONS: 1, RECONCILE_OBSERVATIONS: 2, REVIEW_MANUAL_WORK: 3, PLAN_MANUAL_WORK: 4, REVIEW_SOURCE_AND_ACCESS: 5 };
  lines.sort((a, b) => order[a.nextReview] - order[b.nextReview] || b.needs[0]!.projectPriority - a.needs[0]!.projectPriority || a.label.localeCompare(b.label) || a.stableId.localeCompare(b.stableId));
  const safeLimit = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, MAX_ERP_REVIEW_ROWS) : 100;
  const sources = lines.slice(0, safeLimit);
  const openProvisioningPlanCount = [...projectById.values()].reduce((count, project) => count + project.workOrders.filter((order) => order.kind === "PROVISION" && order.status !== "COMPLETED" && order.status !== "CANCELLED").length, 0);
  return { version, sources, totalSourceCount: lines.length, returnedSourceCount: sources.length, totalNeedCount: lines.reduce((sum, line) => sum + line.needs.length, 0), needsReviewCount: lines.length, nextReviewCounts, groupsWithAlternativeLocations: lines.filter((line) => line.alternativeLocationCount > 0).length, alternativeLocationCount: lines.reduce((sum, line) => sum + line.alternativeLocationCount, 0), groupsWithIncompleteSourceScan: lines.filter((line) => line.alternativeLocationReview === "SOURCE_SCAN_INCOMPLETE" || line.alternativeLocationReview === "POTENTIAL_LOCATIONS_SCAN_INCOMPLETE" || line.alternativeLocationReview === "SOURCE_REVIEW_UNAVAILABLE").length, openProvisioningPlanCount, truncated: sources.length < lines.length, interpretation: "EXPLICIT_SOURCE_SCOPE_AND_MANUAL_REVIEW_ONLY" };
}

/** Combines existing source and project triage reviews without joining any needs whose source is absent or differently scoped. */
export function buildErpPortfolioNextActionReview(projects: readonly ErpProjectView[], version: VersionOrUnknown, limit = 100): ErpPortfolioNextActionReview {
  const actions: ErpPortfolioNextAction[] = ["REVIEW_EVIDENCE", "REVIEW_RESERVATIONS", "RECONCILE_OBSERVATIONS", "REVIEW_MANUAL_WORK", "PLAN_MANUAL_WORK", "REVIEW_SOURCE_AND_ACCESS", "REVIEW_UNSCOPED_ITEM"];
  const counts = Object.fromEntries(actions.map((action) => [action, 0])) as Record<ErpPortfolioNextAction, number>;
  if (version === "unknown-version") return { version, items: [], totalCount: 0, returnedCount: 0, counts, sourceReviewTruncated: false, triageTruncated: false, truncated: false, interpretation: "DETERMINISTIC_PLAYER_REVIEW_QUEUE_ONLY" };
  const triage = buildErpFulfillmentTriage(projects, version, MAX_ERP_REVIEW_ROWS);
  const triageByNeed = new Map(triage.items.filter((item) => item.need).map((item) => [`${item.projectId}\0${item.need!.stableId}`, item]));
  const matched = new Set<string>();
  const sourceReview = buildErpSourceFulfillmentReview(projects, version, MAX_ERP_REVIEW_ROWS);
  const convert = (action: ErpSourceFulfillmentNextReview): ErpPortfolioNextAction => action;
  const rows: ErpPortfolioNextActionItem[] = sourceReview.sources.map((source) => {
    const references = source.needs.map((need) => {
      const key = `${need.projectId}\0${need.needId}`;
      matched.add(key);
      const triaged = triageByNeed.get(key);
      return { projectId: need.projectId, projectTitle: need.projectTitle, projectPriority: need.projectPriority, needId: need.needId, requiredQuantity: need.requiredQuantity, evidenceState: need.state, freshness: need.freshness, ...(need.observedAt !== undefined ? { observedAt: need.observedAt } : {}), ...(triaged?.need?.observationChange?.comparisons.length ? { observationChanges: triaged.need.observationChange.comparisons } : {}) };
    });
    const linked = source.needs.map((need) => triageByNeed.get(`${need.projectId}\0${need.needId}`)).filter((item): item is ErpFulfillmentTriageItem => Boolean(item));
    const signals = [...new Set(linked.flatMap((item) => item.signals))].sort();
    const action: ErpPortfolioNextAction = source.needs.some((need) => need.freshness !== "recent" || need.state === "UNKNOWN" || need.unresolvedSections.length > 0) ? "REVIEW_EVIDENCE"
      : signals.includes("RESERVATION_REVIEW") || source.nextReview === "REVIEW_RESERVATIONS" ? "REVIEW_RESERVATIONS"
        : signals.includes("CHANGED_OBSERVATION") || source.nextReview === "RECONCILE_OBSERVATIONS" ? "RECONCILE_OBSERVATIONS"
          : convert(source.nextReview);
    return { stableId: `source:${source.stableId}`, version, action, resource: { kind: source.kind, resourceKey: source.resourceKey, label: source.label }, source: { scope: source.sourceScope, identityKey: source.sourceIdentityKey ?? source.sourceOwnerKey! }, needReferences: references, signals, workOrders: source.needs.flatMap((need) => need.workOrders.filter((order) => order.status !== "COMPLETED" && order.status !== "CANCELLED").map((order) => ({ projectId: need.projectId, stableId: order.stableId }))).filter((order, index, all) => all.findIndex((candidate) => candidate.projectId === order.projectId && candidate.stableId === order.stableId) === index).sort((a, b) => a.projectId.localeCompare(b.projectId) || a.stableId.localeCompare(b.stableId)), reason: source.reason };
  });
  for (const item of triage.items) {
    if (item.need && matched.has(`${item.projectId}\0${item.need.stableId}`)) continue;
    const action: ErpPortfolioNextAction = item.need ? "REVIEW_UNSCOPED_ITEM" : "REVIEW_MANUAL_WORK";
    const sourceScopeIssue = item.need ? item.need.sourceIdentityKey && item.need.sourceOwnerKey ? "CONFLICTING_SOURCE_FIELDS" as const : item.need.sourceIdentityKey && !item.need.sourceIdentityKey.startsWith(`${version}::`) ? "VERSION_MISMATCH" as const : !item.need.sourceIdentityKey && !item.need.sourceOwnerKey ? "MISSING_SOURCE" as const : undefined : undefined;
    const recordedSourceIdentity = item.need?.sourceIdentityKey ?? item.need?.sourceOwnerKey;
    const recordedSourceScope = item.need && (item.need.sourceIdentityKey || item.need.sourceOwnerKey) ? { ...(item.need.sourceIdentityKey ? { sourceIdentityKey: item.need.sourceIdentityKey } : {}), ...(item.need.sourceOwnerKey ? { sourceOwnerKey: item.need.sourceOwnerKey } : {}) } : undefined;
    const scopeReason = sourceScopeIssue === "MISSING_SOURCE" ? "No source identity was recorded; this requirement remains separate and cannot be combined with source-scoped rows." : sourceScopeIssue ? "A source reference is recorded, but its scope is conflicting or incompatible with the selected version, so it remains separate and cannot be safely grouped." : "";
    rows.push({ stableId: `triage:${item.stableId}`, version, action, ...(item.need ? { resource: { kind: item.need.kind, resourceKey: item.need.resourceKey, label: item.need.label } } : {}), ...(recordedSourceIdentity ? { recordedSourceIdentity } : {}), ...(recordedSourceScope ? { recordedSourceScope } : {}), ...(sourceScopeIssue ? { sourceScopeIssue } : {}), needReferences: item.need ? [{ projectId: item.projectId, projectTitle: item.projectTitle, projectPriority: item.projectPriority, needId: item.need.stableId, requiredQuantity: item.need.requiredQuantity, evidenceState: item.need.evidenceState, freshness: item.need.freshness, ...(item.need.observedAt !== undefined ? { observedAt: item.need.observedAt } : {}), ...(item.need.observationChange?.comparisons.length ? { observationChanges: item.need.observationChange.comparisons } : {}) }] : [], signals: item.signals, workOrders: item.workOrders.filter((order) => order.status !== "COMPLETED" && order.status !== "CANCELLED").map((order) => ({ projectId: item.projectId, stableId: order.stableId })), reason: item.need ? `${item.reason} ${scopeReason}`.trim() : item.reason });
  }
  const order: Record<ErpPortfolioNextAction, number> = { REVIEW_EVIDENCE: 0, REVIEW_RESERVATIONS: 1, RECONCILE_OBSERVATIONS: 2, REVIEW_UNSCOPED_ITEM: 3, REVIEW_MANUAL_WORK: 4, PLAN_MANUAL_WORK: 5, REVIEW_SOURCE_AND_ACCESS: 6 };
  rows.sort((a, b) => order[a.action] - order[b.action] || (b.needReferences[0]?.projectPriority ?? 0) - (a.needReferences[0]?.projectPriority ?? 0) || (a.resource?.label ?? "").localeCompare(b.resource?.label ?? "") || a.stableId.localeCompare(b.stableId));
  for (const row of rows) counts[row.action]++;
  const safeLimit = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 200) : 100;
  const items = rows.slice(0, safeLimit);
  return { version, items, totalCount: rows.length, returnedCount: items.length, counts, sourceReviewTruncated: sourceReview.truncated, triageTruncated: triage.truncated, truncated: items.length < rows.length || sourceReview.truncated || triage.truncated, interpretation: "DETERMINISTIC_PLAYER_REVIEW_QUEUE_ONLY" };
}
