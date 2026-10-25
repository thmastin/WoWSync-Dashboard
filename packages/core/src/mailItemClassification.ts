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
  recipeItem?: { professionState: "KNOWN" | "UNKNOWN"; hasProfession: boolean; requiredSkill?: number; holderSkill?: number; learnedState?: "LEARNED" | "NOT_LEARNED" | "UNKNOWN"; reagentIds?: readonly number[] };
  objectiveQuest?: string;
  quality?: number;
  vendorEachCopper?: number;
  itemClass?: number;
  equippable?: boolean;
  consumable?: boolean;
  conjured?: boolean;
}): SharedMailItemDecision {
  if (input.held) return { action: "KEEP", reason: "on hold list" };
  if (input.bound === "BOUND") return { action: "KEEP", reason: "Item is OBSERVED bound and cannot be routed to another character." };
  if (input.bound === "UNKNOWN") return { action: "UNDETERMINED", reason: "Binding is UNKNOWN; safe routing cannot be established." };
  if (input.evidenceUsable === false) return { action: "UNDETERMINED", reason: "Required bag, identity, or build evidence is not current and usable." };
  const normalize = (value: string) => value.toLocaleLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  if (input.ownRecipeUse || (input.name && input.ownRecipeUseNames?.some((name) => normalize(name) === normalize(input.name!)))) return { action: "KEEP", reason: `used by known recipe ${input.ownRecipeUse ?? input.name}; keep on holder` };
  if (input.reagentForRecipeToLearn) return { action: "KEEP", reason: "reagent for recipe to learn" };
  if (input.reagentForUnresolvedRecipe) return { action: "KEEP", reason: "possible reagent for recipe; learned state is UNKNOWN" };
  if (input.recipeItem) {
    const recipe = input.recipeItem;
    if (recipe.professionState === "UNKNOWN" || !recipe.hasProfession || recipe.learnedState === "UNKNOWN" || recipe.learnedState === undefined || recipe.requiredSkill === undefined || recipe.holderSkill === undefined) {
      return { action: "UNDETERMINED", reason: "recipe profession, required skill, or known state is UNKNOWN" };
    }
    if (recipe.learnedState === "LEARNED") return { action: "UNDETERMINED", reason: "recipe is already known (OBSERVED)" };
    if (recipe.holderSkill < recipe.requiredSkill) return { action: "UNDETERMINED", reason: `required skill ${recipe.requiredSkill} exceeds observed skill ${recipe.holderSkill}` };
    return { action: "LEARN_RECIPE", reason: `learn recipe at observed skill ${recipe.holderSkill}/${recipe.requiredSkill}` };
  }
  if (input.objectiveQuest) return { action: "KEEP", reason: `needed for active quest ${input.objectiveQuest}` };
  if (input.quality === 0) return input.vendorEachCopper === undefined
    ? { action: "UNDETERMINED", reason: "Quality 0 is OBSERVED, but vendor value is UNKNOWN." }
    : { action: "VENDOR", reason: `OBSERVED gray item; vendor value ${input.vendorEachCopper} copper each` };
  const fallbackVersion = input.version === "classic-era" || input.version === "forever";
  if (fallbackVersion && (input.conjured || input.itemId !== undefined && CLASSIC_CONJURED_FALLBACK_IDS.has(input.itemId))) return { action: "KEEP", reason: "conjured, can't be mailed" };
  if (input.consumable || fallbackVersion && input.itemId !== undefined && CLASSIC_CONSUMABLE_FALLBACK_IDS.has(input.itemId)) return { action: "KEEP", reason: "consumable" };
  if (input.equippable || input.itemClass === 2 || input.itemClass === 4) return { action: "KEEP", reason: "possible upgrade, unverified" };
  if (input.itemClass === undefined) return { action: "KEEP", reason: "item class UNKNOWN; safe mail eligibility is unverified" };
  return { action: "ROUTE" };
}
