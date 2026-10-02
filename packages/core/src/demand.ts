// Explicit Demand: the one new durable domain concept for Azeroth ERP Vertical Slice 1.
//
// Demand is USER INTENT ("I want N of this item on this account"), never a WoW observation. It is kept
// deliberately separate from everything in sharedStorage.ts / itemMetadata.ts / accountFacts.ts, which
// describe what the account's storage and the game client actually reported.
//
// Persistence represents CURRENT USER INTENT, not an audit/event history: a demand row is mutated in
// place (status, requiredQuantity, purpose, updatedAt) rather than superseded by an immutable chain.
// Future decision/outcome/history work (approval history, execution correlation, Journalator outcomes,
// economic learning) may add separate durable records when actually needed; Slice 1 deliberately does
// not build that now.
//
// Slice 1 scope: Retail only, one demand type (STOCK_TARGET), one commodity identity per demand
// (version + base item id), account-scoped (no character scope). "Commodity identity" is deliberately
// NOT the universal exact-item-identity model a future BoE/equipment slice will need (an equipped
// instance's bonus ids, gems, etc.) — see CommodityIdentity below.

/** Slice 1 supports exactly one demand type: a flat quantity target for one stackable commodity. */
export type DemandType = "STOCK_TARGET";
export const DEMAND_TYPES: readonly DemandType[] = ["STOCK_TARGET"];

export type DemandStatus = "ACTIVE" | "INACTIVE";

/**
 * A stackable commodity's identity for allocation purposes: version + base item id only. This is
 * deliberately NOT the identity a future exact-item (BoE/equipment) slice will need — an equipped
 * instance additionally carries bonus ids, gems, and other properties that distinguish individual
 * instances of the same base item. `kind: "commodity"` exists so a future `ExactItemIdentity` variant
 * can share a discriminated union with this one without ambiguity, without this slice building that
 * future shape now.
 */
export interface CommodityIdentity {
  readonly kind: "commodity";
  readonly gameVersion: "retail";
  readonly baseItemId: number;
}

export function commodityIdentity(baseItemId: number): CommodityIdentity {
  if (!Number.isSafeInteger(baseItemId) || baseItemId <= 0) throw new TypeError("baseItemId must be a positive integer");
  return { kind: "commodity", gameVersion: "retail", baseItemId };
}

/**
 * One explicit, durable demand. Slice 1: account-scoped (no character scope), Retail only. `purpose` is
 * plain explanatory text, not a structured code — this repository's convention reserves structured
 * codes for machine-decidable states (see allocation.ts AllocationReasonCode), never for free-form human
 * intent text.
 */
export interface ExplicitDemand {
  readonly stableId: string;
  readonly gameVersion: "retail";
  readonly demandType: DemandType;
  readonly commodity: CommodityIdentity;
  readonly requiredQuantity: number;
  readonly purpose?: string;
  readonly status: DemandStatus;
  /** A prior demand this one is understood to replace, for display only; Slice 1 never reads or enforces this. */
  readonly supersedesStableId?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** What a persistence layer stores: plain columns, no JSON documents (every field here is a scalar). */
export interface StoredDemand {
  stableId: string;
  gameVersion: "retail";
  demandType: DemandType;
  baseItemId: number;
  requiredQuantity: number;
  purpose?: string;
  status: DemandStatus;
  supersedesStableId?: string;
  createdAt: number;
  updatedAt: number;
}

/** Thrown by `SnapshotStore.createDemand` when an ACTIVE demand already exists for the same key (see `demandConflictKey`). */
export class DemandConflictError extends Error {
  readonly code = "DEMAND_CONFLICT";
  readonly existingStableId: string;
  constructor(existingStableId: string) {
    super(`An active demand already exists for this (version, demand type, commodity) key: ${existingStableId}`);
    this.name = "DemandConflictError";
    this.existingStableId = existingStableId;
  }
}

export class DemandValidationError extends TypeError {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "DemandValidationError";
    this.code = code;
  }
}

/**
 * The key that must be unique among ACTIVE demands: one effective active demand per
 * (version, demand type, commodity). Shared by the SQLite partial unique index and the API's 409 check,
 * so persistence and API agree on exactly what "conflicting" means.
 */
export function demandConflictKey(gameVersion: "retail", demandType: DemandType, baseItemId: number): string {
  return `${gameVersion}::${demandType}::${baseItemId}`;
}

export interface CreateDemandInput {
  baseItemId: number;
  demandType?: DemandType;
  requiredQuantity: number;
  purpose?: string;
}

/**
 * Validates a demand-creation request against Slice 1's rules. Pure: throws `DemandValidationError`
 * (never silently clamps/coerces) rather than deciding what the caller meant.
 */
export function validateCreateDemandInput(input: CreateDemandInput): { demandType: DemandType; baseItemId: number; requiredQuantity: number; purpose?: string } {
  const demandType = input.demandType ?? "STOCK_TARGET";
  if (!DEMAND_TYPES.includes(demandType)) {
    throw new DemandValidationError("UNSUPPORTED_DEMAND_TYPE", `Unsupported demand type "${demandType}"; Slice 1 only supports STOCK_TARGET.`);
  }
  if (!Number.isSafeInteger(input.baseItemId) || input.baseItemId <= 0) {
    throw new DemandValidationError("INVALID_BASE_ITEM_ID", "baseItemId must be a positive integer.");
  }
  if (!Number.isSafeInteger(input.requiredQuantity) || input.requiredQuantity < 0) {
    throw new DemandValidationError("INVALID_REQUIRED_QUANTITY", "requiredQuantity must be a non-negative integer.");
  }
  if (input.purpose !== undefined && (typeof input.purpose !== "string" || input.purpose.length > 500)) {
    throw new DemandValidationError("INVALID_PURPOSE", "purpose must be a string of at most 500 characters.");
  }
  return { demandType, baseItemId: input.baseItemId, requiredQuantity: input.requiredQuantity, purpose: input.purpose };
}

export interface UpdateDemandInput {
  requiredQuantity?: number;
  purpose?: string;
}

export function validateUpdateDemandInput(input: UpdateDemandInput): UpdateDemandInput {
  if (input.requiredQuantity !== undefined && (!Number.isSafeInteger(input.requiredQuantity) || input.requiredQuantity < 0)) {
    throw new DemandValidationError("INVALID_REQUIRED_QUANTITY", "requiredQuantity must be a non-negative integer.");
  }
  if (input.purpose !== undefined && (typeof input.purpose !== "string" || input.purpose.length > 500)) {
    throw new DemandValidationError("INVALID_PURPOSE", "purpose must be a string of at most 500 characters.");
  }
  return input;
}

export function storedDemandToExplicitDemand(stored: StoredDemand): ExplicitDemand {
  return {
    stableId: stored.stableId,
    gameVersion: stored.gameVersion,
    demandType: stored.demandType,
    commodity: commodityIdentity(stored.baseItemId),
    requiredQuantity: stored.requiredQuantity,
    ...(stored.purpose !== undefined ? { purpose: stored.purpose } : {}),
    status: stored.status,
    ...(stored.supersedesStableId !== undefined ? { supersedesStableId: stored.supersedesStableId } : {}),
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
  };
}
