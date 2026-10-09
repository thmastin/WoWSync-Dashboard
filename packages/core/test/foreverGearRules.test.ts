import test from "node:test";
import assert from "node:assert/strict";
import { assessForeverBinding, combineForeverEligibility, evaluateForeverArmorProficiency, evaluateForeverExplicitClassRestriction, evaluateForeverWeaponProficiency, rankForeverRecipientFit } from "../src/foreverGearRules.ts";

test("Classic-derived armor rules are implemented but labeled as an unvalidated hypothesis", () => {
  assert.deepEqual(evaluateForeverArmorProficiency({ itemClass: "Armor", itemSubclass: "Plate", recipientClass: "Warrior", recipientLevel: 39 }), {
    state: "FAIL", armor: "Plate", confidence: "CLASSIC_DERIVED_HYPOTHESIS",
    reason: "Outside the armor category predicted by the Forever-specific adapter (Warrior armor proficiency is a Classic-derived hypothesis.). Classic-derived only; this is a screening hint, not a confirmed Forever restriction.",
  });
  assert.equal(evaluateForeverArmorProficiency({ itemClass: "Armor", itemSubclass: "Plate", recipientClass: "Warrior", recipientLevel: 40 }).state, "PASS");
  assert.equal(evaluateForeverArmorProficiency({ itemClass: "Armor", itemSubclass: "Plate", recipientClass: "Warrior" }).state, "FAIL");
  assert.equal(evaluateForeverArmorProficiency({ itemClass: "Armor", itemSubclass: "Cloth", recipientClass: "Evoker", recipientLevel: 70 }).state, "UNKNOWN");
  assert.equal(evaluateForeverArmorProficiency({ itemClass: "Armor", itemSubclass: "Shield", recipientClass: "Warrior", recipientLevel: 70 }).state, "UNKNOWN");
});

test("explicit class restrictions require complete exact-item evidence", () => {
  assert.equal(evaluateForeverExplicitClassRestriction({ restrictionState: "OBSERVED_PARTIAL", allowedClasses: ["Mage"], recipientClass: "Warrior" }).state, "UNKNOWN");
  assert.equal(evaluateForeverExplicitClassRestriction({ restrictionState: "OBSERVED_COMPLETE", allowedClasses: ["Mage"], recipientClass: "Warrior" }).state, "FAIL");
  assert.equal(evaluateForeverExplicitClassRestriction({ restrictionState: "OBSERVED_COMPLETE", allowedClasses: ["Mage", "Warrior"], recipientClass: "Warrior" }).state, "PASS");
});

test("weapon proficiency needs a fresh positive rank exact skill name and stays hypothesis-labeled", () => {
  const skill = [{ name: "Swords", rank: 1, provenance: "OBSERVED" }];
  assert.equal(evaluateForeverWeaponProficiency({ itemSubclass: "Swords", observedSkillLines: skill, skillSemantics: "CLASSIC_DERIVED_HYPOTHESIS" }).state, "PASS");
  assert.equal(evaluateForeverWeaponProficiency({ itemSubclass: "Swords", observedSkillLines: skill, skillSemantics: "CLASSIC_DERIVED_HYPOTHESIS" }).confidence, "CLASSIC_DERIVED_HYPOTHESIS");
  assert.equal(evaluateForeverWeaponProficiency({ itemSubclass: "Swords", observedSkillLines: [{ name: "Swords", rank: 0, provenance: "OBSERVED" }] }).state, "UNKNOWN");
  assert.equal(evaluateForeverWeaponProficiency({ itemSubclass: "Swords", observedSkillLines: [{ name: "Swords", rank: 300, provenance: "LAST_SEEN" }] }).state, "UNKNOWN");
  assert.equal(evaluateForeverWeaponProficiency({ itemSubclass: "Swords", observedSkillLines: [{ name: "Espadas", rank: 30, provenance: "OBSERVED" }] }).state, "UNKNOWN");
});

test("binding classification never upgrades raw/ambiguous bound booleans to transfer rules", () => {
  assert.equal(assessForeverBinding({ currentBound: true, accountBound: false, freshness: "recent", apiSemanticsValidated: false }).state, "UNKNOWN");
  assert.equal(assessForeverBinding({ currentBound: true, accountBound: false, freshness: "recent", apiSemanticsValidated: true }).state, "SOULBOUND");
  assert.equal(assessForeverBinding({ accountBound: true, freshness: "recent", apiSemanticsValidated: true }).state, "ACCOUNT_BOUND");
  assert.equal(assessForeverBinding({ accountBound: true, accountBoundUntilEquip: true, freshness: "recent", apiSemanticsValidated: true }).transferability, "POTENTIALLY_ACCOUNT_TRANSFERABLE");
  assert.equal(assessForeverBinding({ currentBound: false, accountBound: false, freshness: "recent", apiSemanticsValidated: true }).transferability, "UNKNOWN");
  assert.equal(assessForeverBinding({ accountBound: true, freshness: "stale", apiSemanticsValidated: true }).state, "UNKNOWN");
});

test("combined eligibility separates hard failures, rule-screen possibilities and unknowns", () => {
  const armor = evaluateForeverArmorProficiency({ itemSubclass: "Plate", recipientClass: "Warrior", recipientLevel: 40 });
  const armorFail = evaluateForeverArmorProficiency({ itemSubclass: "Plate", recipientClass: "Warrior", recipientLevel: 39 });
  const weapon = { state: "NOT_APPLICABLE" as const, confidence: "UNKNOWN" as const, reason: "not a weapon" };
  assert.equal(combineForeverEligibility({ requiredLevel: "NOT_MET", explicitClassRestriction: "UNKNOWN", armorProficiency: armor, weaponProficiency: weapon, slotCompatibility: "MAPPED" }).state, "INELIGIBLE");
  assert.equal(combineForeverEligibility({ requiredLevel: "MET", explicitClassRestriction: "PASS", armorProficiency: armor, weaponProficiency: weapon, slotCompatibility: "MAPPED", playerSpecificEquipCheck: "TRUE" }).state, "POSSIBLE_BY_RULE_SCREEN");
  assert.equal(combineForeverEligibility({ requiredLevel: "MET", explicitClassRestriction: "UNKNOWN", armorProficiency: armor, weaponProficiency: weapon, slotCompatibility: "MAPPED", playerSpecificEquipCheck: "TRUE" }).state, "POSSIBLE_BY_RULE_SCREEN");
  assert.equal(combineForeverEligibility({ requiredLevel: "MET", explicitClassRestriction: "UNKNOWN", armorProficiency: armor, weaponProficiency: weapon, slotCompatibility: "MAPPED" }).state, "UNKNOWN", "missing recipient-specific use evidence cannot yield a potential fit");
  assert.equal(combineForeverEligibility({ requiredLevel: "MET", explicitClassRestriction: "UNKNOWN", armorProficiency: armor, weaponProficiency: weapon, slotCompatibility: "UNKNOWN", playerSpecificEquipCheck: "TRUE" }).state, "UNKNOWN", "unmapped slot cannot yield a potential fit");
  assert.equal(combineForeverEligibility({ requiredLevel: "UNKNOWN", explicitClassRestriction: "UNKNOWN", armorProficiency: armor, weaponProficiency: weapon, slotCompatibility: "MAPPED", playerSpecificEquipCheck: "TRUE" }).state, "UNKNOWN", "missing level cannot yield a potential fit");
  assert.equal(combineForeverEligibility({ requiredLevel: "MET", explicitClassRestriction: "UNKNOWN", armorProficiency: armorFail, weaponProficiency: weapon, slotCompatibility: "MAPPED", playerSpecificEquipCheck: "TRUE" }).state, "UNKNOWN", "a failed Classic armor hypothesis must never be promoted to a possible fit");
  assert.equal(combineForeverEligibility({ requiredLevel: "MET", explicitClassRestriction: "PASS", armorProficiency: armor, weaponProficiency: weapon, slotCompatibility: "MAPPED", playerSpecificEquipCheck: "FALSE" }).state, "UNKNOWN", "negative base-item player signal cannot be overridden by a hypothesis");
});

test("recipient ranks are withheld under unknown transfer scope and exclusions are explained", () => {
  const results = rankForeverRecipientFit([
    { identityKey: "unknown", eligibility: "UNKNOWN", armor: "UNKNOWN", weapon: "UNKNOWN", level: "UNKNOWN", slot: "UNKNOWN", upgrade: "UNKNOWN", transferability: "UNKNOWN" },
    { identityKey: "excluded", eligibility: "INELIGIBLE", armor: "FAIL", weapon: "UNKNOWN", level: "PASS", slot: "PASS", upgrade: "UNKNOWN", transferability: "UNKNOWN" },
  ]);
  assert.deepEqual(results.map((row) => row.state), ["UNRANKED", "EXCLUDED"]);
  assert.equal(results.every((row) => row.rank === undefined), true);
  assert.match(results[1]!.reasons.join(" "), /excludes/);
  const resolvedWithoutPriority = rankForeverRecipientFit([{ identityKey: "fit", eligibility: "ELIGIBLE", armor: "PASS", weapon: "PASS", level: "PASS", slot: "PASS", upgrade: "DOMINATES", transferability: "ALLOWED" }]);
  assert.equal(resolvedWithoutPriority[0]?.state, "UNRANKED", "complete screens still do not create an arbitrary array-order rank");
  const withPriority = rankForeverRecipientFit([
    { identityKey: "second", validatedPriorityOrder: 2, eligibility: "ELIGIBLE", armor: "PASS", weapon: "PASS", level: "PASS", slot: "PASS", upgrade: "DOMINATES", transferability: "ALLOWED" },
    { identityKey: "first", validatedPriorityOrder: 1, eligibility: "ELIGIBLE", armor: "PASS", weapon: "PASS", level: "PASS", slot: "PASS", upgrade: "DOMINATES", transferability: "ALLOWED" },
  ]);
  assert.deepEqual(withPriority.map((row) => [row.identityKey, row.rank]), [["second", 2], ["first", 1]], "only an explicit validated comparable priority is ranked");
});
