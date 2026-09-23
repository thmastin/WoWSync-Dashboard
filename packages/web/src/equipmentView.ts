// Equipment display helpers (N6 leftover: ilvl + average).
// Per-slot itemLevel is already parsed and stored; the character page only
// showed names. Average is DERIVED from observed numeric ilvls — never invent
// zero for missing/unknown, and empty slots are not averaged.

export type EquipmentSlotLike = {
  empty: boolean;
  slotName?: string;
  name?: string;
  itemRef?: string;
  itemLevel?: string;
  requiredLevel?: string;
};

/** Parse an export ilvl field to a finite number, or undefined if absent/unknown. */
export function parseItemLevel(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed === "?" || trimmed.toUpperCase() === "UNKNOWN") return undefined;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return undefined;
  return n;
}

export type EquipmentIlvlSummary = {
  /** Rounded mean of slots that have a known numeric ilvl. */
  average: number;
  /** Equipped slots that contributed to the average. */
  counted: number;
  /** Non-empty slots (equipped), whether or not ilvl is known. */
  equipped: number;
  /** Empty slots. */
  empty: number;
  /** Equipped slots with no usable ilvl (not averaged). */
  unknownIlvl: number;
};

/**
 * Average item level over equipped slots that carry a numeric ilvl.
 * Returns null when nothing equipped or no known ilvls (unknown ≠ zero).
 */
export function summarizeEquipmentIlvl(slots: ReadonlyArray<EquipmentSlotLike>): EquipmentIlvlSummary | null {
  let equipped = 0;
  let empty = 0;
  let unknownIlvl = 0;
  const levels: number[] = [];

  for (const slot of slots) {
    if (slot.empty) {
      empty += 1;
      continue;
    }
    equipped += 1;
    const ilvl = parseItemLevel(slot.itemLevel);
    if (ilvl === undefined) {
      unknownIlvl += 1;
      continue;
    }
    levels.push(ilvl);
  }

  if (levels.length === 0) return null;

  const sum = levels.reduce((a, b) => a + b, 0);
  return {
    average: Math.round(sum / levels.length),
    counted: levels.length,
    equipped,
    empty,
    unknownIlvl,
  };
}