// Freshness convention: WoWSync snapshots are point-in-time observations,
// not live data. A character's dashboard state is only ever as current as
// its most recent snapshot, so the UI must make that age obvious rather
// than presenting stale data as if it were live.
//
// Convention (documented here as the single source of truth):
//   - "recent": most recent observation is within RECENT_THRESHOLD_SECONDS
//   - "stale":  a snapshot exists, but it's older than that
//   - "unknown": no snapshot/timestamp exists at all
//
// `now` is always passed in explicitly — never read from the system clock
// inside this module — so freshness classification stays deterministic
// and testable with a fixed reference time.

export type Freshness = "recent" | "stale" | "unknown";

/** 3 days. Chosen because WoW play sessions are typically not daily; a
 * character not seen in 3+ days is reasonably "stale" for a personal
 * account-tracking tool, without being so short that a normal week of not
 * logging in on one alt looks alarming. */
export const RECENT_THRESHOLD_SECONDS = 3 * 24 * 60 * 60;

export function classifyFreshness(lastObservedAtSeconds: number | undefined, nowSeconds: number): Freshness {
  if (lastObservedAtSeconds === undefined) return "unknown";
  const ageSeconds = nowSeconds - lastObservedAtSeconds;
  if (ageSeconds < 0) return "recent"; // clock skew / future timestamp guard
  return ageSeconds <= RECENT_THRESHOLD_SECONDS ? "recent" : "stale";
}
