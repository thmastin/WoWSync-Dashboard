// A version-aware profession catalog: the complete set of primary +
// secondary professions that actually exist in each WoW version's ruleset.
// This is a code constant, not a database table or an inference — Classic
// Era and TBC Anniversary are frozen rulesets (not moving targets), so
// their lists are stable and safe to hardcode. It exists specifically so
// AccountFacts can say "nobody has Alchemy" (a real fact, derived from
// observing every relevant character) rather than just silently omitting
// Alchemy because nobody happens to have it.
//
// Deliberately excluded per version (not oversights):
//   - Jewelcrafting: added in TBC, not in Classic Era.
//   - Inscription: added in Wrath of the Lich King, not in Classic Era or TBC.
//   - Archaeology: added in Cataclysm.
//   - First Aid: removed from modern Retail (also consistent with real
//     Ezaller/Stoneharry captures, neither of which has it).
//
// `unknown-version` intentionally has no catalog: we don't know enough
// about an unrecognized client to assert "nobody has profession X" as a
// fact, so coverage for that version falls back to "only show what was
// actually observed" (see accountFacts.ts's professionCatalogForVersion).

import type { VersionOrUnknown } from "./types.ts";

const CLASSIC_ERA_PROFESSIONS = [
  "Alchemy",
  "Blacksmithing",
  "Cooking",
  "Enchanting",
  "Engineering",
  "First Aid",
  "Fishing",
  "Herbalism",
  "Leatherworking",
  "Mining",
  "Skinning",
  "Tailoring",
];

const TBC_ANNIVERSARY_PROFESSIONS = [...CLASSIC_ERA_PROFESSIONS, "Jewelcrafting"];

const RETAIL_PROFESSIONS = [
  "Alchemy",
  "Blacksmithing",
  "Cooking",
  "Enchanting",
  "Engineering",
  "Fishing",
  "Herbalism",
  "Inscription",
  "Jewelcrafting",
  "Leatherworking",
  "Mining",
  "Skinning",
  "Tailoring",
];

export function professionCatalogForVersion(version: VersionOrUnknown): string[] {
  switch (version) {
    case "classic-era":
      return CLASSIC_ERA_PROFESSIONS;
    case "tbc-anniversary":
      return TBC_ANNIVERSARY_PROFESSIONS;
    case "retail":
      return RETAIL_PROFESSIONS;
    default:
      return [];
  }
}
