/**
 * Retail equipment observation (GearExport sections.equipment): normalization, validation,
 * canonical JSON generation, and policy-A-E acceptance/rejection. The envelope, including its
 * specEquipmentObservation sidecar, is the canonical evidence; latestExport.specEquipmentObservation
 * is only GearExport's projection of that sidecar, used as corroboration and never as a source.
 * Structural checks only: whether an observation can qualify as a spec baseline is decided by readers.
 * This module is pure: neither storage nor bridge details.
 */

export interface CapturedEquipmentObservation {
  observedAt: number;
  capture: number;
  revision: number;
  completeness: "complete" | "partial";
  reason?: string;
  source?: string;
  changedAt?: number;
  slots: Record<string, unknown>;
  specEquipmentObservation?: Record<string, unknown>;
}

export type EquipmentNormalizationOutcome =
  | "invalid-or-unsupported"
  | "projection-mismatch"
  | "projection-without-canonical";

export type NormalizedEquipment =
  | { ok: true; value: CapturedEquipmentObservation }
  | { ok: false; outcome: EquipmentNormalizationOutcome };

/**
 * Normalize and validate the equipment envelope + sidecar per Slice A structural validation
 * (section 14 of the spec). Policy A-E check happens separately in the store layer.
 */
export function normalizeEquipmentObservation(
  input: unknown,
  version: string | undefined
): NormalizedEquipment {
  // Version gate: only Retail
  if (version !== "retail") {
    return { ok: false, outcome: "invalid-or-unsupported" };
  }

  // Must be an object with required envelope fields
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, outcome: "invalid-or-unsupported" };
  }

  const plain = input as Record<string, unknown>;
  const envelope = plain.envelope;

  if (envelope === undefined && plain.projection !== undefined) {
    // Policy D: a latestExport projection with no canonical equipment envelope at all is never stored.
    return { ok: false, outcome: "projection-without-canonical" };
  }
  if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) {
    return { ok: false, outcome: "invalid-or-unsupported" };
  }

  const env = envelope as Record<string, unknown>;

  // Validate envelope tuple: observedAt, capture, revision must be safe integers >= 0
  const observedAt = env.observedAt;
  const capture = env.capture;
  const revision = env.revision;

  if (
    typeof observedAt !== "number" ||
    !Number.isSafeInteger(observedAt) ||
    observedAt < 0 ||
    typeof capture !== "number" ||
    !Number.isSafeInteger(capture) ||
    capture < 0 ||
    typeof revision !== "number" ||
    !Number.isSafeInteger(revision) ||
    revision < 0
  ) {
    return { ok: false, outcome: "invalid-or-unsupported" };
  }

  // Validate completeness
  const completeness = env.completeness;
  if (completeness !== "complete" && completeness !== "partial") {
    return { ok: false, outcome: "invalid-or-unsupported" };
  }

  // Validate and normalize slots
  const slotsNormalized = normalizeSlots(env.data);
  if (!slotsNormalized.ok) {
    return { ok: false, outcome: "invalid-or-unsupported" };
  }

  // Optional fields: reason, source, changedAt must have correct types if present
  const reason = env.reason;
  if (reason !== undefined && typeof reason !== "string") {
    return { ok: false, outcome: "invalid-or-unsupported" };
  }

  const source = env.source;
  if (source !== undefined && typeof source !== "string") {
    return { ok: false, outcome: "invalid-or-unsupported" };
  }

  const changedAt = env.changedAt;
  if (
    changedAt !== undefined &&
    (typeof changedAt !== "number" || !Number.isSafeInteger(changedAt) || changedAt < 0)
  ) {
    return { ok: false, outcome: "invalid-or-unsupported" };
  }

  // Optional sidecar validation (structure only, not semantics per spec 14)
  const sidecar = env.specEquipmentObservation;
  if (sidecar !== undefined) {
    if (typeof sidecar !== "object" || sidecar === null || Array.isArray(sidecar)) {
      return { ok: false, outcome: "invalid-or-unsupported" };
    }
    const sc = sidecar as Record<string, unknown>;
    if (
      sc.contractVersion !== 1 ||
      sc.clientFamily !== "Retail" ||
      typeof sc.equipmentObservation !== "object" ||
      sc.equipmentObservation === null ||
      Array.isArray(sc.equipmentObservation)
    ) {
      return { ok: false, outcome: "invalid-or-unsupported" };
    }
  }

  // Validate projection if present
  const projection = plain.projection;
  if (projection !== undefined && (typeof projection !== "object" || projection === null || Array.isArray(projection))) {
    return { ok: false, outcome: "invalid-or-unsupported" };
  }

  // Build normalized observation (exclude lastAttemptAt/lastAttemptError)
  const result: CapturedEquipmentObservation = {
    observedAt,
    capture,
    revision,
    completeness,
    slots: slotsNormalized.slots,
    ...(reason !== undefined ? { reason } : {}),
    ...(source !== undefined ? { source } : {}),
    ...(changedAt !== undefined ? { changedAt } : {}),
    ...(sidecar !== undefined ? { specEquipmentObservation: sidecar as Record<string, unknown> } : {}),
  };

  return { ok: true, value: result };
}

interface NormalizedSlots {
  ok: true;
  slots: Record<string, unknown>;
}

interface NormalizedSlotsError {
  ok: false;
}

/**
 * Normalize slots from luaToPlain output (0-based array or string-keyed object) to a
 * deterministic slot-number-keyed object (string keys "1".."19"). No slot shift.
 */
function normalizeSlots(data: unknown): NormalizedSlots | NormalizedSlotsError {
  if (typeof data !== "object" || data === null) {
    return { ok: false };
  }

  const dataObj = data as Record<string, unknown>;
  const slots = dataObj.slots;

  if (typeof slots !== "object" || slots === null) {
    return { ok: false };
  }

  const normalized: Record<string, unknown> = {};

  if (Array.isArray(slots)) {
    // 0-based JS array: index i means slot i+1 (range 1..19)
    for (let i = 0; i < slots.length; i++) {
      const slotNum = i + 1;
      if (slotNum < 1 || slotNum > 19) {
        return { ok: false };
      }
      normalized[String(slotNum)] = slots[i];
    }
  } else {
    // String-keyed object: validate keys are integers in range 1..19
    for (const [key, value] of Object.entries(slots)) {
      const slotNum = parseInt(key, 10);
      if (isNaN(slotNum) || slotNum < 1 || slotNum > 19 || String(slotNum) !== key) {
        return { ok: false };
      }
      normalized[key] = value;
    }
  }

  return { ok: true, slots: normalized };
}

/**
 * Canonical JSON: recursively key-sorted JSON representation for comparing projections
 * and canonical sidecars under policy B. Deterministic and independent of key order.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (typeof value !== "object" || value === null) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }

  const obj = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = sortKeys(obj[key]);
  }
  return sorted;
}

/**
 * Evaluate policies A-E on the normalized envelope and optional projection.
 * Returns the outcome that determines whether to store and what ImportResult to report.
 * This lives in CORE because POST /api/import and /api/captures accept caller JSON.
 *
 * Policy:
 * A: canonical valid, projection absent -> accept
 * B: canonical valid, projection equivalent -> accept
 * C: canonical valid, projection differs -> fail-closed, "projection-mismatch"
 * D: projection present, canonical absent -> fail-closed, "projection-without-canonical"
 * E: no sidecar on either side, valid envelope -> accept
 */
export function evaluateEquipmentPolicy(
  canonical: CapturedEquipmentObservation | undefined,
  projection: unknown
): { ok: true } | { ok: false; outcome: EquipmentNormalizationOutcome } {
  const hasCanonical = canonical?.specEquipmentObservation !== undefined;
  const hasProjection = projection !== undefined;

  if (hasCanonical) {
    if (!hasProjection) {
      // Policy A: canonical only -> accept
      return { ok: true };
    }
    // Check if projection is equivalent to canonical via canonical JSON
    const canonicalJson_value = canonicalJson(canonical.specEquipmentObservation);
    const projectionJson = canonicalJson(projection);
    if (canonicalJson_value === projectionJson) {
      // Policy B: equivalent -> accept
      return { ok: true };
    }
    // Policy C: differs -> reject
    return { ok: false, outcome: "projection-mismatch" };
  }

  if (hasProjection) {
    // Policy D: projection without canonical -> reject
    return { ok: false, outcome: "projection-without-canonical" };
  }

  // Policy E: no sidecar on either side -> accept (valid envelope is already checked)
  return { ok: true };
}
