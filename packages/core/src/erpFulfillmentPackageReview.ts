import type { ErpResourceKind } from "./erpProjects.ts";
import type { Freshness } from "./freshness.ts";
import type { WowVersion } from "./types.ts";

/** A player-requested reservation in one frozen fulfillment package. */
export interface PackageReservationRequest {
  readonly taskKey: string;
  readonly version: WowVersion;
  readonly kind: ErpResourceKind;
  readonly resourceKey: string;
  readonly sourceIdentityKey?: string;
  readonly sourceOwnerKey?: string;
  readonly quantity: number;
  /** Supply remaining after existing commitments, when the exact source was observed completely. */
  readonly availableObservedLowerBound?: number;
}

export interface PackageReservationGroup {
  readonly key: string;
  readonly version: WowVersion;
  readonly kind: ErpResourceKind;
  readonly resourceKey: string;
  readonly sourceLabel: string;
  readonly requestedQuantity: number;
  readonly availableObservedLowerBound?: number;
  readonly state: "WITHIN_OBSERVED_LOWER_BOUND" | "EXCEEDS_OBSERVED_LOWER_BOUND" | "UNKNOWN" | "CONFLICTING_EVIDENCE";
  readonly taskCount: number;
}

/** Preserve a selected alternate identity even when its candidate vanished; never validate against the need's default source. */
export function resolvePackageReservationSource(input: {
  readonly selectedAlternateIdentityKey?: string;
  readonly selectedAlternateLowerBound?: number;
  readonly needSourceIdentityKey?: string;
  readonly needSourceOwnerKey?: string;
  readonly needSourceLowerBound?: number;
}): Pick<PackageReservationRequest, "sourceIdentityKey" | "sourceOwnerKey" | "availableObservedLowerBound"> {
  if (input.selectedAlternateIdentityKey) return { sourceIdentityKey: input.selectedAlternateIdentityKey, ...(input.selectedAlternateLowerBound !== undefined ? { availableObservedLowerBound: input.selectedAlternateLowerBound } : {}) };
  if (input.needSourceIdentityKey) return { sourceIdentityKey: input.needSourceIdentityKey, ...(input.needSourceLowerBound !== undefined ? { availableObservedLowerBound: input.needSourceLowerBound } : {}) };
  if (input.needSourceOwnerKey) return { sourceOwnerKey: input.needSourceOwnerKey, ...(input.needSourceLowerBound !== undefined ? { availableObservedLowerBound: input.needSourceLowerBound } : {}) };
  return {};
}

export interface PackageSourceDemand {
  readonly taskKey: string;
  readonly version: WowVersion;
  readonly kind: ErpResourceKind;
  readonly resourceKey: string;
  readonly sourceIdentityKey: string;
  readonly sourceName: string;
  readonly sourceFreshness: Freshness;
  readonly sourceObservedAt?: number;
  readonly requestedNeedQuantity?: number;
  readonly availableObservedLowerBound?: number;
}

export interface PackageSourceDemandGroup {
  readonly key: string;
  readonly version: WowVersion;
  readonly kind: ErpResourceKind;
  readonly resourceKey: string;
  readonly sourceIdentityKey: string;
  readonly sourceName: string;
  readonly sourceFreshness: Freshness;
  readonly oldestSourceObservedAt?: number;
  readonly sourceTimestampComplete: boolean;
  readonly taskCount: number;
  readonly requestedNeedQuantity?: number;
  readonly availableObservedLowerBound?: number;
  readonly state: "WITHIN_OBSERVED_LOWER_BOUND" | "EXCEEDS_OBSERVED_LOWER_BOUND" | "UNKNOWN_NEED" | "UNKNOWN_SOURCE_QUANTITY" | "CONFLICTING_SOURCE_EVIDENCE" | "STALE_OR_UNKNOWN_SOURCE_EVIDENCE";
}

/** Compare selected exact source leads with a package's known unmet needs; this is a quantity screen, not a route. */
export function reviewPackageSourceDemand(requests: readonly PackageSourceDemand[]): PackageSourceDemandGroup[] {
  const groups = new Map<string, PackageSourceDemand[]>();
  for (const request of requests) {
    const key = JSON.stringify([request.version, request.sourceIdentityKey, request.kind, request.resourceKey]);
    groups.set(key, [...(groups.get(key) ?? []), request]);
  }
  return [...groups.entries()].map(([key, entries]) => {
    const demandKnown = entries.every((entry) => entry.requestedNeedQuantity !== undefined);
    const supplyBounds = new Set(entries.map((entry) => entry.availableObservedLowerBound));
    const conflicting = supplyBounds.size > 1;
    const sourceFreshness = entries.some((entry) => entry.sourceFreshness === "stale") ? "stale" : entries.every((entry) => entry.sourceFreshness === "recent") ? "recent" : "unknown";
    const sourceTimes = entries.flatMap((entry) => entry.sourceObservedAt === undefined ? [] : [entry.sourceObservedAt]);
    const demand = demandKnown ? entries.reduce((sum, entry) => sum + entry.requestedNeedQuantity!, 0) : undefined;
    const supply = !conflicting ? entries[0]!.availableObservedLowerBound : undefined;
    const state = conflicting
      ? "CONFLICTING_SOURCE_EVIDENCE"
      : sourceFreshness !== "recent"
        ? "STALE_OR_UNKNOWN_SOURCE_EVIDENCE"
        : !demandKnown
        ? "UNKNOWN_NEED"
        : supply === undefined
          ? "UNKNOWN_SOURCE_QUANTITY"
          : demand! <= supply ? "WITHIN_OBSERVED_LOWER_BOUND" : "EXCEEDS_OBSERVED_LOWER_BOUND";
    return {
      key, version: entries[0]!.version, kind: entries[0]!.kind, resourceKey: entries[0]!.resourceKey,
      sourceIdentityKey: entries[0]!.sourceIdentityKey, sourceName: entries[0]!.sourceName,
      sourceFreshness,
      ...(sourceTimes.length ? { oldestSourceObservedAt: Math.min(...sourceTimes) } : {}),
      sourceTimestampComplete: sourceTimes.length === entries.length,
      taskCount: entries.length,
      ...(demand !== undefined ? { requestedNeedQuantity: demand } : {}),
      ...(supply !== undefined ? { availableObservedLowerBound: supply } : {}), state,
    };
  });
}

/**
 * Roll up only exact, versioned resource/source scopes. Unknown source scopes are isolated by task,
 * and inconsistent source snapshots remain conflicting instead of selecting a convenient value.
 */
export function reviewPackageReservations(requests: readonly PackageReservationRequest[]): PackageReservationGroup[] {
  const groups = new Map<string, PackageReservationRequest[]>();
  for (const request of requests) {
    if (!Number.isSafeInteger(request.quantity) || request.quantity < 1) continue;
    const sourceScope = request.sourceIdentityKey
      ? ["CHARACTER", request.sourceIdentityKey]
      : request.sourceOwnerKey
        ? ["SHARED_OWNER", request.sourceOwnerKey]
        : ["UNKNOWN_SOURCE", request.taskKey];
    const key = JSON.stringify([request.version, sourceScope, request.kind, request.resourceKey]);
    groups.set(key, [...(groups.get(key) ?? []), request]);
  }
  return [...groups.entries()].map(([key, entries]) => {
    const bounds = entries.map((entry) => entry.availableObservedLowerBound);
    const distinctBounds = new Set(bounds);
    const conflicting = distinctBounds.size > 1;
    const bound = !conflicting && bounds[0] !== undefined ? bounds[0] : undefined;
    const requestedQuantity = entries.reduce((sum, entry) => sum + entry.quantity, 0);
    return {
      key,
      version: entries[0]!.version,
      kind: entries[0]!.kind,
      resourceKey: entries[0]!.resourceKey,
      sourceLabel: entries[0]!.sourceIdentityKey ?? entries[0]!.sourceOwnerKey ?? "UNKNOWN source (kept separate)",
      requestedQuantity,
      ...(bound !== undefined ? { availableObservedLowerBound: bound } : {}),
      state: conflicting ? "CONFLICTING_EVIDENCE" : bound === undefined ? "UNKNOWN" : requestedQuantity <= bound ? "WITHIN_OBSERVED_LOWER_BOUND" : "EXCEEDS_OBSERVED_LOWER_BOUND",
      taskCount: entries.length,
    };
  });
}
