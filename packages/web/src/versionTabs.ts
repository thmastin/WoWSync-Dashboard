// Version-tab helpers (product review N7).
// Tabs show character count + freshness from /api/versions lastUpdatedAt.
// Default version prefers last-used localStorage, else newest observation,
// else first non-empty version, else retail. Never defaults to unknown-version.

import { classifyFreshness, type Freshness } from "@wowsync-dashboard/core/freshness.ts";
import type { VersionOrUnknown } from "./types.ts";
import { WOW_VERSIONS } from "./versions.ts";

/** Minimal shape from GET /api/versions (VersionSummary). */
export type VersionTabSummary = {
  version: VersionOrUnknown;
  characterCount: number;
  lastUpdatedAt?: number;
};

const KNOWN = WOW_VERSIONS as readonly string[];

function isKnownVersion(value: string): value is VersionOrUnknown {
  return KNOWN.includes(value);
}

/**
 * Pick the version to land on when the hash is empty / no valid stored preference.
 * - Valid stored WOW_VERSIONS entry wins.
 * - Else max lastUpdatedAt among known versions that have one.
 * - Else first known version with characterCount > 0 (WOW_VERSIONS order).
 * - Else "retail". Never returns unknown-version.
 */
export function pickDefaultVersion(
  summaries: readonly VersionTabSummary[],
  stored?: string | null,
): VersionOrUnknown {
  if (stored && isKnownVersion(stored)) return stored;

  const known = summaries.filter((s) => isKnownVersion(s.version));

  let freshest: VersionTabSummary | undefined;
  for (const s of known) {
    if (s.lastUpdatedAt === undefined) continue;
    if (freshest === undefined || freshest.lastUpdatedAt === undefined || s.lastUpdatedAt > freshest.lastUpdatedAt) {
      freshest = s;
    }
  }
  if (freshest) return freshest.version;

  const withChars = known.find((s) => s.characterCount > 0);
  if (withChars) return withChars.version;

  return "retail";
}

export type VersionTabMeta = {
  count: number;
  freshness: Freshness;
};

/** Count + freshness for one version tab. Missing summary => 0 / unknown. */
export function versionTabMeta(summary: VersionTabSummary | undefined, nowSeconds: number): VersionTabMeta {
  return {
    count: summary?.characterCount ?? 0,
    freshness: classifyFreshness(summary?.lastUpdatedAt, nowSeconds),
  };
}