import type {
  AccountContext,
  AccountFacts,
  AskAccountResponse,
  DeleteCharacterResult,
  DeleteSharedStorageOwnerResponse,
  ImportResult,
  ItemMetadataResponse,
  SharedOwnerIdentity,
  SharedStorageIntegrityErrorBody,
  SharedStorageResponse,
  StoredCharacterSummary,
  StoredSnapshot,
  VersionOrUnknown,
  VersionSummary,
  AllocationReviewRead,
  ExplicitDemand,
} from "./types.ts";
import { ALLOCATION_RESOLUTIONS } from "./types.ts";
import type { ErpFulfillmentTriage, ErpPortfolioFulfillmentReview, ErpProcurementBudgetPortfolioReview, ErpProcurementBuyerPortfolioReview, ErpNeedReviewSnapshot, ErpProject, ErpProjectDraft, ErpProjectView, ErpResourceCommitmentSummary, ErpWorkOrder } from "@wowsync-dashboard/core";

export interface GearCandidateEvidenceApi {
  data?: { characters: Array<{ identity: { identityKey: string; name: string; realm: string }; captured: boolean; snapshot?: { snapshotId: number; observedAt: number; candidateObservedAt: number }; sidecar?: { completeness: string; rows: Array<{ observationState: string; candidateState: string; itemID: { state: string; value?: number }; itemString: { state: string; value?: string }; currentItemLevel: { state: string; value?: number }; baseEquipLocation: { state: string; value?: string }; locationType: { state: string; value?: string } }> } }> };
  provenance: { state: string; warning?: string };
}
export interface GearAllocationApi {
  status: string;
  value?: { recommendation: string; candidate: { itemID?: number; itemLevel?: number; baseEquipLocation?: string; validity: string }; assessments: Array<{ character: { identityKey: string; name: string; surname?: string; realm: string }; spec: { specID: number; name: string; role: string }; eligibility: string; suitability: string; primaryStatSuitability: string; comparison: string; deltaItemLevel?: number; reasons: string[]; currentSnapshotObservation: { state: string; sourceSnapshotId?: number; observedAt?: number; specID?: number; reason: string }; latestStoredObservation: { relationship: string; state: string; sourceSnapshotId?: number; observedAt?: number; specID?: number; reason: string }; retained: { state: "QUALIFIED"; snapshotId: number; observedAt: number; capture: number; revision: number } | { state: "UNKNOWN"; reason: string } }>; excludedRecipients: Array<{ identityKey: string; name: string; realm: string; reason: string }>; limitations: string[] };
}
export interface ForeverGearAllocationApi {
  status: "FOUND" | "NOT_FOUND" | "AMBIGUOUS";
  value?: {
    data?: {
      version: "forever";
      ruleset: "forever-70291-allocation-screen-v2";
      scope: { accountMembership: "UNKNOWN"; reason: string };
      recipient: { identityKey: string; name: string; surname?: string; realm: string; observedAt?: number; freshness: string; class?: { value: string; provenance: string; observedAt?: number; source: string }; level?: { value: number; provenance: string; observedAt?: number; source: string }; observedSkillLines: Array<{ name: string; rank?: number; maxRank?: number; rawCategoryID?: number; observedAt?: number; provenance: string }>; equipment: { state: string; source: string; observedAt?: number; freshness?: string; items: Array<{ slot: number; slotName: string; itemRef?: string; itemIdentity?: string; provenance: string }> } };
      candidateSources: Array<{ source: { identityKey: string; name: string; surname?: string; realm: string }; observationState: string; observedAt?: number; freshness?: string; carried: { state: string; observedAt?: number; freshness?: string; itemCount?: number }; bank: { state: string; observedAt?: number; freshness?: string; reason?: string }; candidates: unknown[]; unclassifiedItems: Array<{ name?: string; itemRef?: string; itemIdentity?: string; container?: number; slot?: number; quantity?: number; provenance: string; reason: string }> }>;
      recipientEvaluations: Array<{ source: { identityKey: string; name: string; surname?: string; realm: string }; itemRef?: string; recipients: Array<{ identityKey: string; name: string; surname?: string; realm: string; eligibility: string; armorProficiency: string; slotCompatibility: string; upgradeStatus: string; transferability: string; fit: string; reasons: string[] }> }>; assessments: Array<{ candidate: { itemRef?: string; name?: string; itemType?: string; itemSubType?: string; equipLocation?: string; container?: number; slot?: number; quantity?: number; bound?: boolean; binding?: { state: string; value?: boolean }; itemApiEvidence?: { semanticInterpretation: string; playerEquipability: { api: string; state: string; itemString: string; value?: boolean; observedAt?: number; freshness?: string; reason: string }; playerCanUseItem?: { state: string; value?: boolean; api: string; itemString: string; itemID?: number; identityScope?: string; observedAt?: number; freshness?: string; reason: string }; itemSpecInfo?: { state: string; api: string; itemString: string; specializationIDs: number[]; complete: boolean; observedAt?: number; freshness?: string; provenance?: string; reason?: string }; statDeltaEvidence?: { api: string; state: string; completeness: string; observedAt?: number; freshness?: string; reason: string }; bindingEvidence?: { state: string; semanticInterpretation: string; freshness?: string }; statDeltaComparisons?: Array<{ api: string; state: string; candidateItemString: string; equippedItemString: string; observedAt?: number; freshness?: string; complete?: boolean; entries: Array<{ key: string; observation: { state: string; value?: unknown } }>; interpretation: string }>; validatedFields?: { contractState: string; itemLevel: { state: string; value?: unknown }; requiredLevel: { state: string; value?: unknown }; itemClass: { state: string; value?: unknown }; itemSubclass: { state: string; value?: unknown }; equipLocation: { state: string; value?: unknown } }; itemStats: { state: string; entryCount: number | null; entries: Array<{ key: string; observation: { state: string; value?: unknown } }> }; itemInfo: { state: string; returnCount: number | null } } }; source: { identityKey: string; name: string; surname?: string; realm: string }; recipient: { identityKey: string; name: string; surname?: string; realm: string }; eligibility: string; playerApiSignal: "TRUE" | "FALSE" | "UNKNOWN"; playerCanUseSignal: "TRUE" | "FALSE" | "UNKNOWN"; eligibilityAssessment: { state: string; confidence: string; reasons: string[] }; eligibilityChecks: { requiredLevel: { state: string; itemRequiredLevel?: number; recipientLevel?: number; reason: string }; classRestriction: { state: string; reason: string }; armorProficiency: { state: string; armor?: string; confidence: string; reason: string }; weaponProficiency: { state: string; matchingObservedSkill?: string; observedSkillLines: string[]; reason: string }; slotCompatibility: { state: string; equipLocation: string; possibleSlots: number[]; currentlyOccupiedSlots: number[]; knownEmptySlots: number[]; conflicts: Array<{ slot: number; itemRef?: string; equipLocation?: string; state: string; reason: string }>; reason: string } }; suitability: string; suitabilityEvidence: { state: string; reason: string }; upgradeStatus: string; upgradeConfidence: string; rawStatComparisons: Array<{ slot: number; equippedItemRef: string; values: Array<{ key: string; candidate: number; equipped: number; delta: number }>; classification: string; provenance: string; reason: string; weaponMetrics?: { dps: Array<{ key: string; candidate: number; equipped: number; delta: number }>; speed: { state: string; reason: string } } }>; statDeltaCalibrations: Array<{ state: string; matchedKeys: string[]; reason: string }>; bindingAssessment: { state: string; reason: string }; transferability: string; transferabilityReason: string; allocationPriority: string; decision: string; missingEvidence: string[]; reason: string }>;
      allocationPlan?: Array<{ disposition: "EQUIP_CANDIDATE" | "KEEP" | "POSSIBLE_OTHER_CHARACTER" | "NOT_AN_UPGRADE_ON_OBSERVED_METRICS" | "INSUFFICIENT_EVIDENCE"; item: { name?: string; itemRef?: string; itemIdentity?: string }; source: { identityKey: string; name: string; surname?: string; realm: string; location: "CARRIED_INVENTORY" | "EQUIPPED" | "UNKNOWN"; provenance: "OBSERVED" | "LAST_SEEN" | "UNKNOWN"; observedAt?: number; freshness: string }; recipient: { identityKey: string; name: string; surname?: string; realm: string }; comparison?: { upgradeStatus: string; confidence: string; rawComparisons: Array<{ slot: number; equippedItemRef: string; classification: string; reason: string }> }; evidence: { provenance: "DERIVED" | "HYPOTHESIS" | "UNKNOWN"; eligibility: string; suitability: string; transferability: string; confidence: "LIMITED" | "UNKNOWN"; reasons: string[]; whatWouldChange: string[] } }>;
      exclusions: Array<{ character: { identityKey: string; name: string; surname?: string; realm: string }; state: string; reason: string }>;
      conclusion: "LOCAL_REVIEW_CANDIDATE_AVAILABLE" | "INSUFFICIENT_EVIDENCE";
      reason: string;
    };
    provenance: { state: string; observedAt?: number; freshness?: string; source?: string; reason?: string };
  };
}
export interface GearCandidateRef { exporterIdentityKey: string; snapshotId: number; rowOrdinal: number }

/**
 * What went wrong, in terms a caller can act on:
 * - "network": no HTTP response at all (server stopped, connection refused/reset, offline).
 * - "http":    the server (or a proxy) answered with an error status. `status` is set; `code` is the
 *              server's stable machine-readable code when it sent one (e.g. CHARACTER_NOT_FOUND).
 * - "parse":   a success status, but the body was not valid JSON (wrong server, proxy page, truncated reply).
 * - "shape":   valid JSON that is not the shape this client expects (version skew, wrong endpoint).
 */
export type ApiErrorKind = "network" | "http" | "parse" | "shape";

/** An API failure that keeps its classification, so callers can tell e.g. "the character is gone" (404 + code) from a real outage. */
export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status?: number;
  readonly code?: string;
  /** The server's parsed JSON error body, when it sent one (e.g. the damaged owners of a shared-storage integrity failure). */
  readonly details?: unknown;
  constructor(message: string, kind: ApiErrorKind, status?: number, code?: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.kind = kind;
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface RequestOptions {
  /** Aborts the request (e.g. the user switched tabs). An aborted request rejects with the browser's AbortError, which callers should ignore. */
  signal?: AbortSignal;
  /** Returns true when the parsed body has the shape the caller relies on. A failing check is an ApiError of kind "shape", never a later `undefined` crash. */
  validate?: (body: unknown) => boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** validate helper: the body is an object whose `key` is an object (not null/array). */
export const hasObject = (key: string) => (body: unknown) => isRecord(body) && isRecord(body[key]);
/** validate helper: the body is an object whose `key` is an array. */
export const hasArray = (key: string) => (body: unknown) => isRecord(body) && Array.isArray(body[key]);

function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

function httpFallbackMessage(status: number): string {
  if (status >= 500) {
    return `The server reported an error (HTTP ${status}). Is the WoWSync server running? Check its console window.`;
  }
  if (status === 404) return "Not found (HTTP 404).";
  return `The request was rejected (HTTP ${status}).`;
}

export async function request<T>(path: string, init?: RequestInit, options: RequestOptions = {}): Promise<T> {
  let res: Response;
  let text: string;
  try {
    res = await fetch(path, {
      ...init,
      signal: options.signal,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
    text = await res.text();
  } catch (err) {
    if (isAbort(err)) throw err;
    throw new ApiError("Can't reach the WoWSync server. Is it running?", "network");
  }

  let body: unknown;
  let parsed = false;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
      parsed = true;
    } catch {
      // handled below, depending on the status
    }
  }

  if (!res.ok) {
    const message = parsed && isRecord(body) && typeof body.error === "string" ? body.error : httpFallbackMessage(res.status);
    const code = parsed && isRecord(body) && typeof body.code === "string" ? body.code : undefined;
    throw new ApiError(message, "http", res.status, code, parsed ? body : undefined);
  }
  if (!parsed) {
    throw new ApiError("The server sent a reply that is not valid JSON. Is something else running on this port?", "parse", res.status);
  }
  if (options.validate && !options.validate(body)) {
    throw new ApiError("The server sent an unexpected reply (is the dashboard server out of date?).", "shape", res.status);
  }
  return body as T;
}

/** A short, human-readable description of any failure, for display next to a Retry button. */
export function describeApiError(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error && err.message) return err.message;
  return "Something went wrong.";
}

export function fetchCharacter(identityKey: string, signal?: AbortSignal) {
  return request<{ character: StoredCharacterSummary }>(`/api/characters/${encodeURIComponent(identityKey)}`, undefined, {
    signal,
    validate: hasObject("character"),
  });
}

export function fetchSnapshots(identityKey: string, signal?: AbortSignal) {
  return request<{ snapshots: StoredSnapshot[] }>(`/api/characters/${encodeURIComponent(identityKey)}/snapshots`, undefined, {
    signal,
    validate: hasArray("snapshots"),
  });
}

export function fetchAccountFacts(version: VersionOrUnknown, signal?: AbortSignal) {
  return request<{ facts: AccountFacts }>(`/api/versions/${version}/account-facts`, undefined, {
    signal,
    validate: (body) => hasObject("facts")(body) && Array.isArray((body as { facts: { characters?: unknown } }).facts.characters),
  });
}
export function fetchVersions(signal?: AbortSignal) {
  return request<{ versions: VersionSummary[] }>("/api/versions", undefined, {
    signal,
    validate: (body) =>
      hasArray("versions")(body) &&
      (body as { versions: unknown[] }).versions.every(
        (v) => isRecord(v) && typeof v.version === "string" && typeof v.characterCount === "number",
      ),
  });
}

/** Enrichment only: the resolved game-client item metadata for one game version (see itemMetadata.ts). */
export function fetchItemMetadata(version: string, signal?: AbortSignal) {
  return request<ItemMetadataResponse>(`/api/versions/${encodeURIComponent(version)}/item-metadata`, undefined, {
    signal,
    validate: (body) => hasArray("items")(body) && (body as { schema?: unknown }).schema === "item-metadata-1",
  });
}

export function importExport(text: string, signal?: AbortSignal) {
  // Never abort a state-changing request from the UI: the caller passes no signal for imports.
  return request<{ result: ImportResult }>("/api/import", { method: "POST", body: JSON.stringify({ text }) }, { signal, validate: hasObject("result") });
}

/**
 * Permanently deletes one character and its whole snapshot history. The
 * server refuses unless the body's confirmIdentityKey matches the key in
 * the URL - the UI additionally makes the user type the character's name
 * (see deleteConfirmation.ts) before this is ever called. The reply is
 * validated: only a body that names the deleted character counts as success.
 */
export function deleteCharacter(identityKey: string) {
  return request<{ deleted: DeleteCharacterResult }>(
    `/api/characters/${encodeURIComponent(identityKey)}`,
    { method: "DELETE", body: JSON.stringify({ confirmIdentityKey: identityKey }) },
    {
      validate: (body) => hasObject("deleted")(body) && typeof (body as { deleted: { identityKey?: unknown } }).deleted.identityKey === "string",
    },
  );
}

/** The full "Export Dashboard Context" document. Not wrapped in a {key: ...} envelope - this is the exact JSON the developer-tool modal copies/downloads verbatim. */
export function fetchAccountContext(signal?: AbortSignal) {
  return request<AccountContext>("/api/account-context", undefined, {
    signal,
    validate: (body) => isRecord(body) && isRecord(body.versions),
  });
}

/**
 * "Ask My Account" (POC): sends a single question to the server, which
 * retrieves the same canonical account context (above) and forwards it,
 * the question, and a system prompt to a configured LLM provider. A caller
 * may attach a selected Retail gear-candidate reference for server-side
 * deterministic analysis. Each call is independent - no conversation history
 * is kept on either side.
 */
export function askAccount(question: string, gearCandidate?: GearCandidateRef) {
  return request<AskAccountResponse>(
    "/api/ask",
    { method: "POST", body: JSON.stringify({ question, ...(gearCandidate ? { gearCandidate } : {}) }) },
    { validate: (body) => isRecord(body) && typeof body.answer === "string" },
  );
}

// --- Shared storage (Warband + Guild Bank) -----------------------------------------------------------------

/** validate: the reply is a GET /api/shared-storage document (stable even when empty: warband null, guilds []). */
export function isSharedStorageResponse(body: unknown): body is SharedStorageResponse {
  return (
    isRecord(body) &&
    body.schema === "shared-storage-1" &&
    typeof body.asOf === "number" &&
    (body.warband === null || isRecord(body.warband)) &&
    Array.isArray(body.guilds)
  );
}

/** The reconciled (DERIVED) Warband and guild storage. Not part of AccountFacts or any total. */
export function fetchSharedStorage(signal?: AbortSignal) {
  return request<SharedStorageResponse>("/api/shared-storage", undefined, { signal, validate: isSharedStorageResponse });
}

/** The shared-storage integrity failure a rejected request carried, if that is what it was (else undefined). */
export function sharedStorageIntegrityDetails(err: unknown): SharedStorageIntegrityErrorBody | undefined {
  if (!(err instanceof ApiError) || err.code !== "SHARED_STORAGE_INTEGRITY" || !isRecord(err.details) || !Array.isArray(err.details.damagedOwners)) return undefined;
  return err.details as unknown as SharedStorageIntegrityErrorBody;
}

/**
 * EXPLICITLY clears the stored shared-storage history of ONE owner (the Warband, or one guild), as named by an
 * owner from GET /api/shared-storage. It clears stored history; it is not permanent: a later WoWSync export may
 * add it again. It never touches characters or snapshots. The route is chosen by the owner's kind and the guild
 * id is sent verbatim (percent-encoded, never converted to a number); the owner's key is sent only as the
 * confirmation. The reply is validated: only a body that names the deleted owner counts as success. A 404 with
 * code SHARED_OWNER_NOT_FOUND means the server says that history is already gone.
 */
export function deleteSharedStorageOwner(owner: SharedOwnerIdentity) {
  const path = owner.kind === "warband" ? "/api/shared-storage/warband" : `/api/shared-storage/guilds/${encodeURIComponent(owner.guildClubId)}`;
  return request<DeleteSharedStorageOwnerResponse>(
    path,
    { method: "DELETE", body: JSON.stringify({ confirmOwnerKey: owner.ownerKey }) },
    { validate: (body) => hasObject("deleted")(body) && isRecord((body as { deleted: { owner?: unknown } }).deleted.owner) },
  );
}

// --- Azeroth ERP: explicit demand + allocation review (Dashboard Allocation tab) -------------------------------
// GET /api/versions/:version/allocation-review serves DashboardReadModel.getAllocationReview as is; the demand
// routes create / edit / deactivate STOCK_TARGET demands. The client never computes allocation.

export interface AllocationReviewParams {
  demandedOffset?: number;
  demandedLimit?: number;
  unallocatedOffset?: number;
  unallocatedLimit?: number;
  /** Unallocated search: name substring or exact item id. Blank is omitted (no filtering). */
  q?: string;
}

const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isPage = (v: unknown): v is { items: unknown[] } =>
  isRecord(v) && Array.isArray(v.items) && isNumber(v.offset) && isNumber(v.limit) && isNumber(v.totalCount) && typeof v.truncated === "boolean";
const isDemandView = (v: unknown) => isRecord(v) && typeof v.stableId === "string" && isNumber(v.requiredQuantity);

/**
 * One demanded result, checked against its OWN variant: the arithmetic a variant carries must be present and
 * numeric, and an unknown `resolution` (a future semantic this client cannot present) is a shape failure,
 * never something rendered by guesswork.
 */
export function isAllocationResult(v: unknown): boolean {
  if (!isRecord(v) || !isRecord(v.commodity) || !isNumber(v.commodity.baseItemId) || !Array.isArray(v.reasons) || !Array.isArray(v.evidence) || !Array.isArray(v.guildContext)) return false;
  if (typeof v.resolution !== "string" || !(ALLOCATION_RESOLUTIONS as readonly string[]).includes(v.resolution)) return false;
  if (!isRecord(v.confirmedItemStringIdentity) || !isRecord(v.confirmedBinding) || !isRecord(v.potentialBinding)) return false;
  switch (v.resolution) {
    case "RESOLVED":
      return isDemandView(v.demand) && isNumber(v.confirmedAvailable) && isNumber(v.potentialAdditionalAvailable) && isNumber(v.allocated) && isNumber(v.confirmedDeficit) && isNumber(v.confirmedSurplus) && typeof v.hasUnresolvedEvidence === "boolean";
    case "BASE_ITEM_AGGREGATION_UNPROVEN":
      return isDemandView(v.demand) && isNumber(v.confirmedQuantity) && isNumber(v.potentialQuantity) && typeof v.hasUnresolvedEvidence === "boolean";
    case "CONFLICTING_DEMAND":
      return Array.isArray(v.conflictingDemandIds);
    default:
      return true;
  }
}

/** The allocation-review ReadValue: provenance always; `data` (when present) with both pages, the account status, and only known result variants. */
export function isAllocationReviewRead(body: unknown): body is AllocationReviewRead {
  if (!isRecord(body) || !isRecord(body.provenance) || typeof body.provenance.state !== "string") return false;
  if (body.data === undefined) return true;
  const data = body.data;
  if (!isRecord(data) || !Array.isArray(data.unresolvedStorage) || typeof data.hasUnresolvedStorage !== "boolean" || !isRecord(data.itemNames)) return false;
  if (!isPage(data.demanded) || !isPage(data.unallocated)) return false;
  if (!data.demanded.items.every(isAllocationResult)) return false;
  return data.unallocated.items.every((e) => isRecord(e) && e.allocationState === "UNALLOCATED" && isNumber(e.baseItemId) && isNumber(e.confirmedQuantity) && isNumber(e.potentialQuantity));
}

export function fetchAllocationReview(version: VersionOrUnknown, params: AllocationReviewParams = {}, signal?: AbortSignal) {
  const search = new URLSearchParams();
  for (const key of ["demandedOffset", "demandedLimit", "unallocatedOffset", "unallocatedLimit"] as const) {
    if (params[key] !== undefined) search.set(key, String(params[key]));
  }
  const q = params.q?.trim();
  if (q) search.set("q", q);
  const qs = search.toString();
  return request<AllocationReviewRead>(`/api/versions/${encodeURIComponent(version)}/allocation-review${qs ? `?${qs}` : ""}`, undefined, { signal, validate: isAllocationReviewRead });
}

export function fetchGearCandidateEvidence(version: VersionOrUnknown, signal?: AbortSignal): Promise<GearCandidateEvidenceApi> {
  return request(`/api/versions/${encodeURIComponent(version)}/gear-candidates`, undefined, { signal, validate: (body) => isRecord(body) && isRecord(body.provenance) });
}

export function fetchGearAllocation(version: VersionOrUnknown, ref: { exporterIdentityKey: string; snapshotId: number; rowOrdinal: number }, signal?: AbortSignal): Promise<GearAllocationApi> {
  const qs = new URLSearchParams({ exporterIdentityKey: ref.exporterIdentityKey, snapshotId: String(ref.snapshotId), rowOrdinal: String(ref.rowOrdinal) });
  return request(`/api/versions/${encodeURIComponent(version)}/gear-allocation?${qs}`, undefined, { signal, validate: (body) => isRecord(body) && typeof body.status === "string" });
}

export function fetchForeverGearAllocation(identityKey: string, signal?: AbortSignal): Promise<ForeverGearAllocationApi> {
  return request(`/api/characters/${encodeURIComponent(identityKey)}/forever-gear-allocation`, undefined, { signal, validate: (body) => isRecord(body) && typeof body.status === "string" });
}

/** Every demand for a version, any status (the removed-target history and conflict lookups read this). */
export function fetchDemands(version: VersionOrUnknown, signal?: AbortSignal) {
  return request<{ demands: ExplicitDemand[] }>(`/api/versions/${encodeURIComponent(version)}/demands`, undefined, { signal, validate: hasArray("demands") });
}

export interface DemandInput {
  baseItemId: number;
  requiredQuantity: number;
  /** Blank means no purpose; it is omitted rather than sent as "". */
  purpose?: string;
}

/** Creates a new ACTIVE STOCK_TARGET demand. A duplicate is the server's 409 DEMAND_CONFLICT (see describeDemandError). */
export function createDemand(version: VersionOrUnknown, input: DemandInput) {
  const purpose = input.purpose?.trim();
  return request<{ demand: ExplicitDemand }>(
    `/api/versions/${encodeURIComponent(version)}/demands`,
    { method: "POST", body: JSON.stringify({ demandType: "STOCK_TARGET", baseItemId: input.baseItemId, requiredQuantity: input.requiredQuantity, ...(purpose ? { purpose } : {}) }) },
    { validate: hasObject("demand") },
  );
}

/** Edits an ACTIVE demand's quantity and purpose (purpose "" clears it). An inactive demand answers 409 DEMAND_INACTIVE. */
export function updateDemand(version: VersionOrUnknown, stableId: string, input: { requiredQuantity: number; purpose: string }) {
  return request<{ demand: ExplicitDemand }>(
    `/api/versions/${encodeURIComponent(version)}/demands/${encodeURIComponent(stableId)}`,
    { method: "PATCH", body: JSON.stringify({ requiredQuantity: input.requiredQuantity, purpose: input.purpose.trim() }) },
    { validate: hasObject("demand") },
  );
}

/** "Remove target": sets the demand INACTIVE. Never a delete; the record stays as history. */
export function deactivateDemand(version: VersionOrUnknown, stableId: string) {
  return request<{ demand: ExplicitDemand }>(
    `/api/versions/${encodeURIComponent(version)}/demands/${encodeURIComponent(stableId)}/deactivate`,
    { method: "POST", body: "{}" },
    { validate: hasObject("demand") },
  );
}

export function fetchErpProjects(version: VersionOrUnknown, signal?: AbortSignal) {
  return request<{ version: VersionOrUnknown; projects: ErpProjectView[]; resourceCommitments: ErpResourceCommitmentSummary; fulfillmentTriage: ErpFulfillmentTriage; portfolioFulfillment: ErpPortfolioFulfillmentReview; procurementBudgetReview: ErpProcurementBudgetPortfolioReview; procurementBuyerReview: ErpProcurementBuyerPortfolioReview }>(`/api/versions/${encodeURIComponent(version)}/erp/projects`, undefined, { signal, validate: (body) => isRecord(body) && Array.isArray(body.projects) && isRecord(body.resourceCommitments) && isRecord(body.fulfillmentTriage) && isRecord(body.portfolioFulfillment) && isRecord(body.procurementBudgetReview) && isRecord(body.procurementBuyerReview) });
}

export interface ErpWorkOrderBatchTaskDraft {
  readonly needId: string;
  readonly reviewSnapshot: ErpNeedReviewSnapshot;
  readonly kind: ErpWorkOrder["kind"];
  readonly title: string;
  readonly instructions: string;
  readonly assignedIdentityKey?: string;
  /** Player-requested quantity to reserve atomically with this work order; absent means no reservation. */
  readonly reservationQuantity?: number;
  /** Optional player-set purchase ceiling, valid only for an explicitly same-buyer item requirement. */
  readonly spendingCeilingCopper?: number;
  /** For an INVESTIGATE step only: a version-scoped, observed source-screen lead; not an ownership/access claim. */
  readonly sourceLeadIdentityKey?: string;
  /** Same-version requirement gates selected for a player-authored portfolio package. */
  readonly portfolioPrerequisites?: readonly { readonly projectId: string; readonly needId: string }[];
}

export function appendErpWorkOrderBatch(version: VersionOrUnknown, updates: readonly { readonly projectId: string; readonly expectedRevision: number; readonly tasks: readonly ErpWorkOrderBatchTaskDraft[] }[]) {
  return request<{ version: VersionOrUnknown; projects: ErpProjectView[]; createdCount: number; atomic: true }>(
    `/api/versions/${encodeURIComponent(version)}/erp/work-order-batches`,
    { method: "POST", body: JSON.stringify({ updates }) },
    { validate: (body) => isRecord(body) && Array.isArray(body.projects) && typeof body.createdCount === "number" && body.atomic === true },
  );
}

/** Creates supplemental manual provisioning reviews for one exact observed source across linked buyer needs. It records intent only. */
export function appendErpProvisioningReviewBatch(version: VersionOrUnknown, input: {
  readonly buyerIdentityKey: string;
  readonly resourceKey: string;
  readonly sourceIdentityKey: string;
  readonly tasks: readonly { readonly projectId: string; readonly expectedRevision: number; readonly needId: string }[];
}) {
  return request<{ version: VersionOrUnknown; projects: ErpProjectView[]; createdCount: number; skippedExistingCount: number; atomic: true }>(
    `/api/versions/${encodeURIComponent(version)}/erp/provisioning-review-batches`,
    { method: "POST", body: JSON.stringify(input) },
    { validate: (body) => isRecord(body) && Array.isArray(body.projects) && typeof body.createdCount === "number" && typeof body.skippedExistingCount === "number" && body.atomic === true },
  );
}

export function createErpProject(version: VersionOrUnknown, input: Omit<ErpProjectDraft, "version">) {
  return request<{ project: ErpProjectView }>(`/api/versions/${encodeURIComponent(version)}/erp/projects`, { method: "POST", body: JSON.stringify(input) }, { validate: hasObject("project") });
}

export function updateErpProject(project: ErpProjectView) {
  const { needEvidence: _needEvidence, reservationReview: _reservationReview, ...intent } = project;
  return request<{ project: ErpProjectView }>(`/api/versions/${encodeURIComponent(project.version)}/erp/projects/${encodeURIComponent(project.stableId)}`, { method: "PUT", body: JSON.stringify({ expectedRevision: project.revision, project: intent }) }, { validate: hasObject("project") });
}

export function setErpProjectStatus(project: ErpProjectView, status: ErpProject["status"]) {
  return request<{ project: ErpProjectView }>(`/api/versions/${encodeURIComponent(project.version)}/erp/projects/${encodeURIComponent(project.stableId)}/status`, { method: "PATCH", body: JSON.stringify({ expectedRevision: project.revision, status }) }, { validate: hasObject("project") });
}
