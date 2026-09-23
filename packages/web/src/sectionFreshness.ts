// Per-section observation age for the character page (N6 remainder).
// Sections already badge OBSERVED / LAST_SEEN / UNKNOWN; this surfaces the
// timestamps the parser already carries so LAST_SEEN is never read as current.
// observedAt is preferred; lastVisit is the bank/trainer fallback (same as facts).

import { formatAgeSeconds } from "./format.ts";

export type SectionStatusLike = {
  state: string;
  observedAt?: number;
  lastVisit?: number;
};

/** Section observation time: observedAt, else lastVisit. */
export function sectionObservationAt(status: SectionStatusLike): number | undefined {
  return status.observedAt ?? status.lastVisit;
}

export type SectionFreshnessCaption = {
  /** Relative age phrase, e.g. "as of 9d ago" or "observed 2h ago". */
  text: string;
  /** Epoch seconds the caption refers to. */
  at: number;
};

/**
 * Display caption for a section's observation time.
 * UNKNOWN -> null (UI keeps "Never observed.").
 * LAST_SEEN with a timestamp -> "as of ..." (never presented as current).
 * OBSERVED with a timestamp -> "observed ...".
 * Known state but no timestamp -> null (badge alone).
 */
export function sectionFreshnessCaption(
  status: SectionStatusLike,
  nowSeconds: number,
): SectionFreshnessCaption | null {
  if (status.state === "UNKNOWN") return null;
  const at = sectionObservationAt(status);
  if (at === undefined) return null;
  const age = formatAgeSeconds(nowSeconds - at);
  if (status.state === "LAST_SEEN") {
    return { text: `as of ${age}`, at };
  }
  return { text: `observed ${age}`, at };
}