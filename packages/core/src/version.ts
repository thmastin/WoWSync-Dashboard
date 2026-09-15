// Routes a parsed snapshot into a version-isolated account space.
//
// WOWSYNC v1 does not currently render a "ClientFamily" field for Classic
// Era or TBC Anniversary (see WOWSYNC_SCHEMA.md, "Additive Retail fields") —
// only Retail sets it. So routing falls back to the client version number,
// which matches Blizzard's own client numbering:
//   Classic Era     -> 1.x   (e.g. 1.15.7)
//   TBC Anniversary -> 2.x   (e.g. 2.5.6)
//   Retail          -> ClientFamily: Retail (also 11.x/12.x version numbers)
//
// A client we can't confidently place is routed to UNKNOWN_VERSION and
// quarantined rather than guessed — never silently aggregated with a real
// version space.

import { UNKNOWN_VERSION, type CharacterSection, type VersionOrUnknown } from "./types.ts";

export function detectVersion(character: CharacterSection): VersionOrUnknown {
  if (character.clientFamily) {
    const family = character.clientFamily.toLowerCase();
    if (family === "retail") return "retail";
    return UNKNOWN_VERSION;
  }
  const version = character.clientVersion;
  if (!version) return UNKNOWN_VERSION;
  const major = version.split(".")[0];
  if (major === "1") return "classic-era";
  if (major === "2") return "tbc-anniversary";
  // Retail is identified solely by ClientFamily (see above) — a bare version
  // number is not enough evidence to route into Retail's data space.
  return UNKNOWN_VERSION;
}

export const WOW_VERSIONS = ["classic-era", "tbc-anniversary", "retail"] as const;

export const VERSION_LABELS: Record<string, string> = {
  "classic-era": "Classic Era",
  "tbc-anniversary": "TBC Anniversary",
  retail: "Retail",
  [UNKNOWN_VERSION]: "Unrouted / Unknown",
};
