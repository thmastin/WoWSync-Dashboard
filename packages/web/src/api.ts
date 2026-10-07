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

export interface GearCandidateEvidenceApi {
  data?: { characters: Array<{ identity: { identityKey: string; name: string; realm: string }; captured: boolean; snapshot?: { snapshotId: number; observedAt: number; candidateObservedAt: number }; sidecar?: { completeness: string; rows: Array<{ observationState: string; candidateState: string; itemID: { state: string; value?: number }; itemString: { state: string; value?: string }; currentItemLevel: { state: string; value?: number }; baseEquipLocation: { state: string; value?: string }; locationType: { state: string; value?: string } }> } }> };
  provenance: { state: string; warning?: string };
}
export interface GearAllocationApi {
  status: string;
  value?: { recommendation: string; candidate: { itemID?: number; itemLevel?: number; baseEquipLocation?: string; validity: string }; assessments: Array<{ character: { identityKey: string; name: string; realm: string }; spec: { specID: number; name: string; role: string }; eligibility: string; suitability: string; primaryStatSuitability: string; comparison: string; deltaItemLevel?: number; reasons: string[]; currentSnapshotObservation: { state: string; sourceSnapshotId?: number; observedAt?: number; specID?: number; reason: string }; latestStoredObservation: { relationship: string; state: string; sourceSnapshotId?: number; observedAt?: number; specID?: number; reason: string }; retained: { state: "QUALIFIED"; snapshotId: number; observedAt: number; capture: number; revision: number } | { state: "UNKNOWN"; reason: string } }>; excludedRecipients: Array<{ identityKey: string; name: string; realm: string; reason: string }>; limitations: string[] };
}

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
 * the question, and a system prompt to a configured LLM provider. Each
 * call is independent - no conversation history is kept on either side.
 */
export function askAccount(question: string) {
  return request<AskAccountResponse>(
    "/api/ask",
    { method: "POST", body: JSON.stringify({ question }) },
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
