export type FoodDrinkKind = "FOOD" | "DRINK" | "BUFF_FOOD" | "UNKNOWN";

export interface MailBagSpaceConfig {
  /** At or below this many OBSERVED free slots, plans apply quantity caps. */
  lowFreeSlotThreshold?: number;
  /** Food/drink stack allowance grows by this many items per ten character levels. */
  foodPerTenLevels: number;
  minimumFoodQuantity: number;
  maximumFoodQuantity: number;
}

export const DEFAULT_MAIL_BAG_SPACE_CONFIG: Readonly<MailBagSpaceConfig> = Object.freeze({
  foodPerTenLevels: 5,
  minimumFoodQuantity: 5,
  maximumFoodQuantity: 20,
});

export function bagSpaceIsTight(freeSlots: number | undefined, totalSlots: number | undefined, config: MailBagSpaceConfig = DEFAULT_MAIL_BAG_SPACE_CONFIG): boolean {
  if (!Number.isSafeInteger(freeSlots) || freeSlots! < 0 || !Number.isSafeInteger(totalSlots) || totalSlots! < 0) return false;
  const threshold = config.lowFreeSlotThreshold ?? Math.max(8, Math.ceil(totalSlots! * 0.1));
  return freeSlots! <= threshold;
}

export function foodQuantityCap(level: number, config: MailBagSpaceConfig = DEFAULT_MAIL_BAG_SPACE_CONFIG): number | undefined {
  if (!Number.isSafeInteger(level) || level < 1) return undefined;
  const cap = Math.ceil(level / 10) * config.foodPerTenLevels;
  return Math.max(config.minimumFoodQuantity, Math.min(config.maximumFoodQuantity, cap));
}

export interface CookingRecipeFact {
  name: string;
  requiredSkill?: number;
  evidence?: "OBSERVED" | "LAST_SEEN" | "UNKNOWN";
  learnedState?: "OBSERVED_TRUE" | "OBSERVED_FALSE" | "UNKNOWN";
  reagents?: Array<{ itemId?: number; name?: string; count?: number; required?: number }>;
}

export interface CookingMaterialPlan {
  state: "KNOWN" | "UNKNOWN";
  keepQuantity: number | "UNKNOWN";
  excessQuantity: number | "UNKNOWN";
  nextRecipe?: string;
  reason: string;
}

export function cookingRecipeFacts(knowledge: any): { completeness: "complete" | "partial" | "unknown"; recipes: CookingRecipeFact[] } {
  const complete = knowledge?.completeness === "complete" && knowledge?.status?.state === "OBSERVED" && knowledge?.evidence?.state === "OBSERVED";
  const groups = knowledge?.data?.professions ?? [];
  const recipes: CookingRecipeFact[] = [];
  for (const group of groups) {
    if (String(group.professionName ?? group.name ?? "").toLocaleLowerCase() !== "cooking") continue;
    for (const recipe of group.recipes ?? []) {
      const reagents = [
        ...(recipe.reagents ?? []),
        ...(recipe.reagentSlots ?? []).filter((slot: any) => slot.required !== false).flatMap((slot: any) =>
          (slot.alternatives ?? slot.reagents ?? []).map((reagent: any) => ({ ...reagent, count: reagent.count ?? slot.quantityRequired }))),
      ].map((reagent: any) => ({ ...(typeof reagent.itemID === "number" ? { itemId: reagent.itemID } : {}), ...(typeof reagent.name === "string" ? { name: reagent.name } : {}), ...(typeof reagent.count === "number" ? { count: reagent.count } : typeof reagent.required === "number" ? { required: reagent.required } : {}) }));
      recipes.push({ name: String(recipe.name ?? "UNKNOWN recipe"), ...(typeof (recipe.requiredSkill ?? recipe.skillRequired) === "number" ? { requiredSkill: recipe.requiredSkill ?? recipe.skillRequired } : {}), evidence: recipe.evidence ?? group.evidence ?? "UNKNOWN", learnedState: recipe.learnedState === "OBSERVED_TRUE" || recipe.learned === true ? "OBSERVED_TRUE" : recipe.learnedState === "OBSERVED_FALSE" || recipe.learned === false ? "OBSERVED_FALSE" : "UNKNOWN", reagents });
    }
  }
  return { completeness: complete ? "complete" : knowledge?.completeness === "partial" ? "partial" : "unknown", recipes };
}

/** Finds the nearest observed, known Cooking recipe above current skill and sums its exact reagent need. */
export function planCookingMaterial(input: {
  itemId?: number;
  itemName?: string;
  quantity?: number;
  cookingSkill?: number;
  professionState: "OBSERVED" | "LAST_SEEN" | "UNKNOWN";
  recipeCompleteness: "complete" | "partial" | "unknown";
  recipes?: readonly CookingRecipeFact[];
  isCookingMaterial?: boolean;
}): CookingMaterialPlan | undefined {
  const normalize = (value: string) => value.toLocaleLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const matchesItem = (reagent: NonNullable<CookingRecipeFact["reagents"]>[number]) => input.itemId !== undefined && reagent.itemId !== undefined
    ? input.itemId === reagent.itemId
    : input.itemName !== undefined && reagent.name !== undefined && normalize(input.itemName) === normalize(reagent.name);
  const cookingReagentRecipes = input.recipes?.filter((recipe) => recipe.reagents?.some(matchesItem)) ?? [];
  const unknown = (): CookingMaterialPlan => ({ state: "UNKNOWN", keepQuantity: "UNKNOWN", excessQuantity: "UNKNOWN", reason: `Next Cooking goal is UNKNOWN; keep this cooking material${typeof input.quantity === "number" ? ` (quantity ${input.quantity})` : " (quantity UNKNOWN)"}.` });
  if (!cookingReagentRecipes.length) return input.isCookingMaterial && input.recipeCompleteness !== "complete" ? unknown() : undefined;
  if (input.professionState !== "OBSERVED" || input.recipeCompleteness !== "complete" || input.cookingSkill === undefined || !Number.isSafeInteger(input.cookingSkill) || !input.recipes || cookingReagentRecipes.some((recipe) => recipe.evidence !== "OBSERVED")) return unknown();
  const upcoming = input.recipes.filter((recipe) => recipe.learnedState === "OBSERVED_TRUE" && Number.isSafeInteger(recipe.requiredSkill) && recipe.requiredSkill! > input.cookingSkill!);
  if (!upcoming.length) return unknown();
  const nextSkill = Math.min(...upcoming.map((recipe) => recipe.requiredSkill!));
  const goals = upcoming.filter((recipe) => recipe.requiredSkill === nextSkill);
  if (goals.some((recipe) => recipe.evidence !== "OBSERVED" || recipe.learnedState !== "OBSERVED_TRUE")) return unknown();
  if (goals.some((recipe) => !Array.isArray(recipe.reagents) || recipe.reagents.some((reagent) => !Number.isSafeInteger(reagent.count ?? reagent.required) || (reagent.count ?? reagent.required)! < 1))) return unknown();
  const matchingReagents = goals.flatMap((recipe) => recipe.reagents!.filter(matchesItem));
  const needed = matchingReagents.reduce((sum, reagent) => sum + (reagent.count ?? reagent.required!), 0);
  if (input.quantity === undefined || !Number.isSafeInteger(input.quantity) || input.quantity < 0) return unknown();
  const keepQuantity = Math.min(input.quantity, needed);
  const excessQuantity = Math.max(0, input.quantity - needed);
  return { state: "KNOWN", keepQuantity, excessQuantity, nextRecipe: goals.map((recipe) => recipe.name).join(", "), reason: needed > 0
    ? `Next Cooking goal ${goals.map((recipe) => recipe.name).join(", ")} at skill ${nextSkill} needs ${needed}; keep ${keepQuantity}${excessQuantity ? `; ${excessQuantity} excess` : ""}.`
    : `Next Cooking goal is ${goals.map((recipe) => recipe.name).join(", ")} at skill ${nextSkill}; this item is not a required reagent; ${input.quantity} excess.` };
}

export interface FoodDrinkFact {
  kind: FoodDrinkKind;
  requiredLevel?: number;
  quantity?: number;
  stackSize?: number;
  /** Explicit evidence from item data, spell text, or tooltip text. */
  evidence?: "ITEM_DATA" | "SPELL" | "TOOLTIP";
}

export interface FoodDrinkPlan {
  action: "KEEP" | "MAIL_TO_AUCTION_CHARACTER" | "VENDOR" | "UNDETERMINED";
  category: FoodDrinkKind;
  usableNow: boolean | "UNKNOWN";
  tier: number | "UNKNOWN";
  keepQuantity: number | "UNKNOWN";
  reason: string;
}

/** Plans only from explicit category and required-level evidence. It never infers food type or buff status from names. */
export function planFoodDrink(fact: FoodDrinkFact, characterLevel: number | undefined, bagTight: boolean, highestUsableTier?: number, config: MailBagSpaceConfig = DEFAULT_MAIL_BAG_SPACE_CONFIG): FoodDrinkPlan {
  const quantity = Number.isSafeInteger(fact.quantity) && fact.quantity! >= 0 ? fact.quantity! : "UNKNOWN" as const;
  if (fact.kind === "UNKNOWN") return { action: "KEEP", category: "UNKNOWN", usableNow: "UNKNOWN", tier: "UNKNOWN", keepQuantity: quantity, reason: `Food or drink category is UNKNOWN; keep${quantity === "UNKNOWN" ? " with quantity UNKNOWN" : ` quantity ${quantity}`}.` };
  if (fact.requiredLevel === undefined || characterLevel === undefined) return { action: "KEEP", category: fact.kind, usableNow: "UNKNOWN", tier: "UNKNOWN", keepQuantity: quantity, reason: `${fact.requiredLevel === undefined ? "Item required level" : "Character level"} is UNKNOWN; keep${quantity === "UNKNOWN" ? " with quantity UNKNOWN" : ` quantity ${quantity}`}.` };
  if (fact.requiredLevel > characterLevel) return { action: "MAIL_TO_AUCTION_CHARACTER", category: fact.kind, usableNow: false, tier: fact.requiredLevel, keepQuantity: 0, reason: `Requires level ${fact.requiredLevel}; character is level ${characterLevel}; mail for later use${quantity === "UNKNOWN" ? "; quantity UNKNOWN" : `; quantity ${quantity}`}.` };
  const levelCap = foodQuantityCap(characterLevel, config);
  const cap = fact.kind === "BUFF_FOOD" ? quantity === "UNKNOWN" || fact.stackSize === undefined ? "UNKNOWN" : Math.min(quantity, fact.stackSize) : quantity === "UNKNOWN" || levelCap === undefined ? "UNKNOWN" : Math.min(quantity, levelCap);
  const disposition = bagTight && fact.kind !== "BUFF_FOOD" && highestUsableTier !== undefined && fact.requiredLevel < highestUsableTier ? "VENDOR" as const : "KEEP" as const;
  return { action: disposition, category: fact.kind, usableNow: true, tier: fact.requiredLevel, keepQuantity: disposition === "VENDOR" ? 0 : cap,
    reason: `${fact.kind === "BUFF_FOOD" ? "Buff food" : fact.kind === "DRINK" ? "Drink" : "Food"}; usable tier ${fact.requiredLevel}${fact.kind === "BUFF_FOOD" ? fact.stackSize === undefined ? "; stack size UNKNOWN, keep quantity UNKNOWN" : `; keep at most one stack (${cap})` : levelCap === undefined ? "; level-based stack cap UNKNOWN" : `; level stack cap ${levelCap}`}${disposition === "VENDOR" ? "; lower tier and bags are tight" : ""}${quantity === "UNKNOWN" ? "; quantity UNKNOWN" : `; quantity ${quantity}`}.` };
}

/** Newest usable tier first; UNKNOWN tiers stay after ranked rows and retain their source order. */
export function rankFoodDrinkRows<T extends { tier: number | "UNKNOWN"; sourceOrder: number }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => a.tier === "UNKNOWN" ? b.tier === "UNKNOWN" ? a.sourceOrder - b.sourceOrder : 1 : b.tier === "UNKNOWN" ? -1 : b.tier - a.tier || a.sourceOrder - b.sourceOrder);
}
