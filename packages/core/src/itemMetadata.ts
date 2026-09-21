// Item metadata: static, per-base-item facts learned from the game client (`[ITEM METADATA]`).
//
// This is ENRICHMENT, never observation truth:
//  - It lives in its own store, keyed by (game version, base item id). It is not part of a snapshot's
//    observation identity, never enters a shared-storage content hash, and arriving later never rewrites
//    a stored snapshot or observation.
//  - Every facet is independently known or UNKNOWN. UNKNOWN is the absence of evidence: it is never stored,
//    so it can never overwrite a known value, and a later export that knows a facet simply fills it in.
//  - Two different KNOWN values for one facet are never resolved by "latest wins": the facet is CONFLICT
//    (both values are exposed) until a human decides what that means.
//  - `expansionID` is kept as the client's raw number. A human-readable expansion name is derived HERE, at
//    read time, from an explicit, evidence-backed, per-game-version table; anything the table does not
//    support renders as "Expansion unknown (client value N)".
//
// Pure functions only (no I/O): the SQLite store persists `ItemFacetEvidence`, and everything else is
// derived from it on read.

import type { ItemMetadataRow, VersionOrUnknown, WowVersion } from "./types.ts";

/** The facets of the WOWSYNC `[ITEM METADATA]` contract, named as the producer names them. */
export const ITEM_FACETS = ["classID", "subclassID", "bindType", "expansionID", "isCraftingReagent"] as const;
export type ItemFacetName = (typeof ITEM_FACETS)[number];

/** Where a fact came from. Only the game client exists today; a Blizzard-API source would be added here and would never be mixed into the client's evidence. */
export type ItemMetadataSource = "game-client";
export const ITEM_METADATA_SOURCES: readonly ItemMetadataSource[] = ["game-client"];

/**
 * One distinct KNOWN value of one facet for one item, as reported by one source, with its provenance.
 * `value` is the integer as stored: `isCraftingReagent` is 1 (yes) or 0 (no).
 * The provenance fields are order-independent aggregates (min / max / sorted union), so replaying exports
 * in any order yields identical records.
 */
export interface ItemFacetEvidence {
  gameVersion: WowVersion;
  baseItemId: number;
  facet: ItemFacetName;
  source: ItemMetadataSource;
  value: number;
  /** Earliest / latest observation time (Unix seconds) of an export that reported this value. */
  firstSeenAt: number;
  lastSeenAt: number;
  /** Every distinct client build that reported this value, sorted. Empty when the export named no build. */
  clientBuilds: string[];
}

/** One KNOWN facet value flattened out of a parsed `[ITEM METADATA]` row. UNKNOWN facets are omitted, never represented. */
export interface ItemFacetObservation {
  baseItemId: number;
  facet: ItemFacetName;
  value: number;
}

/** The KNOWN facets of a parsed section, in deterministic order (item id, then contract facet order). */
export function knownFacets(rows: readonly ItemMetadataRow[]): ItemFacetObservation[] {
  const out: ItemFacetObservation[] = [];
  for (const row of [...rows].sort((a, b) => a.baseItemId - b.baseItemId)) {
    if (row.classId !== undefined) out.push({ baseItemId: row.baseItemId, facet: "classID", value: row.classId });
    if (row.subclassId !== undefined) out.push({ baseItemId: row.baseItemId, facet: "subclassID", value: row.subclassId });
    if (row.bindType !== undefined) out.push({ baseItemId: row.baseItemId, facet: "bindType", value: row.bindType });
    if (row.expansionId !== undefined) out.push({ baseItemId: row.baseItemId, facet: "expansionID", value: row.expansionId });
    if (row.isCraftingReagent !== undefined) {
      out.push({ baseItemId: row.baseItemId, facet: "isCraftingReagent", value: row.isCraftingReagent ? 1 : 0 });
    }
  }
  return out;
}

/**
 * Folds one more sighting into an evidence record: earliest/latest time and the set of builds. The same
 * value replayed changes nothing, whatever the import order (idempotent, commutative, associative).
 */
export function mergeEvidence(
  existing: Pick<ItemFacetEvidence, "firstSeenAt" | "lastSeenAt" | "clientBuilds"> | undefined,
  seenAt: number,
  clientBuild: string | undefined,
): Pick<ItemFacetEvidence, "firstSeenAt" | "lastSeenAt" | "clientBuilds"> {
  const builds = new Set(existing?.clientBuilds ?? []);
  if (clientBuild !== undefined && clientBuild !== "") builds.add(clientBuild);
  return {
    firstSeenAt: existing ? Math.min(existing.firstSeenAt, seenAt) : seenAt,
    lastSeenAt: existing ? Math.max(existing.lastSeenAt, seenAt) : seenAt,
    clientBuilds: [...builds].sort(),
  };
}

/**
 * The base item id of an `item:` reference, or undefined. Strict on purpose: unlike `baseItemId` (diff.ts,
 * which falls back to the whole reference for grouping), a metadata lookup must never key on anything that is
 * not a real positive integer id.
 */
export function itemIdFromItemRef(itemRef: string | undefined): number | undefined {
  if (!itemRef) return undefined;
  const match = /^item:(\d+)/.exec(itemRef);
  if (!match) return undefined;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

// ---------------------------------------------------------------------------------------------
// Resolution: evidence -> what a consumer may say about a facet
// ---------------------------------------------------------------------------------------------

export interface FacetSighting<T> {
  value: T;
  sources: ItemMetadataSource[];
  /** Distinct client builds that reported this value (sorted). */
  clientBuilds: string[];
}

/**
 * KNOWN     - every source that reported this facet agrees on one value.
 * UNKNOWN   - nothing known was ever reported. Never 0, false or empty.
 * CONFLICT  - two or more different known values were reported; none is chosen. `values` lists them
 *             (ascending) with provenance so the disagreement can be diagnosed.
 */
export type FacetState<T> =
  | { state: "KNOWN"; value: T; sources: ItemMetadataSource[] }
  | { state: "UNKNOWN" }
  | { state: "CONFLICT"; values: FacetSighting<T>[] };

export const UNKNOWN_FACET: { state: "UNKNOWN" } = { state: "UNKNOWN" };

function resolveFacet<T extends number | boolean>(
  evidence: readonly ItemFacetEvidence[],
  decode: (stored: number) => T,
): FacetState<T> {
  if (evidence.length === 0) return UNKNOWN_FACET;
  const byValue = new Map<number, FacetSighting<T>>();
  for (const e of evidence) {
    const sighting = byValue.get(e.value) ?? { value: decode(e.value), sources: [], clientBuilds: [] };
    if (!sighting.sources.includes(e.source)) sighting.sources.push(e.source);
    for (const build of e.clientBuilds) if (!sighting.clientBuilds.includes(build)) sighting.clientBuilds.push(build);
    byValue.set(e.value, sighting);
  }
  const sightings = [...byValue.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, s]) => ({ value: s.value, sources: [...s.sources].sort(), clientBuilds: [...s.clientBuilds].sort() }));
  if (sightings.length === 1) return { state: "KNOWN", value: sightings[0].value, sources: sightings[0].sources };
  return { state: "CONFLICT", values: sightings };
}

const decodeInteger = (stored: number): number => stored;
function decodeBoolean(stored: number): boolean {
  if (stored === 1) return true;
  if (stored === 0) return false;
  throw new Error(`Corrupt item metadata: isCraftingReagent stored as ${stored} (expected 0 or 1)`);
}

// ---------------------------------------------------------------------------------------------
// Expansion labels: derived by the Dashboard, scoped to a game version, evidence-backed
// ---------------------------------------------------------------------------------------------

export interface ExpansionLabelEntry {
  label: string;
  /** Why this mapping is trusted. A number with no documented evidence has no entry. */
  evidence: string;
}

const LIVE_RETAIL_CAPTURE = "live Retail client capture (Retail 12.1.0), GetItemInfo expansionID";

/**
 * Supported expansion-number -> name mappings, PER GAME VERSION. An entry exists only where a real client
 * value was captured for an item whose expansion is independently known. The numbering is deliberately NOT
 * extrapolated from a sequence, and Retail's numbering is not assumed for any other client: a version with no
 * table has no labels. Values missing here (including 0 and 254) render as "Expansion unknown (client value N)".
 */
export const EXPANSION_LABELS: Readonly<Partial<Record<WowVersion, Readonly<Record<number, ExpansionLabelEntry>>>>> = {
  retail: {
    4: { label: "Mists of Pandaria", evidence: `${LIVE_RETAIL_CAPTURE}: Mote of Harmony (89112) = 4` },
    8: { label: "Shadowlands", evidence: `${LIVE_RETAIL_CAPTURE}: Progenitor Essentia (187707) = 8` },
    9: { label: "Dragonflight", evidence: `${LIVE_RETAIL_CAPTURE}: Elemental Mote (202071) = 9` },
    10: { label: "The War Within", evidence: `${LIVE_RETAIL_CAPTURE}: Bismuth (210931) = 10` },
    11: { label: "Midnight", evidence: `${LIVE_RETAIL_CAPTURE}: Mote of Light (236949) = 11` },
  },
};

/**
 * KNOWN    - one raw value, and this game version's table supports a label for it.
 * UNMAPPED - one raw value the Dashboard has no supported label for; `text` says so and keeps the number.
 * UNKNOWN  - the client never reported an expansion for this item.
 * CONFLICT - the client reported different values; no label is chosen.
 */
export type ExpansionInfo =
  | { state: "KNOWN"; rawValue: number; label: string; text: string }
  | { state: "UNMAPPED"; rawValue: number; text: string }
  | { state: "UNKNOWN"; text: string }
  | { state: "CONFLICT"; rawValues: number[]; text: string };

export function describeExpansion(gameVersion: WowVersion, facet: FacetState<number>): ExpansionInfo {
  if (facet.state === "UNKNOWN") return { state: "UNKNOWN", text: "Expansion unknown" };
  if (facet.state === "CONFLICT") {
    const rawValues = facet.values.map((v) => v.value);
    return { state: "CONFLICT", rawValues, text: `Expansion unknown (conflicting client values ${rawValues.join(", ")})` };
  }
  const entry = EXPANSION_LABELS[gameVersion]?.[facet.value];
  if (entry) return { state: "KNOWN", rawValue: facet.value, label: entry.label, text: entry.label };
  return { state: "UNMAPPED", rawValue: facet.value, text: `Expansion unknown (client value ${facet.value})` };
}

// ---------------------------------------------------------------------------------------------
// The per-item view
// ---------------------------------------------------------------------------------------------

/** Everything the Dashboard may say about one base item in one game version. Absence of an item means every facet is UNKNOWN. */
export interface ItemMetadataView {
  baseItemId: number;
  classId: FacetState<number>;
  subclassId: FacetState<number>;
  bindType: FacetState<number>;
  /** The client's raw number, exactly as reported. */
  expansionId: FacetState<number>;
  /** Derived label for `expansionId` (never stored). */
  expansion: ExpansionInfo;
  craftingReagent: FacetState<boolean>;
}

/** The view for an item nothing is known about. What a consumer must use for a lookup miss. */
export function unknownItemMetadata(gameVersion: WowVersion, baseItemId: number): ItemMetadataView {
  return buildItemMetadataView(gameVersion, baseItemId, []);
}

export function buildItemMetadataView(gameVersion: WowVersion, baseItemId: number, evidence: readonly ItemFacetEvidence[]): ItemMetadataView {
  const of = (facet: ItemFacetName) => evidence.filter((e) => e.facet === facet);
  const expansionId = resolveFacet(of("expansionID"), decodeInteger);
  return {
    baseItemId,
    classId: resolveFacet(of("classID"), decodeInteger),
    subclassId: resolveFacet(of("subclassID"), decodeInteger),
    bindType: resolveFacet(of("bindType"), decodeInteger),
    expansionId,
    expansion: describeExpansion(gameVersion, expansionId),
    craftingReagent: resolveFacet(of("isCraftingReagent"), decodeBoolean),
  };
}

/** One view per item that has any evidence, ordered by item id. Evidence for other game versions is never used. */
export function buildItemMetadataViews(gameVersion: WowVersion, evidence: readonly ItemFacetEvidence[]): ItemMetadataView[] {
  const byItem = new Map<number, ItemFacetEvidence[]>();
  for (const e of evidence) {
    if (e.gameVersion !== gameVersion) continue;
    const list = byItem.get(e.baseItemId) ?? [];
    list.push(e);
    byItem.set(e.baseItemId, list);
  }
  return [...byItem.entries()].sort((a, b) => a[0] - b[0]).map(([id, list]) => buildItemMetadataView(gameVersion, id, list));
}

/** GET /api/versions/:version/item-metadata */
export interface ItemMetadataResponse {
  schema: "item-metadata-1";
  version: VersionOrUnknown;
  items: ItemMetadataView[];
}
