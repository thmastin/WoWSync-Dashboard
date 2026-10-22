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
  /** "Alliance" or "Horde": vendors and quests of the other faction are not offered as sources. */
  faction?: string,
): Map<number, RecipeLearnSource> {
  const result = new Map<number, RecipeLearnSource>();
  const side = faction?.toUpperCase().startsWith("H") ? "H" : faction?.toUpperCase().startsWith("A") ? "A" : undefined;
  const allianceBits = [1, 4, 8, 64], hordeBits = [2, 16, 32, 128];
  const questUsable = (races: number | undefined) => {
    if (!side || !races) return true;
    const bits = side === "A" ? allianceBits : hordeBits;
    return bits.some((bit) => Math.floor(races / bit) % 2 === 1);
  };
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
      // Sources the character's faction can use; other-faction vendors and quests are summarized, not offered.
      const vendors = bundleItem?.vendors ?? [];
      const usableVendors = vendors.filter((npc) => { const friendly = index.npc(npc)?.friendly; return !side || !friendly || friendly.includes(side); });
      const quests = bundleItem?.questRewards ?? [];
      const usableQuests = quests.filter((quest) => questUsable(index.quest(quest)?.races));
      const obtainedFrom = [
        ...usableVendors.slice(0, 3).map((npc) => `sold by ${index.npcLocation(index.npc(npc)) ?? `npc ${npc}`}`),
        ...(bundleItem?.dropNpcs ?? []).slice(0, 3).map((npc) => { const n = index.npc(npc); return `drops from ${n?.name ?? `npc ${npc}`}${n?.zone ? ` in ${index.zoneName(n.zone)}` : ""}`; }),
        ...usableQuests.slice(0, 2).map((quest) => `reward from "${index.quest(quest)?.name ?? `quest ${quest}`}"`),
        ...((vendors.length > usableVendors.length || quests.length > usableQuests.length) && !usableVendors.length && !usableQuests.length && !(bundleItem?.dropNpcs ?? []).length
          ? ["other faction only (Auction House or a cross-faction trade)"] : []),
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
