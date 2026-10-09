/** Forever 1.60.1 / build 70291 only. No Retail equipment or weighting rules. */

export type ForeverSlotEvidence = {
  slot: number;
  itemRef?: string;
  equipLocation?: string;
  provenance: string;
};

export type ForeverStatEntry = { key: string; state: string; value?: unknown };
export type ForeverStatTable = { state: string; complete: boolean; entries: ForeverStatEntry[] };

export type ForeverStatComparison = {
  slot: number;
  equippedItemRef: string;
  values: Array<{ key: string; candidate: number; equipped: number; delta: number }>;
  classification: "CANDIDATE_DOMINATES_RECORDED_STATS" | "EQUIPPED_DOMINATES_RECORDED_STATS" | "STAT_TRADEOFF" | "RECORDED_STAT_TIE";
  provenance: "DERIVED";
  reason: string;
  weaponMetrics?: {
    dps: Array<{ key: string; candidate: number; equipped: number; delta: number }>;
    speed: { state: "UNKNOWN"; reason: string };
  };
};

export type ForeverSlotCompatibility = {
  state: "MAPPED" | "UNKNOWN" | "NOT_EQUIPMENT";
  equipLocation: string;
  possibleSlots: number[];
  currentlyOccupiedSlots: number[];
  knownEmptySlots: number[];
  conflicts: Array<{ slot: number; itemRef?: string; equipLocation?: string; state: "REQUIRES_REPLACEMENT" | "UNKNOWN_CONFLICT"; reason: string }>;
  reason: string;
};

export type ForeverGearAssessmentEvaluation = {
  eligibility: "INELIGIBLE_REQUIRED_LEVEL" | "UNKNOWN";
  playerApiSignal: "TRUE" | "FALSE" | "UNKNOWN";
  eligibilityChecks: {
    requiredLevel: { state: "MET" | "NOT_MET" | "UNKNOWN"; itemRequiredLevel?: number; recipientLevel?: number; reason: string };
    classRestriction: { state: "UNKNOWN"; reason: string };
    weaponProficiency: { state: "UNKNOWN" | "NOT_APPLICABLE"; observedSkillLines: string[]; reason: string };
    slotCompatibility: ForeverSlotCompatibility;
  };
  suitability: "OBSERVED_SPEC_TAG_MATCH" | "OBSERVED_SPEC_TAG_MISMATCH" | "UNKNOWN";
  suitabilityEvidence: ReturnType<typeof assessForeverSuitability>;
  upgradeStatus: ReturnType<typeof classifyForeverRecordedUpgrade>["status"];
  upgradeConfidence: ReturnType<typeof classifyForeverRecordedUpgrade>["confidence"];
  rawStatComparisons: ForeverStatComparison[];
  statDeltaCalibrations: Array<ReturnType<typeof calibrateForeverStatDelta>>;
  transferability: "BLOCKED_BOUND_TO_SOURCE" | "UNKNOWN";
  transferabilityReason: string;
  allocationPriority: "LOCAL_REVIEW_CANDIDATE" | "BLOCKED_BY_BINDING" | "UNRANKED_UNKNOWN_SCOPE" | "UNRANKED";
  decision: "REVIEW_LOCAL_CANDIDATE" | "NO_RECOMMENDATION";
  missingEvidence: string[];
  reason: string;
};

const SLOT_BY_EQUIP_LOCATION: Readonly<Record<string, readonly number[]>> = {
  INVTYPE_HEAD: [1], INVTYPE_NECK: [2], INVTYPE_SHOULDER: [3], INVTYPE_BODY: [4],
  INVTYPE_CHEST: [5], INVTYPE_ROBE: [5], INVTYPE_WAIST: [6], INVTYPE_LEGS: [7],
  INVTYPE_FEET: [8], INVTYPE_WRIST: [9], INVTYPE_HAND: [10], INVTYPE_FINGER: [11, 12],
  INVTYPE_TRINKET: [13, 14], INVTYPE_CLOAK: [15], INVTYPE_WEAPON: [16, 17],
  INVTYPE_WEAPONMAINHAND: [16], INVTYPE_WEAPONOFFHAND: [17], INVTYPE_2HWEAPON: [16],
  INVTYPE_SHIELD: [17], INVTYPE_HOLDABLE: [17], INVTYPE_RANGED: [18],
  INVTYPE_THROWN: [18], INVTYPE_RANGEDRIGHT: [18], INVTYPE_RELIC: [18],
  INVTYPE_AMMO: [0], INVTYPE_TABARD: [19], INVTYPE_BAG: [20, 21, 22, 23],
};

export function foreverSlotsForEquipLocation(equipLocation: string | undefined): number[] | undefined {
  if (!equipLocation) return undefined;
  const slots = SLOT_BY_EQUIP_LOCATION[equipLocation];
  return slots ? [...slots] : undefined;
}

export function evaluateForeverSlotCompatibility(input: {
  equipLocation?: string;
  equipment: ForeverSlotEvidence[];
  equipmentComplete: boolean;
}): ForeverSlotCompatibility {
  const equipLocation = input.equipLocation ?? "UNKNOWN";
  if (!input.equipLocation || !SLOT_BY_EQUIP_LOCATION[input.equipLocation]) {
    return { state: "UNKNOWN", equipLocation, possibleSlots: [], currentlyOccupiedSlots: [], knownEmptySlots: [], conflicts: [], reason: "Forever equip-location is absent or has no verified structural slot mapping." };
  }
  const possibleSlots = [...SLOT_BY_EQUIP_LOCATION[input.equipLocation]];
  if (input.equipLocation === "INVTYPE_BAG") {
    return { state: "NOT_EQUIPMENT", equipLocation, possibleSlots: [], currentlyOccupiedSlots: [], knownEmptySlots: [], conflicts: [], reason: "This item maps to carried storage, not an equipment slot used by gear evaluation." };
  }
  const rowBySlot = new Map(input.equipment.map((row) => [row.slot, row]));
  const currentlyOccupiedSlots = possibleSlots.filter((slot) => typeof rowBySlot.get(slot)?.itemRef === "string");
  let knownEmptySlots = input.equipmentComplete
    ? possibleSlots.filter((slot) => slot !== 0 && slot < 20 && !rowBySlot.has(slot))
    : [];
  const conflicts: ForeverSlotCompatibility["conflicts"] = [];
  if (input.equipLocation === "INVTYPE_2HWEAPON") {
    const offhand = rowBySlot.get(17);
    if (offhand?.itemRef) conflicts.push({ slot: 17, itemRef: offhand.itemRef, equipLocation: offhand.equipLocation, state: "REQUIRES_REPLACEMENT", reason: "A two-handed main-hand item requires the currently occupied off-hand to be replaced or removed." });
  }
  if (possibleSlots.includes(17) && input.equipLocation !== "INVTYPE_2HWEAPON") {
    const mainhand = rowBySlot.get(16);
    if (mainhand && mainhand.equipLocation === "INVTYPE_2HWEAPON") {
      conflicts.push({ slot: 16, itemRef: mainhand.itemRef, equipLocation: mainhand.equipLocation, state: "REQUIRES_REPLACEMENT", reason: "An item assigned to the off-hand slot conflicts with the currently equipped two-handed main-hand item." });
      knownEmptySlots = knownEmptySlots.filter((slot) => slot !== 17);
    } else if (mainhand && !mainhand.equipLocation) {
      conflicts.push({ slot: 16, itemRef: mainhand.itemRef, state: "UNKNOWN_CONFLICT", reason: "The occupied main-hand item has unknown equipment type, so a two-handed/off-hand conflict cannot be ruled out." });
    }
  }
  const unknownRows = possibleSlots.filter((slot) => rowBySlot.has(slot) && !rowBySlot.get(slot)?.itemRef);
  return {
    state: conflicts.some((conflict) => conflict.state === "UNKNOWN_CONFLICT") ? "UNKNOWN" : "MAPPED", equipLocation, possibleSlots, currentlyOccupiedSlots,
    knownEmptySlots: conflicts.some((conflict) => conflict.state === "UNKNOWN_CONFLICT") ? [] : knownEmptySlots, conflicts,
    reason: `${equipLocation} structurally maps to slot${possibleSlots.length === 1 ? "" : "s"} ${possibleSlots.join(", ")}. ${unknownRows.length ? "One or more mapped slot rows have unknown item identity." : ""}${input.equipmentComplete ? " Current slot occupancy was captured completely." : " Current occupancy is partial or unknown."}${conflicts.length ? ` Hand-slot constraints: ${conflicts.map((conflict) => conflict.reason).join(" ")}` : ""}`.trim(),
  };
}

function completeNumericTable(table: ForeverStatTable | undefined): Record<string, number> | undefined {
  if (!table || table.state !== "OBSERVED_TABLE" || table.complete !== true) return undefined;
  const values: Record<string, number> = {};
  for (const entry of table.entries) {
    if (entry.state !== "OBSERVED" || typeof entry.value !== "number" || !Number.isFinite(entry.value)) return undefined;
    values[entry.key] = entry.value;
  }
  return values;
}

export function compareForeverStatTables(candidate: ForeverStatTable | undefined, equipped: ForeverStatTable | undefined, slot: number, equippedItemRef: string, itemClass?: string): ForeverStatComparison | undefined {
  const candidateValues = completeNumericTable(candidate);
  const equippedValues = completeNumericTable(equipped);
  if (!candidateValues || !equippedValues) return undefined;
  const keys = [...new Set([...Object.keys(candidateValues), ...Object.keys(equippedValues)])].sort();
  if (keys.length === 0) return undefined;
  const values = keys.map((key) => {
    const candidateValue = candidateValues[key] ?? 0;
    const equippedValue = equippedValues[key] ?? 0;
    return { key, candidate: candidateValue, equipped: equippedValue, delta: candidateValue - equippedValue };
  });
  const gains = values.some((row) => row.delta > 0);
  const losses = values.some((row) => row.delta < 0);
  const classification = gains && losses ? "STAT_TRADEOFF" as const
    : gains ? "CANDIDATE_DOMINATES_RECORDED_STATS" as const
      : losses ? "EQUIPPED_DOMINATES_RECORDED_STATS" as const : "RECORDED_STAT_TIE" as const;
  return {
    slot, equippedItemRef, values, classification, provenance: "DERIVED",
    reason: "Derived from complete numeric GetItemStats tables for exact item variants. Missing keys are zero only within two complete tables. This compares the recorded stat vector; it does not weight stats for a build or include unreported effects.",
    ...(itemClass === "Weapon" ? { weaponMetrics: {
      dps: values.filter((row) => /DAMAGE_PER_SECOND/i.test(row.key)).map((row) => ({ key: row.key, candidate: row.candidate, equipped: row.equipped, delta: row.delta })),
      speed: { state: "UNKNOWN" as const, reason: "The captured item API tables do not contain a separately validated weapon-speed field." },
    } } : {}),
  };
}

export function calibrateForeverStatDelta(input: {
  candidate: ForeverStatTable | undefined;
  equipped: ForeverStatTable | undefined;
  delta: ForeverStatTable | undefined;
}): { state: "MATCHES_CANDIDATE_MINUS_EQUIPPED" | "MATCHES_EQUIPPED_MINUS_CANDIDATE" | "CONFLICT" | "UNKNOWN"; matchedKeys: string[]; reason: string } {
  const a = completeNumericTable(input.candidate);
  const b = completeNumericTable(input.equipped);
  const d = completeNumericTable(input.delta);
  if (!a || !b || !d) return { state: "UNKNOWN", matchedKeys: [], reason: "Complete exact-variant GetItemStats and GetItemStatDelta tables are required to calibrate delta direction." };
  const keys = Object.keys(d).filter((key) => key in a && key in b).sort();
  if (!keys.length) return { state: "UNKNOWN", matchedKeys: [], reason: "No stat key is shared by the delta table and both exact item stat tables." };
  const item1minus2 = keys.filter((key) => Math.abs(d[key]! - (a[key]! - b[key]!)) < 1e-9);
  const item2minus1 = keys.filter((key) => Math.abs(d[key]! - (b[key]! - a[key]!)) < 1e-9);
  if (item1minus2.length === keys.length && item2minus1.length !== keys.length) return { state: "MATCHES_CANDIDATE_MINUS_EQUIPPED", matchedKeys: keys, reason: "Observed API deltas match the candidate-first raw GetItemStats differences for every shared key." };
  if (item2minus1.length === keys.length && item1minus2.length !== keys.length) return { state: "MATCHES_EQUIPPED_MINUS_CANDIDATE", matchedKeys: keys, reason: "Observed API deltas match the equipped-second raw GetItemStats differences for every shared key." };
  return { state: "CONFLICT", matchedKeys: keys, reason: "The delta table does not consistently agree with either exact GetItemStats subtraction direction." };
}

export function classifyForeverRecordedUpgrade(comparisons: ForeverStatComparison[], slot: ForeverSlotCompatibility): {
  status: "POSSIBLE_RECORDED_STAT_UPGRADE" | "RECORDED_STAT_TRADEOFF" | "NO_RECORDED_STAT_GAIN" | "RECORDED_STAT_SIDEGRADE" | "POSSIBLE_EMPTY_SLOT_FILL" | "REQUIRES_HAND_CONFLICT_RESOLUTION" | "UNKNOWN";
  confidence: "LIMITED_RAW_STATS" | "STRUCTURAL_ONLY" | "UNKNOWN";
  reason: string;
} {
  if (slot.state !== "MAPPED") return { status: "UNKNOWN", confidence: "UNKNOWN", reason: "Item slot mapping is not established." };
  if (slot.conflicts.some((conflict) => conflict.state === "REQUIRES_REPLACEMENT")) return { status: "REQUIRES_HAND_CONFLICT_RESOLUTION", confidence: "STRUCTURAL_ONLY", reason: "An observed hand-slot conflict must be resolved before interpreting this as a usable slot fill or upgrade." };
  if (slot.knownEmptySlots.length > 0) return { status: "POSSIBLE_EMPTY_SLOT_FILL", confidence: "STRUCTURAL_ONLY", reason: `The current complete equipment scan shows mapped slot${slot.knownEmptySlots.length === 1 ? "" : "s"} ${slot.knownEmptySlots.join(", ")} empty. This is a possible slot fill, not a proven improvement or eligibility claim.` };
  if (!comparisons.length) return { status: "UNKNOWN", confidence: "UNKNOWN", reason: "No complete same-slot stat comparison is available." };
  if (comparisons.some((row) => row.classification === "CANDIDATE_DOMINATES_RECORDED_STATS")) return { status: "POSSIBLE_RECORDED_STAT_UPGRADE", confidence: "LIMITED_RAW_STATS", reason: "The candidate strictly dominates at least one structurally compatible equipped stat vector. Build weights, weapon interactions, set effects, and other unreported effects remain unknown." };
  if (comparisons.some((row) => row.classification === "STAT_TRADEOFF")) return { status: "RECORDED_STAT_TRADEOFF", confidence: "LIMITED_RAW_STATS", reason: "The candidate gains some recorded stats and loses others; no unsupported stat weights are applied." };
  if (comparisons.every((row) => row.classification === "RECORDED_STAT_TIE")) return { status: "RECORDED_STAT_SIDEGRADE", confidence: "LIMITED_RAW_STATS", reason: "All compared recorded stat values match; hidden effects and build suitability are not evaluated." };
  return { status: "NO_RECORDED_STAT_GAIN", confidence: "LIMITED_RAW_STATS", reason: "The candidate does not improve any compared recorded stat vector. This does not prove it is useless; hidden effects and build suitability are unknown." };
}

export function evaluateForeverTransferability(bound: boolean | undefined): {
  state: "BLOCKED_BOUND_TO_SOURCE" | "UNKNOWN";
  reason: string;
} {
  return bound === true
    ? { state: "BLOCKED_BOUND_TO_SOURCE", reason: "The current container observation says this item is bound to the source character; ordinary transfer to another character is blocked." }
    : { state: "UNKNOWN", reason: "An unbound or missing bound facet does not establish account membership, recipient access, a trade route, or the item's future binding behavior." };
}

export function assessForeverEligibility(input: {
  sameCharacter: boolean;
  apiEquippable?: boolean;
  apiObservedRecent: boolean;
  requiredLevel?: number;
  recipientLevel?: number;
}): {
  state: "INELIGIBLE_REQUIRED_LEVEL" | "UNKNOWN";
  playerApiSignal: "TRUE" | "FALSE" | "UNKNOWN";
  requiredLevel: "MET" | "NOT_MET" | "UNKNOWN";
  reason: string;
} {
  const level = input.requiredLevel !== undefined && input.recipientLevel !== undefined
    ? input.requiredLevel <= input.recipientLevel ? "MET" as const : "NOT_MET" as const : "UNKNOWN" as const;
  const playerApiSignal = input.sameCharacter && input.apiObservedRecent && typeof input.apiEquippable === "boolean" ? input.apiEquippable ? "TRUE" as const : "FALSE" as const : "UNKNOWN" as const;
  if (level === "NOT_MET" && playerApiSignal === "TRUE") return { state: "UNKNOWN", playerApiSignal, requiredLevel: level, reason: "Conflicting evidence: the fresh recipient level is below the required level while the player-scoped API returned true. Neither result is silently preferred." };
  if (level === "NOT_MET") return { state: "INELIGIBLE_REQUIRED_LEVEL", playerApiSignal, requiredLevel: level, reason: "Fresh observed recipient level is below the observed item required level." };
  if (playerApiSignal !== "UNKNOWN") return { state: "UNKNOWN", playerApiSignal, requiredLevel: level, reason: `Forever C_Item.IsEquippableItem returned ${playerApiSignal.toLowerCase()} for this exact item variant on this same character. This signal does not by itself establish class restrictions, weapon proficiency, or full gear eligibility.` };
  return { state: "UNKNOWN", playerApiSignal, requiredLevel: level, reason: "The player-specific equipability API result is unavailable for this recipient. A level pass alone does not prove class, proficiency, or other restrictions are met." };
}

export function assessForeverSuitability(input: {
  activeSpecializationID?: number;
  itemSpecializationIDs?: number[];
  specializationEvidenceCurrent: boolean;
}): { state: "OBSERVED_SPEC_TAG_MATCH" | "OBSERVED_SPEC_TAG_MISMATCH" | "UNKNOWN"; reason: string } {
  if (!input.specializationEvidenceCurrent || input.activeSpecializationID === undefined || !input.itemSpecializationIDs) {
    return { state: "UNKNOWN", reason: "Current recipient specialization and a complete item-specification API result are required; class alone is not treated as a build." };
  }
  if (input.itemSpecializationIDs.length === 0) return { state: "UNKNOWN", reason: "The item API returned no specialization tags; absence is not treated as unsuitable." };
  return input.itemSpecializationIDs.includes(input.activeSpecializationID)
    ? { state: "OBSERVED_SPEC_TAG_MATCH", reason: "The item API's observed useful-specialization list includes the recipient's observed active specialization. This is a suitability hint, not an upgrade or equipability result." }
    : { state: "OBSERVED_SPEC_TAG_MISMATCH", reason: "The item API returned specialization tags and none matches the observed active specialization. This is a suitability caution, not proof of ineligibility." };
}
