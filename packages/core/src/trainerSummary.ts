// Trainer presentation summarization. STORE EVERYTHING, SURFACE WHAT
// MATTERS, ALLOW DRILL-DOWN: this never discards a TrainerService — it
// only classifies/groups the existing services array for a compact
// default view. The raw `services` array on TrainerCategorySnapshot
// remains untouched and fully available for drill-down.
//
// Real Voodan (TBC Anniversary) data drove this: a single class trainer
// visit can carry 250+ observed "unavailable" services, which is useless
// as a flat list but very useful grouped by requiredLevel.

import type { TrainerCategorySnapshot, TrainerService } from "./types.ts";

export interface SummarizedAbility {
  ability?: string;
  rank?: string;
  requiredLevel?: number;
  costCopper?: number;
  requirementsAtVisit?: string;
}

export interface RequiredLevelGroup {
  requiredLevel: number;
  abilities: SummarizedAbility[];
  /** Sum of known costs in this group; undefined if none had a known cost. */
  totalCostCopper?: number;
  /** True if at least one ability in this group has an unknown cost, so totalCostCopper is a partial sum. */
  costPartial: boolean;
}

export interface NextTraining {
  requiredLevel: number;
  abilityCount: number;
  totalCostCopper?: number;
  costPartial: boolean;
}

export interface TrainerCategorySummary {
  category: string;
  /** Abilities whose observed statusAtVisit is literally "available". */
  available: SummarizedAbility[];
  /** Abilities already known by the character (statusAtVisit === "known"), shown only as a count by default. */
  known: SummarizedAbility[];
  /** Everything else (typically "unavailable"), grouped by a known numeric requiredLevel, ascending. */
  upcomingByLevel: RequiredLevelGroup[];
  /** Same bucket as upcomingByLevel, but requiredLevel was missing/unparseable — never guessed. */
  unknownUnlockLevel: SummarizedAbility[];
  /** The lowest-level upcoming group, if any. Never invented — absent if no group has a known level. */
  nextTraining?: NextTraining;
  totalServices: number;
}

/**
 * Parses a trainer service's requiredLevel field into a number. Only a
 * literal non-negative integer is accepted; anything else (missing, "?",
 * non-numeric text) is treated as genuinely unknown. Never inferred from
 * spell ID, rank, character level, or ordering.
 */
export function parseRequiredLevel(requiredLevel: string | undefined): number | undefined {
  if (requiredLevel === undefined) return undefined;
  if (!/^\d+$/.test(requiredLevel)) return undefined;
  return Number(requiredLevel);
}

function toSummarizedAbility(service: TrainerService): SummarizedAbility {
  return {
    ability: service.ability,
    rank: service.rank,
    requiredLevel: parseRequiredLevel(service.requiredLevel),
    costCopper: service.costCopper,
    requirementsAtVisit: service.requirementsAtVisit,
  };
}

export function summarizeTrainerCategory(category: TrainerCategorySnapshot): TrainerCategorySummary {
  const available: SummarizedAbility[] = [];
  const known: SummarizedAbility[] = [];
  const groups = new Map<number, SummarizedAbility[]>();
  const unknownUnlockLevel: SummarizedAbility[] = [];

  for (const service of category.services) {
    const status = service.statusAtVisit?.toLowerCase();
    const summarized = toSummarizedAbility(service);
    if (status === "available") {
      available.push(summarized);
      continue;
    }
    if (status === "known") {
      known.push(summarized);
      continue;
    }
    // Anything else (typically "unavailable", or any status we don't
    // specifically recognize) is treated as not-yet-trainable. Never
    // upgraded to "available" just because it's an unrecognized word.
    if (summarized.requiredLevel !== undefined) {
      const list = groups.get(summarized.requiredLevel) ?? [];
      list.push(summarized);
      groups.set(summarized.requiredLevel, list);
    } else {
      unknownUnlockLevel.push(summarized);
    }
  }

  const upcomingByLevel: RequiredLevelGroup[] = [...groups.entries()]
    .sort(([a], [b]) => a - b)
    .map(([requiredLevel, abilities]) => {
      const knownCosts = abilities.filter((a) => a.costCopper !== undefined);
      const totalCostCopper = knownCosts.length > 0 ? knownCosts.reduce((sum, a) => sum + (a.costCopper ?? 0), 0) : undefined;
      return {
        requiredLevel,
        abilities,
        totalCostCopper,
        costPartial: knownCosts.length > 0 && knownCosts.length < abilities.length,
      };
    });

  const nextTraining: NextTraining | undefined =
    upcomingByLevel.length > 0
      ? {
          requiredLevel: upcomingByLevel[0].requiredLevel,
          abilityCount: upcomingByLevel[0].abilities.length,
          totalCostCopper: upcomingByLevel[0].totalCostCopper,
          costPartial: upcomingByLevel[0].costPartial,
        }
      : undefined;

  return {
    category: category.category,
    available,
    known,
    upcomingByLevel,
    unknownUnlockLevel,
    nextTraining,
    totalServices: category.services.length,
  };
}
