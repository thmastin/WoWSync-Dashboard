/** Forever 1.60.1 inventory-slot IDs. These labels are presentation only. */
export const FOREVER_EQUIPMENT_SLOT_LABELS: Readonly<Record<number, string>> = Object.freeze({
  1: "Head", 2: "Neck", 3: "Shoulder", 4: "Shirt", 5: "Chest", 6: "Waist",
  7: "Legs", 8: "Feet", 9: "Wrist", 10: "Hands", 11: "Finger 1", 12: "Finger 2",
  13: "Trinket 1", 14: "Trinket 2", 15: "Back", 16: "Main Hand", 17: "Off Hand",
  18: "Ranged", 19: "Tabard",
});

export type ForeverEmptySlotApplicability = "OPTIONAL_OR_COSMETIC" | "UNKNOWN_APPLICABILITY";

/** Shirt/tabard are optional cosmetic presentation slots; other gaps are not deficiencies. */
export function classifyForeverEmptySlot(slot: number): ForeverEmptySlotApplicability | "UNKNOWN_SLOT" {
  if (!FOREVER_EQUIPMENT_SLOT_LABELS[slot]) return "UNKNOWN_SLOT";
  return slot === 4 || slot === 19 ? "OPTIONAL_OR_COSMETIC" : "UNKNOWN_APPLICABILITY";
}

export function foreverEquipmentSlotLabel(slot: number, supplied?: string): string {
  const known = FOREVER_EQUIPMENT_SLOT_LABELS[slot];
  if (known) return known;
  return supplied && !/^slot\s+\d+$/i.test(supplied) ? supplied : `Slot ${slot}`;
}

export function equipmentSlotLabel(version: string | undefined, slot: number, supplied?: string): string {
  if (version === "forever") return foreverEquipmentSlotLabel(slot, supplied);
  return supplied || `Slot ${slot}`;
}

export function unresolvedItemName(itemID: number | undefined, itemRef?: string): string {
  const id = itemID ?? (itemRef?.match(/^item:(\d+)/)?.[1] ? Number(itemRef.match(/^item:(\d+)/)![1]) : undefined);
  return id === undefined ? `Item name unresolved (${itemRef ?? "item ID UNKNOWN"})` : `Item name unresolved (item ID ${id})`;
}
