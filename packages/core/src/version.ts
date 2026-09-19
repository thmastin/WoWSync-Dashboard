// Routes a parsed snapshot into a version-isolated account space.
//
// WOWSYNC v1 does not currently render a "ClientFamily" field for Classic
// Era or TBC Anniversary (see WOWSYNC_SCHEMA.md, "Additive Retail fields") —
// only Retail and Forever set it. So routing falls back to the client
// version number, which matches Blizzard's own client numbering:
//   Classic Era     -> 1.x   (e.g. 1.15.7)
//   TBC Anniversary -> 2.x   (e.g. 2.5.6)
//   Retail          -> ClientFamily: Retail (also 11.x/12.x version numbers)
//   Forever         -> ClientFamily: Forever (e.g. 1.60.1, wow_classic_beta)
//
// Forever's client number (1.60.1) starts with "1" just like Classic Era's
// (1.15.x), which is exactly why ClientFamily is checked FIRST and the
// bare-version fallback is never allowed to claim a family-tagged client:
// a Forever export must never be silently routed into Classic Era.
//
// A client we can't confidently place is routed to UNKNOWN_VERSION and
// quarantined rather than guessed — never silently aggregated with a real
// version space.

import { UNKNOWN_VERSION, type CharacterSection, type VersionOrUnknown, type WowVersion } from "./types.ts";

/** ClientFamily values (lowercased) that identify a version on their own, without relying on a version number. */
const CLIENT_FAMILY_VERSIONS: Record<string, WowVersion> = {
  retail: "retail",
  forever: "forever",
};

export function detectVersion(character: CharacterSection): VersionOrUnknown {
  if (character.clientFamily) {
    return CLIENT_FAMILY_VERSIONS[character.clientFamily.toLowerCase()] ?? UNKNOWN_VERSION;
  }
  const version = character.clientVersion;
  if (!version) return UNKNOWN_VERSION;
  const major = version.split(".")[0];
  if (major === "1") return "classic-era";
  if (major === "2") return "tbc-anniversary";
  // Retail/Forever are identified solely by ClientFamily (see above) — a
  // bare version number is not enough evidence to route into their data
  // spaces.
  return UNKNOWN_VERSION;
}

/** Every real (routable) WoW version space, in display order. The single source of truth: the store, AccountContext, and the API all iterate this rather than repeating the list. */
export const WOW_VERSIONS: readonly WowVersion[] = ["classic-era", "tbc-anniversary", "retail", "forever"];

// Typed as Record<VersionOrUnknown, string> (not Record<string, string>) so
// adding a WowVersion without a label is a compile error, not a silent gap.
export const VERSION_LABELS: Record<VersionOrUnknown, string> = {
  "classic-era": "Classic Era",
  "tbc-anniversary": "TBC Anniversary",
  retail: "Retail",
  forever: "Forever",
  [UNKNOWN_VERSION]: "Unrouted / Unknown",
};
