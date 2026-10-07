import type { GearCandidateRow } from "./types.ts";
import type { StoredEquipmentObservation } from "./store.ts";

/** Retail-only rule data. Unknown/unsupported class/spec pairs are never guessed. */
export const RETAIL_GEAR_RULESET = "retail-midnight-12.1.5-conservative-v1" as const;
const SPECS: Record<string, Array<{ id: number; name: string; role: "TANK" | "HEALER" | "DAMAGER" }>> = {
  "Death Knight": [{ id: 250, name: "Blood", role: "TANK" }, { id: 251, name: "Frost", role: "DAMAGER" }, { id: 252, name: "Unholy", role: "DAMAGER" }],
  "Demon Hunter": [{ id: 577, name: "Havoc", role: "DAMAGER" }, { id: 581, name: "Vengeance", role: "TANK" }, { id: 1480, name: "Devourer", role: "DAMAGER" }],
  Druid: [{ id: 102, name: "Balance", role: "DAMAGER" }, { id: 103, name: "Feral", role: "DAMAGER" }, { id: 104, name: "Guardian", role: "TANK" }, { id: 105, name: "Restoration", role: "HEALER" }],
  Evoker: [{ id: 1467, name: "Devastation", role: "DAMAGER" }, { id: 1468, name: "Preservation", role: "HEALER" }, { id: 1473, name: "Augmentation", role: "DAMAGER" }],
  Hunter: [{ id: 253, name: "Beast Mastery", role: "DAMAGER" }, { id: 254, name: "Marksmanship", role: "DAMAGER" }, { id: 255, name: "Survival", role: "DAMAGER" }],
  Mage: [{ id: 62, name: "Arcane", role: "DAMAGER" }, { id: 63, name: "Fire", role: "DAMAGER" }, { id: 64, name: "Frost", role: "DAMAGER" }],
  Monk: [{ id: 268, name: "Brewmaster", role: "TANK" }, { id: 270, name: "Mistweaver", role: "HEALER" }, { id: 269, name: "Windwalker", role: "DAMAGER" }],
  Paladin: [{ id: 65, name: "Holy", role: "HEALER" }, { id: 66, name: "Protection", role: "TANK" }, { id: 70, name: "Retribution", role: "DAMAGER" }],
  Priest: [{ id: 256, name: "Discipline", role: "HEALER" }, { id: 257, name: "Holy", role: "HEALER" }, { id: 258, name: "Shadow", role: "DAMAGER" }],
  Rogue: [{ id: 259, name: "Assassination", role: "DAMAGER" }, { id: 260, name: "Outlaw", role: "DAMAGER" }, { id: 261, name: "Subtlety", role: "DAMAGER" }],
  Shaman: [{ id: 262, name: "Elemental", role: "DAMAGER" }, { id: 263, name: "Enhancement", role: "DAMAGER" }, { id: 264, name: "Restoration", role: "HEALER" }],
  Warlock: [{ id: 265, name: "Affliction", role: "DAMAGER" }, { id: 266, name: "Demonology", role: "DAMAGER" }, { id: 267, name: "Destruction", role: "DAMAGER" }],
  Warrior: [{ id: 71, name: "Arms", role: "DAMAGER" }, { id: 72, name: "Fury", role: "DAMAGER" }, { id: 73, name: "Protection", role: "TANK" }],
};

const ARMOR: Record<string, string> = { "Death Knight": "PLATE", Paladin: "PLATE", Warrior: "PLATE", Hunter: "MAIL", Shaman: "MAIL", Evoker: "MAIL", "Demon Hunter": "LEATHER", Druid: "LEATHER", Monk: "LEATHER", Rogue: "LEATHER", Mage: "CLOTH", Priest: "CLOTH", Warlock: "CLOTH" };
const ARMOR_SUBCLASS: Record<number, string> = { 1: "CLOTH", 2: "LEATHER", 3: "MAIL", 4: "PLATE" };
const evidence = <T>(v: { state: "KNOWN"; value: T } | { state: "UNKNOWN" }): T | undefined => v.state === "KNOWN" ? v.value : undefined;

export type QualifiedRetailEquipment =
  | { state: "QUALIFIED"; specID: number; snapshotId: number; observedAt: number; capture: number; revision: number; slots: Record<string, { empty?: boolean; itemID?: number; itemString?: string; name?: string; itemLevel?: number }> }
  | { state: "UNKNOWN"; reason: string };

function qualified(obs: StoredEquipmentObservation): number | undefined {
  const sc = obs.evidence.specEquipmentObservation as Record<string, unknown> | undefined;
  const link = sc?.equipmentObservation as Record<string, unknown> | undefined;
  const before = sc?.activeSpecBefore as Record<string, unknown> | undefined;
  const after = sc?.activeSpecAfter as Record<string, unknown> | undefined;
  if (obs.completeness !== "complete" || sc?.contractVersion !== 1 || sc.clientFamily !== "Retail" || sc.readiness !== "READY" || sc.stability !== "STABLE") return undefined;
  if (!link || link.observedAt !== obs.observedAt || link.capture !== obs.capture || link.revision !== obs.revision) return undefined;
  if (!Number.isSafeInteger(before?.specID) || (before!.specID as number) <= 0 || before?.specID !== after?.specID) return undefined;
  return before!.specID as number;
}

export function retainedRetailEquipment(observations: StoredEquipmentObservation[], specID: number): QualifiedRetailEquipment {
  const ordered = [...observations].sort((a, b) => b.observedAt - a.observedAt || b.capture - a.capture || b.revision - a.revision);
  const row = ordered.find((item) => qualified(item) === specID);
  if (!row) return { state: "UNKNOWN", reason: "No qualifying complete, stable, same-spec Retail equipment observation exists; observation age does not expire retained state." };
  const rawSlots = row.evidence.slots;
  const slots: Extract<QualifiedRetailEquipment, { state: "QUALIFIED" }>["slots"] = {};
  if (rawSlots && typeof rawSlots === "object" && !Array.isArray(rawSlots)) for (const [slot, raw] of Object.entries(rawSlots)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    const itemLevel = typeof item.itemLevel === "number" && Number.isFinite(item.itemLevel) ? item.itemLevel : undefined;
    slots[slot] = { ...(item.empty === true ? { empty: true } : {}), ...(typeof item.itemID === "number" ? { itemID: item.itemID } : {}), ...(typeof item.itemString === "string" ? { itemString: item.itemString } : {}), ...(typeof item.name === "string" ? { name: item.name } : {}), ...(itemLevel !== undefined ? { itemLevel } : {}) };
  }
  return { state: "QUALIFIED", specID, snapshotId: row.snapshotId, observedAt: row.observedAt, capture: row.capture, revision: row.revision, slots };
}

export interface RetailGearSpecAssessment {
  character: { identityKey: string; name: string; realm: string };
  spec: { specID: number; name: string; role: string };
  eligibility: "ELIGIBLE" | "INELIGIBLE" | "UNKNOWN";
  suitability: "POSSIBLE_BY_CHECKED_RULES" | "UNSUITABLE" | "UNKNOWN";
  primaryStatSuitability: "MATCH" | "MISMATCH" | "UNKNOWN";
  comparison: "UPGRADE_BY_ITEM_LEVEL" | "UPGRADE_BY_FILLING_EMPTY_SLOT" | "SIDEGRADE_BY_ITEM_LEVEL" | "DOWNGRADE_BY_ITEM_LEVEL" | "UNKNOWN";
  deltaItemLevel?: number;
  comparisonSlots?: string[];
  currentSnapshotObservation: { state: "QUALIFYING" | "NONQUALIFYING" | "UNKNOWN"; sourceSnapshotId?: number; observedAt?: number; specID?: number; reason: string };
  latestStoredObservation: { relationship: "LATEST_STORED_EQUIPMENT_OBSERVATION"; state: "QUALIFYING" | "NONQUALIFYING" | "UNKNOWN"; sourceSnapshotId?: number; observedAt?: number; specID?: number; reason: string };
  retained: QualifiedRetailEquipment;
  reasons: string[];
}

export function assessRetailCandidate(input: {
  candidate: GearCandidateRow; exporterSnapshotId: number; rowOrdinal: number; candidateObservedAt?: number;
  characters: Array<{ identityKey: string; name: string; realm: string; class?: string; level?: number; characterState: string; latestSnapshotId?: number; observations: StoredEquipmentObservation[] }>;
}): { version: "retail"; ruleset: typeof RETAIL_GEAR_RULESET; candidate: { exporterSnapshotId: number; rowOrdinal: number; itemID?: number; itemLevel?: number; baseEquipLocation?: string; locationType: string; binding: "NOT_ASSESSED"; validity: string }; recommendation: string; ranking: string; assessments: RetailGearSpecAssessment[]; excludedRecipients: Array<{ identityKey: string; name: string; realm: string; reason: string }>; limitations: string[] } {
  const loc = evidence(input.candidate.baseEquipLocation);
  const classID = evidence(input.candidate.classID);
  const subclass = evidence(input.candidate.subclassID);
  const equipType = evidence(input.candidate.equipType);
  const itemLevel = evidence(input.candidate.currentItemLevel);
  const req = evidence(input.candidate.requiredLevel);
  const armorBodyLocation = ["INVTYPE_HEAD","INVTYPE_SHOULDER","INVTYPE_CHEST","INVTYPE_ROBE","INVTYPE_WAIST","INVTYPE_LEGS","INVTYPE_FEET","INVTYPE_WRIST","INVTYPE_HAND"].includes(loc ?? "");
  const armor = armorBodyLocation && classID === 4 && subclass !== undefined ? ARMOR_SUBCLASS[subclass] : undefined;
  const weapon = classID === 2;
  const slotNames: Record<string, string[]> = {
    INVTYPE_HEAD: ["1"], INVTYPE_NECK: ["2"], INVTYPE_SHOULDER: ["3"], INVTYPE_CHEST: ["5"], INVTYPE_ROBE: ["5"], INVTYPE_WAIST: ["6"], INVTYPE_LEGS: ["7"], INVTYPE_FEET: ["8"], INVTYPE_WRIST: ["9"], INVTYPE_HAND: ["10"], INVTYPE_CLOAK: ["15"], INVTYPE_FINGER: ["11", "12"], INVTYPE_TRINKET: ["13", "14"], INVTYPE_WEAPON: ["16", "17"], INVTYPE_WEAPONMAINHAND: ["16"], INVTYPE_WEAPONOFFHAND: ["17"], INVTYPE_2HWEAPON: ["16", "17"], INVTYPE_SHIELD: ["17"], INVTYPE_HOLDABLE: ["17"], INVTYPE_RANGED: ["18"], INVTYPE_RANGEDRIGHT: ["18"], INVTYPE_THROWN: ["18"], INVTYPE_RELIC: ["18"],
  };
  const relevantSlots = loc ? slotNames[loc] : undefined;
  const expectedLocation: Record<number, string> = { 1:"INVTYPE_HEAD",2:"INVTYPE_NECK",3:"INVTYPE_SHOULDER",4:"INVTYPE_BODY",5:"INVTYPE_CHEST",6:"INVTYPE_WAIST",7:"INVTYPE_LEGS",8:"INVTYPE_FEET",9:"INVTYPE_WRIST",10:"INVTYPE_HAND",11:"INVTYPE_FINGER",12:"INVTYPE_TRINKET",13:"INVTYPE_WEAPON",14:"INVTYPE_SHIELD",15:"INVTYPE_RANGED",16:"INVTYPE_CLOAK",17:"INVTYPE_2HWEAPON",20:"INVTYPE_ROBE",21:"INVTYPE_WEAPONMAINHAND",22:"INVTYPE_WEAPONOFFHAND",23:"INVTYPE_HOLDABLE",26:"INVTYPE_RANGEDRIGHT",28:"INVTYPE_RELIC" };
  const typeLocation = equipType === undefined ? undefined : expectedLocation[equipType];
  const weaponLocation = ["INVTYPE_WEAPON","INVTYPE_WEAPONMAINHAND","INVTYPE_WEAPONOFFHAND","INVTYPE_2HWEAPON","INVTYPE_RANGED","INVTYPE_RANGEDRIGHT","INVTYPE_THROWN","INVTYPE_RELIC"].includes(loc ?? "");
  const contradictory = (typeLocation !== undefined && loc !== undefined && typeLocation !== loc) || (classID === 2 && !weaponLocation) || (classID === 4 && weaponLocation) || (input.candidate.locationType.state === "KNOWN" && input.candidate.locationType.value === "EQUIPMENT_SLOT") || input.candidate.candidateState !== "EQUIPPABLE" || input.candidate.observationState !== "OBSERVED";
  const candidateValidity = contradictory || input.candidate.locationType.state !== "KNOWN" || !["CONTAINER_SLOT", "BANK_SLOT"].includes(input.candidate.locationType.value) || !evidence(input.candidate.itemID) ? "UNKNOWN_OR_NOT_ALLOCATABLE" : "VALID_CANDIDATE";
  const assessments: RetailGearSpecAssessment[] = [];
  const excludedRecipients: Array<{ identityKey: string; name: string; realm: string; reason: string }> = [];
  for (const character of input.characters) {
    if (character.characterState !== "OBSERVED" || !character.class || !SPECS[character.class]) {
      excludedRecipients.push({ identityKey: character.identityKey, name: character.name, realm: character.realm, reason: character.characterState !== "OBSERVED" ? `Latest character class/level section is ${character.characterState}; recipient eligibility is UNKNOWN.` : !character.class ? "No observed class is available; recipient specialization cannot be determined." : `Class ${character.class} is not in this Retail ruleset; suitability is UNKNOWN.` });
      continue;
    }
    for (const spec of SPECS[character.class]!) {
      const reasons: string[] = [];
      const eligibility = req === undefined || character.level === undefined ? "UNKNOWN" : character.level < req ? "INELIGIBLE" : "ELIGIBLE";
      if (eligibility === "INELIGIBLE") reasons.push(`Observed level ${character.level} is below candidate required level ${req}.`);
      else if (eligibility === "UNKNOWN") reasons.push("Observed character level or candidate required level is unavailable.");
      let suitability: RetailGearSpecAssessment["suitability"] = "UNKNOWN";
      if (armor && ARMOR[character.class] !== armor) { suitability = "UNKNOWN"; reasons.push(`Candidate ${armor} armor differs from this class's native ${ARMOR[character.class]} family. This plausibility mismatch does not prove the client forbids equipping lower armor families; technical suitability remains UNKNOWN.`); }
      else if (weapon) { suitability = "UNKNOWN"; reasons.push("Weapon subclass proficiency and spec weapon suitability are not asserted by this conservative allocation ruleset."); }
      else if (loc === "INVTYPE_SHIELD" || loc === "INVTYPE_HOLDABLE") reasons.push("Off-hand shield/holdable compatibility and weapon-pair interactions are not asserted by this ruleset.");
      else if (classID !== 4) reasons.push("Only known Retail armor and jewelry candidates are handled; item class is unsupported or UNKNOWN.");
      else if (armorBodyLocation && armor === undefined) reasons.push("Candidate body-armor subclass is UNKNOWN or unsupported; native armor-family suitability is UNKNOWN.");
      else if (loc && relevantSlots) { suitability = "POSSIBLE_BY_CHECKED_RULES"; reasons.push("Slot and known class-family checks pass; candidate stat lines and item-specific restrictions are not present in candidate evidence."); }
      else reasons.push("Candidate item class, subclass, or equipment location is insufficient for a specialization suitability check.");
      const retained = retainedRetailEquipment(character.observations, spec.id);
      const latestObservation = [...character.observations].sort((a,b) => b.observedAt - a.observedAt || b.capture - a.capture || b.revision - a.revision)[0];
      const latestSpec = latestObservation ? qualified(latestObservation) : undefined;
      const currentObservation = character.latestSnapshotId === undefined ? undefined : character.observations.find((item) => item.snapshotId === character.latestSnapshotId);
      const currentSpec = currentObservation ? qualified(currentObservation) : undefined;
      const currentSnapshotObservation: RetailGearSpecAssessment["currentSnapshotObservation"] = !currentObservation
        ? { state: "UNKNOWN", reason: "No equipment observation is linked to the latest overall character snapshot; retained evidence is selected independently by spec." }
        : currentSpec !== undefined
          ? { state: "QUALIFYING", sourceSnapshotId: currentObservation.snapshotId, observedAt: currentObservation.observedAt, specID: currentSpec, reason: `This snapshot links a qualifying observation for spec ${currentSpec}; it is current only for this captured snapshot.` }
          : { state: "NONQUALIFYING", sourceSnapshotId: currentObservation.snapshotId, observedAt: currentObservation.observedAt, reason: "This snapshot links a nonqualifying equipment observation; it does not erase retained evidence for any spec." };
      const latestStoredObservation: RetailGearSpecAssessment["latestStoredObservation"] = !latestObservation
        ? { relationship: "LATEST_STORED_EQUIPMENT_OBSERVATION", state: "UNKNOWN", reason: "No stored equipment observation exists." }
        : latestSpec !== undefined
          ? { relationship: "LATEST_STORED_EQUIPMENT_OBSERVATION", state: "QUALIFYING", sourceSnapshotId: latestObservation.snapshotId, observedAt: latestObservation.observedAt, specID: latestSpec, reason: `Latest stored qualifying equipment observation is for spec ${latestSpec}; it may be historical, and retained per-spec state is selected independently.` }
          : { relationship: "LATEST_STORED_EQUIPMENT_OBSERVATION", state: "NONQUALIFYING", sourceSnapshotId: latestObservation.snapshotId, observedAt: latestObservation.observedAt, reason: "Latest stored equipment observation does not qualify; it does not erase an older qualifying observation for this spec." };
      let comparison: RetailGearSpecAssessment["comparison"] = "UNKNOWN"; let delta: number | undefined;
      let comparisonSlots: string[] | undefined;
      if (contradictory) reasons.push("Candidate evidence is unknown, historical, already equipped, or has contradictory item/equip-location fields; allocation analysis is withheld.");
      if (weapon) reasons.push("Weapon set comparison is UNKNOWN because main-hand/off-hand, two-hand, shield, and specialization weapon interactions are not modeled as a complete equipped set.");
      if (candidateValidity === "VALID_CANDIDATE" && !weapon && suitability === "POSSIBLE_BY_CHECKED_RULES" && eligibility === "ELIGIBLE" && retained.state === "QUALIFIED" && relevantSlots && itemLevel !== undefined) {
        const available = relevantSlots.map((s) => ({ slot: s, empty: retained.slots?.[s]?.empty === true, ilvl: retained.slots?.[s]?.itemLevel }));
        const empty = available.filter((x) => x.empty);
        if (empty.length > 0) {
          comparison = "UPGRADE_BY_FILLING_EMPTY_SLOT";
          comparisonSlots = [empty[0]!.slot];
          reasons.push(`Retained applicable slot ${comparisonSlots[0]} is explicitly OBSERVED empty; candidate would fill it. Empty is not represented as item level zero.`);
        }
        else if (available.some((x) => x.ilvl === undefined)) reasons.push("At least one applicable retained equipment slot has no known item level; comparison remains UNKNOWN.");
        else {
          const baseline = Math.min(...available.map((x) => x.ilvl!)); delta = itemLevel - baseline;
          comparison = delta > 0 ? "UPGRADE_BY_ITEM_LEVEL" : delta < 0 ? "DOWNGRADE_BY_ITEM_LEVEL" : "SIDEGRADE_BY_ITEM_LEVEL";
          comparisonSlots = available.filter((x) => x.ilvl === baseline).map((x) => x.slot);
          reasons.push(`Compared against the lowest item-level interchangeable slot(s) ${comparisonSlots.join(", ")}; delta ${delta}. This is an item-level comparison, not a stat simulation.`);
        }
      } else if (retained.state === "UNKNOWN") reasons.push(retained.reason!);
      assessments.push({ character: { identityKey: character.identityKey, name: character.name, realm: character.realm }, spec: { specID: spec.id, name: spec.name, role: spec.role }, eligibility, suitability, primaryStatSuitability: "UNKNOWN", comparison, ...(delta !== undefined ? { deltaItemLevel: delta } : {}), ...(comparisonSlots ? { comparisonSlots } : {}), currentSnapshotObservation, latestStoredObservation, retained, reasons: [...reasons, "Candidate evidence has no trustworthy primary-stat field; primary-stat suitability is UNKNOWN."] });
    }
  }
  assessments.sort((a,b) => (a.comparison === "UPGRADE_BY_ITEM_LEVEL" ? -1 : 0) - (b.comparison === "UPGRADE_BY_ITEM_LEVEL" ? -1 : 0) || (a.character.identityKey < b.character.identityKey ? -1 : a.character.identityKey > b.character.identityKey ? 1 : 0) || a.spec.specID - b.spec.specID);
  const upgrades = assessments.filter((a) => a.comparison === "UPGRADE_BY_ITEM_LEVEL" || a.comparison === "UPGRADE_BY_FILLING_EMPTY_SLOT");
  const top = upgrades[0]; const tied = top ? upgrades.filter((a) => a.deltaItemLevel === top.deltaItemLevel) : [];
  const upgradeKinds = new Set(upgrades.map((a) => a.comparison));
  const anyUnknown = excludedRecipients.length > 0 || assessments.some((a) => a.comparison === "UNKNOWN" && a.eligibility !== "INELIGIBLE" && a.suitability !== "UNSUITABLE") || candidateValidity !== "VALID_CANDIDATE";
  const recommendation = anyUnknown ? "UNKNOWN" : upgrades.length === 0 ? "NO_SUPPORTED_UPGRADE" : upgradeKinds.size > 1 ? "AMBIGUOUS_SUPPORTED_UPGRADE_TYPES" : tied.length > 1 ? "TIED_BEST_SUPPORTED_UPGRADE" : top?.comparison === "UPGRADE_BY_FILLING_EMPTY_SLOT" ? "BEST_SUPPORTED_UPGRADE_BY_FILLING_EMPTY_SLOT" : "BEST_SUPPORTED_UPGRADE_BY_ITEM_LEVEL";
  return { version: "retail", ruleset: RETAIL_GEAR_RULESET, candidate: { exporterSnapshotId: input.exporterSnapshotId, rowOrdinal: input.rowOrdinal, ...(evidence(input.candidate.itemID) !== undefined ? { itemID: evidence(input.candidate.itemID) } : {}), ...(itemLevel !== undefined ? { itemLevel } : {}), ...(loc ? { baseEquipLocation: loc } : {}), locationType: input.candidate.locationType.state === "KNOWN" ? input.candidate.locationType.value : "UNKNOWN", binding: "NOT_ASSESSED", validity: candidateValidity }, recommendation, ranking: "Sorted by supported positive item-level delta, then stable character/spec identity; equal deltas are explicitly tied. No opaque score is used.", assessments, excludedRecipients, limitations: ["Retail-only rules. Character identity is installation-local and does not prove Battle.net account membership.", "Candidate rows are snapshot scoped; rowOrdinal and snapshot ID are references to evidence, not physical-item identity.", "Binding fields do not prove transferability and are not used.", "Stat lines, unique/equip restrictions, and item-specific CanEquip restrictions are unavailable in the candidate contract; item-level comparison is coarse and may not be a true upgrade.", "Weapon subclass proficiency, spec weapon suitability, main-hand/off-hand, two-hand, shield, and dual-wield equipped-set interactions remain UNKNOWN."] };
}
