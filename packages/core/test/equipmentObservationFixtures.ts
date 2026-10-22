// Plain-JSON equipment observations in the exact shape GearExport 7958c56 persists in
// WoWSyncDB.characters[guid].sections.equipment (S.Commit + the specEquipmentObservation sidecar), as
// luaToPlain delivers them. Shared by the core equipment-observation tests.
import { buildWowSyncExport } from "./fixtureBuilder.ts";

/** The live-validated Virek capture: Retail Hunter, Beast Mastery before and after, complete equipment. */
export const VIREK_TUPLE = { observedAt: 1791375064, capture: 29, revision: 220 } as const;

export const VIREK_ROSTER = {
  state: "OBSERVED",
  specializations: [
    { index: 1, specID: 253, name: "Beast Mastery", role: "DAMAGER", primaryStat: 2, isUnlocked: true },
    { index: 2, specID: 254, name: "Marksmanship", role: "DAMAGER", primaryStat: 2 },
    { index: 3, specID: 255, name: "Survival", role: "DAMAGER", primaryStat: 2, isUnlocked: false },
  ],
};

export interface SidecarOptions {
  specID?: number;
  afterSpecID?: number;
  readiness?: "READY" | "NOT_READY" | "UNKNOWN";
  stability?: "STABLE" | "UNSTABLE" | "NOT_READY" | "UNKNOWN";
  link?: { observedAt: unknown; capture: unknown; revision: unknown };
}

const SPEC_NAMES: Record<number, string> = { 253: "Beast Mastery", 254: "Marksmanship", 255: "Survival" };
const active = (specID: number) => ({ index: specID - 252, specID, name: SPEC_NAMES[specID] ?? `Spec ${specID}`, role: "DAMAGER", primaryStat: 2, isUnlocked: true });

/** GearExport's specEquipmentObservation sidecar (WoWSyncCollectors.lua SpecObservation + Core.lua attach). */
export function sidecar(tuple: { observedAt: number; capture: number; revision: number } = VIREK_TUPLE, options: SidecarOptions = {}): Record<string, unknown> {
  const readiness = options.readiness ?? "READY";
  if (readiness !== "READY") {
    return {
      contractVersion: 1,
      clientFamily: "Retail",
      atomicity: "NOT_CLAIMED",
      readiness,
      classID: 3,
      roster: { state: readiness === "NOT_READY" ? "NOT_READY" : "UNKNOWN" },
      activeSpecBefore: {},
      activeSpecAfter: {},
      stability: options.stability ?? (readiness === "NOT_READY" ? "NOT_READY" : "UNKNOWN"),
      equipmentObservation: options.link ?? { ...tuple },
    };
  }
  const before = options.specID ?? 253;
  const after = options.afterSpecID ?? before;
  return {
    contractVersion: 1,
    clientFamily: "Retail",
    atomicity: "NOT_CLAIMED",
    readiness,
    classID: 3,
    roster: structuredClone(VIREK_ROSTER),
    activeSpecBefore: active(before),
    activeSpecAfter: active(after),
    stability: options.stability ?? (before === after ? "STABLE" : "UNSTABLE"),
    equipmentObservation: options.link ?? { ...tuple },
  };
}

/** Two equipped items, slot-keyed the way luaToPlain renders a gapped Lua table (slots 1 and 16). */
export const VIREK_SLOTS = {
  "1": { itemID: 237610, itemString: "item:237610::::::::80", name: "Midnight Hunter's Helm", quality: 4, level: 80, itemLevel: 684 },
  "16": { itemID: 237611, itemString: "item:237611::::::::80", name: "Midnight Longbow", quality: 4, level: 80, itemLevel: 684 },
};

export interface EnvelopeOptions extends SidecarOptions {
  tuple?: { observedAt: number; capture: number; revision: number };
  completeness?: "complete" | "partial";
  slots?: unknown;
  /** false = no specEquipmentObservation on the envelope (an older addon, or a non-attached capture). */
  withSidecar?: boolean;
  /** Mutable S.Attempt diagnostics that a JSON caller might (wrongly) include. */
  lastAttempt?: boolean;
}

/** The canonical sections.equipment envelope (S.Commit fields + optional sidecar). */
export function envelope(options: EnvelopeOptions = {}): Record<string, unknown> {
  const tuple = options.tuple ?? VIREK_TUPLE;
  const completeness = options.completeness ?? "complete";
  return {
    data: { slots: options.slots ?? structuredClone(VIREK_SLOTS) },
    observedAt: tuple.observedAt,
    changedAt: tuple.observedAt,
    revision: tuple.revision,
    completeness,
    ...(completeness === "partial" ? { reason: "Item metadata or equipped tooltip pending" } : {}),
    source: "client",
    capture: tuple.capture,
    ...(options.withSidecar === false ? {} : { specEquipmentObservation: sidecar(tuple, options) }),
    ...(options.lastAttempt ? { lastAttemptAt: tuple.observedAt + 60, lastAttemptError: "Equipment identity pending" } : {}),
  };
}

/** The ImportExtras.equipmentObservation wire value. `projection: true` copies the canonical sidecar, as GearExport does. */
export function observation(options: EnvelopeOptions & { projection?: true | unknown } = {}): { envelope: Record<string, unknown>; projection?: unknown } {
  const env = envelope(options);
  const projection = options.projection === true ? structuredClone(env.specEquipmentObservation) : options.projection;
  return { envelope: env, ...(projection === undefined ? {} : { projection }) };
}

/** A Retail WOWSYNC v1 export for a character; identical arguments give byte-identical text. */
export const retailExport = (name = "Virek", realm = "Cairne", generatedAt = 1_791_375_000) =>
  buildWowSyncExport({ generatedAt, character: { name, realm, clientFamily: "Retail", clientVersion: "12.1.0" } });
