/**
 * Explicit Forever 1.60.1 gear-rule adapter. The class/armor table is a
 * Classic-derived hypothesis, not a live-validated Forever rule. Its results
 * can narrow possibilities but never produce confirmed positive eligibility.
 */
export type ForeverRuleState = "PASS" | "FAIL" | "UNKNOWN" | "NOT_APPLICABLE";
export type ForeverClassName = "Druid" | "Hunter" | "Mage" | "Paladin" | "Priest" | "Rogue" | "Shaman" | "Warlock" | "Warrior";

const ARMOR_ORDER = ["Cloth", "Leather", "Mail", "Plate"] as const;
type Armor = typeof ARMOR_ORDER[number];

function canonicalClass(name: string | undefined): ForeverClassName | undefined {
  return typeof name === "string" ? (Object.keys(CLASS_ARMOR).find((key) => key.toLocaleLowerCase() === name.toLocaleLowerCase()) as ForeverClassName | undefined) : undefined;
}

// Classic-derived armor progression. Retained as a separately labeled
// hypothesis so a future capture/review can enable or reject it cleanly.
const CLASS_ARMOR: Readonly<Record<ForeverClassName, { base: Armor; next?: Armor; atLevel?: number }>> = {
  Druid: { base: "Leather" }, Hunter: { base: "Leather", next: "Mail", atLevel: 40 },
  Mage: { base: "Cloth" }, Paladin: { base: "Mail", next: "Plate", atLevel: 40 },
  Priest: { base: "Cloth" }, Rogue: { base: "Leather" }, Shaman: { base: "Leather", next: "Mail", atLevel: 40 },
  Warlock: { base: "Cloth" }, Warrior: { base: "Mail", next: "Plate", atLevel: 40 },
};

function armorForClass(className: string | undefined, level: number | undefined): { armor?: Armor; reason: string } {
  const canonical = canonicalClass(className);
  if (!canonical) return { reason: "Recipient class is missing or outside the documented nine-class Classic hypothesis." };
  const row = CLASS_ARMOR[canonical];
  if (row.next && level !== undefined && level >= (row.atLevel ?? Number.POSITIVE_INFINITY)) return { armor: row.next, reason: `${className} armor progression hypothesis at level ${level}.` };
  if (row.next && level === undefined) return { armor: row.base, reason: `${className} base armor is a Classic-derived hypothesis; level ${row.atLevel} transition is unknown without a fresh level.` };
  return { armor: row.base, reason: `${className} armor proficiency is a Classic-derived hypothesis.` };
}

export function evaluateForeverArmorProficiency(input: {
  itemClass?: string;
  itemSubclass?: string;
  recipientClass?: string;
  recipientLevel?: number;
  rulesetEvidence?: "FOREVER_LIVE_VALIDATED" | "CLASSIC_DERIVED_HYPOTHESIS" | "UNKNOWN";
}): { state: ForeverRuleState; armor?: Armor; confidence: "LIVE_VALIDATED" | "CLASSIC_DERIVED_HYPOTHESIS" | "UNKNOWN"; reason: string } {
  if (input.itemClass && input.itemClass !== "Armor") return { state: "NOT_APPLICABLE", confidence: "UNKNOWN", reason: "Observed item class is not Armor; armor-family proficiency does not apply." };
  if (!input.itemSubclass) return { state: "UNKNOWN", confidence: "UNKNOWN", reason: "Item armor category is unavailable." };
  const armorName = ARMOR_ORDER.find((name) => name.toLocaleLowerCase() === input.itemSubclass!.toLocaleLowerCase());
  if (!armorName) return { state: "UNKNOWN", confidence: "UNKNOWN", reason: `Observed armor subtype “${input.itemSubclass}” is not in the verified category adapter.` };
  if (!canonicalClass(input.recipientClass)) return { state: "UNKNOWN", confidence: "UNKNOWN", reason: "Recipient class is missing or is not covered by the Classic-derived armor table." };
  const allowed = armorForClass(input.recipientClass, input.recipientLevel);
  const result: ForeverRuleState = ARMOR_ORDER.indexOf(armorName) <= ARMOR_ORDER.indexOf(allowed.armor!) ? "PASS" : "FAIL";
  const live = input.rulesetEvidence === "FOREVER_LIVE_VALIDATED";
  return {
    state: result,
    armor: armorName,
    confidence: live ? "LIVE_VALIDATED" : "CLASSIC_DERIVED_HYPOTHESIS",
    reason: `${result === "PASS" ? "Within" : "Outside"} the armor category predicted by the Forever-specific adapter (${allowed.reason}). ${live ? "Rule has been marked live-validated." : "Classic-derived only; this is a screening hint, not a confirmed Forever restriction."}`,
  };
}

export function evaluateForeverExplicitClassRestriction(input: {
  restrictionState: "OBSERVED_COMPLETE" | "OBSERVED_PARTIAL" | "UNKNOWN";
  allowedClasses?: string[];
  recipientClass?: string;
}): { state: "PASS" | "FAIL" | "UNKNOWN"; reason: string } {
  if (input.restrictionState !== "OBSERVED_COMPLETE" || !Array.isArray(input.allowedClasses) || !input.recipientClass) {
    return { state: "UNKNOWN", reason: "A complete exact-item class-restriction observation and recipient class are required." };
  }
  return input.allowedClasses.some((name) => name.toLocaleLowerCase() === input.recipientClass!.toLocaleLowerCase())
    ? { state: "PASS", reason: "Recipient class appears in the observed complete allowed-class list." }
    : { state: "FAIL", reason: "Recipient class is absent from the observed complete allowed-class list." };
}

export function assessForeverBinding(input: {
  currentBound?: boolean;
  accountBound?: boolean;
  accountBoundUntilEquip?: boolean;
  bindType?: number;
  freshness: "recent" | "stale" | "unknown";
  apiSemanticsValidated: boolean;
}): {
  state: "SOULBOUND" | "ACCOUNT_BOUND" | "ACCOUNT_BOUND_UNTIL_EQUIP" | "NOT_CURRENTLY_BOUND" | "OTHER_BIND_RULE" | "UNKNOWN";
  transferability: "BLOCKED_TO_OTHER_CHARACTER" | "POTENTIALLY_ACCOUNT_TRANSFERABLE" | "UNKNOWN";
  reason: string;
} {
  if (input.freshness !== "recent" || !input.apiSemanticsValidated) return {
    state: "UNKNOWN", transferability: "UNKNOWN",
    reason: "Binding inputs are stale/unknown or the target-client meaning of the binding APIs has not been validated; raw values are not promoted to soulbound/account-bound conclusions.",
  };
  if (input.accountBound === true && input.accountBoundUntilEquip === true) return {
    state: "ACCOUNT_BOUND_UNTIL_EQUIP", transferability: "POTENTIALLY_ACCOUNT_TRANSFERABLE",
    reason: "Fresh validated APIs report account-bound-until-equipped; account membership and actual recipient access still need proof.",
  };
  if (input.accountBound === true) return {
    state: "ACCOUNT_BOUND", transferability: "POTENTIALLY_ACCOUNT_TRANSFERABLE",
    reason: "Fresh validated API reports account-bound. This does not establish that the proposed recipient shares the relevant account or can access this location.",
  };
  if (input.accountBound === false && input.currentBound === true) return {
    state: "SOULBOUND", transferability: "BLOCKED_TO_OTHER_CHARACTER",
    reason: "Fresh validated evidence reports currently bound and not account-bound; ordinary cross-character transfer is blocked under the validated API contract.",
  };
  if (input.accountBound === false && input.currentBound === false) return {
    state: "NOT_CURRENTLY_BOUND", transferability: "UNKNOWN",
    reason: "The item is not currently bound, but trade timers, future bind-on-equip behavior, recipient access, and transfer route remain unresolved.",
  };
  if (typeof input.bindType === "number") return {
    state: "OTHER_BIND_RULE", transferability: "UNKNOWN",
    reason: `A validated binding category (${input.bindType}) is present, but current ownership/bound status or a permitted route is missing.`,
  };
  return { state: "UNKNOWN", transferability: "UNKNOWN", reason: "No complete fresh binding evidence establishes the item's binding class or a transfer route." };
}

export function evaluateForeverWeaponProficiency(input: {
  itemSubclass?: string;
  observedSkillLines?: Array<{ name?: string; rank?: number; provenance?: string }>;
  skillSemantics?: "FOREVER_LIVE_VALIDATED" | "CLASSIC_DERIVED_HYPOTHESIS" | "UNKNOWN";
}): { state: ForeverRuleState; confidence: "LIVE_VALIDATED" | "CLASSIC_DERIVED_HYPOTHESIS" | "UNKNOWN"; matchingSkill?: string; reason: string } {
  if (!input.itemSubclass) return { state: "UNKNOWN", confidence: "UNKNOWN", reason: "Weapon subclass is unavailable." };
  const expected = input.itemSubclass.trim().toLocaleLowerCase();
  const observed = (input.observedSkillLines ?? []).filter((line) => line.provenance === "OBSERVED" && typeof line.name === "string" && (line.rank ?? 0) > 0);
  const match = observed.find((line) => line.name!.trim().toLocaleLowerCase() === expected);
  if (!match) return { state: "UNKNOWN", confidence: "UNKNOWN", reason: `No fresh observed positive-rank skill line exactly matches “${input.itemSubclass}”. Absence or localized naming does not prove lack of proficiency.` };
  const live = input.skillSemantics === "FOREVER_LIVE_VALIDATED";
  return { state: "PASS", confidence: live ? "LIVE_VALIDATED" : "CLASSIC_DERIVED_HYPOTHESIS", matchingSkill: match.name,
    reason: `Observed positive-rank skill line “${match.name}” matches the item subtype. ${live ? "Skill semantics are live-validated." : "Skill-to-proficiency interpretation is a Classic-derived hypothesis; it is not complete item eligibility."}` };
}

export function rankForeverRecipientFit(input: Array<{
  identityKey: string;
  validatedPriorityOrder?: number;
  eligibility: "ELIGIBLE" | "INELIGIBLE" | "UNKNOWN";
  armor: ForeverRuleState;
  weapon: ForeverRuleState;
  level: ForeverRuleState;
  slot: ForeverRuleState;
  upgrade: "DOMINATES" | "TRADEOFF" | "NO_GAIN" | "UNKNOWN";
  transferability: "ALLOWED" | "BLOCKED" | "UNKNOWN";
}>): Array<{ identityKey: string; rank?: number; state: "RANKED_POTENTIAL" | "EXCLUDED" | "UNRANKED"; reasons: string[] }> {
  const rows = input.map((row) => {
    const reasons: string[] = [];
    if (row.eligibility === "INELIGIBLE" || row.armor === "FAIL" || row.weapon === "FAIL" || row.level === "FAIL" || row.slot === "FAIL" || row.transferability === "BLOCKED") {
      if (row.transferability === "BLOCKED") reasons.push("Observed transfer restriction blocks this recipient.");
      if (row.eligibility === "INELIGIBLE" || row.armor === "FAIL" || row.weapon === "FAIL" || row.level === "FAIL" || row.slot === "FAIL") reasons.push("A supported eligibility or slot check excludes this recipient.");
      return { identityKey: row.identityKey, state: "EXCLUDED" as const, reasons };
    }
    const uncertain = [row.eligibility, row.armor, row.weapon, row.level, row.slot, row.transferability].includes("UNKNOWN");
    if (uncertain || row.upgrade === "UNKNOWN" || row.upgrade === "TRADEOFF") {
      reasons.push("Eligibility, improvement, or transfer evidence is incomplete; recipient remains unranked.");
      return { identityKey: row.identityKey, state: "UNRANKED" as const, reasons };
    }
    if (!Number.isSafeInteger(row.validatedPriorityOrder)) return { identityKey: row.identityKey, state: "UNRANKED" as const, reasons: ["A validated, comparable allocation-priority result was not supplied; no array-order ranking is invented."] };
    return { identityKey: row.identityKey, state: "RANKED_POTENTIAL" as const, reasons: ["All supplied dimensions and a validated comparable priority are resolved; rank is only among the supplied set and does not execute a transfer."] };
  });
  const rankedInput = input.filter((row) => Number.isSafeInteger(row.validatedPriorityOrder));
  const ranked = rows.filter((row) => row.state === "RANKED_POTENTIAL").sort((a, b) => {
    const av = rankedInput.find((row) => row.identityKey === a.identityKey)?.validatedPriorityOrder ?? Number.POSITIVE_INFINITY;
    const bv = rankedInput.find((row) => row.identityKey === b.identityKey)?.validatedPriorityOrder ?? Number.POSITIVE_INFINITY;
    return av - bv;
  });
  let rank = 0; let prior: number | undefined;
  for (const row of ranked) {
    const value = rankedInput.find((candidate) => candidate.identityKey === row.identityKey)?.validatedPriorityOrder;
    if (value === undefined) continue;
    if (value !== prior) rank += 1;
    (row as { rank?: number }).rank = rank;
    prior = value;
  }
  return rows;
}

export function combineForeverEligibility(input: {
  requiredLevel: "MET" | "NOT_MET" | "UNKNOWN";
  explicitClassRestriction: ForeverRuleState;
  armorProficiency: ReturnType<typeof evaluateForeverArmorProficiency>;
  weaponProficiency: ReturnType<typeof evaluateForeverWeaponProficiency> | { state: "NOT_APPLICABLE"; confidence: "UNKNOWN"; reason: string };
  slotCompatibility: "MAPPED" | "UNKNOWN" | "NOT_EQUIPMENT";
  playerSpecificEquipCheck?: "TRUE" | "FALSE" | "UNKNOWN";
}): { state: "INELIGIBLE" | "POSSIBLE_BY_RULE_SCREEN" | "UNKNOWN"; confidence: "DIRECT_OBSERVATION" | "CLASSIC_DERIVED_HYPOTHESIS" | "UNKNOWN"; reasons: string[] } {
  if (input.requiredLevel === "NOT_MET") return { state: "INELIGIBLE", confidence: "DIRECT_OBSERVATION", reasons: ["Fresh observed required level exceeds the fresh recipient level."] };
  if (input.explicitClassRestriction === "FAIL") return { state: "INELIGIBLE", confidence: "DIRECT_OBSERVATION", reasons: ["Fresh complete exact-item class restriction excludes this recipient."] };
  if (input.slotCompatibility === "NOT_EQUIPMENT") return { state: "INELIGIBLE", confidence: "DIRECT_OBSERVATION", reasons: ["Observed equip-location identifies this as non-equipment for the gear-slot evaluator."] };
  if (input.playerSpecificEquipCheck === "FALSE") return { state: "UNKNOWN", confidence: "UNKNOWN", reasons: ["The current-player CanUseItem signal is negative, but its base-item scope does not establish exact-variant or cross-character eligibility; no positive rule-screen conclusion is made."] };
  if (input.armorProficiency.state === "FAIL" && input.armorProficiency.confidence === "LIVE_VALIDATED") return { state: "INELIGIBLE", confidence: "DIRECT_OBSERVATION", reasons: ["Live-validated armor proficiency excludes this recipient."] };
  const hardWeaponFailure = input.weaponProficiency.state === "FAIL" && input.weaponProficiency.confidence === "LIVE_VALIDATED";
  if (hardWeaponFailure) return { state: "INELIGIBLE", confidence: "DIRECT_OBSERVATION", reasons: ["Live-validated observed proficiency rule excludes the recipient."] };
  const checks = [input.requiredLevel !== "UNKNOWN", input.explicitClassRestriction !== "UNKNOWN",
    input.armorProficiency.state === "PASS" && input.armorProficiency.confidence === "LIVE_VALIDATED",
    input.weaponProficiency.state === "PASS" && input.weaponProficiency.confidence === "LIVE_VALIDATED",
    input.slotCompatibility === "MAPPED", input.playerSpecificEquipCheck === "TRUE"];
  if (checks.every(Boolean)) return { state: "POSSIBLE_BY_RULE_SCREEN", confidence: "DIRECT_OBSERVATION", reasons: ["All supplied checks pass. This still does not establish omitted item requirements or an upgrade."] };
  const requiredPositiveChecks = input.requiredLevel === "MET" && input.slotCompatibility === "MAPPED"
    && input.playerSpecificEquipCheck === "TRUE";
  const hypothesisOnlyPasses = [input.armorProficiency, input.weaponProficiency].every((check) => check.state === "NOT_APPLICABLE"
    || (check.state === "PASS" && check.confidence === "CLASSIC_DERIVED_HYPOTHESIS"));
  if (requiredPositiveChecks && hypothesisOnlyPasses
    && (input.armorProficiency.confidence === "CLASSIC_DERIVED_HYPOTHESIS" || input.weaponProficiency.confidence === "CLASSIC_DERIVED_HYPOTHESIS")) {
    return { state: "POSSIBLE_BY_RULE_SCREEN", confidence: "CLASSIC_DERIVED_HYPOTHESIS", reasons: ["Required level, mapped slot, and current-player item signal pass; remaining applicable proficiency screens pass only under Classic-derived hypotheses. This is a candidate for review, not confirmed eligibility."] };
  }
  return { state: "UNKNOWN", confidence: "UNKNOWN", reasons: ["At least one required eligibility dimension is missing, partial, or not target-client validated."] };
}

export function evaluateForeverRecipientFit(input: {
  identityKey: string;
  eligibility: ReturnType<typeof combineForeverEligibility>;
  level: "MET" | "NOT_MET" | "UNKNOWN";
  slotCompatibility: "MAPPED" | "UNKNOWN" | "NOT_EQUIPMENT";
  upgrade: "POSSIBLE_RECORDED_STAT_UPGRADE" | "POSSIBLE_EMPTY_SLOT_FILL" | "RECORDED_STAT_TRADEOFF" | "NO_RECORDED_STAT_GAIN" | "RECORDED_STAT_SIDEGRADE" | "REQUIRES_HAND_CONFLICT_RESOLUTION" | "UNKNOWN";
  sourceLocation: "LOCAL_CARRIED" | "OTHER_CHARACTER" | "UNKNOWN";
  transferability: "BLOCKED" | "ALLOWED" | "UNKNOWN";
}): { identityKey: string; state: "EXCLUDED" | "LOCAL_REVIEW" | "POTENTIAL_GEAR_FIT" | "UNRANKED"; rank?: number; transferability: "BLOCKED" | "ALLOWED" | "UNKNOWN"; reasons: string[] } {
  if (input.level === "NOT_MET" || input.slotCompatibility === "NOT_EQUIPMENT" || input.eligibility.state === "INELIGIBLE") {
    return { identityKey: input.identityKey, state: "EXCLUDED", transferability: input.transferability, reasons: [
      ...(input.level === "NOT_MET" ? ["Fresh required-level comparison excludes this character."] : []),
      ...(input.slotCompatibility === "NOT_EQUIPMENT" ? ["Observed item category is not equipment."] : []),
      ...(input.eligibility.state === "INELIGIBLE" ? input.eligibility.reasons : []),
    ] };
  }
  const gearSignal = input.upgrade === "POSSIBLE_RECORDED_STAT_UPGRADE" || input.upgrade === "POSSIBLE_EMPTY_SLOT_FILL";
  if (input.sourceLocation === "LOCAL_CARRIED" && gearSignal && input.eligibility.state === "POSSIBLE_BY_RULE_SCREEN") {
    return { identityKey: input.identityKey, state: "LOCAL_REVIEW", transferability: "ALLOWED", reasons: ["Observed source-local item and gear comparison justify user review; this is not a confirmed equip/upgrade conclusion.", ...input.eligibility.reasons] };
  }
  if (gearSignal && input.slotCompatibility === "MAPPED") {
    return { identityKey: input.identityKey, state: "POTENTIAL_GEAR_FIT", transferability: input.transferability, reasons: [
      "Slot or recorded-stat evidence warrants evaluation for this character.",
      ...(input.transferability === "UNKNOWN" ? ["No verified source-to-recipient transfer route; this is not an allocation recommendation."] : []),
      ...input.eligibility.reasons,
    ] };
  }
  return { identityKey: input.identityKey, state: "UNRANKED", transferability: input.transferability, reasons: ["Available evidence does not support a recipient ranking; one or more eligibility, comparison, or transfer dimensions remain unresolved.", ...input.eligibility.reasons] };
}
