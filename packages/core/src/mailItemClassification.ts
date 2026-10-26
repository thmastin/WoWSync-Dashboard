import { CLASSIC_CONJURED_FALLBACK_IDS, CLASSIC_CONSUMABLE_FALLBACK_IDS } from "./classicMailItemRules.ts";
import { DEFAULT_MAIL_BAG_SPACE_CONFIG, planFoodDrink, type CookingMaterialPlan, type MailBagSpaceConfig } from "./foodDrinkPlanning.ts";
import type { WowVersion } from "./types.ts";
export type MailBindingState = "BOUND" | "UNBOUND" | "UNKNOWN";
export function normalizeMailBinding(value: unknown): MailBindingState {
  if (value === true) return "BOUND";
  if (value === false) return "UNBOUND";
  if (typeof value !== "string") return "UNKNOWN";
  switch (value.trim().toUpperCase()) {
    case "YES": case "TRUE": case "1": case "BOUND": case "OBSERVED_TRUE": return "BOUND";
    case "NO": case "FALSE": case "0": case "UNBOUND": case "OBSERVED_FALSE": return "UNBOUND";
    default: return "UNKNOWN";
  }
}

export type SharedMailItemDecision =
  | { action: "KEEP"; reason: string; quantityLimit?: number; excessQuantity?: number; excessDisposition?: "COOK_FIRST" | "VENDOR" | "MAIL_TO_AUCTION_CHARACTER" }
  | { action: "UNDETERMINED"; reason: string; quantityLimit?: number; excessQuantity?: number; excessDisposition?: "COOK_FIRST" | "VENDOR" | "MAIL_TO_AUCTION_CHARACTER" }
  | { action: "LEARN_RECIPE"; reason: string; quantityLimit?: number; excessQuantity?: number; excessDisposition?: "COOK_FIRST" | "VENDOR" | "MAIL_TO_AUCTION_CHARACTER" }
  | { action: "VENDOR"; reason: string; quantityLimit?: number; excessQuantity?: number; excessDisposition?: "COOK_FIRST" | "VENDOR" | "MAIL_TO_AUCTION_CHARACTER" }
  | { action: "ROUTE"; reason?: string; quantityLimit?: number; excessQuantity?: number; excessDisposition?: "COOK_FIRST" | "VENDOR" | "MAIL_TO_AUCTION_CHARACTER" };

/** Flavor-neutral item safeguards. Routing destinations and snapshot/build gates remain in each planner. */
export function classifyMailItem(input: {
  version: WowVersion;
  itemId?: number;
  name?: string;
  held?: boolean;
  bound: "BOUND" | "UNBOUND" | "UNKNOWN";
  evidenceUsable?: boolean;
  ownRecipeUse?: string;
  ownRecipeUseNames?: readonly string[];
  reagentForRecipeToLearn?: boolean;
  reagentForUnresolvedRecipe?: boolean;
  recipeItem?: { professionState: "KNOWN" | "UNKNOWN"; hasProfession: boolean; profession?: string; recipeName?: string; requiredSkill?: number; holderSkill?: number; learnedState?: "LEARNED" | "NOT_LEARNED" | "UNKNOWN"; reagentIds?: readonly number[] };
  objectiveQuest?: string;
  quality?: number;
  vendorEachCopper?: number;
  itemClass?: number;
  equippable?: boolean;
  consumable?: boolean;
  conjured?: boolean;
  itemMetadataState?: "OBSERVED" | "UNKNOWN";
  subClassID?: number;
  equipLoc?: string;
  requiredLevel?: number;
  holderLevel?: number;
  recipeAlreadyKnown?: boolean;
  requiredProfession?: string;
  requiredSkill?: number;
  classCanEquip?: boolean;
  /** Item-data-derived food/drink category. UNKNOWN is kept without a tier guess. */
  foodKind?: "FOOD" | "DRINK" | "BUFF_FOOD" | "UNKNOWN";
  foodQuantity?: number;
  foodStackSize?: number;
  foodEvidence?: "ITEM_DATA" | "SPELL" | "TOOLTIP";
  foodBagsTight?: boolean;
  highestUsableFoodTier?: number;
  bagSpaceConfig?: MailBagSpaceConfig;
  cookingMaterialPlan?: CookingMaterialPlan;
  cookingFireAvailable?: boolean;
  cookingExcessDisposition?: "VENDOR" | "MAIL_TO_AUCTION_CHARACTER";
}): SharedMailItemDecision {
  if (input.held) return { action: "KEEP", reason: "on hold list" };
  if (input.evidenceUsable === false) return { action: "UNDETERMINED", reason: "Required bag, identity, or build evidence is not current and usable." };
  const normalize = (value: string) => value.toLocaleLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  if (input.ownRecipeUse || (input.name && input.ownRecipeUseNames?.some((name) => normalize(name) === normalize(input.name!)))) return { action: "KEEP", reason: `used by known recipe ${input.ownRecipeUse ?? input.name}; keep on holder` };
  if (input.reagentForRecipeToLearn) return { action: "KEEP", reason: "reagent for recipe to learn" };
  if (input.reagentForUnresolvedRecipe) return { action: "KEEP", reason: "possible reagent for recipe; learned state is UNKNOWN" };
  if (input.recipeAlreadyKnown === true) { /* known recipes are routed normally below */ }
  if (input.recipeItem && input.recipeAlreadyKnown !== true) {
    const recipe = input.recipeItem;
    if (recipe.professionState === "UNKNOWN" || !recipe.hasProfession || recipe.requiredSkill === undefined || recipe.holderSkill === undefined) {
      return { action: "UNDETERMINED", reason: "recipe profession, required skill, or known state is UNKNOWN" };
    }
    if (recipe.holderSkill < recipe.requiredSkill) return { action: "KEEP", reason: `learn at ${recipe.profession ?? "profession"} ${recipe.requiredSkill} (now ${recipe.holderSkill})` };
    if (recipe.learnedState === "UNKNOWN" || recipe.learnedState === undefined) return { action: "UNDETERMINED", reason: "recipe learned state is UNKNOWN" };
    if (recipe.learnedState === "LEARNED") return { action: "UNDETERMINED", reason: "recipe is already known (OBSERVED)" };
    return { action: "LEARN_RECIPE", reason: `learn ${recipe.recipeName ?? "recipe"} at ${recipe.profession ?? "profession"} ${recipe.requiredSkill} (now ${recipe.holderSkill})` };
  }
  else if (input.requiredProfession && typeof input.requiredSkill === "number" && input.recipeAlreadyKnown === false) return { action: "LEARN_RECIPE", reason: `learn recipe for ${input.requiredProfession} at skill ${input.requiredSkill}` };
  if (input.objectiveQuest) return { action: "KEEP", reason: `needed for active quest ${input.objectiveQuest}` };
  if (input.cookingMaterialPlan) {
    const plan = input.cookingMaterialPlan;
    if (plan.state === "UNKNOWN") return { action: "KEEP", reason: plan.reason };
    if (typeof plan.keepQuantity !== "number" || typeof plan.excessQuantity !== "number") return { action: "KEEP", reason: plan.reason };
    const extra = plan.excessQuantity;
    const excessDisposition = extra > 0 ? input.cookingFireAvailable === true && plan.nextRecipe ? "COOK_FIRST" as const : input.cookingExcessDisposition ?? "VENDOR" as const : undefined;
    const action = plan.keepQuantity > 0 || excessDisposition === "COOK_FIRST" ? "KEEP" as const : excessDisposition === "MAIL_TO_AUCTION_CHARACTER" ? "ROUTE" as const : excessDisposition === "VENDOR" ? "VENDOR" as const : "KEEP" as const;
    return { action, quantityLimit: plan.keepQuantity, excessQuantity: extra, ...(excessDisposition ? { excessDisposition } : {}), reason: `${plan.reason}${extra > 0 ? excessDisposition === "COOK_FIRST" ? ` COOK_FIRST: use the observed ${plan.nextRecipe} recipe when a fire is available.` : ` Excess ${extra}: ${excessDisposition}.` : ""}` };
  }
  if (input.quality === 0) return { action: "VENDOR", reason: input.vendorEachCopper === undefined
    ? "OBSERVED gray item; vendor value is UNKNOWN."
    : `OBSERVED gray item; vendor value ${input.vendorEachCopper} copper each` };
  const observedEquipment = input.itemMetadataState === "OBSERVED" && (input.itemClass === 2 || input.itemClass === 4 || !!input.equipLoc && input.equipLoc !== "INVTYPE_NON_EQUIP_IGNORE");
  const equipmentUnusable = input.classCanEquip === false || observedEquipment && input.requiredLevel !== undefined && input.holderLevel !== undefined && input.requiredLevel > input.holderLevel;
  if (input.bound === "BOUND") {
    if (equipmentUnusable) return { action: "VENDOR", reason: input.vendorEachCopper === undefined
      ? "OBSERVED bound item is unusable; vendor value is UNKNOWN."
      : `OBSERVED bound item is unusable; vendor value ${input.vendorEachCopper} copper each` };
    return { action: "KEEP", reason: "Item is OBSERVED bound and cannot be routed to another character." };
  }
  if (input.bound === "UNKNOWN") return { action: "UNDETERMINED", reason: "Binding is UNKNOWN; safe routing cannot be established." };
  if (input.foodKind) {
    const food = planFoodDrink({ kind: input.foodKind, ...(input.requiredLevel !== undefined ? { requiredLevel: input.requiredLevel } : {}), ...(input.foodQuantity !== undefined ? { quantity: input.foodQuantity } : {}), ...(input.foodStackSize !== undefined ? { stackSize: input.foodStackSize } : {}), ...(input.foodEvidence ? { evidence: input.foodEvidence } : {}) }, input.holderLevel, input.foodBagsTight === true, input.highestUsableFoodTier, input.bagSpaceConfig ?? DEFAULT_MAIL_BAG_SPACE_CONFIG);
    return { action: food.action === "MAIL_TO_AUCTION_CHARACTER" ? "ROUTE" : food.action, reason: food.reason, ...(typeof food.keepQuantity === "number" ? { quantityLimit: food.keepQuantity } : {}) };
  }
  if (equipmentUnusable) return { action: "ROUTE" };
  const fallbackVersion = (input.version === "classic-era" || input.version === "forever") && input.itemMetadataState !== "OBSERVED";
  if (fallbackVersion && (input.conjured || input.itemId !== undefined && CLASSIC_CONJURED_FALLBACK_IDS.has(input.itemId))) return { action: "KEEP", reason: "conjured, can't be mailed" };
  const observedConsumable = input.itemMetadataState === "OBSERVED" && input.itemClass === 0;
  const observedEquippable = input.itemMetadataState === "OBSERVED" && (input.itemClass === 2 || input.itemClass === 4 || !!input.equipLoc && input.equipLoc !== "INVTYPE_NON_EQUIP_IGNORE");
  const levelUsable = input.requiredLevel === undefined || input.holderLevel === undefined || input.requiredLevel <= input.holderLevel;
  if ((observedConsumable || fallbackVersion && (input.consumable || input.itemId !== undefined && CLASSIC_CONSUMABLE_FALLBACK_IDS.has(input.itemId))) && levelUsable) return { action: "KEEP", reason: "consumable" };
  if (input.equippable || observedEquippable || input.itemMetadataState !== "OBSERVED" && (input.itemClass === 2 || input.itemClass === 4)) return { action: "KEEP", reason: "Observed equipment item; upgrade suitability is UNKNOWN." };
  if (input.itemClass === undefined) return { action: "KEEP", reason: "item class UNKNOWN; safe mail eligibility is unverified" };
  return { action: "ROUTE" };
}
