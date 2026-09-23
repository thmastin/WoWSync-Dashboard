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

/**
 * Newest-first Retail profession expansion names (and common tier labels that
 * name the same era). Matching is case-insensitive substring against
 * expansion or tier strings from the export. Update when a new expansion ships.
 */
export const RETAIL_PROFESSION_EXPANSION_RANK = [
  "Midnight",
  "The War Within",
  "Khaz Algar",
  "Dragonflight",
  "Dragon Isles",
  "Shadowlands",
  "Battle for Azeroth",
  "Legion",
  "Warlords of Draenor",
  "Mists of Pandaria",
  "Cataclysm",
  "Wrath of the Lich King",
  "The Burning Crusade",
  "Classic",
] as const;

/** Planning target for Retail account coverage. Bump when a new expansion ships. */
export const CURRENT_RETAIL_PROFESSION_EXPANSION = "Midnight";

/** Extra substrings that imply a ranked expansion (tier names like Kul Tiran). */
const RETAIL_EXPANSION_ALIASES: Readonly<Record<string, readonly string[]>> = {
  "Battle for Azeroth": ["kul tiran", "zandalari", "bfa"],
  "Warlords of Draenor": ["draenor", "wod"],
  "Mists of Pandaria": ["pandaria", "mop"],
  "Wrath of the Lich King": ["northrend", "wrath", "wotlk"],
  "The Burning Crusade": ["burning crusade", "outland", "tbc"],
  "The War Within": ["war within", "tww"],
  Dragonflight: ["df"],
};

function matchTokensForExpansion(name: string): string[] {
  const tokens = [name.toLowerCase()];
  const aliases = RETAIL_EXPANSION_ALIASES[name];
  if (aliases) {
    for (const a of aliases) tokens.push(a.toLowerCase());
  }
  return tokens;
}

/**
 * Higher = newer Retail profession expansion. Unknown / missing / literal
 * "Unknown" => -1.
 */
export function expansionRank(label?: string): number {
  if (label === undefined || label === null) return -1;
  const hay = String(label).trim().toLowerCase();
  if (!hay || hay === "unknown") return -1;
  let best = -1;
  const n = RETAIL_PROFESSION_EXPANSION_RANK.length;
  for (let i = 0; i < n; i++) {
    const name = RETAIL_PROFESSION_EXPANSION_RANK[i];
    const rankValue = n - i;
    for (const token of matchTokensForExpansion(name)) {
      if (hay.includes(token)) {
        if (rankValue > best) best = rankValue;
      }
    }
  }
  return best;
}

/** Canonical ranked name if label matches one, else undefined. */
export function matchedRetailExpansionName(label?: string): string | undefined {
  if (label === undefined || label === null) return undefined;
  const hay = String(label).trim().toLowerCase();
  if (!hay || hay === "unknown") return undefined;
  let bestName: string | undefined;
  let best = -1;
  const n = RETAIL_PROFESSION_EXPANSION_RANK.length;
  for (let i = 0; i < n; i++) {
    const name = RETAIL_PROFESSION_EXPANSION_RANK[i];
    const rankValue = n - i;
    for (const token of matchTokensForExpansion(name)) {
      if (hay.includes(token) && rankValue > best) {
        best = rankValue;
        bestName = name;
      }
    }
  }
  return bestName;
}

export function characterExpansionRank(c: { expansion?: string; tier?: string }): number {
  return Math.max(expansionRank(c.expansion), expansionRank(c.tier));
}

/**
 * True when expansion or tier indicates the current Retail planning target
 * (substring / case-insensitive match on CURRENT_RETAIL_PROFESSION_EXPANSION).
 */
export function characterHasCurrentRetailExpansion(c: {
  expansion?: string;
  tier?: string;
}): boolean {
  const needle = CURRENT_RETAIL_PROFESSION_EXPANSION.toLowerCase();
  const exp = c.expansion?.toLowerCase() ?? "";
  const tier = c.tier?.toLowerCase() ?? "";
  return exp.includes(needle) || tier.includes(needle);
}

export type RetailProfessionPlanningClass =
  | "currentCovered"
  | "olderOnly"
  | "none"
  | "unknown";

/**
 * Classify a coverage row for Retail Midnight planning.
 * coverageStatus none/unknown unchanged; covered splits into current vs older-only.
 */
export function classifyRetailProfessionCoverage(entry: {
  coverageStatus: "covered" | "none" | "unknown";
  characters: readonly { expansion?: string; tier?: string }[];
}): RetailProfessionPlanningClass {
  if (entry.coverageStatus === "none") return "none";
  if (entry.coverageStatus === "unknown") return "unknown";
  if (entry.characters.some(characterHasCurrentRetailExpansion)) return "currentCovered";
  return "olderOnly";
}

/** Best display label for the highest-ranked expansion among holders. */
export function highestProfessionExpansionLabel(
  characters: readonly { expansion?: string; tier?: string }[],
): string | undefined {
  let bestRank = -1;
  let bestLabel: string | undefined;
  for (const c of characters) {
    for (const raw of [c.expansion, c.tier]) {
      if (!raw) continue;
      const rank = expansionRank(raw);
      if (rank > bestRank) {
        bestRank = rank;
        bestLabel = matchedRetailExpansionName(raw) ?? raw;
      }
    }
  }
  return bestLabel;
}

/** Minimal character skill fields used to pick a covered-row primary. */
export type ProfessionCharacterSkill = {
  identityKey: string;
  name: string;
  skill?: number;
  maxSkill?: number;
  expansion?: string;
  tier?: string;
};

/**
 * Primary character for a covered profession: highest expansionRank
 * (expansion or tier), then skill, then maxSkill, then name.
 * Undefined skill/maxSkill sort last (never as 0). Not a saved designation.
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
  const byExpansion = characterExpansionRank(b) - characterExpansionRank(a);
  if (byExpansion !== 0) return byExpansion;
  const bySkill = compareOptionalNumberDesc(a.skill, b.skill);
  if (bySkill !== 0) return bySkill;
  const byMax = compareOptionalNumberDesc(a.maxSkill, b.maxSkill);
  if (byMax !== 0) return byMax;
  return a.name.localeCompare(b.name);
}