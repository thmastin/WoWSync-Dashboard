// Forever opportunity discovery: finds quests, gear, training and profession paths the account has not
// encountered yet, using the runtime knowledge bundle, and checks them against the character's real
// evidence (level, race, class, faction, completed quests, equipped items, trainer visits, professions).
//
// Faction and realm are hard constraints: only same-realm, same-faction characters form an economy that
// can mail items. Opposite-faction or unknown-faction characters never supply inputs.
import { formatCopper } from "./currency.ts";
import { ARMOR_SUBCLASS, CLASS_BITS, ITEM_CLASS, NPC_FLAG, RACE_BITS, hasBit, type BundleNpc, type BundleQuest, type ForeverKnowledgeIndex } from "./foreverKnowledgeBundle.ts";
import { foreverItem, foreverSpell, type ForeverItemKnowledge } from "./foreverKnowledge.ts";
import type { ForeverTrainerService } from "./foreverTrainer.ts";
import { compareToEquipped, describeItem, eligibility, externalItem, label, sameRealmFaction, type CharacterEvidence, type Comparison, type Draft, type EvidenceLine } from "./foreverCopilot.ts";

const ALLIANCE_RACE_BITS = [1, 4, 8, 64];
const HORDE_RACE_BITS = [2, 16, 32, 128];
export const PRIMARY_PROFESSIONS = ["Alchemy", "Blacksmithing", "Enchanting", "Engineering", "Herbalism", "Leatherworking", "Mining", "Skinning", "Tailoring"];
const GATHERING = new Set(["Herbalism", "Mining", "Skinning"]);
const HERB_NAMES = /^(Peacebloom|Silverleaf|Earthroot|Mageroyal|Briarthorn|Swiftthistle|Stranglekelp|Bruiseweed|Wild Steelbloom|Grave Moss|Kingsblood|Liferoot|Fadeleaf|Goldthorn|Khadgar's Whisker|Wintersbite)$/;

/** Classic baseline armor proficiency below level 40; labelled unverified for Forever wherever it is used. */
const CLASS_ARMOR: Record<string, string[]> = { WARRIOR: ["Cloth", "Leather", "Mail", "Shield"], PALADIN: ["Cloth", "Leather", "Mail", "Shield"], SHAMAN: ["Cloth", "Leather", "Shield"], HUNTER: ["Cloth", "Leather"], ROGUE: ["Cloth", "Leather"], DRUID: ["Cloth", "Leather"], PRIEST: ["Cloth"], MAGE: ["Cloth"], WARLOCK: ["Cloth"] };
/** Classic baseline trainable weapon types, by tooltip subtype; slot decides one- vs two-handed. */
const CLASS_WEAPONS: Record<string, string[]> = { WARRIOR: ["Axe", "Mace", "Sword", "Dagger", "Polearm", "Staff", "Fist Weapon", "Bow", "Gun", "Crossbow", "Thrown"], PALADIN: ["Axe", "Mace", "Sword", "Polearm"], SHAMAN: ["Axe", "Mace", "Staff", "Dagger", "Fist Weapon"], HUNTER: ["Axe", "Sword", "Dagger", "Polearm", "Staff", "Fist Weapon", "Bow", "Gun", "Crossbow", "Thrown"], ROGUE: ["Dagger", "Sword", "Mace", "Fist Weapon", "Bow", "Gun", "Crossbow", "Thrown"], DRUID: ["Mace", "Staff", "Dagger", "Fist Weapon"], PRIEST: ["Mace", "Dagger", "Staff", "Wand"], MAGE: ["Sword", "Dagger", "Staff", "Wand"], WARLOCK: ["Sword", "Dagger", "Staff", "Wand"] };
export const CLASSIC_BASELINE_NOTE = "Classic Era class rules, not verified for Forever";

/** Racial starting zones: below level 12 a character is not sent to another race's starting zone. */
const STARTER_ZONES: Record<string, string[]> = { Mulgore: ["TAUREN"], Durotar: ["ORC", "TROLL"], "Tirisfal Glades": ["UNDEAD", "SCOURGE"], "Elwynn Forest": ["HUMAN"], "Dun Morogh": ["DWARF", "GNOME"], Teldrassil: ["NIGHT ELF", "NIGHTELF"] };
const CAPITALS: Record<string, string[]> = { Horde: ["Orgrimmar", "Thunder Bluff", "Undercity"], Alliance: ["Stormwind City", "Ironforge", "Darnassus"] };
/** Low-level characters stay on their race's home continent; capitals of the other continent count as far. */
const KALIMDOR = new Set(["Mulgore", "Durotar", "The Barrens", "Thunder Bluff", "Orgrimmar", "Teldrassil", "Darnassus", "Darkshore", "Ashenvale", "Stonetalon Mountains", "Desolace", "Thousand Needles", "Dustwallow Marsh", "Feralas", "Tanaris", "Moonglade", "Azshara", "Felwood", "Un'Goro Crater", "Silithus", "Winterspring", "Moonglade"]);
const EASTERN_KINGDOMS = new Set(["Elwynn Forest", "Dun Morogh", "Tirisfal Glades", "Silverpine Forest", "Westfall", "Loch Modan", "Redridge Mountains", "Duskwood", "Wetlands", "Hillsbrad Foothills", "Undercity", "Stormwind City", "Ironforge", "Arathi Highlands", "Stranglethorn Vale", "Badlands", "Searing Gorge", "Burning Steppes", "Swamp of Sorrows", "Blasted Lands", "Alterac Mountains", "The Hinterlands", "Western Plaguelands", "Eastern Plaguelands", "Deadwind Pass"]);
const HOME_CONTINENT: Record<string, Set<string>> = { TAUREN: KALIMDOR, ORC: KALIMDOR, TROLL: KALIMDOR, "NIGHT ELF": KALIMDOR, NIGHTELF: KALIMDOR, HUMAN: EASTERN_KINGDOMS, DWARF: EASTERN_KINGDOMS, GNOME: EASTERN_KINGDOMS, UNDEAD: EASTERN_KINGDOMS, SCOURGE: EASTERN_KINGDOMS };
const isSingleClass = (mask: number | undefined) => !!mask && mask > 0 && (mask & (mask - 1)) === 0;

/** A zone the character can sensibly be sent to now; false for another race's starting zone below level 12. */
export function zonePlausible(zone: string | undefined, character: CharacterEvidence): boolean {
  if (!zone) return true;
  const race = character.brief.race?.toUpperCase();
  const level = character.brief.level ?? 0;
  const home = race ? HOME_CONTINENT[race] : undefined;
  if (home && level < 15 && (KALIMDOR.has(zone) || EASTERN_KINGDOMS.has(zone)) && !home.has(zone)) return false;
  const races = STARTER_ZONES[zone];
  if (!races || level >= 12) return true;
  return race ? races.includes(race) : zone === character.zone;
}

/** Zones the plan uses: current zone, faction capitals, and zones holding discovered quests. */
export function plausibleZones(character: CharacterEvidence, quests: DiscoveredQuest[]): Set<string> {
  const zones = new Set<string>([...(character.zone ? [character.zone] : []), ...(CAPITALS[character.brief.faction ?? ""] ?? []).filter((zone) => zonePlausible(zone, character))]);
  for (const quest of quests) if (quest.zone) zones.add(quest.zone);
  return zones;
}

export function raceAllowed(mask: number | undefined, character: CharacterEvidence): boolean | undefined {
  if (!mask) return true;
  const race = character.brief.race?.toUpperCase();
  const bit = race ? RACE_BITS[race] : undefined;
  if (bit) return hasBit(mask, bit);
  const factionBits = character.brief.faction === "Alliance" ? ALLIANCE_RACE_BITS : character.brief.faction === "Horde" ? HORDE_RACE_BITS : undefined;
  return factionBits ? factionBits.some((value) => hasBit(mask, value)) : undefined;
}

export function classAllowed(mask: number | undefined, character: CharacterEvidence): boolean | undefined {
  if (!mask) return true;
  const bit = character.brief.class ? CLASS_BITS[character.brief.class.toUpperCase()] : undefined;
  return bit ? hasBit(mask, bit) : undefined;
}

/** Can this class wear/wield the item under the Classic baseline? undefined = no rule applies. */
export function proficiencyBaseline(item: ForeverItemKnowledge, character: CharacterEvidence): { allowed: boolean; rule: string } | undefined {
  const cls = character.brief.class?.toUpperCase();
  if (!cls || !item.subtype) return undefined;
  if (ARMOR_SUBCLASS[1] && ["Cloth", "Leather", "Mail", "Plate", "Shield"].includes(item.subtype)) {
    const allowed = (CLASS_ARMOR[cls] ?? []).includes(item.subtype);
    return { allowed, rule: `${cls.toLowerCase()}s ${allowed ? "can" : "cannot"} use ${item.subtype} before level 40 (${CLASSIC_BASELINE_NOTE})` };
  }
  if (item.slot === "Off Hand" && item.dps) {
    const level = character.brief.level ?? 0;
    const allowed = (cls === "ROGUE" && level >= 10) || ((cls === "WARRIOR" || cls === "HUNTER") && level >= 20);
    return { allowed, rule: `off-hand weapons need dual wield, which ${cls.toLowerCase()}s ${allowed ? "have" : "do not have at this level"} (${CLASSIC_BASELINE_NOTE})` };
  }
  if (item.slot && /Hand|Ranged|Thrown/.test(item.slot)) {
    const allowed = (CLASS_WEAPONS[cls] ?? []).includes(item.subtype);
    return { allowed, rule: `${cls.toLowerCase()}s ${allowed ? "can train" : "cannot use"} ${item.subtype}s (${CLASSIC_BASELINE_NOTE})` };
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Quests

export interface DiscoveredQuest {
  id: number;
  quest: BundleQuest;
  zone?: string;
  starter?: BundleNpc;
  starterLocation?: string;
  available: boolean;
  missingPrerequisites: number[];
  classQuest: boolean;
  xpShare?: number;
  rewardUpgrades: GearCandidate[];
  score: number;
}

export function discoverQuests(index: ForeverKnowledgeIndex, subject: CharacterEvidence, window = 5): DiscoveredQuest[] {
  const level = subject.brief.level;
  if (level === undefined) return [];
  const active = new Set(subject.quests.map((quest) => quest.questID));
  const completed = subject.completedQuests;
  const results: DiscoveredQuest[] = [];
  for (const [id, quest] of index.quests()) {
    if (completed.has(id) || active.has(id)) continue;
    if ((quest.special ?? 0) % 4 >= 1) continue; // repeatable or event
    const reqLevel = quest.reqLevel ?? quest.level ?? 1;
    const questLevel = quest.level ?? reqLevel;
    if (reqLevel > level + window || questLevel < level - 2 || questLevel > level + window + 1) continue;
    if (quest.maxLevel && quest.maxLevel < level) continue;
    if (raceAllowed(quest.races, subject) !== true || classAllowed(quest.classes, subject) !== true) continue;
    if (quest.reqSkill && !subject.brief.professions.some((profession) => profession.skill >= quest.reqSkill![1])) continue;
    if ((quest.exclusiveTo ?? []).some((other) => completed.has(other) || active.has(other))) continue;
    const starter = index.questStarter(quest);
    const friendly = index.npcFriendlyTo(starter, subject.brief.faction);
    if (friendly === false) continue;
    const missing = [...(quest.preGroup ?? []).filter((pre) => !completed.has(pre)), ...((quest.preSingle ?? []).length && !(quest.preSingle ?? []).some((pre) => completed.has(pre)) ? [quest.preSingle![0]] : [])];
    const zone = (quest.zone !== undefined && quest.zone > 0 ? index.zoneName(quest.zone) : undefined) ?? index.zoneName(starter?.zone);
    if (!zonePlausible(zone, subject)) continue;
    const classQuest = isSingleClass(quest.classes);
    const xpShare = quest.xp && subject.xp ? quest.xp / subject.xp.xpMax : undefined;
    const sameZone = zone !== undefined && subject.zone !== undefined && zone === subject.zone;
    const available = missing.length === 0 && reqLevel <= level;
    results.push({
      id, quest, zone, starter, starterLocation: index.npcLocation(starter), available, missingPrerequisites: missing, classQuest, xpShare, rewardUpgrades: [],
      score: (xpShare ?? 0.05) + (sameZone ? 0.35 : 0) + (zone && CAPITALS[subject.brief.faction ?? ""]?.includes(zone) ? 0.1 : 0) + (classQuest ? 0.3 : 0) + (available ? 0.1 : 0) - (missing.length ? 0.1 : 0),
    });
  }
  // Same-named variants (e.g. per-race copies) collapse to the best-scoring one.
  const byName = new Map<string, DiscoveredQuest>();
  for (const quest of results.sort((a, b) => b.score - a.score)) if (!byName.has(quest.quest.name)) byName.set(quest.quest.name, quest);
  return [...byName.values()];
}

// ---------------------------------------------------------------------------------------------
// Gear

export type GearSourceKind = "ACTIVE_QUEST_REWARD" | "QUEST_REWARD" | "VENDOR" | "CRAFT" | "DROP";
export interface GearCandidate {
  itemId: number;
  item: ForeverItemKnowledge;
  source: { kind: GearSourceKind; detail: string; questId?: number; npcId?: number; recipeId?: number; profession?: string; crafter?: string };
  comparison: Comparison;
  prerequisites: string[];
  evidence: EvidenceLine[];
  reqLevel: number;
  magnitude: number;
}

const SOURCE_EFFORT: Record<GearSourceKind, number> = { ACTIVE_QUEST_REWARD: 1, QUEST_REWARD: 0.85, VENDOR: 0.7, CRAFT: 0.6, DROP: 0.4 };

function evaluateCandidate(itemId: number, subject: CharacterEvidence, window: number): Omit<GearCandidate, "source" | "evidence"> & { evidence: EvidenceLine[] } | undefined {
  const item = foreverItem(itemId);
  if (!item?.slot) return undefined;
  const level = subject.brief.level ?? 1;
  const reqLevel = item.requiredLevel ?? 1;
  if (reqLevel > level + window) return undefined;
  const baseline = proficiencyBaseline(item, subject);
  if (baseline && !baseline.allowed) return undefined;
  const comparison = compareToEquipped(item, subject);
  if (!comparison || !["UPGRADE", "FILLS_EMPTY_SLOT", "TRADEOFF"].includes(comparison.verdict)) return undefined;
  if (subject.equipment.find((slot) => slot.slotName === "Main Hand" && !slot.empty) && comparison.slotName === "Off Hand") {
    const mainHand = foreverItem(subject.equipment.find((slot) => slot.slotName === "Main Hand")?.itemId);
    if (mainHand?.slot === "Two-Hand") return undefined;
  }
  const check = eligibility({ ...item, requiredLevel: item.requiredLevel !== undefined && item.requiredLevel > level ? undefined : item.requiredLevel }, subject);
  if (check.blocked) return undefined;
  const prerequisites = [...check.prerequisites.filter((line) => !/Confirm .* can wear/.test(line) || !baseline?.allowed)];
  if (reqLevel > level) prerequisites.unshift(`Requires level ${reqLevel} (${label(subject)} is ${level}).`);
  const evidence: EvidenceLine[] = [externalItem(item)];
  if (comparison.equippedKnowledge) evidence.push(externalItem(comparison.equippedKnowledge, `${label(subject)} wears ${comparison.equippedKnowledge.name} in ${comparison.slotName} (observed): ${describeItem(comparison.equippedKnowledge)}`));
  else if (comparison.equipped?.empty) evidence.push({ kind: "OBSERVED", statement: `${label(subject)}'s ${comparison.slotName} slot is empty.`, source: "observed equipment", observedAt: subject.equipmentObservedAt });
  if (baseline?.allowed) evidence.push({ kind: "EXTERNAL", statement: `Proficiency: ${baseline.rule}.`, source: "Classic Era baseline (unverified for Forever)" });
  evidence.push({ kind: "DERIVED", statement: `Listed-stat difference vs ${comparison.equipped?.empty ? "an empty slot" : comparison.equipped?.name}: ${comparison.deltas.join(", ") || "none"}. Not a simulation; item level alone is not used.`, source: "Forever item records" });
  return { itemId, item, comparison, prerequisites, evidence, reqLevel, magnitude: comparison.verdict === "FILLS_EMPTY_SLOT" ? 0.5 + comparison.magnitude * 0.5 : comparison.verdict === "UPGRADE" ? 0.35 + comparison.magnitude * 0.65 : comparison.magnitude * 0.4 };
}

export function discoverGear(index: ForeverKnowledgeIndex, subject: CharacterEvidence, economy: CharacterEvidence[], quests: DiscoveredQuest[], window = 5): GearCandidate[] {
  const out: GearCandidate[] = [];
  const zones = plausibleZones(subject, quests);
  const reachable = (npc: BundleNpc | undefined) => { const zone = index.zoneName(npc?.zone); return zone !== undefined && zones.has(zone); };
  const add = (itemId: number, source: GearCandidate["source"], extra: EvidenceLine[] = [], prerequisites: string[] = []) => {
    const evaluated = evaluateCandidate(itemId, subject, window);
    if (!evaluated) return;
    const questLevel = source.questId !== undefined ? index.quest(source.questId)?.reqLevel ?? 0 : 0;
    const reqLevel = Math.max(evaluated.reqLevel, questLevel);
    if (reqLevel > (subject.brief.level ?? 0) + window) return;
    out.push({ ...evaluated, reqLevel, source, evidence: [...extra, ...evaluated.evidence], prerequisites: [...prerequisites, ...evaluated.prerequisites], magnitude: evaluated.magnitude * SOURCE_EFFORT[source.kind] * (reqLevel > (subject.brief.level ?? 0) ? 0.85 : 1) });
  };
  // Quest rewards: active quests first, then discovered quests.
  for (const active of subject.quests) for (const itemId of index.questRewards(active.questID)) add(itemId, { kind: "ACTIVE_QUEST_REWARD", questId: active.questID, detail: `reward from "${active.title}", already in your quest log` }, [{ kind: "OBSERVED", statement: `"${active.title}" is in ${label(subject)}'s quest log.`, source: "Forever C_QuestLog sidecar" }, { kind: "EXTERNAL", statement: `QuestieDB lists ${foreverItem(itemId)?.name ?? itemId} as a reward of quest ${active.questID} (may be one of several choices).`, source: "QuestieDB Forever" }]);
  for (const quest of quests) {
    for (const itemId of index.questRewards(quest.id)) {
      const before = out.length;
      add(itemId, { kind: "QUEST_REWARD", questId: quest.id, detail: `reward from "${quest.quest.name}"${quest.zone ? ` (${quest.zone})` : ""}` }, [{ kind: "EXTERNAL", statement: `QuestieDB lists ${foreverItem(itemId)?.name ?? itemId} as a reward of "${quest.quest.name}" (quest ${quest.id}, level ${quest.quest.level ?? "?"}${quest.starterLocation ? `, from ${quest.starterLocation}` : ""}); it may be one of several choices.`, source: "QuestieDB Forever" }], quest.available ? [] : [`First complete: ${quest.missingPrerequisites.map((id) => index.quest(id)?.name ?? `quest ${id}`).join(", ")}${(quest.quest.reqLevel ?? 0) > (subject.brief.level ?? 0) ? `; requires level ${quest.quest.reqLevel}` : ""}.`]);
      if (out.length > before) quest.rewardUpgrades.push(out[out.length - 1]);
    }
  }
  // Vendors friendly to this faction.
  for (const [itemId, item] of index.items()) {
    if ((item.cls !== ITEM_CLASS.ARMOR && item.cls !== ITEM_CLASS.WEAPON) || !item.vendors?.length) continue;
    if ((item.reqLevel ?? 0) > (subject.brief.level ?? 0) + window) continue;
    const vendor = item.vendors.map((npcId) => ({ npcId, npc: index.npc(npcId) })).find((entry) => entry.npc && index.npcFriendlyTo(entry.npc, subject.brief.faction) === true && ((entry.npc.flags ?? 0) & NPC_FLAG.VENDOR) !== 0 && reachable(entry.npc));
    if (!vendor) continue;
    add(itemId, { kind: "VENDOR", npcId: vendor.npcId, detail: `sold by ${index.npcLocation(vendor.npc)}` }, [{ kind: "EXTERNAL", statement: `QuestieDB lists ${item.name} as sold by ${index.npcLocation(vendor.npc)} (friendly to ${subject.brief.faction}). Purchase price is not in the knowledge base; vendor stock is not guaranteed.`, source: "QuestieDB Forever" }]);
  }
  // Crafting: the subject's own professions (learned + unlearned catalog + trainer recipes) and same-economy crafters.
  for (const crafter of economy) {
    const recipes = [...crafter.catalog];
    for (const visit of crafter.trainerVisits.filter((entry) => entry.kind !== "CLASS")) for (const service of visit.services) {
      const match = crafter.catalog.find((recipe) => recipe.name === service.name);
      if (match && !recipes.includes(match)) recipes.push(match);
    }
    for (const recipe of recipes) {
      if (!recipe.outputItemID) continue;
      const learned = crafter.recipes.some((known) => known.recipeID === recipe.recipeID);
      const trainer = crafter.trainerVisits.flatMap((visit) => visit.services).find((service) => service.name === recipe.name);
      const skill = crafter.brief.professions.find((profession) => profession.name === recipe.profession);
      const crafterLabel = crafter === subject ? "you" : label(crafter);
      const prereq: string[] = [];
      if (!learned) prereq.push(trainer ? `Learn ${recipe.name} from a ${recipe.profession} trainer (${trainer.costCopper !== undefined ? formatCopper(trainer.costCopper) : "cost unknown"}; needs ${recipe.profession} ${trainer.skillRequirement?.rank ?? "?"}, ${crafterLabel === "you" ? "you have" : `${crafterLabel} has`} ${skill?.skill ?? "?"}).` : `Learn ${recipe.name} (${recipe.profession}); how it is taught is not captured.`);
      prereq.push(`Reagents: ${recipe.reagents.map((reagent) => `${foreverItem(reagent.itemId)?.name ?? `item ${reagent.itemId}`} x${reagent.quantity}`).join(", ") || "not captured"}.`);
      if (crafter !== subject) prereq.push(`${label(crafter)} crafts it and mails it (same realm and faction).`);
      add(recipe.outputItemID, { kind: "CRAFT", recipeId: recipe.recipeID, profession: recipe.profession, crafter: crafter === subject ? undefined : label(crafter), detail: `${learned ? "craftable" : "learnable"} ${recipe.profession} recipe ${recipe.name}${crafter === subject ? "" : ` (crafter: ${label(crafter)})`}` }, [{ kind: recipe.state === "LAST_SEEN" ? "LAST_SEEN" : "OBSERVED", statement: `${label(crafter)}'s ${recipe.profession} window lists ${recipe.name} (${learned ? "learned" : "not learned"}).`, source: "Forever recipe sidecar" }, ...(trainer ? [{ kind: "OBSERVED" as const, statement: `A ${recipe.profession} trainer offered ${recipe.name} for ${trainer.costCopper !== undefined ? formatCopper(trainer.costCopper) : "?"} at skill ${trainer.skillRequirement?.rank ?? "?"} (trainer visit).`, source: "Forever trainer window" }] : [])], prereq);
    }
  }
  // Specific drops: items dropped by at most three creatures near the character's level.
  for (const [itemId, item] of index.items()) {
    if ((item.cls !== ITEM_CLASS.ARMOR && item.cls !== ITEM_CLASS.WEAPON) || !item.dropNpcs?.length || item.dropNpcs.length > 3 || item.questRewards || item.vendors) continue;
    if ((item.reqLevel ?? 0) > (subject.brief.level ?? 0) + window) continue;
    const dropper = item.dropNpcs.map((npcId) => ({ npcId, npc: index.npc(npcId) })).find((entry) => entry.npc?.level && entry.npc.level[1] <= (subject.brief.level ?? 0) + window && (entry.npc.rank ?? 0) <= 1 && reachable(entry.npc));
    if (!dropper) continue;
    add(itemId, { kind: "DROP", npcId: dropper.npcId, detail: `drops from ${index.npcLocation(dropper.npc)}` }, [{ kind: "EXTERNAL", statement: `QuestieDB lists ${item.name} as a drop from ${index.npcLocation(dropper.npc)} (level ${dropper.npc!.level![0]}-${dropper.npc!.level![1]}). Drop chance is not known.`, source: "QuestieDB Forever" }]);
  }
  // Keep the strongest candidates per slot (and the best of each source kind).
  const bySlot = new Map<string, GearCandidate[]>();
  for (const candidate of out) {
    const key = candidate.comparison.slotName;
    const list = bySlot.get(key) ?? [];
    if (!list.some((existing) => existing.itemId === candidate.itemId)) list.push(candidate);
    bySlot.set(key, list);
  }
  return [...bySlot.values()].flatMap((list) => list.sort((a, b) => b.magnitude - a.magnitude).slice(0, 3)).sort((a, b) => b.magnitude - a.magnitude);
}

// ---------------------------------------------------------------------------------------------
// Class progression

export function classTraining(subject: CharacterEvidence, window = 5): { visitAt?: number; now: ForeverTrainerService[]; upcoming: Map<number, ForeverTrainerService[]>; unknownLevel: number } | undefined {
  const visit = subject.trainerVisits.find((entry) => entry.kind === "CLASS");
  const level = subject.brief.level;
  if (!visit || level === undefined) return undefined;
  const known = new Set(subject.spells.map((name) => name.toLowerCase()));
  const now = visit.services.filter((service) => service.level !== undefined && service.level <= level && service.statusAtVisit !== "used" && !(service.rank === undefined && known.has(service.name.toLowerCase())));
  const upcoming = new Map<number, ForeverTrainerService[]>();
  for (const service of visit.services) if (service.level !== undefined && service.level > level && service.level <= level + window) upcoming.set(service.level, [...(upcoming.get(service.level) ?? []), service]);
  return { visitAt: visit.observedAt, now, upcoming, unknownLevel: visit.services.filter((service) => service.level === undefined).length };
}

// ---------------------------------------------------------------------------------------------
// Profession comparison

export interface ProfessionOption {
  profession: string;
  craftedUpgrades: GearCandidate[];
  consumables: string[];
  inputs: Array<{ name: string; supply: string }>;
  economyCoverage: string[];
  blockedCoverage: string[];
  notes: string[];
  selfSupplied: boolean;
  score: number;
}

function gatherer(itemName: string): string | undefined {
  if (/Leather|Hide|Scraps/.test(itemName)) return "Skinning";
  if (/Ore$|Rough Stone|Coarse Stone|Heavy Stone/.test(itemName)) return "Mining";
  if (/Bar$/.test(itemName)) return "Mining";
  if (HERB_NAMES.test(itemName)) return "Herbalism";
  return undefined;
}

export function compareProfessions(index: ForeverKnowledgeIndex, subject: CharacterEvidence, economy: CharacterEvidence[], others: CharacterEvidence[]): ProfessionOption[] {
  const owned = new Set(subject.brief.professions.map((profession) => profession.name));
  const ownedPrimary = [...owned].filter((name) => PRIMARY_PROFESSIONS.includes(name));
  if (ownedPrimary.length >= 2) return [];
  const options: ProfessionOption[] = [];
  for (const profession of PRIMARY_PROFESSIONS.filter((name) => !owned.has(name))) {
    const recipeIds = index.bundle.recipesByProfession[profession] ?? [];
    const craftedUpgrades: GearCandidate[] = [];
    const consumables: string[] = [];
    const inputNames = new Set<string>();
    for (const recipeId of recipeIds) {
      const spell = foreverSpell(recipeId);
      if (!spell?.createsItemId) continue;
      const output = foreverItem(spell.createsItemId);
      if (!output) continue;
      for (const reagent of spell.reagents) inputNames.add(reagent.name);
      if (output.slot) {
        const evaluated = evaluateCandidate(output.id, subject, 10);
        if (evaluated) craftedUpgrades.push({ ...evaluated, source: { kind: "CRAFT", recipeId, profession, detail: `${profession} recipe ${spell.name}` }, evidence: [{ kind: "EXTERNAL", statement: `Forever recipe ${spell.name}: ${spell.reagents.map((reagent) => `${reagent.name} x${reagent.quantity}`).join(", ")}.`, source: spell.sourceUrl }, ...evaluated.evidence], prerequisites: evaluated.prerequisites });
      } else if (output.useText) consumables.push(`${output.name}: ${output.useText}`);
    }
    const inputs = [...inputNames].map((name) => {
      const by = gatherer(name);
      const economyGatherer = by ? economy.find((character) => character.brief.professions.some((entry) => entry.name === by)) : undefined;
      const vendorItem = index.items().find(([, item]) => item.name === name && item.vendors?.some((npcId) => index.npcFriendlyTo(index.npc(npcId), subject.brief.faction) === true));
      const supply = by === undefined ? (vendorItem ? "vendor (friendly vendor listed in QuestieDB)" : /Cloth/.test(name) ? "cloth drops from humanoids" : "source not classified") : owned.has(by) ? `your own ${by}` : profession === by ? `this profession itself` : economyGatherer ? `${label(economyGatherer)}'s ${by} (same realm and faction)` : `${by} (nobody in this faction economy has it)`;
      return { name, supply };
    });
    const economyCoverage = economy.filter((character) => character !== subject && character.brief.professions.some((entry) => entry.name === profession)).map((character) => `${label(character)} already has ${profession}`);
    const blockedCoverage = others.filter((character) => character.brief.professions.some((entry) => entry.name === profession)).map((character) => `${label(character)} has ${profession} but is ${character.brief.realm !== subject.brief.realm ? "on another realm" : character.brief.faction && subject.brief.faction ? `${character.brief.faction} (you are ${subject.brief.faction})` : "of unknown faction"}, so it cannot supply you by mail`);
    const selfSupplied = inputs.length > 0 && inputs.filter((input) => /^your own|same realm and faction|vendor/.test(input.supply)).length >= inputs.length * 0.6;
    const notes: string[] = [];
    if (GATHERING.has(profession)) notes.push("Gathering profession: income and inputs, no crafted gear.");
    if (!recipeIds.length && !GATHERING.has(profession)) notes.push("No verified Forever recipes for this profession are in the knowledge base yet.");
    const score = Math.min(1, craftedUpgrades.length * 0.08 + (selfSupplied ? 0.25 : 0) + (economyCoverage.length ? -0.15 : 0.1) + (consumables.length ? 0.1 : 0) + (GATHERING.has(profession) ? 0.2 : 0));
    options.push({ profession, craftedUpgrades: craftedUpgrades.sort((a, b) => b.magnitude - a.magnitude), consumables: consumables.slice(0, 4), inputs, economyCoverage, blockedCoverage, notes, selfSupplied, score });
  }
  return options.sort((a, b) => b.score - a.score);
}

// ---------------------------------------------------------------------------------------------
// Draft builders

const zoneOf = (quest: DiscoveredQuest) => quest.zone ?? "an unrecorded zone";

/**
 * The character as it would be after equipping better items it already carries (observed bags only), so
 * external discoveries are compared against what is free and immediate, not against what is worn now.
 */
export function projectOwnedUpgrades(subject: CharacterEvidence): { projected: CharacterEvidence; replaced: Map<string, string> } {
  const equipment = subject.equipment.map((slot) => ({ ...slot }));
  const replaced = new Map<string, string>();
  const projected = { ...subject, equipment };
  for (const held of subject.held.filter((item) => item.storage === "bags" && item.state === "OBSERVED")) {
    const item = foreverItem(held.itemId);
    if (!item) continue;
    const baseline = proficiencyBaseline(item, subject);
    if (baseline && !baseline.allowed) continue;
    const comparison = compareToEquipped(item, projected);
    if (!comparison || !["UPGRADE", "FILLS_EMPTY_SLOT"].includes(comparison.verdict) || eligibility(item, subject).blocked) continue;
    const slot = equipment.find((entry) => entry.slotName === comparison.slotName);
    if (!slot) continue;
    slot.itemId = item.id; slot.name = item.name; slot.empty = false; slot.itemLevel = item.itemLevel;
    replaced.set(comparison.slotName, item.name);
  }
  return { projected, replaced };
}

export function discoveryDrafts(index: ForeverKnowledgeIndex, actual: CharacterEvidence, characters: CharacterEvidence[]): { drafts: Draft[]; plan: LevelPlanStep[]; quests: DiscoveredQuest[]; gear: GearCandidate[]; professions: ProfessionOption[] } {
  const { projected: subject, replaced } = projectOwnedUpgrades(actual);
  const economy = characters.filter((character) => character === actual || sameRealmFaction(character, actual)).map((character) => character === actual ? subject : character);
  const others = characters.filter((character) => character !== actual && !sameRealmFaction(character, actual));
  const quests = discoverQuests(index, subject);
  const gear = discoverGear(index, subject, economy, quests);
  const drafts: Draft[] = [];
  const level = subject.brief.level ?? 1;
  const gold = subject.brief.gold.copper;

  // Gear: one recommendation per slot (best candidate), alternatives listed.
  const bestBySlot = new Map<string, GearCandidate[]>();
  for (const candidate of gear) bestBySlot.set(candidate.comparison.slotName, [...(bestBySlot.get(candidate.comparison.slotName) ?? []), candidate]);
  for (const [slot, list] of bestBySlot) {
    const [best, ...rest] = list;
    const soon = best.reqLevel > level;
    const biggerElsewhere = rest.find((other) => other.comparison.magnitude > best.comparison.magnitude);
    const preference = biggerElsewhere ? ` Chosen over ${biggerElsewhere.item.name} (${biggerElsewhere.comparison.deltas.join(", ")}, ${biggerElsewhere.source.detail}) because ${best.source.kind.includes("QUEST") ? "a quest reward costs no gold" : "it is easier to get"}${biggerElsewhere.source.kind === "VENDOR" ? `, the vendor price is unknown${gold !== undefined ? ` and you have ${formatCopper(gold)}` : ""}` : biggerElsewhere.source.kind === "CRAFT" ? ", and crafting it needs the profession and materials" : ""}.` : "";
    drafts.push({
      id: `discover-gear-${slot.toLowerCase().replace(/\W+/g, "-")}`,
      category: "DISCOVERED_GEAR",
      title: `${slot}: ${best.item.name} (${best.source.kind === "ACTIVE_QUEST_REWARD" ? "quest you already have" : best.source.kind.toLowerCase().replace("_", " ")})`,
      what: `Get ${best.item.name}: ${best.source.detail}.`,
      why: `${best.comparison.verdict === "FILLS_EMPTY_SLOT" ? `Fills your empty ${slot} slot` : best.comparison.verdict === "UPGRADE" ? `Beats ${best.comparison.equipped?.name}` : `Trades off against ${best.comparison.equipped?.name}`}: ${best.comparison.deltas.join(", ")}.${soon ? ` Usable at level ${best.reqLevel}.` : ""}${preference}`,
      supports: "IMMEDIATE_POWER",
      feasibility: best.source.kind === "ACTIVE_QUEST_REWARD" ? "NEEDS_INPUTS" : soon ? "NEEDS_PROGRESSION" : best.source.kind === "DROP" ? "UNCERTAIN" : "NEEDS_INPUTS",
      evidence: replaced.has(slot) ? [{ kind: "DERIVED" as const, statement: `Compared against ${replaced.get(slot)}, which you already carry and should equip first.`, source: "observed bags + Forever item records" }, ...best.evidence] : best.evidence,
      prerequisites: best.prerequisites,
      costs: best.source.kind === "VENDOR" ? ["Vendor price unknown (not in the knowledge base)."] : best.source.kind === "CRAFT" ? ["Materials listed under prerequisites."] : ["Time."],
      alternatives: rest.map((other) => `${other.item.name} (${other.source.detail}): ${other.comparison.deltas.join(", ")}`),
      tradeoffs: best.comparison.notes,
      unknowns: best.source.kind === "QUEST_REWARD" || best.source.kind === "ACTIVE_QUEST_REWARD" ? ["Quest rewards may be a choice between items; QuestieDB does not say which."] : best.source.kind === "DROP" ? ["Drop chance unknown."] : [],
      nextActions: best.source.questId ? [`${best.source.kind === "ACTIVE_QUEST_REWARD" ? "Finish" : "Pick up"} "${index.quest(best.source.questId)?.name ?? best.source.questId}"${best.source.kind === "QUEST_REWARD" && quests.find((quest) => quest.id === best.source.questId)?.starterLocation ? ` from ${quests.find((quest) => quest.id === best.source.questId)!.starterLocation}` : ""} and choose ${best.item.name}.`] : [best.source.detail.charAt(0).toUpperCase() + best.source.detail.slice(1) + "."],
      value: Math.min(0.85, 0.25 + best.magnitude * 0.6),
      confidence: best.source.kind === "CRAFT" && best.evidence.some((line) => line.kind === "OBSERVED") ? 0.95 : 0.75,
      objectives: ["GEAR", "IMPROVE_CHARACTER"],
    });
  }

  // Quests: the strongest available quests, grouped by zone.
  const availableNow = quests.filter((quest) => quest.available && !quest.classQuest);
  const byZone = new Map<string, DiscoveredQuest[]>();
  for (const quest of availableNow) byZone.set(zoneOf(quest), [...(byZone.get(zoneOf(quest)) ?? []), quest]);
  const zones = [...byZone].sort((a, b) => b[1].reduce((sum, quest) => sum + quest.score, 0) - a[1].reduce((sum, quest) => sum + quest.score, 0)).slice(0, 2);
  for (const [zone, list] of zones) {
    const top = list.slice(0, 6);
    const xp = top.reduce((sum, quest) => sum + (quest.quest.xp ?? 0), 0);
    drafts.push({
      id: `discover-quests-${zone.toLowerCase().replace(/\W+/g, "-")}`,
      category: "DISCOVERED_QUESTS",
      title: `Quests you haven't picked up in ${zone} (${top.length})`,
      what: top.map((quest) => `"${quest.quest.name}" (level ${quest.quest.level ?? "?"}${quest.starterLocation ? `, from ${quest.starterLocation}` : quest.quest.startItem ? `, starts from the item ${index.item(quest.quest.startItem)?.name ?? quest.quest.startItem}` : quest.quest.startObjects?.length ? `, starts from ${index.bundle.objects[String(quest.quest.startObjects[0])]?.name ?? "an object"}` : ""}${quest.quest.xp ? `, ${quest.quest.xp} XP` : ""})`).join("; ") + ".",
      why: `${xp ? `About ${xp} XP together${subject.xp ? ` (${Math.round(xp / subject.xp.xpMax * 100)}% of this level)` : ""}` : "Quest XP not known"}${top.some((quest) => quest.rewardUpgrades.length) ? `; rewards include ${top.flatMap((quest) => quest.rewardUpgrades.map((upgrade) => upgrade.item.name)).slice(0, 3).join(", ")}` : ""}. None of these are in your log or completed history.`,
      supports: "IMMEDIATE_POWER",
      feasibility: "READY_NOW",
      evidence: [{ kind: subject.completedState === "UNKNOWN" ? "UNKNOWN" : "OBSERVED", statement: `${label(subject)}'s completed-quest history (${subject.completedQuests.size} IDs) and quest log were checked; these quests appear in neither.`, source: "Forever C_QuestLog sidecar" }, ...top.map((quest) => ({ kind: "EXTERNAL" as const, statement: `"${quest.quest.name}" (quest ${quest.id}): level ${quest.quest.level ?? "?"}, requires ${quest.quest.reqLevel ?? "?"}${quest.quest.text ? `. ${quest.quest.text.slice(0, 140)}` : ""}`, source: "QuestieDB Forever (XP from Classic-seeded table)" }))],
      prerequisites: [],
      costs: ["Travel and time."],
      alternatives: list.slice(6, 10).map((quest) => `"${quest.quest.name}" (level ${quest.quest.level ?? "?"})`),
      tradeoffs: [],
      unknowns: ["Forever-only quests are only partly covered by QuestieDB; quests the database lacks are not listed.", "Quest XP comes from a Classic-seeded table."],
      nextActions: top.slice(0, 3).map((quest) => `Pick up "${quest.quest.name}"${quest.starterLocation ? ` from ${quest.starterLocation}` : ""}.`),
      value: Math.min(0.75, 0.3 + (subject.xp && xp ? xp / subject.xp.xpMax * 0.4 : 0)),
      confidence: 0.75,
      objectives: ["LEVELING", "IMPROVE_CHARACTER"],
    });
  }
  const chainQuests = quests.filter((quest) => !quest.available && quest.missingPrerequisites.length && quest.rewardUpgrades.length);
  for (const quest of chainQuests.slice(0, 2)) drafts.push({
    id: `discover-chain-${quest.id}`, category: "DISCOVERED_QUESTS",
    title: `Quest chain toward "${quest.quest.name}"`,
    what: `Complete ${quest.missingPrerequisites.map((id) => `"${index.quest(id)?.name ?? id}"`).join(", ")} to unlock "${quest.quest.name}"${quest.zone ? ` in ${quest.zone}` : ""}.`,
    why: `Its rewards include ${quest.rewardUpgrades.map((upgrade) => `${upgrade.item.name} (${upgrade.comparison.deltas.join(", ")})`).join("; ")}.`,
    supports: "IMMEDIATE_POWER", feasibility: "NEEDS_PROGRESSION",
    evidence: quest.rewardUpgrades[0].evidence, prerequisites: quest.rewardUpgrades[0].prerequisites, costs: ["Time."], alternatives: [], tradeoffs: [], unknowns: ["Reward may be a choice."],
    nextActions: [`Start with "${index.quest(quest.missingPrerequisites[0])?.name ?? quest.missingPrerequisites[0]}".`], value: 0.4, confidence: 0.7, objectives: ["LEVELING", "GEAR"],
  });

  // Class quests (milestones such as the level 10 druid chain).
  const classQuests = quests.filter((quest) => quest.classQuest);
  if (classQuests.length) {
    const first = classQuests.filter((quest) => quest.missingPrerequisites.length === 0).sort((a, b) => (a.quest.reqLevel ?? 0) - (b.quest.reqLevel ?? 0) || (a.zone === subject.zone ? -1 : 0) - (b.zone === subject.zone ? -1 : 0))[0] ?? classQuests[0];
    const chain: BundleQuest[] = [];
    let cursor: BundleQuest | undefined = first.quest;
    const seen = new Set<number>();
    while (cursor && chain.length < 8) { chain.push(cursor); const next: number | undefined = cursor.next ?? index.quests().find(([candidateId, candidate]) => !seen.has(candidateId) && (candidate.preSingle ?? candidate.preGroup ?? []).some((pre) => index.quest(pre) === cursor) && raceAllowed(candidate.races, subject) === true && classAllowed(candidate.classes, subject) === true)?.[0]; if (next === undefined || seen.has(next)) break; seen.add(next); cursor = index.quest(next); }
    const classVisit = subject.trainerVisits.find((visit) => visit.kind === "CLASS");
    const trainerHasBear = !!classVisit?.services.some((service) => service.name === "Bear Form");
    const needsBear = (classVisit?.services ?? []).filter((service) => service.requires.some((requirement) => /^Bear Form/.test(requirement)) && (service.level ?? 99) <= level + 10);
    const druidBear = subject.brief.class === "DRUID" && chain.some((quest) => /Body and Heart|Great Bear Spirit/.test(quest.name));
    drafts.push({
      id: `class-quest-${first.id}`, category: "CLASS_QUEST",
      title: `Class quest${chain.length > 1 ? " chain" : ""} at level ${first.quest.reqLevel ?? "?"}: ${chain.map((quest) => quest.name).join(" -> ")}`,
      what: `At level ${first.quest.reqLevel ?? "?"}, start "${first.quest.name}"${first.starterLocation ? ` from ${first.starterLocation}` : ""}${chain.length > 1 ? ` and follow it to "${chain[chain.length - 1].name}"` : ""}.`,
      why: druidBear ? `This is the druid chain that teaches Bear Form in Classic Era (${CLASSIC_BASELINE_NOTE}).${trainerHasBear ? "" : " Your Forever trainer does not sell Bear Form"}${!trainerHasBear && needsBear.length ? `, yet it sells ${needsBear.map((service) => `${service.name} (level ${service.level}, ${service.costCopper !== undefined ? formatCopper(service.costCopper) : "?"})`).join(" and ")}, which require Bear Form: finish this chain first or those purchases are blocked.` : trainerHasBear ? "" : "."}` : "Class quests unlock class abilities or items.",
      supports: "IMMEDIATE_POWER", feasibility: (first.quest.reqLevel ?? 0) > level ? "NEEDS_PROGRESSION" : "READY_NOW",
      evidence: [...chain.map((quest) => ({ kind: "EXTERNAL" as const, statement: `"${quest.name}" (level ${quest.level ?? "?"}, requires ${quest.reqLevel ?? "?"}, ${index.zoneName(quest.zone) ?? "zone unknown"})${quest.text ? `: ${quest.text.slice(0, 160)}` : ""}`, source: "QuestieDB Forever" })), ...(druidBear && classVisit ? [{ kind: "OBSERVED" as const, statement: trainerHasBear ? "The observed class trainer lists Bear Form." : `The observed class trainer (${classVisit.serviceCount} services) does not list Bear Form${needsBear.length ? `; ${needsBear.map((service) => `${service.name} ${service.rank ?? ""}`.trim()).join(", ")} list "Bear Form (Shapeshift)" as a requirement` : ""}.`, source: "Forever trainer window" }] : [])],
      prerequisites: [`Level ${first.quest.reqLevel ?? "?"}.`, "Travel: the chain sends you between zones; travel time is not estimated."],
      costs: ["Time and travel."], alternatives: [], tradeoffs: [], unknowns: druidBear && needsBear.length && !trainerHasBear ? [] : ["The ability the chain teaches in Forever is not confirmed by the client."],
      nextActions: [`At level ${first.quest.reqLevel ?? "?"}, go to ${first.starterLocation ?? "the quest giver"}.`],
      value: druidBear ? 0.7 : 0.5, confidence: 0.75, objectives: ["IMPROVE_CHARACTER", "LEVELING"],
    });
  }

  // Class training from the observed trainer visit.
  const training = classTraining(subject);
  if (training) {
    const nowCost = training.now.reduce((sum, service) => sum + (service.costCopper ?? 0), 0);
    const upcomingCost = [...training.upcoming.values()].flat().reduce((sum, service) => sum + (service.costCopper ?? 0), 0);
    drafts.push({
      id: "class-training", category: "CLASS_TRAINING",
      title: `Class training: ${training.now.length ? `${training.now.length} ability rank${training.now.length > 1 ? "s" : ""} now (${formatCopper(nowCost)})` : "nothing new at your level"}; ${formatCopper(upcomingCost)} over the next 5 levels`,
      what: [training.now.length ? `Now: ${training.now.map((service) => `${service.name}${service.rank ? ` ${service.rank}` : ""} (${service.costCopper !== undefined ? formatCopper(service.costCopper) : "?"})`).join(", ")}.` : "", ...[...training.upcoming].sort((a, b) => a[0] - b[0]).map(([lvl, list]) => `Level ${lvl}: ${list.map((service) => `${service.name}${service.rank ? ` ${service.rank}` : ""} (${service.costCopper !== undefined ? formatCopper(service.costCopper) : "?"})`).join(", ")}.`)].filter(Boolean).join(" "),
      why: `These are the ranks your class trainer offered at the observed visit.${gold !== undefined ? ` You have ${formatCopper(gold)}; the next five levels of training cost ${formatCopper(nowCost + upcomingCost)}${gold < nowCost + upcomingCost ? `, so you are short by ${formatCopper(nowCost + upcomingCost - gold)}` : ""}.` : ""}`,
      supports: "IMMEDIATE_POWER", feasibility: gold !== undefined && gold >= nowCost ? "READY_NOW" : "NEEDS_INPUTS",
      evidence: [{ kind: "OBSERVED", statement: `Class trainer window observed ${training.visitAt ? new Date(training.visitAt * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "at an unknown time"}: each service's level, cost and status at that visit.`, source: "Forever trainer window (GetTrainerServiceInfo/Cost)" }, ...(gold !== undefined ? [{ kind: subject.brief.gold.state, statement: `${label(subject)} has ${formatCopper(gold)}.`, source: "observed money" }] : [])],
      prerequisites: [], costs: [`${formatCopper(nowCost)} now; ${formatCopper(upcomingCost)} for levels ${level + 1}-${level + 5}.`], alternatives: [], tradeoffs: gold !== undefined && gold < nowCost + upcomingCost ? ["If gold is short, train the ranks you press most first (your main damage and heal spells)."] : [],
      unknowns: ["Statuses can change after leveling; reopen the trainer to refresh."],
      nextActions: training.now.length ? ["Visit your class trainer and train the available ranks."] : [`Train at level ${[...training.upcoming.keys()].sort((a, b) => a - b)[0] ?? level + 2}.`],
      value: 0.7, confidence: 1, objectives: ["IMPROVE_CHARACTER", "LEVELING"],
    });
  }

  // Profession trainer recipes near the current skill (e.g. Blacksmithing visit).
  for (const visit of subject.trainerVisits.filter((entry) => entry.kind !== "CLASS")) {
    const skill = subject.brief.professions.find((profession) => profession.name === visit.kind)?.skill;
    const reachable = visit.services.filter((service) => service.skillRequirement?.rank !== undefined && skill !== undefined && service.skillRequirement.rank <= skill + 25).map((service) => ({ service, recipe: subject.catalog.find((recipe) => recipe.name === service.name) })).map((entry) => ({ ...entry, output: foreverItem(entry.recipe?.outputItemID) })).map((entry) => ({ ...entry, comparison: entry.output ? compareToEquipped(entry.output, subject) : undefined }));
    const upgrades = reachable.filter((entry) => entry.comparison && ["UPGRADE", "FILLS_EMPTY_SLOT"].includes(entry.comparison.verdict));
    if (!reachable.length) continue;
    drafts.push({
      id: `profession-trainer-${visit.kind.toLowerCase()}`, category: "PROFESSION_TRAINING",
      title: `${visit.kind} trainer recipes within reach (${reachable.length}, skill ${skill})`,
      what: reachable.slice(0, 8).map((entry) => `${entry.service.name} at ${visit.kind} ${entry.service.skillRequirement?.rank} for ${entry.service.costCopper !== undefined ? formatCopper(entry.service.costCopper) : "?"}${entry.comparison && ["UPGRADE", "FILLS_EMPTY_SLOT"].includes(entry.comparison.verdict) ? ` (upgrade: ${entry.comparison.deltas.join(", ")})` : ""}`).join("; ") + ".",
      why: upgrades.length ? `${upgrades.map((entry) => entry.output!.name).join(", ")} would improve your gear once you reach the skill; everything else is skill-ups.` : "Next recipes for skill-ups.",
      supports: "BOTH", feasibility: "NEEDS_PROGRESSION",
      evidence: [{ kind: "OBSERVED", statement: `${visit.kind} trainer window: ${visit.serviceCount} services with skill requirement and cost.`, source: "Forever trainer window" }, ...upgrades.slice(0, 3).flatMap((entry) => [externalItem(entry.output!), { kind: "DERIVED" as const, statement: `${entry.output!.name} vs ${entry.comparison!.equipped?.empty ? "empty slot" : entry.comparison!.equipped?.name}: ${entry.comparison!.deltas.join(", ")}.`, source: "Forever item records" }])],
      prerequisites: [`Raise ${visit.kind} from ${skill} to the listed skill.`], costs: [`Training ${formatCopper(reachable.slice(0, 8).reduce((sum, entry) => sum + (entry.service.costCopper ?? 0), 0))} for the listed recipes, plus materials.`],
      alternatives: [], tradeoffs: [], unknowns: [], nextActions: [`Level ${visit.kind} with the recipes you know, then train the next recipe.`],
      value: upgrades.length ? 0.5 : 0.3, confidence: 0.95, objectives: ["DEVELOP_PROFESSIONS", "SELF_SUFFICIENCY", "GEAR"],
    });
  }

  // Profession choice.
  const professions = compareProfessions(index, subject, economy, others);
  if (professions.length) {
    const current = subject.brief.professions.filter((profession) => PRIMARY_PROFESSIONS.includes(profession.name)).map((profession) => profession.name);
    const pick = professions.find((option) => !GATHERING.has(option.profession) && option.craftedUpgrades.length > 0 && option.selfSupplied) ?? professions[0];
    const gatheringPick = professions.find((option) => GATHERING.has(option.profession));
    const gathers = (option: ProfessionOption) => (GATHERED_MATERIALS[option.profession] ?? []).map((id) => foreverItem(id)).filter((item): item is ForeverItemKnowledge => !!item).slice(0, 4).map((item) => `${item.name}${item.sellPriceCopper !== undefined ? ` (vendor ${formatCopper(item.sellPriceCopper)})` : ""}`).join(", ");
    const describe = (option: ProfessionOption) => GATHERING.has(option.profession) ? `${[...current, option.profession].join(" + ")}: no gear; gathers ${gathers(option) || "materials"}${option.blockedCoverage.length ? `; ${option.blockedCoverage.join("; ")}` : ""}.` : `${[...current, option.profession].join(" + ")}: ${option.craftedUpgrades.length ? `${option.craftedUpgrades.length} crafted upgrade(s) for you within 10 levels (best ${option.craftedUpgrades[0].item.name}: ${option.craftedUpgrades[0].comparison.deltas.join(", ")})` : GATHERING.has(option.profession) ? "no gear; raw materials" : "no crafted upgrades found"}; inputs ${option.inputs.slice(0, 4).map((input) => `${input.name} from ${input.supply}`).join(", ") || "n/a"}${option.consumables.length ? `; consumables such as ${option.consumables[0].split(":")[0]}` : ""}${option.economyCoverage.length ? `; ${option.economyCoverage.join("; ")}` : ""}${option.blockedCoverage.length ? `; ${option.blockedCoverage.join("; ")}` : ""}.`;
    const naturalPair = new Map([["Skinning", "Leatherworking"], ["Herbalism", "Alchemy"], ["Mining", "Blacksmithing"]]);
    const shown = [pick, ...(gatheringPick && gatheringPick !== pick ? [gatheringPick] : []), ...professions.filter((option) => option !== pick && option !== gatheringPick && (current.some((name) => naturalPair.get(name) === option.profession) || ["Herbalism", "Leatherworking", "Alchemy"].includes(option.profession)))].slice(0, 4);
    drafts.push({
      id: "profession-choice", category: "PROFESSION_CHOICE",
      title: `Second profession: ${[...current, pick.profession].join(" + ")} looks strongest for your goals`,
      what: shown.map(describe).join(" | "),
      why: `${pick.profession} ${pick.craftedUpgrades.length ? `makes gear you can wear now or soon` : "fills the gap"}${pick.selfSupplied ? " and your own or your faction's gathering supplies most inputs" : ""}.${gatheringPick && gatheringPick !== pick ? ` ${[...current, gatheringPick.profession].join(" + ")} earns more raw materials to sell, but income depends on Auction House prices WoWSync does not have.` : ""} Characters of the other faction or on another realm are not counted as suppliers.`,
      supports: "SELF_SUFFICIENCY", feasibility: "NEEDS_INPUTS",
      evidence: [{ kind: subject.brief.professionsState, statement: `${label(subject)} has ${subject.brief.professions.map((profession) => `${profession.name} ${profession.skill}/${profession.maxSkill}`).join(", ") || "no professions"}.`, source: "observed professions" }, ...economy.filter((character) => character !== subject).map((character) => ({ kind: character.brief.professionsState, statement: `${label(character)} (same realm, ${character.brief.faction}) has ${character.brief.professions.map((profession) => profession.name).join(", ") || "no professions"}.`, source: "observed professions" })), ...others.filter((character) => character.brief.realm === subject.brief.realm).map((character) => ({ kind: "DERIVED" as const, statement: `${label(character)} is ${character.brief.faction ?? "of unknown faction"} on the same realm: ordinary mail to ${label(subject)} (${subject.brief.faction}) is not possible.`, source: "observed faction" })), ...pick.craftedUpgrades.slice(0, 2).flatMap((upgrade) => upgrade.evidence.slice(0, 2))],
      prerequisites: [`Find a ${pick.profession} trainer (location and cost not in the knowledge base).`], costs: ["Training fee unknown; materials as listed."],
      alternatives: shown.filter((option) => option !== pick).map(describe), tradeoffs: ["Gathering pairs earn more raw goods; crafting pairs turn them into gear and save buying it."],
      unknowns: ["Recipe skill thresholds are known only for trainer-observed or pattern recipes.", "Auction House prices are unknown, so gathering income is not estimated."],
      nextActions: [`Learn ${pick.profession}, then open its window once and run /wowsync so WoWSync records the real Forever recipe list.`, ...economy.filter((character) => character !== subject && character.brief.professionsState === "OBSERVED" && character.brief.professions.filter((entry) => PRIMARY_PROFESSIONS.includes(entry.name)).length < 2).slice(0, 1).map((character) => `Account plan: ${label(character)} (same realm and faction) has free profession slots; ${gatheringPick && gatheringPick !== pick ? `taking ${gatheringPick.profession}${gatheringPick.profession === "Herbalism" ? " (and Alchemy)" : ""} there` : "a complementary profession there"} covers what ${label(subject)} gives up, and they can mail each other.`)],
      value: 0.55, confidence: 0.75, objectives: ["DEVELOP_PROFESSIONS", "SELF_SUFFICIENCY", "MAKE_GOLD"],
    });
  }

  return { drafts, plan: buildLevelPlan(index, subject, quests, gear, training), quests, gear, professions };
}

// ---------------------------------------------------------------------------------------------
// Goldmaking discovery (one economy: same realm and faction)

const GATHERED_MATERIALS: Record<string, number[]> = {
  Skinning: [2934, 783, 2318, 4232, 2319, 4234],
  Mining: [2770, 2835, 2771, 2836, 2775, 774, 1210, 818],
  Herbalism: [2447, 765, 2449, 785, 2450, 2452, 2453, 3820, 3355],
};

function recipeDemand(index: ForeverKnowledgeIndex, itemId: number): Array<{ profession: string; recipe: string }> {
  const uses: Array<{ profession: string; recipe: string }> = [];
  for (const [profession, ids] of Object.entries(index.bundle.recipesByProfession)) for (const id of ids) {
    const spell = foreverSpell(id);
    if (spell?.reagents.some((reagent) => reagent.itemId === itemId)) uses.push({ profession, recipe: spell.name });
  }
  return uses;
}

export function goldDiscoveryDrafts(index: ForeverKnowledgeIndex, members: CharacterEvidence[], economyLabel: string): Draft[] {
  const drafts: Draft[] = [];
  const owned = new Map<string, CharacterEvidence[]>();
  for (const character of members) for (const profession of character.brief.professions) owned.set(profession.name, [...(owned.get(profession.name) ?? []), character]);
  // 1. What this economy's gatherers can harvest, with Forever vendor floors and recipe demand.
  for (const [profession, gatherers] of owned) {
    const materials = (GATHERED_MATERIALS[profession] ?? []).map((id) => ({ id, item: foreverItem(id) })).filter((entry): entry is { id: number; item: ForeverItemKnowledge } => !!entry.item);
    if (!materials.length) continue;
    const lines = materials.map((entry) => {
      const demand = recipeDemand(index, entry.id);
      const where = profession === "Herbalism" ? Object.values(index.bundle.objects).filter((object) => object.name === entry.item.name).flatMap((object) => (object.zones ?? []).map((zone) => index.zoneName(zone))).filter((zone): zone is string => !!zone && gatherers.some((character) => zonePlausible(zone, character))) : [];
      return { name: entry.item.name, sell: entry.item.sellPriceCopper, demand, where: [...new Set(where)].slice(0, 3) };
    });
    const ownCrafters = [...owned.keys()].filter((name) => !GATHERING.has(name) && PRIMARY_PROFESSIONS.includes(name));
    drafts.push({
      id: `gold-gather-${profession.toLowerCase()}-${economyLabel}`, category: "GATHERING_DISCOVERY",
      title: `${profession} materials worth gathering (${gatherers.map((character) => label(character)).join(", ")})`,
      what: lines.map((line) => `${line.name}${line.sell !== undefined ? ` (vendor ${formatCopper(line.sell)})` : ""}${line.demand.length ? `, used by ${[...new Set(line.demand.map((use) => use.profession))].join("/")} (${line.demand.length} recipes)` : ""}${line.where.length ? `, grows in ${line.where.join(", ")}` : ""}`).join("; ") + ".",
      why: `Vendor prices are the guaranteed floor. Materials with many recipe uses are the ones crafters buy, so they are the best Auction House candidates, but their price is unknown.${ownCrafters.length ? ` In this economy, ${ownCrafters.join(" and ")} can use some of them directly.` : " Nobody in this faction economy crafts with them yet."}`,
      supports: "GOLD", feasibility: "READY_NOW",
      evidence: [...gatherers.map((character) => ({ kind: character.brief.professionsState, statement: `${label(character)} has ${profession} ${character.brief.professions.find((entry) => entry.name === profession)?.skill ?? "?"}.`, source: "observed professions" })), ...lines.slice(0, 4).map((line) => ({ kind: "EXTERNAL" as const, statement: `${line.name}: vendor ${line.sell !== undefined ? formatCopper(line.sell) : "unknown"}; ${line.demand.length} known recipe uses${line.demand.length ? ` (e.g. ${line.demand[0].recipe})` : ""}.`, source: "Wowhead Forever tooltips + QuestieDB Forever" }))],
      prerequisites: [], costs: ["Time while questing."], alternatives: [], tradeoffs: ["Selling raw gives up crafting value; keep what your own crafters use."],
      unknowns: ["Auction House prices.", "Node and creature density per zone."],
      nextActions: [`Keep ${profession} tracking on; vendor anything with no recipe use.`],
      value: 0.35, confidence: 0.8, objectives: ["MAKE_GOLD", "SELF_SUFFICIENCY"],
    });
  }
  // 2. Profession investment: an unowned crafting profession that turns this economy's own materials into guaranteed vendor profit.
  const held = new Set<number>();
  for (const character of members) for (const item of character.held) if (!item.bound) held.add(item.itemId);
  const gatherable = new Set([...owned.keys()].flatMap((name) => GATHERED_MATERIALS[name] ?? []));
  for (const [profession, ids] of Object.entries(index.bundle.recipesByProfession)) {
    if (owned.has(profession) || GATHERING.has(profession) || !PRIMARY_PROFESSIONS.includes(profession)) continue;
    const margins = ids.map((id) => foreverSpell(id)).filter((spell): spell is NonNullable<typeof spell> => !!spell?.createsItemId && spell.reagents.length > 0).map((spell) => {
      const output = foreverItem(spell.createsItemId);
      const inputValue = spell.reagents.reduce((sum, reagent) => sum + (foreverItem(reagent.itemId)?.sellPriceCopper ?? Number.NaN) * reagent.quantity, 0);
      const available = spell.reagents.every((reagent) => held.has(reagent.itemId) || gatherable.has(reagent.itemId));
      return { spell, output, margin: output?.sellPriceCopper !== undefined && Number.isFinite(inputValue) ? output.sellPriceCopper - inputValue : undefined, available };
    }).filter((entry) => entry.available && entry.margin !== undefined && entry.margin > 0).sort((a, b) => b.margin! - a.margin!);
    if (!margins.length) continue;
    const best = margins.slice(0, 3);
    drafts.push({
      id: `gold-invest-${profession.toLowerCase()}-${economyLabel}`, category: "PROFESSION_INVESTMENT",
      title: `${profession} would turn ${economyLabel}'s own materials into vendor profit`,
      what: best.map((entry) => `${entry.spell.name}: ${entry.spell.reagents.map((reagent) => `${reagent.name} x${reagent.quantity}`).join(", ")} -> ${entry.output?.name} (+${formatCopper(entry.margin!)} per craft at vendor prices)`).join("; ") + ".",
      why: "Every input is held or gathered inside this faction economy, and the product vendors for more than the inputs. It also builds your own supply chain instead of selling raw.",
      supports: "BOTH", feasibility: "NEEDS_PROGRESSION",
      evidence: best.map((entry) => ({ kind: "EXTERNAL" as const, statement: `Forever recipe ${entry.spell.name}: ${entry.spell.reagents.map((reagent) => `${reagent.name} x${reagent.quantity} (vendor ${foreverItem(reagent.itemId)?.sellPriceCopper !== undefined ? formatCopper(foreverItem(reagent.itemId)!.sellPriceCopper!) : "?"})`).join(", ")} -> ${entry.output?.name} (vendor ${entry.output?.sellPriceCopper !== undefined ? formatCopper(entry.output.sellPriceCopper) : "?"}).`, source: entry.spell.sourceUrl })),
      prerequisites: [`Learn ${profession} (training cost unknown) and reach the recipe's skill.`], costs: ["Training fee unknown."],
      alternatives: [], tradeoffs: ["Uses a primary profession slot."], unknowns: ["Recipe skill requirements unless trainer-observed."],
      nextActions: [`Decide which character in ${economyLabel} has a free profession slot, then learn ${profession}.`],
      value: Math.min(0.5, 0.25 + best[0].margin! / 200), confidence: 0.8, objectives: ["MAKE_GOLD", "DEVELOP_PROFESSIONS", "SELF_SUFFICIENCY"],
    });
  }
  return drafts.map((draft) => ({ ...draft, realm: economyLabel }));
}

// ---------------------------------------------------------------------------------------------
// Level plan

export interface LevelPlanStep { level: number; training: string[]; quests: string[]; gear: string[]; milestones: string[]; goldNeeded?: number }

export function buildLevelPlan(index: ForeverKnowledgeIndex, subject: CharacterEvidence, quests: DiscoveredQuest[], gear: GearCandidate[], training: ReturnType<typeof classTraining>, window = 5): LevelPlanStep[] {
  const level = subject.brief.level;
  if (level === undefined) return [];
  const steps: LevelPlanStep[] = [];
  let cumulative = 0;
  for (let lvl = level; lvl <= level + window; lvl += 1) {
    const services = lvl === level ? training?.now ?? [] : training?.upcoming.get(lvl) ?? [];
    const cost = services.reduce((sum, service) => sum + (service.costCopper ?? 0), 0);
    cumulative += cost;
    const questsHere = quests.filter((quest) => !quest.classQuest && (quest.quest.level ?? 0) === lvl && (quest.quest.reqLevel ?? 0) <= lvl).sort((a, b) => b.score - a.score).slice(0, 4);
    const gearHere = gear.filter((candidate) => (lvl === level ? candidate.reqLevel <= level : candidate.reqLevel === lvl)).slice(0, 3);
    const milestoneQuests = quests.filter((quest) => quest.classQuest && (quest.quest.reqLevel ?? 0) === lvl && quest.missingPrerequisites.length === 0);
    const milestones = [...new Map(milestoneQuests.sort((a, b) => (a.zone === subject.zone ? -1 : 0) - (b.zone === subject.zone ? -1 : 0)).map((quest) => [quest.quest.name, `Class quest "${quest.quest.name}"${quest.starterLocation ? ` (${quest.starterLocation})` : ""}`] as [string, string])).values()];
    steps.push({
      level: lvl,
      training: services.map((service) => `${service.name}${service.rank ? ` ${service.rank}` : ""} (${service.costCopper !== undefined ? formatCopper(service.costCopper) : "?"})`),
      quests: questsHere.map((quest) => `"${quest.quest.name}"${quest.zone ? ` (${quest.zone})` : ""}`),
      gear: gearHere.map((candidate) => `${candidate.item.name} for ${candidate.comparison.slotName} (${candidate.source.detail})`),
      milestones,
      goldNeeded: cumulative,
    });
  }
  return steps;
}
