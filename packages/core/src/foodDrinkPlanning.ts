export type FoodDrinkKind = "FOOD" | "DRINK" | "BUFF_FOOD" | "UNKNOWN";

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
export function planFoodDrink(fact: FoodDrinkFact, characterLevel: number | undefined, bagTight: boolean, highestUsableTier?: number): FoodDrinkPlan {
  const quantity = Number.isSafeInteger(fact.quantity) && fact.quantity! >= 0 ? fact.quantity! : "UNKNOWN" as const;
  if (fact.kind === "UNKNOWN") return { action: "KEEP", category: "UNKNOWN", usableNow: "UNKNOWN", tier: "UNKNOWN", keepQuantity: quantity, reason: `Food or drink category is UNKNOWN; keep${quantity === "UNKNOWN" ? " with quantity UNKNOWN" : ` quantity ${quantity}`}.` };
  if (fact.requiredLevel === undefined || characterLevel === undefined) return { action: "KEEP", category: fact.kind, usableNow: "UNKNOWN", tier: "UNKNOWN", keepQuantity: quantity, reason: `${fact.requiredLevel === undefined ? "Item required level" : "Character level"} is UNKNOWN; keep${quantity === "UNKNOWN" ? " with quantity UNKNOWN" : ` quantity ${quantity}`}.` };
  if (fact.requiredLevel > characterLevel) return { action: "MAIL_TO_AUCTION_CHARACTER", category: fact.kind, usableNow: false, tier: fact.requiredLevel, keepQuantity: 0, reason: `Requires level ${fact.requiredLevel}; character is level ${characterLevel}; mail for later use${quantity === "UNKNOWN" ? "; quantity UNKNOWN" : `; quantity ${quantity}`}.` };
  const cap = fact.kind === "BUFF_FOOD" ? quantity === "UNKNOWN" || fact.stackSize === undefined ? "UNKNOWN" : Math.min(quantity, fact.stackSize) : quantity;
  const disposition = bagTight && fact.kind !== "BUFF_FOOD" && highestUsableTier !== undefined && fact.requiredLevel < highestUsableTier ? "VENDOR" as const : "KEEP" as const;
  return { action: disposition, category: fact.kind, usableNow: true, tier: fact.requiredLevel, keepQuantity: disposition === "VENDOR" ? 0 : cap,
    reason: `${fact.kind === "BUFF_FOOD" ? "Buff food" : fact.kind === "DRINK" ? "Drink" : "Food"}; usable tier ${fact.requiredLevel}${fact.kind === "BUFF_FOOD" ? fact.stackSize === undefined ? "; stack size UNKNOWN, keep quantity UNKNOWN" : `; keep at most one stack (${cap})` : ""}${disposition === "VENDOR" ? "; lower tier and bags are tight" : ""}${quantity === "UNKNOWN" ? "; quantity UNKNOWN" : `; quantity ${quantity}`}.` };
}

/** Newest usable tier first; UNKNOWN tiers stay after ranked rows and retain their source order. */
export function rankFoodDrinkRows<T extends { tier: number | "UNKNOWN"; sourceOrder: number }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => a.tier === "UNKNOWN" ? b.tier === "UNKNOWN" ? a.sourceOrder - b.sourceOrder : 1 : b.tier === "UNKNOWN" ? -1 : b.tier - a.tier || a.sourceOrder - b.sourceOrder);
}
