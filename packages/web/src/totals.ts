// How an aggregate total is worded, so it never overstates what is known:
//
//   - no contributor observed        -> "?"  (never "0c" / "0m")
//   - a known 0 (observed at 0)      -> the real zero
//   - stale contributors             -> stated, with how old the oldest one is
//   - unobserved characters          -> stated as excluded, never counted as 0
//
// "Stale" is an OBSERVED AGE against the project's existing fixed freshness
// window (core/src/freshness.ts) - a plain fact about the contributions, not a
// judgement. The counts and timestamps come straight from AccountFacts; nothing
// here re-derives freshness.
import { RECENT_THRESHOLD_SECONDS } from "@wowsync-dashboard/core/freshness.ts";
import { formatCopper, formatPlaytime } from "./format.ts";
import type { GoldFacts, PlaytimeFacts } from "./types.ts";

export interface TotalDescription {
  /** What to show as the headline value: the formatted total, or "?" when nothing was observed. */
  value: string;
  /** False when `value` is the "?" placeholder. */
  known: boolean;
  /** Plain-language basis: how many characters it covers, what was excluded, how old it is. Always present. */
  basis: string;
  /** True when the total leans on stale contributions (worth visual emphasis). */
  hasStale: boolean;
}

const STALE_DAYS = Math.round(RECENT_THRESHOLD_SECONDS / 86400);

/** "5 min", "3 h", "12 d" - a coarse age, never rounded up to look fresher than it is. */
export function formatAge(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86400)} d`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function basisLine(nouns: string, known: number, unknown: number, stale: number, oldestObservedAt: number | undefined, now: number): string {
  if (known === 0) {
    return unknown > 0 ? `${nouns} not observed for ${plural(unknown, "character")}` : "no characters yet";
  }
  const parts = [`from ${plural(known, "character")}`];
  if (unknown > 0) parts.push(`${unknown} not observed (not counted)`);
  if (stale > 0) parts.push(`${stale} last synced over ${STALE_DAYS} d ago`);
  if (oldestObservedAt !== undefined) parts.push(`oldest data ${formatAge(now - oldestObservedAt)} old`);
  return parts.join(" · ");
}

/** `now` is the facts' own generation time (unix seconds) - never the wall clock, so the wording is deterministic. */
export function describeGoldTotal(gold: GoldFacts, now: number): TotalDescription {
  const known = gold.charactersWithKnownGold > 0;
  return {
    value: known ? formatCopper(gold.totalKnownCopper) : "?",
    known,
    basis: basisLine("gold", gold.charactersWithKnownGold, gold.charactersWithUnknownGold, gold.staleCharactersWithKnownGold, gold.oldestKnownGoldObservedAt, now),
    hasStale: known && gold.staleCharactersWithKnownGold > 0,
  };
}

export function describePlaytimeTotal(playtime: PlaytimeFacts, characterCount: number, now: number): TotalDescription {
  const known = playtime.charactersWithKnownPlaytime > 0;
  return {
    value: known ? formatPlaytime(playtime.totalKnownPlayedSeconds) : "?",
    known,
    basis: basisLine(
      "/played",
      playtime.charactersWithKnownPlaytime,
      characterCount - playtime.charactersWithKnownPlaytime,
      playtime.staleCharactersWithKnownPlaytime,
      playtime.oldestKnownPlaytimeObservedAt,
      now,
    ),
    hasStale: known && playtime.staleCharactersWithKnownPlaytime > 0,
  };
}
