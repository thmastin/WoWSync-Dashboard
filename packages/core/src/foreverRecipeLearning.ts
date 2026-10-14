// The profession skill at which a Forever recipe can be learned, and where it comes from. Two sources:
//   - TRAINER_OBSERVED: a profession trainer window the player opened ("Requires <Profession> (N)", cost).
//   - PATTERN_TOOLTIP: a pattern/plan/recipe/formula item in the Forever database whose tooltip says
//     "Requires <Profession> (N)"; matched to the recipe by name within the same profession (DERIVED match).
// The client's recipe rows do not carry a learn rank (maxTrivialLevel is the grey point, not the learn point),
// so recipes taught only by trainers stay UNKNOWN until their trainer tier has been seen.
import type { ForeverKnowledgeIndex } from "./foreverKnowledgeBundle.ts";
import type { ForeverTrainerVisit } from "./foreverTrainer.ts";

export interface RecipeLearnSource {
  rank: number;
  basis: "TRAINER_OBSERVED" | "PATTERN_TOOLTIP";
  costCopper?: number;
  observedAt?: number;
  /** For PATTERN_TOOLTIP: the item that teaches it and where QuestieDB says it comes from. */
  item?: { id: number; name: string };
  obtainedFrom?: string[];
}

const PATTERN_PREFIX = /^(Pattern|Plans|Recipe|Formula|Schematic|Manual|Design|Technique):\s*/i;
const norm = (value: string) => value.trim().toLowerCase();

/** Learn rank by recipe ID for one profession's recipes. Trainer observations win over pattern data. */
export function recipeLearnSkills(
  profession: string,
  recipes: Array<{ recipeID: number; name: string }>,
  trainerVisits: ForeverTrainerVisit[],
  index?: ForeverKnowledgeIndex,
): Map<number, RecipeLearnSource> {
  const result = new Map<number, RecipeLearnSource>();
  const byName = new Map<string, number[]>();
  for (const recipe of recipes) byName.set(norm(recipe.name), [...(byName.get(norm(recipe.name)) ?? []), recipe.recipeID]);

  if (index) {
    for (const [id, recipeItem] of Object.entries(index.bundle.recipeItems)) {
      if (recipeItem.profession !== profession || !Number.isFinite(recipeItem.skill)) continue;
      const itemId = Number(id);
      const itemName = index.tooltipItem(itemId)?.name ?? index.item(itemId)?.name;
      const candidates = [itemName?.replace(PATTERN_PREFIX, ""), recipeItem.teaches].filter((name): name is string => !!name);
      const recipeIds = candidates.flatMap((name) => byName.get(norm(name)) ?? []);
      if (!recipeIds.length || !itemName) continue;
      const bundleItem = index.item(itemId);
      const obtainedFrom = [
        ...(bundleItem?.vendors ?? []).slice(0, 3).map((npc) => { const n = index.npc(npc); return `sold by ${index.npcLocation(n) ?? `npc ${npc}`}${n?.friendly ? ` (${n.friendly.replace("A", "Alliance ").replace("H", "Horde").trim()})` : ""}`; }),
        ...(bundleItem?.dropNpcs ?? []).slice(0, 3).map((npc) => { const n = index.npc(npc); return `drops from ${n?.name ?? `npc ${npc}`}${n?.zone ? ` in ${index.zoneName(n.zone)}` : ""}`; }),
        ...(bundleItem?.questRewards ?? []).slice(0, 2).map((quest) => `reward from "${index.quest(quest)?.name ?? `quest ${quest}`}"`),
      ];
      for (const recipeID of new Set(recipeIds)) {
        const existing = result.get(recipeID);
        if (!existing || recipeItem.skill < existing.rank) result.set(recipeID, { rank: recipeItem.skill, basis: "PATTERN_TOOLTIP", item: { id: itemId, name: itemName }, obtainedFrom });
      }
    }
  }

  for (const visit of trainerVisits) {
    if (visit.kind !== profession) continue;
    for (const service of visit.services) {
      const rank = service.skillRequirement?.rank;
      if (rank === undefined || (service.skillRequirement?.skill && service.skillRequirement.skill !== profession)) continue;
      for (const recipeID of byName.get(norm(service.name)) ?? []) {
        result.set(recipeID, { rank, basis: "TRAINER_OBSERVED", ...(service.costCopper !== undefined ? { costCopper: service.costCopper } : {}), ...(visit.observedAt !== undefined ? { observedAt: visit.observedAt } : {}) });
      }
    }
  }
  return result;
}
