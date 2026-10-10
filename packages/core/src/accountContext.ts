// AccountContext: a single, deterministic, LLM-readable snapshot of the
// whole dashboard (every known WoW version) for hand-off to an
// external LLM conversation. This is explicitly NOT a second
// implementation of account logic — it is a thin, pure assembly layer
// over things that already exist:
//
//   - AccountFacts (one per version, embedded wholesale — already
//     realm-scoped for Classic Era/TBC Anniversary/Forever, account-wide
//     for Retail, already carries gold/playtime/professions/inventory/
//     recentChanges/freshness with full UNKNOWN-vs-NONE-vs-zero fidelity)
//   - diffSnapshots (reused, via diffToChangeSummary, to build a
//     transition entry between every consecutive pair of snapshots, not
//     just the latest "meaningful" one AccountFacts.recentChanges covers)
//   - summarizeTrainerCategory (reused as-is — the export embeds the same
//     grouped/summarized trainer view the character page shows, never
//     the raw hundreds-of-services array)
//
// Nothing here recomputes a gold total, a freshness classification, or a
// profession coverage rule. If a future consumer needs different facts,
// the fix belongs in accountFacts.ts, not here.
//
// Determinism: buildAccountContext is pure (no I/O, no clock reads) and
// every collection is explicitly sorted, so the same input + the same
// `now` always produces byte-identical JSON.

import { diffToChangeSummary, type AccountChangeSummary, type AccountFacts } from "./accountFacts.ts";
import { snapshotObservedAt } from "./chronology.ts";
import { diffSnapshots } from "./diff.ts";
import { summarizeTrainerCategory, type TrainerCategorySummary } from "./trainerSummary.ts";
import type { ParsedSnapshot, SectionState, WowVersion } from "./types.ts";
import type { StoredSnapshot } from "./store.ts";
import type { CharacterResolution, ReadValue } from "./readModel.ts";
import type { buildForeverGearObservation } from "./foreverGearObservation.ts";
import type { DashboardReadModel } from "./readModel.ts";
import { WOW_VERSIONS } from "./version.ts";
import { buildErpResourceCommitmentSummary, type ErpProjectView, type ErpWorkOrder } from "./erpProjects.ts";
import { buildErpProcurementBudgetPortfolioReview } from "./erpProcurementPortfolio.ts";
import { buildErpProcurementBuyerPortfolioReview } from "./erpProcurementBuyerPortfolio.ts";
import { buildErpNeedObservationChangeReview } from "./erpObservationChanges.ts";
import { buildErpFulfillmentTriage, buildErpPortfolioFulfillmentReview, buildErpSourceFulfillmentReview, buildErpPortfolioNextActionReview, type ErpFulfillmentTriageSignal, type ErpPortfolioNextAction } from "./erpFulfillmentTriage.ts";

// Bumped to "3" (additive, on top of the v2 changes below): gold/playtime
// totals gained freshness fields (staleCharactersWith*/oldest*ObservedAt),
// change summaries gained `observedAt`, realm-partitioned versions gained an
// in-band `scopeNote`, and the `currency` note now states that a total over
// zero observed values is not zero.
// Bumped to "17": project summaries distinguish whether a player quote can be
// compared to a later gross-gold snapshot after recorded reservations.
//
// Bumped to "2": added the `currency` field, renamed the two differently-
// scoped profession `status` fields to `observationStatus`/`coverageStatus`
// (see accountFacts.ts), and added `AccountChangeSummary.inventoryItemChanges`
// — all identified as concrete gaps by a real LLM-evaluation pass (a model
// misread 102815 copper as "102.8 gold", contradicted itself on profession
// coverage, and reported inventory item changes as absent from its context).
// Bumped to 21 for linked planned gold needs, 22 for quote-to-budget
// comparison summaries, 23 for reservation review states, 24 for the
// cross-domain project fulfillment snapshot, 25 for changed-need review counts,
// 26 for compact per-version combined fulfillment triage, 27 for dependency-
// ordered portfolio summaries, 28 for dynamic prerequisite evidence gates,
// 29 for procurement ceiling reviews, 30 for cross-project buyer reviews,
// 31 for exact-resource buyer packages, 32 for observed-source leads,
// 33 for returned package need/provisioning summaries, 34 for source-capacity
// summaries, 35 for explicit cross-project source-intent summaries, 36 for
// the version-scoped source fulfillment review queue, and 37 for open selected
// provisioning-plan counts within that queue, 38 for evidence-qualified
// per-need fulfillment pathway counts, 39 for persisted pathway context, 40
// for pathway-review truncation, 43 for saved-plan lineage, 44 for per-requirement saved planning history,
// 45 for bounded post-review observation interval summaries, 46 for
// actionable intervening-variation history counts, and 47 for portfolio
// attention signals sourced from saved requirement history.
export const ACCOUNT_CONTEXT_SCHEMA_VERSION = "47";

/**
 * Explicit, in-band documentation of the one unit convention this document
 * uses everywhere: every field ending in "Copper" (goldCopper, moneyCopper,
 * deltaCopper, costCopper, totalKnownCopper, goldDeltaCopper, ...) is a raw
 * copper integer, WoW's smallest currency unit. Embedding this in the
 * exported JSON itself (rather than relying solely on an LLM consumer's
 * system prompt) means the convention travels with the data to any
 * consumer, not just the one prompt that happens to mention it.
 */
export interface CurrencyConvention {
  unit: "copper";
  conversion: string;
  note: string;
}

const CURRENCY_CONVENTION: CurrencyConvention = {
  unit: "copper",
  conversion: "1 gold = 100 silver = 10000 copper",
  note:
    "Every field whose name ends in \"Copper\" (e.g. goldCopper, moneyCopper, deltaCopper, costCopper, totalKnownCopper) is an integer amount of copper, WoW's smallest currency unit — never gold, and never a decimal gold amount. To display as gold/silver/copper: gold = floor(copper / 10000), silver = floor((copper % 10000) / 100), remaining copper = copper % 100. A total whose known-character count is 0 (charactersWithKnownGold / charactersWithKnownPlaytime) is a sum over nothing observed - it means unknown, NOT zero gold. Totals are sums of each character's last observed value (not live balances); staleCharactersWith* and oldest*ObservedAt say how old the contributions are.",
};

/**
 * In-band explanation attached to realm-partitioned versions (Classic Era,
 * TBC Anniversary, Forever). The version-wide totals in `facts` (gold,
 * playtime, inventory, ...) are computed for every version, but across
 * separate realm economies they are DERIVED sums that no player could spend
 * as one balance. The note travels with the data so a consumer that never
 * sees a system prompt (a pasted developer export) is still told which view
 * to use.
 */
export const REALM_SCOPE_NOTE =
  "This version is realm-partitioned: characters on different realms do not share an economy. The version-wide totals in facts (gold, playtime, inventory, profession coverage) are DERIVED sums across separate realms, kept for completeness only - use facts.realms[] (one entry per realm) for any per-realm or economic question, and never present a cross-realm sum as one account balance.";

export interface SnapshotHistoryEntry {
  generatedAt?: number;
  importedAt: number;
  level?: number;
  moneyCopper?: number;
  xp?: number;
  xpMax?: number;
  playedSeconds?: number;
  levelPlayedSeconds?: number;
  zone?: string;
  subzone?: string;
}

export interface CharacterTrainerCategoryContext {
  category: string;
  /** Status of the raw trainer category section itself (UNKNOWN = never visited). */
  status: SectionState;
  /** Trainer NPC name, when observed. */
  name?: string;
  /** The existing grouped/summarized view (available now / grouped by required level / unknown unlock level / next training) — never the raw services list. Full per-service drill-down remains available via the existing GET /api/characters/:identityKey/snapshots endpoint if ever needed. */
  summary: TrainerCategorySummary;
}

export interface CharacterContext {
  identityKey: string;
  name: string;
  surname?: string;
  surnameSource?: string;
  realm: string;
  /** Chronological, oldest first. */
  snapshotHistory: SnapshotHistoryEntry[];
  /** One entry per consecutive snapshot pair, chronological, oldest transition first. Same shape as AccountFacts.recentChanges — reused, not reinvented. */
  transitions: AccountChangeSummary[];
  /** From the character's latest snapshot only. */
  trainer: CharacterTrainerCategoryContext[];
  /** Forever 70291 view from the same GUID-guarded read model used by REST and MCP. */
  foreverGearObservation?: CharacterResolution<ReadValue<ReturnType<typeof buildForeverGearObservation>>>;
  /** Evidence-gated, cross-character Forever assessment; all unsupported conclusions remain UNKNOWN. */
  foreverGearAllocation?: ReturnType<DashboardReadModel["getForeverGearAllocation"]>;
}

export interface VersionContext {
  version: WowVersion;
  aggregationScope: AccountFacts["aggregationScope"];
  /** Present only when aggregationScope is "realm": says the version-wide totals are derived cross-realm sums and that facts.realms[] is the per-realm view. */
  scopeNote?: string;
  /** The full, authoritative AccountFacts for this version — embedded wholesale, not re-derived. */
  facts: AccountFacts;
  /** Per-character history/trainer detail AccountFacts itself doesn't carry (it only has "latest + one diff"). Same character set and order as facts.characters. */
  characters: CharacterContext[];
}

export interface AccountContext {
  schemaVersion: typeof ACCOUNT_CONTEXT_SCHEMA_VERSION;
  generatedAt: number;
  currency: CurrencyConvention;
  versions: Record<WowVersion, VersionContext>;
  /** Player-authored ERP intent, separate from observed facts; evidence is summarized by the planning read model. */
  planning: { projects: Array<{ stableId: string; version: WowVersion; title: string; status: ErpProjectView["status"]; priority: number; revision: number; historyEventCount: number; updatedAt: number; needsCount: number; fulfillment: ErpProjectView["fulfillment"]; workOrderCounts: Record<string, number>; workOrderPathways: Array<{ stableId: string; needIds: readonly string[]; context: NonNullable<ErpWorkOrder["pathwayContext"]> }>; reservationReviewStates: Partial<Record<ErpProjectView["reservationReview"][number]["state"], number>>; workOrderReadinessStates: Partial<Record<ErpProjectView["workOrderReadiness"][number]["state"], number>>; workOrderProgressStates: Partial<Record<ErpProjectView["workOrderProgress"][number]["reconciliation"], number>>; retrievalObservationStates: Partial<Record<NonNullable<ErpProjectView["workOrderProgress"][number]["retrievalObservationReviews"]>[number]["state"], number>>; retrievalRecipientBagObservationStates: Partial<Record<NonNullable<NonNullable<ErpProjectView["workOrderProgress"][number]["retrievalObservationReviews"]>[number]["recipientBagObservation"]>["state"], number>>; retrievalPairedObservationPatternStates: Partial<Record<NonNullable<NonNullable<ErpProjectView["workOrderProgress"][number]["retrievalObservationReviews"]>[number]["pairedObservationPattern"]>["state"], number>>; plannedCraftOutputStates: Partial<Record<NonNullable<ErpProjectView["workOrderProgress"][number]["plannedOutputAssessment"]>["state"], number>>; craftInputObservationStates: Partial<Record<NonNullable<ErpProjectView["workOrderProgress"][number]["craftInputObservationReviews"]>[number]["state"], number>>; sellObservationStates: Partial<Record<NonNullable<ErpProjectView["workOrderProgress"][number]["sellObservationReviews"]>[number]["state"], number>>; procurementReviewStates: Partial<Record<NonNullable<ErpProjectView["workOrderReadiness"][number]["procurementAssessment"]>["reviewState"], number>>; procurementQuoteStates: Partial<Record<NonNullable<ErpProjectView["workOrderReadiness"][number]["procurementAssessment"]>["quoteState"], number>>; procurementQuoteFreshnessStates: Partial<Record<NonNullable<NonNullable<ErpProjectView["workOrderReadiness"][number]["procurementAssessment"]>["playerQuote"]>["freshness"], number>>; procurementGoldReservationStates: Partial<Record<NonNullable<ErpProjectView["workOrderReadiness"][number]["procurementAssessment"]>["recordedGoldReservationState"], number>>; procurementQuoteGoldComparisonStates: Partial<Record<NonNullable<ErpProjectView["workOrderReadiness"][number]["procurementAssessment"]>["quoteVsRecordedGoldState"], number>>; procurementQuotePlannedBudgetStates: Partial<Record<NonNullable<ErpProjectView["workOrderReadiness"][number]["procurementAssessment"]>["quoteVsPlannedBudgetState"], number>>; procurementBudgetNeedStates: Record<string, number>; needStates: Record<string, number>; resourceSourceScreenCounts: { needsScreened: number; possibleSources: number; unresolvedCharacters: number } }>; resourceCommitments: Record<WowVersion, { lineCount: number; linesWithReservations: number; unknownSourceLines: number; overlappingScopeLines: number; truncated: boolean }>; needObservationChangeReviews: Record<WowVersion, { changedNeedCount: number; affectedProjectCount: number; truncated: boolean }>; fulfillmentTriage: Record<WowVersion, { totalCount: number; affectedProjectCount: number; counts: Record<ErpFulfillmentTriageSignal, number>; truncated: boolean }>; portfolioFulfillment: Record<WowVersion, { packageCount: number; stepCount: number; stepsNeedingReview: number; stepsWithPrerequisiteReview: number; savedBatchCount: number; savedBatchReviewStates: Record<string, number>; savedBatchTaskCount: number; replanFollowUpCount: number; replanLineageConflictCount: number; batchesWithFollowUps: number; savedNeedHistoryCount: number; savedNeedHistoryNextReviewCounts: Record<string, number>; savedBatchIntervalSampleCount: number; savedBatchIntervalsWithPartialEvidence: number; savedBatchIntervalsTruncated: number; savedNeedHistoriesTruncated: boolean; savedBatchesTruncated: boolean; pathwayReviewTruncated: boolean; truncated: boolean }>; sourceFulfillment: Record<WowVersion, { sourceCount: number; needCount: number; needsReviewCount: number; nextReviewCounts: Readonly<Record<string, number>>; pathwayStates: Readonly<Record<string, number>>; pathwayOptionKinds: Readonly<Record<string, number>>; groupsWithAlternativeLocations: number; alternativeLocationCount: number; groupsWithIncompleteSourceScan: number; openProvisioningPlanCount: number; truncated: boolean }>; portfolioNextActions: Record<WowVersion, { totalCount: number; counts: Readonly<Record<ErpPortfolioNextAction, number>>; interveningHistoryReviewCount: number; savedHistoryReviewTruncated: boolean; truncated: boolean }>; procurementBudgetReview: Record<WowVersion, { lineCount: number; overPlannedBudget: number; totalOpenCeilingCopper?: number; returnedCeilingsExceedSafeInteger?: true; quoteReviewStates: Record<string, number>; quoteBudgetsAbovePlan: number; quoteBudgetsIncomplete: number; truncated: boolean }>; procurementBuyerReview: Record<WowVersion, { buyerCount: number; returnedBuyerCount: number; returnedQuoteStates: Record<string, number>; returnedQuoteTotalsAboveRecordedRemainder: number; returnedIncompleteQuoteCoverage: number; returnedCrossProjectResourcePackageCount: number; returnedPackagesWithObservedSourceLeads: number; returnedPackagesWithIncompleteSourceReview: number; returnedObservedSourceLeadRows: number; returnedPackageNeedReviewCount: number; returnedPackageNeedReviewStates: Record<string, number>; returnedPackagesWithOpenProvisioningReview: number; returnedPackageSourceCoverageReviewCount: number; returnedPackageSourceCoverageReviewStates: Record<string, number>; returnedSourceCoverageReviewsWithOtherProjectNeeds: number; returnedOtherSourceScopedNeedCount: number; unresolvedBuyerOrderCount: number; truncated: boolean }> };
}

export interface AccountContextInput {
  now: number;
  /** One AccountFacts per known WoW version (WOW_VERSIONS: classic-era, tbc-anniversary, retail, forever) — already built via SqliteSnapshotStore.buildAccountFacts. */
  versionFacts: Record<WowVersion, AccountFacts>;
  /** Every stored snapshot for every character appearing in any versionFacts, keyed by identityKey. Newest-first or any order — sorted internally. */
  characterSnapshots: Map<string, StoredSnapshot[]>;
  /** Precomputed with the canonical read-model version and source-GUID guard. */
  foreverGearObservations?: Map<string, CharacterContext["foreverGearObservation"]>;
  foreverGearAllocations?: Map<string, CharacterContext["foreverGearAllocation"]>;
  erpProjects?: readonly ErpProjectView[];
}

// The one chronology rule (see chronology.ts) - shared with the SQLite
// queries behind "latest"/"previous", so the store, AccountFacts and this
// document always describe the same snapshot pairs.
function snapshotSortKey(s: StoredSnapshot): number {
  return snapshotObservedAt(s.generatedAt, s.importedAt);
}

// generatedAt (or its importedAt fallback) is not guaranteed unique - two
// snapshots can legitimately share the same value (same-second imports,
// or an addon export whose in-game clock didn't tick between them).
// Array.prototype.sort is stable, so a comparator that returns 0 for tied
// keys preserves the *input* array's relative order for that pair - and
// the input here (SqliteSnapshotStore.listSnapshots) is newest-first, not
// oldest-first, so an unbroken tie would silently reverse that pair's
// chronology (and therefore every directional delta the transition
// reports). `id` is the snapshots table's AUTOINCREMENT primary key: an
// existing, already-persisted signal that is unique per row and strictly
// increasing in true insertion order, so it's an exact, transitive
// tie-breaker - no new persisted field needed.
function compareSnapshotsChronologically(a: StoredSnapshot, b: StoredSnapshot): number {
  const byObservedTime = snapshotSortKey(a) - snapshotSortKey(b);
  if (byObservedTime !== 0) return byObservedTime;
  return a.id - b.id;
}

function toHistoryEntry(parsed: ParsedSnapshot, importedAt: number): SnapshotHistoryEntry {
  return {
    generatedAt: parsed.generatedAt,
    importedAt,
    level: parsed.character.level,
    moneyCopper: parsed.character.moneyCopper,
    xp: parsed.character.xp,
    xpMax: parsed.character.xpMax,
    playedSeconds: parsed.character.playedSeconds,
    levelPlayedSeconds: parsed.character.levelPlayedSeconds,
    zone: parsed.location.zone,
    subzone: parsed.location.subzone,
  };
}

function buildCharacterContext(identityKey: string, name: string, realm: string, snapshots: StoredSnapshot[], surname?: string, surnameSource?: string, foreverGearObservation?: CharacterContext["foreverGearObservation"], foreverGearAllocation?: CharacterContext["foreverGearAllocation"]): CharacterContext {
  const chronological = [...snapshots].sort(compareSnapshotsChronologically);

  const snapshotHistory = chronological.map((s) => toHistoryEntry(s.parsed, s.importedAt));

  const transitions: AccountChangeSummary[] = [];
  for (let i = 1; i < chronological.length; i++) {
    const from = chronological[i - 1];
    const to = chronological[i];
    const diff = diffSnapshots(from.parsed, to.parsed);
    transitions.push(
      diffToChangeSummary(diff, {
        identityKey,
        characterName: name,
        importedAt: to.importedAt,
        observedAt: snapshotObservedAt(to.generatedAt, to.importedAt),
      }),
    );
  }

  const latest = chronological[chronological.length - 1];
  const trainer: CharacterTrainerCategoryContext[] = latest
    ? [...latest.parsed.trainer.categories]
        .sort((a, b) => a.category.localeCompare(b.category))
        .map((category) => ({
          category: category.category,
          status: category.status.state,
          name: category.name,
          summary: summarizeTrainerCategory(category),
        }))
    : [];

  return { identityKey, name, ...(surname ? { surname } : {}), ...(surnameSource ? { surnameSource } : {}), realm, snapshotHistory, transitions, trainer, ...(foreverGearObservation ? { foreverGearObservation } : {}), ...(foreverGearAllocation ? { foreverGearAllocation } : {}) };
}

export function buildAccountContext(input: AccountContextInput): AccountContext {
  const { now, versionFacts, characterSnapshots } = input;

  const versions = {} as Record<WowVersion, VersionContext>;
  for (const version of WOW_VERSIONS) {
    const facts = versionFacts[version];
    const characters = [...facts.characters]
      .sort((a, b) => a.realm.localeCompare(b.realm) || a.name.localeCompare(b.name))
      .map((c) => buildCharacterContext(c.identityKey, c.name, c.realm, characterSnapshots.get(c.identityKey) ?? [], c.surname, c.surnameSource, version === "forever" ? input.foreverGearObservations?.get(c.identityKey) : undefined, version === "forever" ? input.foreverGearAllocations?.get(c.identityKey) : undefined));

    versions[version] = {
      version,
      aggregationScope: facts.aggregationScope,
      ...(facts.aggregationScope === "realm" ? { scopeNote: REALM_SCOPE_NOTE } : {}),
      facts,
      characters,
    };
  }

  return {
    schemaVersion: ACCOUNT_CONTEXT_SCHEMA_VERSION,
    generatedAt: now,
    currency: CURRENCY_CONVENTION,
    versions,
    planning: { projects: [...(input.erpProjects ?? [])].map((p) => ({
      stableId: p.stableId, version: p.version, title: p.title, status: p.status, priority: p.priority, revision: p.revision, historyEventCount: p.historyEventCount, updatedAt: p.updatedAt,
      needsCount: p.needs.length,
      fulfillment: p.fulfillment,
      workOrderCounts: Object.fromEntries([...new Set(p.workOrders.map((w) => w.status))].sort().map((status) => [status, p.workOrders.filter((w) => w.status === status).length])),
      workOrderPathways: p.workOrders.flatMap((workOrder) => workOrder.pathwayContext ? [{ stableId: workOrder.stableId, needIds: workOrder.resourceNeedIds, context: workOrder.pathwayContext }] : []),
      reservationReviewStates: Object.fromEntries([...new Set(p.reservationReview.map((reservation) => reservation.state))].sort().map((state) => [state, p.reservationReview.filter((reservation) => reservation.state === state).length])),
      workOrderReadinessStates: Object.fromEntries([...new Set(p.workOrderReadiness.map((w) => w.state))].sort().map((state) => [state, p.workOrderReadiness.filter((w) => w.state === state).length])),
      workOrderProgressStates: Object.fromEntries([...new Set(p.workOrderProgress.map((w) => w.reconciliation))].sort().map((state) => [state, p.workOrderProgress.filter((w) => w.reconciliation === state).length])),
      retrievalObservationStates: Object.fromEntries([...new Set(p.workOrderProgress.flatMap((w) => w.retrievalObservationReviews?.map((review) => review.state) ?? []))].sort().map((state) => [state, p.workOrderProgress.reduce((count, w) => count + (w.retrievalObservationReviews?.filter((review) => review.state === state).length ?? 0), 0)])),
      retrievalRecipientBagObservationStates: Object.fromEntries([...new Set(p.workOrderProgress.flatMap((w) => w.retrievalObservationReviews?.flatMap((review) => review.recipientBagObservation ? [review.recipientBagObservation.state] : []) ?? []))].sort().map((state) => [state, p.workOrderProgress.reduce((count, w) => count + (w.retrievalObservationReviews?.filter((review) => review.recipientBagObservation?.state === state).length ?? 0), 0)])),
      retrievalPairedObservationPatternStates: Object.fromEntries([...new Set(p.workOrderProgress.flatMap((w) => w.retrievalObservationReviews?.flatMap((review) => review.pairedObservationPattern ? [review.pairedObservationPattern.state] : []) ?? []))].sort().map((state) => [state, p.workOrderProgress.reduce((count, w) => count + (w.retrievalObservationReviews?.filter((review) => review.pairedObservationPattern?.state === state).length ?? 0), 0)])),
      plannedCraftOutputStates: Object.fromEntries([...new Set(p.workOrderProgress.flatMap((w) => w.plannedOutputAssessment ? [w.plannedOutputAssessment.state] : []))].sort().map((state) => [state, p.workOrderProgress.filter((w) => w.plannedOutputAssessment?.state === state).length])),
      craftInputObservationStates: Object.fromEntries([...new Set(p.workOrderProgress.flatMap((w) => w.craftInputObservationReviews?.map((review) => review.state) ?? []))].sort().map((state) => [state, p.workOrderProgress.reduce((count, w) => count + (w.craftInputObservationReviews?.filter((review) => review.state === state).length ?? 0), 0)])),
      sellObservationStates: Object.fromEntries([...new Set(p.workOrderProgress.flatMap((w) => w.sellObservationReviews?.map((review) => review.state) ?? []))].sort().map((state) => [state, p.workOrderProgress.reduce((count, w) => count + (w.sellObservationReviews?.filter((review) => review.state === state).length ?? 0), 0)])),
      gatherObservationStates: Object.fromEntries([...new Set(p.workOrderProgress.flatMap((w) => w.gatherObservationReviews?.map((review) => review.state) ?? []))].sort().map((state) => [state, p.workOrderProgress.reduce((count, w) => count + (w.gatherObservationReviews?.filter((review) => review.state === state).length ?? 0), 0)])),
      procurementReviewStates: Object.fromEntries([...new Set(p.workOrderReadiness.flatMap((w) => w.procurementAssessment ? [w.procurementAssessment.reviewState] : []))].sort().map((state) => [state, p.workOrderReadiness.filter((w) => w.procurementAssessment?.reviewState === state).length])),
      procurementQuoteStates: Object.fromEntries([...new Set(p.workOrderReadiness.flatMap((w) => w.procurementAssessment ? [w.procurementAssessment.quoteState] : []))].sort().map((state) => [state, p.workOrderReadiness.filter((w) => w.procurementAssessment?.quoteState === state).length])),
      procurementQuoteFreshnessStates: Object.fromEntries([...new Set(p.workOrderReadiness.flatMap((w) => w.procurementAssessment?.playerQuote ? [w.procurementAssessment.playerQuote.freshness] : []))].sort().map((freshness) => [freshness, p.workOrderReadiness.filter((w) => w.procurementAssessment?.playerQuote?.freshness === freshness).length])),
      procurementGoldReservationStates: Object.fromEntries([...new Set(p.workOrderReadiness.flatMap((w) => w.procurementAssessment ? [w.procurementAssessment.recordedGoldReservationState] : []))].sort().map((state) => [state, p.workOrderReadiness.filter((w) => w.procurementAssessment?.recordedGoldReservationState === state).length])),
      procurementQuoteGoldComparisonStates: Object.fromEntries([...new Set(p.workOrderReadiness.flatMap((w) => w.procurementAssessment ? [w.procurementAssessment.quoteVsRecordedGoldState] : []))].sort().map((state) => [state, p.workOrderReadiness.filter((w) => w.procurementAssessment?.quoteVsRecordedGoldState === state).length])),
      procurementQuotePlannedBudgetStates: Object.fromEntries([...new Set(p.workOrderReadiness.flatMap((w) => w.procurementAssessment ? [w.procurementAssessment.quoteVsPlannedBudgetState] : []))].sort().map((state) => [state, p.workOrderReadiness.filter((w) => w.procurementAssessment?.quoteVsPlannedBudgetState === state).length])),
      procurementBudgetNeedStates: Object.fromEntries([...new Set(p.workOrderReadiness.flatMap((w) => w.procurementAssessment ? [w.procurementAssessment.budgetNeedAssessment?.ceilingCoverage ?? "NO_EXPLICIT_BUDGET_NEED"] : []))].sort().map((state) => [state, p.workOrderReadiness.filter((w) => w.procurementAssessment && (w.procurementAssessment.budgetNeedAssessment?.ceilingCoverage ?? "NO_EXPLICIT_BUDGET_NEED") === state).length])),
      needStates: Object.fromEntries([...new Set(p.needEvidence.map((n) => n.state))].sort().map((state) => [state, p.needEvidence.filter((n) => n.state === state).length])),
      resourceSourceScreenCounts: { needsScreened: p.resourceSourceScreens.length, possibleSources: p.resourceSourceScreens.reduce((sum, screen) => sum + screen.candidateCount, 0), unresolvedCharacters: p.resourceSourceScreens.reduce((sum, screen) => sum + screen.unresolvedCharacterCount, 0) },
    })), resourceCommitments: Object.fromEntries(WOW_VERSIONS.map((version) => {
      const summary = buildErpResourceCommitmentSummary((input.erpProjects ?? []).filter((project) => project.version === version));
      return [version, { lineCount: summary.totalCount, linesWithReservations: summary.linesWithReservations, unknownSourceLines: summary.unknownSourceLines, overlappingScopeLines: summary.overlappingScopeLines, truncated: summary.truncated }];
    })) as AccountContext["planning"]["resourceCommitments"], needObservationChangeReviews: Object.fromEntries(WOW_VERSIONS.map((version) => {
      const review = buildErpNeedObservationChangeReview((input.erpProjects ?? []).filter((project) => project.version === version), version, 200);
      return [version, { changedNeedCount: review.totalCount, affectedProjectCount: review.affectedProjectCount, truncated: review.truncated }];
    })) as AccountContext["planning"]["needObservationChangeReviews"], fulfillmentTriage: Object.fromEntries(WOW_VERSIONS.map((version) => {
      const triage = buildErpFulfillmentTriage((input.erpProjects ?? []).filter((project) => project.version === version), version, 200);
      return [version, { totalCount: triage.totalCount, affectedProjectCount: triage.affectedProjectCount, counts: triage.counts, truncated: triage.truncated }];
    })) as AccountContext["planning"]["fulfillmentTriage"], portfolioFulfillment: Object.fromEntries(WOW_VERSIONS.map((version) => { const review = buildErpPortfolioFulfillmentReview((input.erpProjects ?? []).filter((project) => project.version === version), version, 200); return [version, { packageCount: review.totalPackageCount, stepCount: review.totalStepCount, stepsNeedingReview: review.stepsNeedingReview, stepsWithPrerequisiteReview: review.stepsWithPrerequisiteReview, savedBatchCount: review.totalSavedPlanningBatchCount, savedBatchReviewStates: Object.fromEntries([...new Set(review.savedPlanningBatches.map((batch) => batch.state))].sort().map((state) => [state, review.savedPlanningBatches.filter((batch) => batch.state === state).length])), savedBatchTaskCount: review.savedPlanningBatches.reduce((sum, batch) => sum + batch.steps.length, 0), replanFollowUpCount: review.savedPlanningBatches.filter((batch) => batch.replanFrom).length, replanLineageConflictCount: review.savedPlanningBatches.filter((batch) => batch.lineageState === "FOLLOW_UP_CONTEXT_CONFLICT").length, batchesWithFollowUps: review.savedPlanningBatches.filter((batch) => batch.followUpBatchIds.length > 0).length, savedNeedHistoryCount: review.totalSavedNeedHistoryCount, savedNeedHistoryNextReviewCounts: Object.fromEntries([...new Set(review.savedNeedHistories.map((history) => history.nextReview))].sort().map((state) => [state, review.savedNeedHistories.filter((history) => history.nextReview === state).length])), savedBatchIntervalSampleCount: review.savedPlanningBatches.reduce((sum, batch) => sum + batch.steps.reduce((stepSum, step) => stepSum + (step.observationInterval?.points.length ?? 0), 0), 0), savedBatchIntervalsWithPartialEvidence: review.savedPlanningBatches.reduce((sum, batch) => sum + batch.steps.filter((step) => step.observationInterval?.points.some((point) => point.sections.some((section) => section.state === "PARTIAL"))).length, 0), savedBatchIntervalsTruncated: review.savedPlanningBatches.reduce((sum, batch) => sum + batch.steps.filter((step) => (step.observationInterval?.state === "HISTORY_TRUNCATED" || (step.observationInterval?.omittedEarlierPointCount ?? 0) > 0)).length, 0), savedNeedHistoriesTruncated: review.savedNeedHistoriesTruncated, savedBatchesTruncated: review.savedPlanningBatchesTruncated, pathwayReviewTruncated: review.pathwayReviewTruncated, truncated: review.truncated }]; })) as AccountContext["planning"]["portfolioFulfillment"], sourceFulfillment: Object.fromEntries(WOW_VERSIONS.map((version) => { const review = buildErpSourceFulfillmentReview((input.erpProjects ?? []).filter((project) => project.version === version), version, 200); const pathways = review.sources.flatMap((source) => source.needs.map((need) => need.fulfillmentPathways)); const pathwayStates = Object.fromEntries([...new Set(pathways.map((pathway) => pathway.state))].sort().map((state) => [state, pathways.filter((pathway) => pathway.state === state).length])); const pathwayOptionKinds = Object.fromEntries([...new Set(pathways.flatMap((pathway) => pathway.options.map((option) => option.kind)))].sort().map((kind) => [kind, pathways.reduce((count, pathway) => count + pathway.options.filter((option) => option.kind === kind).length, 0)])); return [version, { sourceCount: review.totalSourceCount, needCount: review.totalNeedCount, needsReviewCount: review.needsReviewCount, nextReviewCounts: review.nextReviewCounts, pathwayStates, pathwayOptionKinds, groupsWithAlternativeLocations: review.groupsWithAlternativeLocations, alternativeLocationCount: review.alternativeLocationCount, groupsWithIncompleteSourceScan: review.groupsWithIncompleteSourceScan, openProvisioningPlanCount: review.openProvisioningPlanCount, truncated: review.truncated }]; })) as AccountContext["planning"]["sourceFulfillment"], portfolioNextActions: Object.fromEntries(WOW_VERSIONS.map((version) => { const review = buildErpPortfolioNextActionReview((input.erpProjects ?? []).filter((project) => project.version === version), version, 200); return [version, { totalCount: review.totalCount, counts: review.counts, interveningHistoryReviewCount: review.items.reduce((sum, item) => sum + item.needReferences.filter((reference) => reference.savedHistoryReview !== undefined).length, 0), savedHistoryReviewTruncated: review.savedHistoryReviewTruncated, truncated: review.truncated }]; })) as AccountContext["planning"]["portfolioNextActions"], procurementBudgetReview: Object.fromEntries(WOW_VERSIONS.map((version) => { const review = buildErpProcurementBudgetPortfolioReview((input.erpProjects ?? []).filter((project) => project.version === version), version, 200); const quoteReviewStates = Object.fromEntries([...new Set(review.lines.map((line) => line.quoteReview.state))].sort().map((state) => [state, review.lines.filter((line) => line.quoteReview.state === state).length])); const quoteBudgetsAbovePlan = review.lines.filter((line) => line.quoteReview.comparisonToPlannedBudget === "RECENT_QUOTES_ABOVE_PLANNED_BUDGET").length; const quoteBudgetsIncomplete = review.lines.filter((line) => line.quoteReview.state !== "RECENT_QUOTES_COVER_OBSERVED_GAPS").length; const totalOpen = review.lines.reduce((sum, line) => sum + BigInt(line.openCeilingCopper ?? 0), 0n); const returnedCeilingsExceedSafeInteger = review.lines.some((line) => line.openCeilingExceedsSafeInteger) || totalOpen > BigInt(Number.MAX_SAFE_INTEGER); return [version, { lineCount: review.totalLineCount, overPlannedBudget: review.linesOverPlannedBudget, ...(!review.truncated && !returnedCeilingsExceedSafeInteger ? { totalOpenCeilingCopper: Number(totalOpen) } : {}), ...(returnedCeilingsExceedSafeInteger ? { returnedCeilingsExceedSafeInteger: true as const } : {}), quoteReviewStates, quoteBudgetsAbovePlan, quoteBudgetsIncomplete, truncated: review.truncated }]; })) as AccountContext["planning"]["procurementBudgetReview"], procurementBuyerReview: Object.fromEntries(WOW_VERSIONS.map((version) => { const review = buildErpProcurementBuyerPortfolioReview((input.erpProjects ?? []).filter((project) => project.version === version), version, 200); const quoteStates = Object.fromEntries([...new Set(review.buyers.map((line) => line.state))].sort().map((state) => [state, review.buyers.filter((line) => line.state === state).length])); const packageNeedReviews = review.buyers.flatMap((line) => line.resourcePackages.flatMap((pkg) => pkg.needReviews)); const packageNeedReviewStates = Object.fromEntries([...new Set(packageNeedReviews.map((need) => need.state))].sort().map((state) => [state, packageNeedReviews.filter((need) => need.state === state).length])); const packagesWithOpenProvisioningReview = review.buyers.reduce((sum, line) => sum + line.resourcePackages.filter((pkg) => pkg.needReviews.some((need) => need.linkedWorkOrders.some((order) => order.kind === "PROVISION" && order.status !== "COMPLETED" && order.status !== "CANCELLED"))).length, 0); const sourceCoverageReviews = review.buyers.flatMap((line) => line.resourcePackages.flatMap((pkg) => pkg.sourceCoverageReviews)); const sourceCoverageStates = Object.fromEntries([...new Set(sourceCoverageReviews.map((entry) => entry.state))].sort().map((state) => [state, sourceCoverageReviews.filter((entry) => entry.state === state).length])); const sourceCoverageReviewsWithOtherProjectNeeds = sourceCoverageReviews.filter((entry) => entry.otherSourceScopedNeedCount > 0).length; const otherSourceScopedNeedCount = sourceCoverageReviews.reduce((sum, entry) => sum + entry.otherSourceScopedNeedCount, 0); return [version, { buyerCount: review.totalBuyerCount, returnedBuyerCount: review.returnedBuyerCount, returnedQuoteStates: quoteStates, returnedQuoteTotalsAboveRecordedRemainder: review.buyers.filter((line) => line.state === "QUOTES_EXCEED_RECORDED_REMAINDER").length, returnedIncompleteQuoteCoverage: review.buyers.filter((line) => line.state === "QUOTE_COVERAGE_INCOMPLETE").length, returnedCrossProjectResourcePackageCount: review.buyers.reduce((sum, line) => sum + line.resourcePackages.length, 0), returnedPackagesWithObservedSourceLeads: review.buyers.reduce((sum, line) => sum + line.resourcePackages.filter((pkg) => pkg.observedSources.length > 0).length, 0), returnedPackagesWithIncompleteSourceReview: review.buyers.reduce((sum, line) => sum + line.resourcePackages.filter((pkg) => pkg.sourceReviewState === "SOURCE_SCAN_INCOMPLETE" || pkg.sourceReviewState === "POTENTIAL_SOURCES_SCAN_INCOMPLETE" || pkg.sourceReviewState === "SOURCE_REVIEW_UNAVAILABLE").length, 0), returnedObservedSourceLeadRows: review.buyers.reduce((sum, line) => sum + line.resourcePackages.reduce((pkgSum, pkg) => pkgSum + pkg.observedSources.length, 0), 0), returnedPackageNeedReviewCount: packageNeedReviews.length, returnedPackageNeedReviewStates: packageNeedReviewStates, returnedPackagesWithOpenProvisioningReview: packagesWithOpenProvisioningReview, returnedPackageSourceCoverageReviewCount: sourceCoverageReviews.length, returnedPackageSourceCoverageReviewStates: sourceCoverageStates, returnedSourceCoverageReviewsWithOtherProjectNeeds: sourceCoverageReviewsWithOtherProjectNeeds, returnedOtherSourceScopedNeedCount: otherSourceScopedNeedCount, unresolvedBuyerOrderCount: review.unresolvedBuyerOrderCount, truncated: review.truncated }]; })) as AccountContext["planning"]["procurementBuyerReview"] },
  };
}
