import type { WowVersion } from "./types.ts";

// Classic-era and Forever use the same original Classic class proficiencies.
// Numeric item class/subclass values are the client ItemClassID/SubclassID values.
const CLASS_PROFICIENCIES: Readonly<Record<string, { armor: readonly number[]; weapons: readonly number[] }>> = {
  WARRIOR: { armor: [1, 2, 3, 4, 6], weapons: [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 13, 15, 16, 18] },
  PALADIN: { armor: [1, 2, 3, 4, 6], weapons: [0, 1, 4, 5, 6, 7, 8, 10] },
  HUNTER: { armor: [1, 2, 3], weapons: [0, 1, 2, 3, 4, 5, 7, 8, 10, 13, 15, 16, 18] },
  ROGUE: { armor: [1, 2], weapons: [0, 4, 7, 8, 13, 15, 16] },
  PRIEST: { armor: [1], weapons: [4, 7, 10, 19] },
  SHAMAN: { armor: [1, 2, 3, 6], weapons: [0, 1, 4, 5, 6, 10, 13, 15] },
  MAGE: { armor: [1], weapons: [4, 7, 10, 19] },
  WARLOCK: { armor: [1], weapons: [7, 10, 15, 19] },
  DRUID: { armor: [1, 2], weapons: [4, 5, 6, 10, 13, 15] },
};

/** Undefined means the class or item metadata is insufficient to decide safely. */
export function classicClassCanEquip(version: WowVersion, className: string | undefined, itemClass: number | undefined, subClassID: number | undefined, equipLoc: string | undefined): boolean | undefined {
  if (version !== "classic-era" && version !== "forever") return undefined;
  if (!className || itemClass === undefined || subClassID === undefined || !equipLoc || equipLoc === "INVTYPE_NON_EQUIP_IGNORE") return undefined;
  const proficiency = CLASS_PROFICIENCIES[className.toUpperCase()];
  if (!proficiency) return undefined;
  if (itemClass === 4 && ["INVTYPE_HEAD", "INVTYPE_NECK", "INVTYPE_SHOULDER", "INVTYPE_BODY", "INVTYPE_CHEST", "INVTYPE_ROBE", "INVTYPE_WAIST", "INVTYPE_LEGS", "INVTYPE_FEET", "INVTYPE_WRIST", "INVTYPE_HAND", "INVTYPE_FINGER", "INVTYPE_TRINKET", "INVTYPE_CLOAK", "INVTYPE_SHIELD", "INVTYPE_HOLDABLE"].includes(equipLoc)) {
    return proficiency.armor.includes(subClassID);
  }
  if (itemClass === 2 && equipLoc.startsWith("INVTYPE_")) return proficiency.weapons.includes(subClassID);
  return undefined;
}
