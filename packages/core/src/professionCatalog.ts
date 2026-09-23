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
//
// `forever` ALSO intentionally has no catalog, for a different reason:
// Forever is a distinct, still-evolving ruleset (beta), not a frozen
// Classic Era/TBC one, and its addon exports only the "player profession
// enums" C_TradeSkillUI reports (no Cooking/Fishing/First Aid rows were
// observed). Applying the Classic/TBC list would assert "nobody has
// Cooking" (status "none") for a profession the Forever export cannot
// even observe. So Forever coverage is built purely from what imported
// exports actually contain, and a profession absent from every export is
// simply not listed — never reported as "none".
//
// Forever also needs a per-entry evidence rule (professionEntryIsEvidence
// below): its addon lists every player profession enum, reporting the ones
// the character has not learned as skill 0 / maxSkill 0.

import type { ProfessionEntry, VersionOrUnknown } from "./types.ts";

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
    case "forever":
      return []; // see the "forever" note in the file header
    default:
      return [];
  }
}

/**
 * Whether an observed profession entry is positive evidence that the
 * character actually has that profession.
 *
 * Classic Era / TBC Anniversary / Retail exports only list professions the
 * character has, so any entry counts (unchanged behavior).
 *
 * Forever's addon lists every player profession enum returned by
 * C_TradeSkillUI, and reports skill 0 / maxSkill 0 both for a profession
 * the character has not learned AND, per the addon's own docs
 * (FOREVER_PROFESSIONS.md), possibly for one whose data has not hydrated
 * yet — the API exposes nothing to tell those apart. A 0/0 entry is
 * therefore neither "has it" nor "confirmed does not have it": it is
 * indeterminate. Only a positive skill or maxSkill is evidence. (Unknown
 * skill values are never evidence either: `undefined > 0` is false.)
 */
export function professionEntryIsEvidence(
  version: VersionOrUnknown,
  entry: Pick<ProfessionEntry, "skill" | "maxSkill">,
): boolean {
  if (version !== "forever") return true;
  return (entry.skill ?? 0) > 0 || (entry.maxSkill ?? 0) > 0;
}

export type ProfessionPlanningKind = "crafting" | "gathering";

const GATHERING_PROFESSIONS = new Set([
  "herbalism",
  "mining",
  "skinning",
  "fishing",
]);

/**
 * Planning bucket for AccountProfessions UI (Crafting vs Gathering).
 * Case-insensitive match on profession name. Unknown Forever observation-only
 * names default to crafting so the UI stays two sections (not a third Other).
 */
export function professionPlanningKind(name: string): ProfessionPlanningKind {
  const key = name.trim().toLowerCase();
  if (GATHERING_PROFESSIONS.has(key)) return "gathering";
  return "crafting";
}

/** Minimal character skill fields used to pick a covered-row primary. */
export type ProfessionCharacterSkill = {
  identityKey: string;
  name: string;
  skill?: number;
  maxSkill?: number;
};

/**
 * Primary character for a covered profession: highest observed skill;
 * undefined skill sorts last (never as 0). Tie-break: higher maxSkill
 * (undefined last), then name localeCompare. Not a saved designation.
 */
export function selectPrimaryProfessionCharacter<T extends ProfessionCharacterSkill>(
  characters: readonly T[],
): T | undefined {
  if (characters.length === 0) return undefined;
  return characters.slice().sort(compareProfessionCharacterPrimary)[0];
}

function compareOptionalNumberDesc(a: number | undefined, b: number | undefined): number {
  const aMissing = a === undefined;
  const bMissing = b === undefined;
  if (aMissing && bMissing) return 0;
  if (aMissing) return 1;
  if (bMissing) return -1;
  return b - a;
}

function compareProfessionCharacterPrimary(
  a: ProfessionCharacterSkill,
  b: ProfessionCharacterSkill,
): number {
  const bySkill = compareOptionalNumberDesc(a.skill, b.skill);
  if (bySkill !== 0) return bySkill;
  const byMax = compareOptionalNumberDesc(a.maxSkill, b.maxSkill);
  if (byMax !== 0) return byMax;
  return a.name.localeCompare(b.name);
}

