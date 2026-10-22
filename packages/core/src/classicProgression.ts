/**
 * Read views over the Classic Era / TBC Anniversary legacy reputation and
 * talent observations (classicState.ts). Rows keep the exporter's evidence;
 * a domain carried from an earlier snapshot or after a failed refresh is
 * LAST_SEEN. Reputation is visible-rows-only and therefore always partial.
 */

import { classifyFreshness, type Freshness } from "./freshness.ts";
import type { CapturedCharacterDomain } from "./types.ts";

type Obj = Record<string, unknown>;
const object = (value: unknown): value is Obj => value !== null && typeof value === "object" && !Array.isArray(value);
const num = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const str = (value: unknown): string | undefined => typeof value === "string" && value.length > 0 ? value : undefined;
const rows = (value: unknown): Obj[] => Array.isArray(value) ? value.filter(object) : [];

export type DomainEvidence = "OBSERVED" | "LAST_SEEN" | "UNKNOWN";

/** Legacy standing IDs are fixed by the Classic client (1 Hated … 8 Exalted); the label is DERIVED from the ID. */
const STANDINGS = ["Hated", "Hostile", "Unfriendly", "Neutral", "Friendly", "Honored", "Revered", "Exalted"];

export interface DomainHeader {
  state: DomainEvidence;
  completeness: string;
  observedAt?: number;
  freshness: Freshness;
  sourceSnapshotId?: number;
  clientProfile?: string;
  reason?: string;
}

function header(domain: CapturedCharacterDomain | undefined, now: number, unknownReason: string): DomainHeader {
  if (!domain) return { state: "UNKNOWN", completeness: "unknown", freshness: "unknown", reason: unknownReason };
  const data = object(domain.data) ? domain.data : {};
  const state: DomainEvidence = domain.status.state === "LAST_SEEN" ? "LAST_SEEN" : domain.status.state === "OBSERVED" ? "OBSERVED" : "UNKNOWN";
  return {
    state, completeness: domain.completeness ?? "unknown", ...(domain.observedAt !== undefined ? { observedAt: domain.observedAt } : {}),
    freshness: classifyFreshness(domain.observedAt, now),
    ...(domain.status.carriedFromSnapshotId !== undefined ? { sourceSnapshotId: domain.status.carriedFromSnapshotId } : {}),
    ...(str(data.clientProfile) ? { clientProfile: str(data.clientProfile) } : {}),
    ...(domain.status.reason ? { reason: domain.status.reason } : {}),
  };
}

export interface ClassicFactionRow {
  name: string;
  factionID?: number;
  factionKey?: string;
  parentCategory?: string;
  standingID?: number;
  standingLabel?: string;
  standingLabelBasis?: "DERIVED_FROM_STANDING_ID";
  barMin?: number;
  barMax?: number;
  barValue?: number;
  atWar?: boolean;
  isWatched?: boolean;
  isHeaderReputation?: boolean;
  evidence: DomainEvidence;
  ownerScope: "CHARACTER";
}

export interface ClassicReputationView extends DomainHeader {
  coverage: "VISIBLE_REPUTATION_ROWS_ONLY" | "UNKNOWN";
  factions: ClassicFactionRow[];
  totalCount: number;
  truncated: boolean;
  semantics: string;
}

export function buildClassicReputationView(domain: CapturedCharacterDomain | undefined, now: number, options: { query?: string; limit?: number } = {}): ClassicReputationView {
  const head = header(domain, now, "Reputation was not captured for this character (the legacy reputation list is read when the client reports a faction update).");
  const historical = head.state === "LAST_SEEN";
  const needle = options.query?.trim().toLowerCase();
  const all = rows(object(domain?.data) ? domain!.data.factions : undefined).flatMap((row): ClassicFactionRow[] => {
    const name = str(row.name);
    if (!name) return [];
    const standingID = num(row.standingID);
    const label = standingID !== undefined && Number.isInteger(standingID) && standingID >= 1 && standingID <= 8 ? STANDINGS[standingID - 1] : undefined;
    return [{
      name,
      ...(num(row.factionID) !== undefined ? { factionID: num(row.factionID) } : {}),
      ...(str(row.factionKey) ? { factionKey: str(row.factionKey) } : {}),
      ...(str(row.parentCategory) ? { parentCategory: str(row.parentCategory) } : {}),
      ...(standingID !== undefined ? { standingID } : {}),
      ...(label ? { standingLabel: label, standingLabelBasis: "DERIVED_FROM_STANDING_ID" as const } : {}),
      ...(num(row.barMin) !== undefined ? { barMin: num(row.barMin) } : {}),
      ...(num(row.barMax) !== undefined ? { barMax: num(row.barMax) } : {}),
      ...(num(row.barValue) !== undefined ? { barValue: num(row.barValue) } : {}),
      ...(typeof row.atWar === "boolean" ? { atWar: row.atWar } : {}),
      ...(typeof row.isWatched === "boolean" ? { isWatched: row.isWatched } : {}),
      ...(row.isHeaderReputation === true ? { isHeaderReputation: true } : {}),
      evidence: historical || row.evidence === "LAST_SEEN" ? "LAST_SEEN" : "OBSERVED",
      ownerScope: "CHARACTER",
    }];
  }).filter((row) => !needle || `${row.name} ${row.parentCategory ?? ""}`.toLowerCase().includes(needle));
  const limit = Math.max(1, Math.min(options.limit ?? 100, 200));
  return {
    ...head,
    coverage: domain ? "VISIBLE_REPUTATION_ROWS_ONLY" : "UNKNOWN",
    factions: all.slice(0, limit),
    totalCount: all.length,
    truncated: all.length > limit,
    semantics: "Character-scoped rows from the legacy reputation list as displayed (collapsed headers hide rows). A faction absent here is UNKNOWN, not Neutral or unmet. barValue/barMin/barMax are the client's raw bar values. Classic has no account-wide reputation.",
  };
}

export interface ClassicTalentTree {
  tab: number;
  name?: string;
  pointsSpent?: number;
  talentCoverage: string;
  talents: Array<{ index: number; name?: string; tier?: number; column?: number; currentRank?: number; maxRank?: number }>;
}

export interface ClassicTalentView extends DomainHeader {
  trees: ClassicTalentTree[];
  /** DERIVED: points spent per tree in tab order, e.g. "31/20/0", only when every tree reported points. */
  distribution?: string;
  totalPointsSpent?: number;
  semantics: string;
}

export function buildClassicTalentView(domain: CapturedCharacterDomain | undefined, now: number, options: { includeTalents?: boolean } = {}): ClassicTalentView {
  const head = header(domain, now, "Talents were not captured for this character.");
  const trees: ClassicTalentTree[] = rows(object(domain?.data) ? domain!.data.trees : undefined).flatMap((tree) => {
    const tab = num(tree.tab);
    if (tab === undefined) return [];
    const talents = rows(tree.talents).flatMap((talent) => num(talent.index) === undefined ? [] : [{
      index: num(talent.index)!,
      ...(str(talent.name) ? { name: str(talent.name) } : {}),
      ...(num(talent.tier) !== undefined ? { tier: num(talent.tier) } : {}),
      ...(num(talent.column) !== undefined ? { column: num(talent.column) } : {}),
      ...(num(talent.currentRank) !== undefined ? { currentRank: num(talent.currentRank) } : {}),
      ...(num(talent.maxRank) !== undefined ? { maxRank: num(talent.maxRank) } : {}),
    }]);
    return [{
      tab, ...(str(tree.name) ? { name: str(tree.name) } : {}), ...(num(tree.pointsSpent) !== undefined ? { pointsSpent: num(tree.pointsSpent) } : {}),
      talentCoverage: str(tree.talentCoverage) ?? "UNKNOWN",
      // Unspent ranks are noise for most questions; the full list is returned only on request.
      talents: options.includeTalents ? talents : talents.filter((talent) => (talent.currentRank ?? 0) > 0),
    }];
  }).sort((a, b) => a.tab - b.tab);
  const complete = trees.length > 0 && trees.every((tree) => tree.pointsSpent !== undefined);
  return {
    ...head,
    trees,
    ...(complete ? { distribution: trees.map((tree) => tree.pointsSpent).join("/"), totalPointsSpent: trees.reduce((sum, tree) => sum + tree.pointsSpent!, 0) } : {}),
    semantics: "Legacy talent tabs and ranks as returned by the client. distribution is DERIVED from pointsSpent. Talents with rank 0 are omitted unless includeTalents is requested. Spec role, gear fit, and optimality are not inferred.",
  };
}
