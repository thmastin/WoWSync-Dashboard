import { CLASSIC_CONJURED_FALLBACK_IDS, CLASSIC_CONSUMABLE_FALLBACK_IDS } from "./classicMailItemRules.ts";
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
  | { action: "KEEP"; reason: string }
  | { action: "UNDETERMINED"; reason: string }
  | { action: "LEARN_RECIPE"; reason: string }
  | { action: "VENDOR"; reason: string }
  | { action: "ROUTE"; reason?: string };

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
}): SharedMailItemDecision {
  if (input.held) return { action: "KEEP", reason: "on hold list" };
  if (input.bound === "BOUND") return { action: "KEEP", reason: "Item is OBSERVED bound and cannot be routed to another character." };
  if (input.bound === "UNKNOWN") return { action: "UNDETERMINED", reason: "Binding is UNKNOWN; safe routing cannot be established." };
  if (input.evidenceUsable === false) return { action: "UNDETERMINED", reason: "Required bag, identity, or build evidence is not current and usable." };
  const normalize = (value: string) => value.toLocaleLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  if (input.ownRecipeUse || (input.name && input.ownRecipeUseNames?.some((name) => normalize(name) === normalize(input.name!)))) return { action: "KEEP", reason: `used by known recipe ${input.ownRecipeUse ?? input.name}; keep on holder` };
  if (input.reagentForRecipeToLearn) return { action: "KEEP", reason: "reagent for recipe to learn" };
  if (input.reagentForUnresolvedRecipe) return { action: "KEEP", reason: "possible reagent for recipe; learned state is UNKNOWN" };
  if (input.recipeAlreadyKnown === true) { /* known recipes are routed normally below */ }
  else if (input.requiredProfession && typeof input.requiredSkill === "number") return { action: "LEARN_RECIPE", reason: `learn ${input.requiredProfession} recipe at skill ${input.requiredSkill}` };
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
  if (input.requiredProfession && typeof input.requiredSkill === "number" && input.recipeAlreadyKnown === false) return { action: "LEARN_RECIPE", reason: `learn recipe for ${input.requiredProfession} at skill ${input.requiredSkill}` };
  if (input.objectiveQuest) return { action: "KEEP", reason: `needed for active quest ${input.objectiveQuest}` };
  if (input.quality === 0) return input.vendorEachCopper === undefined
    ? { action: "UNDETERMINED", reason: "Quality 0 is OBSERVED, but vendor value is UNKNOWN." }
    : { action: "VENDOR", reason: `OBSERVED gray item; vendor value ${input.vendorEachCopper} copper each` };
  const fallbackVersion = (input.version === "classic-era" || input.version === "forever") && input.itemMetadataState !== "OBSERVED";
  if (fallbackVersion && (input.conjured || input.itemId !== undefined && CLASSIC_CONJURED_FALLBACK_IDS.has(input.itemId))) return { action: "KEEP", reason: "conjured, can't be mailed" };
  const observedConsumable = input.itemMetadataState === "OBSERVED" && input.itemClass === 0;
  const observedEquippable = input.itemMetadataState === "OBSERVED" && (input.itemClass === 2 || input.itemClass === 4 || !!input.equipLoc && input.equipLoc !== "INVTYPE_NON_EQUIP_IGNORE");
  const levelUsable = input.requiredLevel === undefined || input.holderLevel === undefined || input.requiredLevel <= input.holderLevel;
  if ((observedConsumable || fallbackVersion && (input.consumable || input.itemId !== undefined && CLASSIC_CONSUMABLE_FALLBACK_IDS.has(input.itemId))) && levelUsable) return { action: "KEEP", reason: "consumable" };
  if (input.equippable || observedEquippable || input.itemMetadataState !== "OBSERVED" && (input.itemClass === 2 || input.itemClass === 4)) return { action: "KEEP", reason: "possible upgrade, unverified" };
  if (input.itemClass === undefined) return { action: "KEEP", reason: "item class UNKNOWN; safe mail eligibility is unverified" };
  return { action: "ROUTE" };
}
