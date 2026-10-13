// Forever Co-Pilot: a goal-aware, read-only recommendation engine for one WoW version (Forever).
//
// Flow: player question -> objective -> account evidence (DashboardReadModel, Forever only) ->
// candidate actions from several generators (owned gear, other characters, crafting, quests,
// profession tools and supply, consumables, gold) -> prerequisites/costs/tradeoffs -> ranking ->
// explained recommendations with provenance -> next actions.
//
// Rules this module keeps:
// - Version isolation: only "forever" is accepted, and every read is made with version "forever".
// - Provenance: every evidence line is OBSERVED, DERIVED, LAST_SEEN, EXTERNAL or UNKNOWN.
//   LAST_SEEN is never described as current; UNKNOWN is never zero.
// - No invented prices, ownership, eligibility, recipes or mechanics. External facts come only from
//   the Forever knowledge dataset (foreverKnowledge.ts) and carry their source URL.
// - Player control: recommendations never execute anything. Moving items is described as
//   player-run steps; /bankx transfers always need the player to run each move.
import type { DashboardReadModel } from "./readModel.ts";
import type { ForeverTrainerVisit } from "./foreverTrainer.ts";
import { requiredSkillFor, type ForeverClassSpells, type ForeverSkillLines, type ForeverTalents } from "./foreverSkills.ts";
import type { ForeverKnowledgeIndex } from "./foreverKnowledgeBundle.ts";
import { discoveryDrafts, goldDiscoveryDrafts, proficiencyBaseline, type LevelPlanStep } from "./foreverDiscovery.ts";
import { formatCopper } from "./currency.ts";
import { AHLEDGER_ATTRIBUTION, currentForeverPrices, describePrice, foreverMarketFor, marketPrice, useForeverPrices, type ForeverPriceIndex, type PriceLookup } from "./foreverPrices.ts";
import {
  FOREVER_SYSTEM_FACTS,
  useForeverKnowledge,
  currentForeverKnowledge,
  foreverItem,
  foreverQuest,
  foreverSpell,
  foreverSpells,
  type ForeverItemKnowledge,
  type ForeverSystemFact,
} from "./foreverKnowledge.ts";

// ---------------------------------------------------------------------------------------------
// Public types

export type CopilotObjective = "IMPROVE_CHARACTER" | "MAKE_GOLD" | "DEVELOP_PROFESSIONS" | "SELF_SUFFICIENCY" | "LEVELING" | "GEAR";
export type CopilotEmphasis = "IMMEDIATE_POWER" | "SELF_SUFFICIENCY" | "BALANCED";
export type EvidenceKind = "OBSERVED" | "DERIVED" | "LAST_SEEN" | "EXTERNAL" | "UNKNOWN";
export type Supports = "IMMEDIATE_POWER" | "SELF_SUFFICIENCY" | "BOTH" | "GOLD" | "INFORMATION";
export type Feasibility = "READY_NOW" | "NEEDS_TRANSFER" | "NEEDS_INPUTS" | "NEEDS_PROGRESSION" | "UNCERTAIN";

export interface CopilotRequest {
  version: string;
  question: string;
  character?: { name: string; realm?: string };
  realm?: string;
  objectives?: CopilotObjective[];
  preferences?: { emphasis?: CopilotEmphasis; avoidSpending?: boolean; goals?: string[] };
  limit?: number;
}

export interface EvidenceLine {
  kind: EvidenceKind;
  statement: string;
  source: string;
  observedAt?: number;
}

export type GoldBucket = "SUPPORTED_NOW" | "NEEDS_INPUTS_OR_PROGRESSION" | "MARKET_DEPENDENT";

export interface CopilotRecommendation {
  id: string;
  category: string;
  realm?: string;
  goldBucket?: GoldBucket;
  title: string;
  what: string;
  why: string;
  supports: Supports;
  feasibility: Feasibility;
  evidence: EvidenceLine[];
  prerequisites: string[];
  costs: string[];
  alternatives: string[];
  tradeoffs: string[];
  unknowns: string[];
  nextActions: string[];
  score: { total: number; value: number; feasibility: number; objectiveFit: number; confidence: number; costPenalty: number; basis: string };
}

export interface CopilotCharacterBrief {
  name: string;
  realm: string;
  identityKey: string;
  class?: string;
  race?: string;
  faction?: string;
  level?: number;
  gold: { copper?: number; state: EvidenceKind };
  professions: Array<{ name: string; skill: number; maxSkill: number }>;
  professionsState: EvidenceKind;
  bagsState: EvidenceKind;
  bankState: EvidenceKind;
  snapshotFreshness?: string;
  generatedAt?: number;
}

export interface CopilotAnswer {
  status: "ANSWERED" | "UNSUPPORTED_VERSION" | "CHARACTER_NOT_FOUND" | "CHARACTER_AMBIGUOUS" | "NO_DATA";
  version: string;
  question: string;
  objective: { objectives: CopilotObjective[]; emphasis: CopilotEmphasis; basis: string; matchedTerms: string[] };
  subject?: CopilotCharacterBrief;
  scope: { realms: string[]; characters: CopilotCharacterBrief[]; note: string };
  playerGoals: Array<{ title: string; status: string; openSteps: string[]; source: string }>;
  challenges: string[];
  recommendations: CopilotRecommendation[];
  otherOpportunities: Array<{ title: string; reason: string }>;
  limitations: string[];
  knowledge: { source: string; refreshedAt?: string; ageDays?: number; available: boolean; sources: Array<{ name: string; url: string; usage: string; confidence: string }>; systemFacts: ForeverSystemFact[] };
  /** Level-by-level plan for the subject when external knowledge is available. */
  plan: LevelPlanStep[];
  discovery?: { questsConsidered: number; gearCandidates: number; professionOptions: number };
  playerControl: string;
  message?: string;
  markdown: string;
}

// ---------------------------------------------------------------------------------------------
// Evidence gathering

// The read model's projections are large discriminated unions; the co-pilot reads a stable subset.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Loose = Record<string, any>;

export interface HeldItem { itemId: number; name: string; qty: number; bound: boolean; storage: "bags" | "bank"; state: EvidenceKind; observedAt?: number; snapshotId?: number }
export interface EquippedItem { slotName: string; itemId?: number; name?: string; empty: boolean; itemLevel?: number }
export interface LearnedRecipe { recipeID: number; name: string; profession: string; outputItemID?: number; outputQuantity?: number; reagents: Array<{ itemId: number; quantity: number }>; canSkillUp?: boolean; numSkillUps?: number; state: EvidenceKind; sourceSnapshotId?: number }
export interface QuestRow { questID: number; title: string; readyForTurnIn: boolean | undefined; isComplete: boolean | undefined; objectives: Array<{ text: string; finished?: boolean; numFulfilled?: number; numRequired?: number }>; state: EvidenceKind; observedAt?: number }

export interface CharacterEvidence {
  brief: CopilotCharacterBrief;
  query: { version: "forever"; name: string; realm: string };
  xp?: { xp: number; xpMax: number };
  location?: string;
  equipment: EquippedItem[];
  equipmentState: EvidenceKind;
  equipmentObservedAt?: number;
  held: HeldItem[];
  bagsObservedAt?: number;
  bankObservedAt?: number;
  spells: string[];
  recipes: LearnedRecipe[];
  quests: QuestRow[];
  questState: EvidenceKind;
  questObservedAt?: number;
  /** Quest IDs the client returned as completed (OBSERVED or carried LAST_SEEN; both mean completed at some point). */
  completedQuests: Set<number>;
  completedState: EvidenceKind;
  /** Every recipe row the client enumerated for a captured profession, learned or not. */
  catalog: LearnedRecipe[];
  trainerVisits: ForeverTrainerVisit[];
  skills?: ForeverSkillLines;
  talents?: ForeverTalents;
  classSpells?: ForeverClassSpells;
  zone?: string;
  snapshotId?: number;
}

const kindOf = (state: unknown): EvidenceKind => state === "OBSERVED" ? "OBSERVED" : state === "LAST_SEEN" ? "LAST_SEEN" : state === "DERIVED" ? "DERIVED" : "UNKNOWN";
const itemIdFromRef = (ref: unknown): number | undefined => { const match = typeof ref === "string" ? /^item:(\d+)/.exec(ref) : null; return match ? Number(match[1]) : undefined; };
const valueOf = (resolution: Loose): Loose | undefined => resolution?.status === "FOUND" ? resolution.value?.data : undefined;


const isoDay = (epoch?: number) => epoch ? new Date(epoch * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "unknown time";

function gatherCharacter(readModel: DashboardReadModel, summary: Loose): CharacterEvidence {
  const query = { version: "forever" as const, name: String(summary.name), realm: String(summary.realm) };
  const state = valueOf(readModel.getCharacterState(query)) ?? {};
  const professionsRead = valueOf(readModel.getCharacterProfessions(query)) ?? {};
  const equipmentRead = valueOf(readModel.getCharacterEquipment(query)) ?? {};
  const held: HeldItem[] = [];
  let bagsObservedAt: number | undefined;
  let bankObservedAt: number | undefined;
  for (const storage of ["bags", "bank"] as const) {
    const resolution = readModel.getCharacterStorage({ ...query, storage, limit: 100 }) as Loose;
    const data = valueOf(resolution);
    const provenance = resolution?.value?.provenance ?? {};
    const sectionState = kindOf(data?.sectionState ?? provenance.state);
    if (storage === "bags") bagsObservedAt = provenance.observedAt; else bankObservedAt = provenance.observedAt;
    for (const item of (data?.items ?? []) as Loose[]) {
      const itemId = itemIdFromRef(item.itemRef);
      if (!itemId) continue;
      held.push({ itemId, name: String(item.name ?? `item ${itemId}`), qty: Number(item.qty ?? 0), bound: item.bound === "yes", storage, state: sectionState, observedAt: provenance.observedAt, snapshotId: provenance.snapshotId });
    }
  }
  const spellsRead = valueOf(readModel.getCharacterSpells({ ...query, limit: 100 })) ?? {};
  const recipeKnowledge = professionsRead.recipeKnowledge ?? {};
  const recipeState = kindOf(recipeKnowledge.evidence?.state);
  const recipes: LearnedRecipe[] = [];
  const catalog: LearnedRecipe[] = [];
  for (const profession of (recipeKnowledge.data?.professions ?? []) as Loose[]) {
    for (const recipe of (profession.recipes ?? []) as Loose[]) {
      if (typeof recipe.recipeID !== "number") continue;
      const target = recipe.learnedState === "OBSERVED_TRUE" ? recipes : recipe.learnedState === "OBSERVED_FALSE" ? catalog : undefined;
      if (!target) continue;
      target.push({
        recipeID: recipe.recipeID,
        name: String(recipe.name ?? recipe.recipeID),
        profession: String(profession.professionName ?? profession.name ?? "Unknown profession"),
        outputItemID: typeof recipe.outputItemID === "number" ? recipe.outputItemID : undefined,
        outputQuantity: recipe.outputQuantityMin === recipe.outputQuantityMax && typeof recipe.outputQuantityMin === "number" ? recipe.outputQuantityMin : undefined,
        reagents: ((recipe.reagentSlots ?? []) as Loose[]).filter((slot) => slot.required !== false).flatMap((slot) => (slot.reagents ?? []).slice(0, 1).map((reagent: Loose) => ({ itemId: Number(reagent.itemID), quantity: Number(slot.quantityRequired ?? 1) }))),
        canSkillUp: typeof recipe.canSkillUp === "boolean" ? recipe.canSkillUp : undefined,
        numSkillUps: typeof recipe.numSkillUps === "number" ? recipe.numSkillUps : undefined,
        state: recipeState,
        sourceSnapshotId: recipeKnowledge.evidence?.sourceSnapshotId,
      });
    }
  }
  const questResolution = readModel.getForeverQuestObservation(query) as Loose;
  const questData = valueOf(questResolution);
  const history = questData?.completedHistory as Loose | undefined;
  const completedQuests = new Set<number>(((history?.questIDs ?? []) as unknown[]).filter((id): id is number => typeof id === "number"));
  // Only rows the latest refresh actually returned are active; a carried LAST_SEEN row or an ID in the
  // completed history is not an open quest.
  const quests: QuestRow[] = ((questData?.active ?? []) as Loose[]).filter((quest) => quest.rowEvidence === "OBSERVED" && !completedQuests.has(Number(quest.questID))).map((quest) => ({
    questID: Number(quest.questID),
    title: String(quest.title ?? quest.questID),
    readyForTurnIn: quest.turnInReadinessState === "OBSERVED" ? Boolean(quest.readyForTurnIn) : undefined,
    isComplete: quest.completionState === "OBSERVED" ? Boolean(quest.isComplete) : undefined,
    objectives: ((quest.objectives ?? []) as Loose[]).map((objective) => ({ text: String(objective.text ?? ""), finished: objective.finishedState === "OBSERVED" ? Boolean(objective.finished) : undefined, numFulfilled: objective.numFulfilled, numRequired: objective.numRequired })),
    state: kindOf(quest.rowEvidence ?? questData?.state),
    observedAt: questData?.observedAt,
  }));
  const trainerResolution = readModel.getForeverTrainerVisits(query);
  const trainerVisits = trainerResolution.status === "FOUND" ? trainerResolution.value : [];
  const skillsResolution = readModel.getForeverSkillsAndTalents(query);
  const skillsAndTalents = skillsResolution.status === "FOUND" ? skillsResolution.value : {};
  const professionsSection = state.professions ?? {};
  const brief: CopilotCharacterBrief = {
    name: query.name,
    realm: query.realm,
    identityKey: String(summary.identityKey),
    class: summary.class,
    race: summary.race,
    faction: summary.faction,
    level: typeof summary.latestLevel === "number" ? summary.latestLevel : undefined,
    gold: { copper: typeof state.gold?.copper === "number" ? state.gold.copper : undefined, state: typeof state.gold?.copper === "number" ? kindOf(state.gold?.provenance?.state ?? "OBSERVED") : "UNKNOWN" },
    professions: ((professionsSection.entries ?? professionsRead.entries ?? []) as Loose[]).map((entry) => ({ name: String(entry.name), skill: Number(entry.skill), maxSkill: Number(entry.maxSkill) })),
    professionsState: kindOf(professionsSection.state ?? professionsRead.status?.state),
    bagsState: kindOf(state.bags?.state),
    bankState: kindOf(state.bank?.state),
    snapshotFreshness: state.provenance?.freshness,
    generatedAt: summary.latestGeneratedAt,
  };
  return {
    brief,
    query,
    xp: typeof state.progression?.xp === "number" && typeof state.progression?.xpMax === "number" ? { xp: state.progression.xp, xpMax: state.progression.xpMax } : undefined,
    location: [state.location?.zone, state.location?.subzone].filter(Boolean).join(" / ") || undefined,
    equipment: ((equipmentRead.slots ?? []) as Loose[]).map((slot) => ({ slotName: String(slot.slotName), itemId: itemIdFromRef(slot.itemRef), name: slot.name, empty: Boolean(slot.empty), itemLevel: slot.itemLevel !== undefined ? Number(slot.itemLevel) : undefined })),
    equipmentState: kindOf(equipmentRead.status?.state),
    equipmentObservedAt: equipmentRead.status?.observedAt,
    held,
    bagsObservedAt,
    bankObservedAt,
    spells: ((spellsRead.spells?.items ?? []) as Loose[]).map((spell) => String(spell.name)),
    recipes,
    quests,
    questState: kindOf(questData?.state),
    questObservedAt: questData?.observedAt,
    completedQuests,
    completedState: kindOf(history?.state),
    catalog: [...recipes, ...catalog],
    trainerVisits,
    skills: skillsAndTalents.skills,
    talents: skillsAndTalents.talents,
    classSpells: skillsAndTalents.classSpells,
    zone: state.location?.zone,
    snapshotId: state.provenance?.snapshotId,
  };
}

// ---------------------------------------------------------------------------------------------
// Objective understanding

const OBJECTIVE_TERMS: Array<[CopilotObjective, RegExp]> = [
  ["MAKE_GOLD", /\b(gold|goldmaking|money|profit|income|sell|auction|vendor|rich|farm(?:ing)? gold)\b/i],
  ["DEVELOP_PROFESSIONS", /\b(profession|professions|craft|crafting|skill ?up|blacksmith\w*|mining|tailor\w*|leatherwork\w*|engineer\w*|alchemy|herbalism|skinning|enchanting|cooking|first aid)\b/i],
  ["SELF_SUFFICIENCY", /\b(self[- ]?sufficien\w*|self[- ]?suppl\w*|pipeline|my own (?:mats|materials)|stop buying)\b/i],
  ["LEVELING", /\b(level(?:ing)?|xp|experience|quest(?:s|ing)?|ding)\b/i],
  ["GEAR", /\b(gear|upgrade|upgrades|equipment|armor|weapon|item level|ilvl)\b/i],
  ["IMPROVE_CHARACTER", /\b(improve|stronger|better|power|valuable|progress|what should i do|haven'?t considered)\b/i],
];

export function understandObjective(request: CopilotRequest): CopilotAnswer["objective"] {
  const emphasis = request.preferences?.emphasis ?? "BALANCED";
  if (request.objectives?.length) return { objectives: [...new Set(request.objectives)], emphasis, basis: "Objectives supplied explicitly by the caller.", matchedTerms: [] };
  const matchedTerms: string[] = [];
  const objectives: CopilotObjective[] = [];
  for (const [objective, pattern] of OBJECTIVE_TERMS) {
    const match = pattern.exec(request.question);
    if (match) { objectives.push(objective); matchedTerms.push(match[0]); }
  }
  if (!objectives.length) objectives.push("IMPROVE_CHARACTER");
  // "Improve this character" is broad on purpose: it includes gear, leveling and professions.
  if (objectives.includes("IMPROVE_CHARACTER")) for (const implied of ["GEAR", "LEVELING", "DEVELOP_PROFESSIONS"] as const) if (!objectives.includes(implied)) objectives.push(implied);
  return { objectives, emphasis, basis: matchedTerms.length ? "DERIVED from words in the question; pass objectives explicitly to override." : "No objective words found; defaulted to broad character improvement.", matchedTerms };
}

function resolveSubject(request: CopilotRequest, characters: Loose[]): { status: "FOUND"; summary: Loose } | { status: "NONE" } | { status: "NOT_FOUND" | "AMBIGUOUS"; message: string } {
  if (request.character?.name) {
    const name = request.character.name.trim().toLowerCase();
    const realm = request.character.realm?.trim().toLowerCase();
    const matches = characters.filter((character) => String(character.name).toLowerCase() === name && (!realm || String(character.realm).toLowerCase() === realm));
    if (matches.length === 1) return { status: "FOUND", summary: matches[0] };
    if (!matches.length) return { status: "NOT_FOUND", message: `No Forever character named ${request.character.name}${request.character.realm ? ` on ${request.character.realm}` : ""} has been imported.` };
    return { status: "AMBIGUOUS", message: `${request.character.name} exists on several Forever realms (${matches.map((match) => match.realm).join(", ")}). Name the realm.` };
  }
  const mentioned = characters.filter((character) => new RegExp(`\\b${String(character.name).replace(/[^A-Za-z]/g, "")}\\b`, "i").test(request.question));
  const names = [...new Set(mentioned.map((character) => String(character.name).toLowerCase()))];
  if (names.length === 1) {
    if (mentioned.length === 1) return { status: "FOUND", summary: mentioned[0] };
    const realm = request.realm?.toLowerCase();
    const onRealm = realm ? mentioned.filter((character) => String(character.realm).toLowerCase() === realm) : [];
    if (onRealm.length === 1) return { status: "FOUND", summary: onRealm[0] };
    // Same name on several realms: use class, race and realm words in the question ("Hallo the druid on the PvE realm").
    const question = request.question.toLowerCase();
    const realmWords = (realmName: string) => realmName.toLowerCase().replace(/^classic beta\s*/, "").trim();
    const scored = mentioned.map((character) => {
      const realmWord = realmWords(String(character.realm));
      const score = (character.class && question.includes(String(character.class).toLowerCase()) ? 1 : 0) + (character.race && question.includes(String(character.race).toLowerCase()) ? 1 : 0) + (realmWord && new RegExp(`\\b${realmWord.replace(/[^a-z0-9 ]/g, "")}\\b`).test(question) ? 2 : 0);
      return { character, score };
    }).sort((a, b) => b.score - a.score);
    if (scored[0].score > 0 && scored[0].score > (scored[1]?.score ?? -1)) return { status: "FOUND", summary: scored[0].character };
    return { status: "AMBIGUOUS", message: `${mentioned[0].name} exists on several Forever realms (${mentioned.map((match) => match.realm).join(", ")}). Name the realm.` };
  }
  return { status: "NONE" };
}

// ---------------------------------------------------------------------------------------------
// Item comparison (Forever knowledge vs. what the character wears)

const SLOT_MAP: Record<string, string[]> = {
  Head: ["Head"], Neck: ["Neck"], Shoulder: ["Shoulder"], Back: ["Back"], Chest: ["Chest"], Robe: ["Chest"], Wrist: ["Wrist"], Hands: ["Hands"], Waist: ["Waist"], Legs: ["Legs"], Feet: ["Feet"],
  Finger: ["Finger 1", "Finger 2"], Trinket: ["Trinket 1", "Trinket 2"],
  "Main Hand": ["Main Hand"], "One-Hand": ["Main Hand"], "Two-Hand": ["Main Hand"], "Off Hand": ["Off Hand"], "Held In Off-hand": ["Off Hand"],
  Ranged: ["Ranged"], Thrown: ["Ranged"], "Ranged Right": ["Ranged"],
};
const TOOL_ITEM_IDS = new Set([2901, 5956, 7005, 6219, 6256]);
const ARMOR_TYPES = ["Cloth", "Leather", "Mail", "Plate"];

export interface Comparison {
  slotName: string;
  equipped?: EquippedItem;
  equippedKnowledge?: ForeverItemKnowledge;
  verdict: "UPGRADE" | "FILLS_EMPTY_SLOT" | "TRADEOFF" | "NOT_BETTER" | "UNKNOWN";
  deltas: string[];
  magnitude: number;
  notes: string[];
}

function statMap(item: ForeverItemKnowledge): Map<string, number> {
  const map = new Map<string, number>();
  if (item.armor) map.set("Armor", item.armor);
  for (const stat of item.stats) map.set(stat.stat, (map.get(stat.stat) ?? 0) + stat.value);
  if (item.dps) map.set("DPS", item.dps);
  return map;
}

export function compareToEquipped(candidate: ForeverItemKnowledge, character: CharacterEvidence): Comparison | undefined {
  if (!candidate.slot || TOOL_ITEM_IDS.has(candidate.id)) return undefined;
  const slots = SLOT_MAP[candidate.slot];
  if (!slots) return undefined;
  const results: Comparison[] = [];
  for (const slotName of slots) {
    const equipped = character.equipment.find((slot) => slot.slotName === slotName);
    if (!equipped) continue;
    if (equipped.empty) {
      results.push({ slotName, equipped, verdict: "FILLS_EMPTY_SLOT", deltas: [...statMap(candidate)].map(([stat, value]) => `+${value} ${stat}`), magnitude: 0.6 + Math.min(0.3, (candidate.armor ?? 0) / 100), notes: [] });
      continue;
    }
    if (equipped.itemId === candidate.id) return undefined;
    const equippedKnowledge = foreverItem(equipped.itemId);
    if (!equippedKnowledge) { results.push({ slotName, equipped, verdict: "UNKNOWN", deltas: [], magnitude: 0.2, notes: [`No Forever database record for the equipped ${equipped.name ?? "item"}.`] }); continue; }
    const a = statMap(candidate);
    const b = statMap(equippedKnowledge);
    const keys = new Set([...a.keys(), ...b.keys()]);
    let better = 0, worse = 0, relative = 0;
    const deltas: string[] = [];
    for (const key of keys) {
      const delta = Math.round(((a.get(key) ?? 0) - (b.get(key) ?? 0)) * 100) / 100;
      if (delta === 0) continue;
      deltas.push(`${delta > 0 ? "+" : ""}${delta} ${key}`);
      if (delta > 0) better += 1; else worse += 1;
      const base = Math.max(1, b.get(key) ?? 0);
      relative += (key === "Armor" || key === "DPS" ? delta / base : delta / 3);
    }
    const notes: string[] = [];
    if (candidate.slot === "Two-Hand") {
      const offHand = character.equipment.find((slot) => slot.slotName === "Off Hand");
      if (offHand && !offHand.empty) {
        const offHandKnowledge = foreverItem(offHand.itemId);
        notes.push(`A two-handed weapon also replaces the off-hand ${offHand.name ?? "item"}${offHandKnowledge?.armor ? ` (${offHandKnowledge.armor} Armor)` : ""}.`);
        worse += 1;
      }
    }
    if (candidate.randomEnchantment) notes.push("This item rolls a random enchantment; the exact bonus stats on the owned copy are not captured.");
    const verdict = better > 0 && worse === 0 ? "UPGRADE" : better > 0 ? "TRADEOFF" : "NOT_BETTER";
    results.push({ slotName, equipped, equippedKnowledge, verdict, deltas, magnitude: Math.max(0, Math.min(1, relative / 2)), notes });
  }
  const order = { FILLS_EMPTY_SLOT: 0, UPGRADE: 1, TRADEOFF: 2, UNKNOWN: 3, NOT_BETTER: 4 } as const;
  return results.sort((x, y) => order[x.verdict] - order[y.verdict] || y.magnitude - x.magnitude)[0];
}

function wearsArmorType(character: CharacterEvidence, subtype: string): boolean {
  return character.equipment.some((slot) => slot.itemId !== undefined && foreverItem(slot.itemId)?.subtype === subtype);
}

export function eligibility(candidate: ForeverItemKnowledge, character: CharacterEvidence): { blocked?: string; prerequisites: string[]; evidence: EvidenceLine[] } {
  const prerequisites: string[] = [];
  const evidence: EvidenceLine[] = [];
  const level = character.brief.level;
  if (candidate.requiredLevel !== undefined) {
    if (level === undefined) prerequisites.push(`Requires level ${candidate.requiredLevel}; ${label(character)}'s level is unknown.`);
    else if (level < candidate.requiredLevel) return { blocked: `requires level ${candidate.requiredLevel} (${label(character)} is ${level})`, prerequisites, evidence };
    else evidence.push({ kind: "DERIVED", statement: `Required level ${candidate.requiredLevel} is met (${label(character)} is level ${level}).`, source: "Forever item record + observed character level" });
  }
  const required = requiredSkillFor(candidate.slot, candidate.subtype);
  const skills = character.skills;
  if (required && skills && (required.kind === "weapon" ? skills.weapons.size > 0 : skills.armor.size > 0)) {
    const source = `Forever skill lines (snapshot ${skills.snapshotId})`;
    if (required.kind === "armor") {
      if (!skills.armor.has(required.name)) return { blocked: `${label(character)} has no ${required.name} proficiency (observed skill lines)`, prerequisites, evidence };
      evidence.push({ kind: "OBSERVED", statement: `${label(character)} has the ${required.name} armor proficiency.`, source, observedAt: skills.observedAt });
    } else {
      const skill = skills.weapons.get(required.name);
      if (skill) {
        evidence.push({ kind: "OBSERVED", statement: `${label(character)} has ${required.name} ${skill.rank}/${skill.maxRank}.`, source, observedAt: skills.observedAt });
        if (skill.rank < skill.maxRank / 2) prerequisites.push(`${required.name} is only ${skill.rank}/${skill.maxRank}: expect misses until you raise it by fighting with this weapon type.`);
      } else prerequisites.push(`Train ${required.name} at a weapon master first: it is not among ${label(character)}'s observed weapon skills (${[...skills.weapons.keys()].join(", ")}); training cost unknown.`);
    }
  } else if (candidate.subtype && ARMOR_TYPES.includes(candidate.subtype)) {
    if (wearsArmorType(character, candidate.subtype)) evidence.push({ kind: "OBSERVED", statement: `${label(character)} already wears ${candidate.subtype} armor, so the armor type is usable.`, source: "observed equipment" });
    else prerequisites.push(`Confirm ${label(character)} can wear ${candidate.subtype}; no ${candidate.subtype} item is currently equipped, and class armor rules are not captured.`);
  } else if (candidate.subtype && candidate.slot && /Hand/.test(candidate.slot)) {
    const weaponSkill = candidate.slot === "Two-Hand" ? `Two-Handed ${candidate.subtype}s` : `${candidate.subtype}s`;
    prerequisites.push(`Confirm ${label(character)} has the ${weaponSkill} weapon skill (weapon skills are not captured in the export).`);
  }
  if (candidate.classes?.length && character.brief.class && !candidate.classes.some((name) => name.toUpperCase() === character.brief.class)) return { blocked: `class-restricted to ${candidate.classes.join(", ")}`, prerequisites, evidence };
  return { prerequisites, evidence };
}

// ---------------------------------------------------------------------------------------------
// Recommendation construction and ranking

export const FEASIBILITY_SCORE: Record<Feasibility, number> = { READY_NOW: 1, NEEDS_TRANSFER: 0.75, NEEDS_INPUTS: 0.55, NEEDS_PROGRESSION: 0.35, UNCERTAIN: 0.3 };

/** confidence: 1 for account observations, lower for community or Classic-seeded external knowledge. */
export interface Draft extends Omit<CopilotRecommendation, "score"> { value: number; goldCost?: number; costUnknown?: boolean; objectives: CopilotObjective[]; confidence?: number }

function objectiveFit(draft: Draft, objective: CopilotAnswer["objective"]): number {
  const overlap = draft.objectives.filter((value) => objective.objectives.includes(value)).length;
  // Objective overlap alone tops out at 0.7 so a stated emphasis can still move the ranking.
  let fit = overlap ? 0.4 + 0.15 * Math.min(overlap, 2) : 0.2;
  if (objective.emphasis === "IMMEDIATE_POWER" && (draft.supports === "IMMEDIATE_POWER" || draft.supports === "BOTH")) fit += 0.25;
  if (objective.emphasis === "SELF_SUFFICIENCY" && (draft.supports === "SELF_SUFFICIENCY" || draft.supports === "BOTH")) fit += 0.25;
  if (draft.supports === "BOTH") fit += 0.05;
  return Math.min(1, fit);
}

function finalize(draft: Draft, objective: CopilotAnswer["objective"], availableCopper: number | undefined, avoidSpending: boolean): CopilotRecommendation {
  const fit = objectiveFit(draft, objective);
  const feasibility = FEASIBILITY_SCORE[draft.feasibility];
  let costPenalty = 0;
  let costBasis = "no gold cost";
  if (draft.goldCost !== undefined && draft.goldCost > 0) {
    if (availableCopper === undefined) { costPenalty = 0.15; costBasis = "gold cost known, available gold unknown"; }
    else if (draft.goldCost > availableCopper) { costPenalty = 0.35; costBasis = `costs ${formatCopper(draft.goldCost)}, more than the ${formatCopper(availableCopper)} observed`; }
    else { costPenalty = Math.min(0.25, draft.goldCost / Math.max(1, availableCopper) * 0.25); costBasis = `costs ${formatCopper(draft.goldCost)} of ${formatCopper(availableCopper)} observed`; }
    if (avoidSpending) costPenalty = Math.min(0.6, costPenalty + 0.2);
  } else if (draft.costUnknown) { costPenalty = 0.1; costBasis = "a cost exists but is not known"; }
  const confidence = draft.confidence ?? 1;
  const total = Math.round((draft.value * 0.4 + feasibility * 0.3 + fit * 0.15 + confidence * 0.15) * (1 - costPenalty) * 1000) / 1000;
  const { value, goldCost: _goldCost, costUnknown: _costUnknown, objectives: _objectives, confidence: _confidence, ...rest } = draft;
  return { ...rest, score: { total, value: Math.round(value * 1000) / 1000, feasibility, objectiveFit: Math.round(fit * 1000) / 1000, confidence, costPenalty: Math.round(costPenalty * 1000) / 1000, basis: `0.40 x value + 0.30 x feasibility (${draft.feasibility}) + 0.15 x objective fit + 0.15 x evidence confidence, reduced by cost penalty (${costBasis}).` } };
}

export function heldEvidence(item: HeldItem, owner: CharacterEvidence): EvidenceLine {
  return {
    kind: item.state === "LAST_SEEN" ? "LAST_SEEN" : item.state === "OBSERVED" ? "OBSERVED" : "UNKNOWN",
    statement: `${label(owner)} ${item.state === "LAST_SEEN" ? "was last seen holding" : "holds"} ${item.name} x${item.qty} in ${item.storage}${item.bound ? " (soulbound)" : ""}${item.state === "LAST_SEEN" ? " (not confirmed current)" : ""}.`,
    source: `${label(owner)} ${item.storage} snapshot ${item.snapshotId ?? "?"}`,
    observedAt: item.observedAt,
  };
}

export const externalItem = (item: ForeverItemKnowledge, statement?: string): EvidenceLine => ({ kind: "EXTERNAL", statement: statement ?? describeItem(item), source: item.sourceUrl });

export function describeItem(item: ForeverItemKnowledge): string {
  const parts = [item.slot, item.subtype].filter(Boolean).join(" ");
  const stats = [item.armor ? `${item.armor} Armor` : "", item.dps ? `${item.dps} DPS (${item.damageMin}-${item.damageMax}, ${item.speed} speed)` : "", ...item.stats.map((stat) => `${stat.value > 0 ? "+" : ""}${stat.value} ${stat.stat}`)].filter(Boolean).join(", ");
  return `Forever: ${item.name}${parts ? ` (${parts}` : ""}${item.itemLevel ? `${parts ? ", " : " ("}item level ${item.itemLevel}` : ""}${parts || item.itemLevel ? ")" : ""}${stats ? `: ${stats}` : ""}${item.requiredLevel ? `; requires level ${item.requiredLevel}` : ""}${item.useText ? `; Use: ${item.useText}` : ""}.`;
}

const labels = new Map<CharacterEvidence, string>();
export const label = (character: CharacterEvidence) => labels.get(character) ?? character.brief.name;
function assignLabels(characters: CharacterEvidence[]) {
  labels.clear();
  for (const character of characters) {
    const duplicate = characters.filter((other) => other.brief.name === character.brief.name).length > 1;
    labels.set(character, duplicate ? `${label(character)} (${character.brief.realm})` : character.brief.name);
  }
}

export const sameRealmFaction = (a: CharacterEvidence, b: CharacterEvidence) => a.brief.realm === b.brief.realm && a.brief.faction !== undefined && a.brief.faction === b.brief.faction;

function sourcesOf(itemId: number, characters: CharacterEvidence[], subject?: CharacterEvidence): Array<{ owner: CharacterEvidence; item: HeldItem }> {
  const result: Array<{ owner: CharacterEvidence; item: HeldItem }> = [];
  for (const owner of characters) {
    if (subject && owner !== subject && !sameRealmFaction(owner, subject)) continue;
    for (const item of owner.held) if (item.itemId === itemId) result.push({ owner, item });
  }
  return result;
}

export function transferSteps(owner: CharacterEvidence, recipient: CharacterEvidence, item: HeldItem, quantity?: number): string[] {
  const stacks = quantity === undefined ? owner.held.filter((held) => held.itemId === item.itemId && !held.bound) : [item];
  const bank = stacks.filter((held) => held.storage === "bank");
  const total = quantity ?? stacks.reduce((sum, held) => sum + held.qty, 0);
  const steps: string[] = [];
  if (bank.length) steps.push(`On ${label(owner)}, take ${item.name} x${bank.reduce((sum, held) => sum + held.qty, 0)} out of the bank (${bank.some((held) => held.state === "LAST_SEEN") ? "last-seen, so confirm it is still there" : "observed"}).`);
  if (owner !== recipient) steps.push(`On ${label(owner)}, mail ${item.name} x${total} to ${label(recipient)} (same realm and faction). You run this; WoWSync never moves items.`);
  return steps;
}

// ---------------------------------------------------------------------------------------------
// Generators: character improvement

function generateOwnedGear(subject: CharacterEvidence, characters: CharacterEvidence[]): Draft[] {
  const drafts: Draft[] = [];
  const seen = new Set<number>();
  for (const { owner, item } of characters.flatMap((owner) => owner.held.map((item) => ({ owner, item })))) {
    const own = owner === subject;
    if (!own && (!sameRealmFaction(owner, subject) || item.bound)) continue;
    if (seen.has(item.itemId)) continue;
    const knowledge = foreverItem(item.itemId);
    if (!knowledge || (!own && knowledge.binding === "BIND_ON_PICKUP")) continue;
    const comparison = compareToEquipped(knowledge, subject);
    if (!comparison || comparison.verdict === "NOT_BETTER" || comparison.verdict === "UNKNOWN") continue;
    const check = eligibility(knowledge, subject);
    if (check.blocked) continue;
    const baseline = proficiencyBaseline(knowledge, subject);
    if (baseline && !baseline.allowed) continue;
    seen.add(item.itemId);
    const equippedName = comparison.equipped?.empty ? "an empty slot" : comparison.equipped?.name ?? "the current item";
    const evidence: EvidenceLine[] = [heldEvidence(item, owner), externalItem(knowledge)];
    if (comparison.equippedKnowledge) evidence.push(externalItem(comparison.equippedKnowledge, `${label(subject)} wears ${comparison.equippedKnowledge.name} in ${comparison.slotName} (observed): ${describeItem(comparison.equippedKnowledge)}`));
    else if (comparison.equipped?.empty) evidence.push({ kind: "OBSERVED", statement: `${label(subject)}'s ${comparison.slotName} slot is empty.`, source: "observed equipment", observedAt: subject.equipmentObservedAt });
    evidence.push(...check.evidence);
    evidence.push({ kind: "DERIVED", statement: `Recorded-stat difference vs ${equippedName}: ${comparison.deltas.join(", ") || "none"}. This compares listed stats only; it is not a simulation.`, source: "Forever item records" });
    const isUpgrade = comparison.verdict !== "TRADEOFF";
    drafts.push({
      id: `${own ? "equip" : "transfer"}-${item.itemId}`,
      category: own ? "EQUIP_OWNED_ITEM" : "TRANSFER_OWNED_ITEM",
      title: own ? `Equip the ${knowledge.name} already in your ${item.storage}` : `Get ${knowledge.name} from ${label(owner)}`,
      what: own ? `Equip ${knowledge.name} in ${comparison.slotName}, replacing ${equippedName}.` : `Move ${knowledge.name} from ${label(owner)}'s ${item.storage} to ${label(subject)} and equip it in ${comparison.slotName}.`,
      why: `${isUpgrade ? "It beats" : "It trades off against"} ${equippedName}: ${comparison.deltas.join(", ")}.${own ? " It costs nothing and is already in hand." : ""}`,
      supports: "IMMEDIATE_POWER",
      feasibility: own && item.state === "OBSERVED" && check.prerequisites.length === 0 ? "READY_NOW" : own ? "UNCERTAIN" : "NEEDS_TRANSFER",
      evidence,
      prerequisites: check.prerequisites,
      costs: own ? ["None."] : ["Mail postage (Forever amount not in the knowledge base)."],
      alternatives: own ? [] : [`Keep it on ${label(owner)} or sell it (vendor ${knowledge.sellPriceCopper !== undefined ? formatCopper(knowledge.sellPriceCopper) : "price unknown"}; auction price unknown).`],
      tradeoffs: [...comparison.notes, ...(isUpgrade ? [] : ["Not strictly better: weigh the losses listed above."])],
      unknowns: item.state === "LAST_SEEN" ? ["The item was last seen in an earlier observation; confirm it is still there."] : [],
      nextActions: own ? [`Open ${label(subject)}'s bags and equip ${knowledge.name}.`] : [...transferSteps(owner, subject, item), `Equip it on ${label(subject)}.`],
      value: Math.min(1, (comparison.verdict === "FILLS_EMPTY_SLOT" ? 0.55 : isUpgrade ? 0.5 : 0.3) + comparison.magnitude * 0.5),
      goldCost: undefined,
      costUnknown: !own,
      objectives: ["GEAR", "IMPROVE_CHARACTER"],
    });
  }
  return drafts;
}

function generateQuests(subject: CharacterEvidence, characters: CharacterEvidence[]): Draft[] {
  const drafts: Draft[] = [];
  const remainingXp = subject.xp ? subject.xp.xpMax - subject.xp.xp : undefined;
  const ready = subject.quests.filter((quest) => quest.readyForTurnIn === true);
  if (ready.length) {
    let xp = 0, unknownRewards = 0;
    const coin = 0;
    const reputation = new Map<string, number>();
    const evidence: EvidenceLine[] = [];
    for (const quest of ready) {
      evidence.push({ kind: quest.state === "LAST_SEEN" ? "LAST_SEEN" : "OBSERVED", statement: `Quest "${quest.title}" (${quest.questID}) is ready for turn-in.`, source: "Forever C_QuestLog sidecar", observedAt: quest.observedAt });
      const knowledge = foreverQuest(quest.questID);
      if (!knowledge) { unknownRewards += 1; continue; }
      const questXp = Object.values(knowledge.xpByLevel)[0];
      if (questXp !== undefined) xp += questXp; else unknownRewards += 1;
      for (const rep of knowledge.reputation) reputation.set(rep.faction, (reputation.get(rep.faction) ?? 0) + rep.amount);
      evidence.push({ kind: "EXTERNAL", statement: `Forever quest ${knowledge.name}: ${questXp ?? "?"} XP (Classic-seeded XP table)${knowledge.reputation.length ? `, ${knowledge.reputation.map((rep) => `+${rep.amount} ${rep.faction}`).join(", ")}` : ""}.`, source: `${knowledge.source} (${knowledge.sourceUrl})` });
    }
    const share = remainingXp ? xp / remainingXp : 0;
    if (remainingXp && xp) evidence.push({ kind: "DERIVED", statement: `${xp} XP is ${Math.round(share * 100)}% of the ${remainingXp} XP ${label(subject)} needs for the next level.`, source: "observed XP + Forever quest records" });
    drafts.push({
      id: "quest-turn-ins",
      category: "QUEST_TURN_IN",
      title: `Turn in ${ready.length} finished quest${ready.length > 1 ? "s" : ""}`,
      what: `Hand in ${ready.map((quest) => quest.title).join(", ")}.`,
      why: `Finished work${xp ? ` that pays out ${xp} XP` : ""}${coin ? ` and ${formatCopper(coin)}` : ""}${reputation.size ? `, plus ${[...reputation].map(([faction, amount]) => `${amount} ${faction} reputation`).join(", ")}` : ""}${unknownRewards ? ` (rewards unknown for ${unknownRewards})` : ""}. Turning in also unlocks follow-up quests.`,
      supports: "IMMEDIATE_POWER",
      feasibility: "READY_NOW",
      evidence,
      prerequisites: ["Travel to each quest giver (locations are not captured; waypoints are UNKNOWN)."],
      costs: ["Travel time only."],
      alternatives: [],
      tradeoffs: [],
      unknowns: unknownRewards ? [`Rewards for ${unknownRewards} quest(s) are not in the Forever knowledge base.`] : [],
      nextActions: ready.map((quest) => `Turn in "${quest.title}".`),
      value: Math.min(1, 0.45 + share * 1.2 + (coin > 0 ? 0.05 : 0)),
      objectives: ["LEVELING", "IMPROVE_CHARACTER"],
    });
  }
  for (const quest of subject.quests.filter((row) => row.readyForTurnIn === false && row.isComplete !== true)) {
    const knowledge = foreverQuest(quest.questID);
    const questXp = knowledge ? Object.values(knowledge.xpByLevel)[0] : undefined;
    const questCoin: number | undefined = undefined;
    const open = quest.objectives.filter((objective) => objective.finished === false);
    const evidence: EvidenceLine[] = [{ kind: quest.state === "LAST_SEEN" ? "LAST_SEEN" : "OBSERVED", statement: `Active quest "${quest.title}": ${open.map((objective) => objective.text).join("; ") || "objectives not reported"}.`, source: "Forever C_QuestLog sidecar", observedAt: quest.observedAt }];
    const costs: string[] = [];
    let goldCost: number | undefined;
    if (knowledge) {
      evidence.push({ kind: "EXTERNAL", statement: `Forever quest ${knowledge.name}${knowledge.level ? ` (level ${knowledge.level})` : ""}: ${questXp ?? "?"} XP (Classic-seeded XP table)${knowledge.reputation.length ? `, ${knowledge.reputation.map((rep) => `+${rep.amount} ${rep.faction}`).join(", ")}` : ""}${knowledge.rewardItemIds.length ? `; rewards ${knowledge.rewardItemIds.map((id) => foreverItem(id)?.name ?? `item ${id}`).join(", ")}` : ""}.`, source: `${knowledge.source} (${knowledge.sourceUrl})` });
      const rewardFood = knowledge.rewardItemIds.map((id) => foreverItem(id)).find((item) => item?.useText && /well fed/i.test(item.useText));
      if (rewardFood) evidence.push(externalItem(rewardFood));
    }
    // Objective items another same-realm character already holds turn a farming task into a mail.
    const supplied: string[] = [];
    const supplySteps: string[] = [];
    let coveredObjectives = 0;
    for (const objective of open) {
      const objectiveItem = /\d+\/\d+ (.+)$/.exec(objective.text)?.[1];
      if (!objectiveItem) continue;
      const needed = Math.max(1, (objective.numRequired ?? 1) - (objective.numFulfilled ?? 0));
      for (const owner of characters) {
        if (owner === subject || !sameRealmFaction(owner, subject)) continue;
        const stacks = owner.held.filter((item) => item.name.toLowerCase() === objectiveItem.toLowerCase() && !item.bound);
        if (!stacks.length) continue;
        for (const stack of stacks) evidence.push(heldEvidence(stack, owner));
        const total = stacks.reduce((sum, stack) => sum + stack.qty, 0);
        if (total >= needed) {
          coveredObjectives += 1;
          supplied.push(`${label(owner)} already has ${objectiveItem} x${total}${stacks.every((stack) => stack.state === "LAST_SEEN") ? " (last seen, not confirmed current)" : stacks.some((stack) => stack.state === "LAST_SEEN") ? " (partly last-seen)" : ""}`);
          supplySteps.push(...transferSteps(owner, subject, stacks[0], stacks.length === 1 ? needed : undefined));
          break;
        }
      }
    }
    const share = subject.xp && questXp ? questXp / (subject.xp.xpMax - subject.xp.xp) : 0;
    const remainingObjectives = open.filter((objective) => !supplied.some((line) => line.includes(/\d+\/\d+ (.+)$/.exec(objective.text)?.[1] ?? "\u0000")));
    drafts.push({
      id: `quest-${quest.questID}`,
      category: "QUEST_PROGRESS",
      title: supplied.length ? `Finish "${quest.title}" with items your stable already has` : `Finish "${quest.title}"`,
      what: `${supplied.length ? `${supplied.join("; ")}: mail it instead of farming. ` : ""}${remainingObjectives.length ? `Complete: ${remainingObjectives.map((objective) => objective.text).join("; ")}.` : "Then turn it in."}`,
      why: knowledge ? `${questXp ?? "?"} XP${questCoin ? `, ${formatCopper(questCoin)}` : ""}${knowledge.reputation.length ? ", reputation" : ""}${knowledge.rewardItemIds.length ? `, and ${knowledge.rewardItemIds.map((id) => foreverItem(id)?.name ?? `item ${id}`).join(" + ")}` : ""}.` : "Rewards are not in the Forever knowledge base.",
      supports: "IMMEDIATE_POWER",
      feasibility: open.length === 0 ? "UNCERTAIN" : coveredObjectives > 0 ? "NEEDS_TRANSFER" : "NEEDS_INPUTS",
      evidence,
      prerequisites: knowledge?.level && subject.brief.level !== undefined && knowledge.level > subject.brief.level + 1 ? [`Quest level ${knowledge.level} is above ${label(subject)}'s level ${subject.brief.level}; expect harder enemies.`] : [],
      costs: costs.length ? costs : ["Time; no purchase identified."],
      alternatives: [],
      tradeoffs: [],
      unknowns: knowledge ? [] : ["Quest rewards unknown."],
      nextActions: [...supplySteps, ...remainingObjectives.map((objective) => { const item = /\d+\/\d+ (.+)$/.exec(objective.text)?.[1]; return item ? `Get ${item}${objective.numRequired && objective.numRequired > 1 ? ` x${objective.numRequired - (objective.numFulfilled ?? 0)}` : ""}.` : objective.text; }).slice(0, 3), ...(supplied.length ? [`Turn in "${quest.title}".`] : [])],
      value: Math.min(0.9, 0.25 + share * 1.1 + (coveredObjectives > 0 ? 0.15 : 0)),
      goldCost,
      objectives: ["LEVELING", "IMPROVE_CHARACTER"],
    });
  }
  return drafts;
}

function professionTools(character: CharacterEvidence): Array<{ tool: string; reason: string; source: string }> {
  const tools = new Map<string, { reason: string; source: string }>();
  for (const profession of character.brief.professions) {
    const spellId = profession.name === "Mining" ? 2575 : undefined;
    const spell = foreverSpell(spellId);
    for (const tool of spell?.tools ?? []) tools.set(tool, { reason: `${profession.name} requires it`, source: spell!.sourceUrl });
  }
  for (const recipe of character.recipes) {
    const spell = foreverSpell(recipe.recipeID);
    for (const tool of spell?.tools ?? []) if (!tools.has(tool)) tools.set(tool, { reason: `learned recipe ${recipe.name} requires it`, source: spell!.sourceUrl });
  }
  return [...tools].map(([tool, detail]) => ({ tool, ...detail }));
}

function generateProfessionTools(subject: CharacterEvidence, characters: CharacterEvidence[]): Draft[] {
  const drafts: Draft[] = [];
  if (subject.brief.bagsState !== "OBSERVED") return drafts;
  for (const need of professionTools(subject)) {
    if (subject.held.some((item) => item.name === need.tool && item.storage === "bags") || subject.equipment.some((slot) => slot.name === need.tool)) continue;
    const sources = characters.filter((owner) => owner !== subject && sameRealmFaction(owner, subject)).flatMap((owner) => owner.held.filter((item) => item.name === need.tool && !item.bound).map((item) => ({ owner, item })));
    const toolUser = (owner: CharacterEvidence) => professionTools(owner).some((need2) => need2.tool === need.tool);
    const spare = sources.filter((source) => !toolUser(source.owner));
    const best = spare.find((source) => source.item.state === "OBSERVED") ?? spare[0];
    const inUse = sources.find((source) => toolUser(source.owner));
    const evidence: EvidenceLine[] = [
      { kind: "OBSERVED", statement: `${label(subject)}'s observed bags do not contain a ${need.tool}.`, source: "observed bags", observedAt: subject.bagsObservedAt },
      { kind: "EXTERNAL", statement: `Forever: ${need.reason} (Tools: ${need.tool}).`, source: need.source },
    ];
    if (best) evidence.push(heldEvidence(best.item, best.owner));
    if (inUse && !best) evidence.push({ ...heldEvidence(inUse.item, inUse.owner), statement: `${heldEvidence(inUse.item, inUse.owner).statement} ${label(inUse.owner)} needs it for their own profession, so it is not treated as spare.` });
    drafts.push({
      id: `tool-${need.tool.toLowerCase().replace(/\W+/g, "-")}`,
      category: "PROFESSION_TOOL",
      title: `Carry a ${need.tool}`,
      what: best ? `Send ${label(best.owner)}'s spare ${need.tool} to ${label(subject)} and keep it in bags.` : `Buy a ${need.tool} from a trade supplies vendor and keep it in bags.`,
      why: `Without it ${label(subject)} cannot use ${need.reason.replace(/ requires it$/, "")}. It is the gate for every craft or gather that depends on it.`,
      supports: "SELF_SUFFICIENCY",
      feasibility: best ? "NEEDS_TRANSFER" : "NEEDS_INPUTS",
      evidence,
      prerequisites: [],
      costs: best ? ["Mail postage."] : ["Vendor price of the tool (not in the Forever knowledge base)."],
      alternatives: best ? [`Buy a new ${need.tool} from a trade supplies vendor instead of moving one.`] : inUse ? [`Borrow ${label(inUse.owner)}'s ${need.tool} only if ${label(inUse.owner)} stops using it.`] : [],
      tradeoffs: [],
      unknowns: best?.item.state === "LAST_SEEN" ? ["The spare tool was last seen in an earlier observation."] : [],
      nextActions: best ? transferSteps(best.owner, subject, best.item) : [`Buy a ${need.tool} at a trade supplies vendor.`],
      value: 0.55,
      costUnknown: true,
      objectives: ["DEVELOP_PROFESSIONS", "SELF_SUFFICIENCY", "IMPROVE_CHARACTER"],
    });
  }
  return drafts;
}

function generateCrafting(subject: CharacterEvidence, characters: CharacterEvidence[]): Draft[] {
  const drafts: Draft[] = [];
  for (const recipe of subject.recipes) {
    const output = foreverItem(recipe.outputItemID);
    const spell = foreverSpell(recipe.recipeID);
    if (!output) continue;
    const comparison = compareToEquipped(output, subject);
    const isEnhancement = !!output.useText && /weapon damage|sharp|blunt/i.test(output.useText);
    const ownedOutput = subject.held.find((item) => item.itemId === output.id);
    const gearUseful = comparison && (comparison.verdict === "UPGRADE" || comparison.verdict === "FILLS_EMPTY_SLOT");
    const evidence: EvidenceLine[] = [{ kind: recipe.state === "LAST_SEEN" ? "LAST_SEEN" : "OBSERVED", statement: `${label(subject)} has learned ${recipe.name} (${recipe.profession}).`, source: `recipe sidecar snapshot ${recipe.sourceSnapshotId ?? "?"}` }, externalItem(output)];
    if (spell) evidence.push({ kind: "EXTERNAL", statement: `Forever recipe ${spell.name}: reagents ${spell.reagents.map((reagent) => `${reagent.name} x${reagent.quantity}`).join(", ") || "none listed"}${spell.tools.length ? `; tools ${spell.tools.join(", ")}` : ""}.`, source: spell.sourceUrl });
    // Reagent supply across the realm.
    const reagentLines: string[] = [];
    let allInBags = true;
    let anySource = true;
    const transfers: string[] = [];
    for (const reagent of recipe.reagents) {
      const name = foreverItem(reagent.itemId)?.name ?? `item ${reagent.itemId}`;
      const mine = subject.held.filter((item) => item.itemId === reagent.itemId && item.storage === "bags" && item.state === "OBSERVED").reduce((sum, item) => sum + item.qty, 0);
      if (mine >= reagent.quantity) { reagentLines.push(`${name} x${reagent.quantity}: in bags (${mine}).`); continue; }
      allInBags = false;
      const others = sourcesOf(reagent.itemId, characters, subject).filter((source) => source.owner !== subject && !source.item.bound);
      if (others.length) {
        for (const source of others) evidence.push(heldEvidence(source.item, source.owner));
        reagentLines.push(`${name} x${reagent.quantity}: ${mine} in bags; also held by ${others.map((source) => `${label(source.owner)} (${source.item.qty} in ${source.item.storage}${source.item.state === "LAST_SEEN" ? ", last seen" : ""})`).join(", ")}.`);
        transfers.push(...transferSteps(others[0].owner, subject, others[0].item, recipe.canSkillUp ? undefined : Math.max(reagent.quantity - mine, 1)));
      } else {
        // Precursor chain: e.g. Copper Bar <- Smelt Copper <- Copper Ore.
        const smelt = foreverSpells().find((candidate) => candidate.createsItemId === reagent.itemId && candidate.reagents.length > 0);
        const precursor = smelt?.reagents[0];
        const precursorSources = precursor ? sourcesOf(precursor.itemId, characters, subject).filter((source) => !source.item.bound) : [];
        const canMakePrecursor = smelt && subject.spells.some((spellName) => /smelting/i.test(spellName) && /smelt/i.test(smelt.name));
        if (smelt && precursorSources.length) {
          for (const source of precursorSources) evidence.push(heldEvidence(source.item, source.owner));
          evidence.push({ kind: "EXTERNAL", statement: `Forever: ${smelt.name} turns ${precursor!.name} into ${name}${smelt.description ? ` (${smelt.description})` : ""}.`, source: smelt.sourceUrl });
          if (canMakePrecursor) evidence.push({ kind: "OBSERVED", statement: `${label(subject)}'s spellbook includes Smelting.`, source: "observed spellbook" });
          reagentLines.push(`${name} x${reagent.quantity}: none held; make it with ${smelt.name} from ${precursor!.name}, held by ${precursorSources.map((source) => `${label(source.owner)} (${source.item.qty} in ${source.item.storage}${source.item.state === "LAST_SEEN" ? ", last seen" : ""})`).join(", ")}.`);
          const external = precursorSources.find((source) => source.owner !== subject);
          if (external) transfers.push(...transferSteps(external.owner, subject, external.item));
          transfers.push(`${canMakePrecursor ? "" : "Learn Smelting, then "}${smelt.name} at a forge until you have ${reagent.quantity} ${name}.`);
        } else {
          anySource = false;
          reagentLines.push(`${name} x${reagent.quantity}: no source found on this realm's observed characters.`);
        }
      }
    }
    const tools = spell?.tools ?? [];
    const missingTools = tools.filter((tool) => !subject.held.some((item) => item.name === tool && item.storage === "bags"));
    const prerequisites = [...missingTools.map((tool) => `Carry a ${tool} (not in ${label(subject)}'s observed bags).`), "Crafting station requirements (anvil/forge) are not captured; Forever lists Smelting as needing a forge."];
    const skillUp = recipe.canSkillUp === true ? `It can still give skill-ups (${recipe.numSkillUps ?? "?"} per craft observed).` : recipe.canSkillUp === false ? "It no longer gives skill-ups (observed)." : "Skill-up state unknown.";
    if (gearUseful && !ownedOutput) {
      const check = eligibility(output, subject);
      if (check.blocked) continue;
      drafts.push({
        id: `craft-${recipe.recipeID}`,
        category: "CRAFT_UPGRADE",
        title: `Craft ${output.name} for yourself`,
        what: `Craft ${output.name} with ${recipe.profession} and equip it in ${comparison!.slotName}.`,
        why: `${comparison!.deltas.join(", ")} over ${comparison!.equipped?.empty ? "an empty slot" : comparison!.equipped?.name}. ${skillUp}`,
        supports: "BOTH",
        feasibility: allInBags && missingTools.length === 0 ? "READY_NOW" : anySource ? "NEEDS_INPUTS" : "NEEDS_PROGRESSION",
        evidence: [...evidence, ...check.evidence],
        prerequisites: [...prerequisites, ...check.prerequisites],
        costs: reagentLines,
        alternatives: ["Buy or receive the item instead of crafting it (market price unknown)."],
        tradeoffs: [],
        unknowns: ["Crafting station availability is not captured."],
        nextActions: [...transfers, `Craft ${output.name}.`, `Equip it.`],
        value: Math.min(1, 0.45 + (comparison!.magnitude ?? 0) * 0.5),
        objectives: ["GEAR", "DEVELOP_PROFESSIONS", "SELF_SUFFICIENCY", "IMPROVE_CHARACTER"],
      });
    } else if (isEnhancement) {
      const mainHand = foreverItem(subject.equipment.find((slot) => slot.slotName === "Main Hand")?.itemId);
      const sharp = mainHand?.subtype && /Axe|Sword|Dagger|Polearm/.test(mainHand.subtype);
      const blunt = mainHand?.subtype && /Mace|Staff/.test(mainHand.subtype);
      const fits = (/sharp/i.test(output.useText!) && sharp) || (/blunt/i.test(output.useText!) && blunt);
      if (!fits) continue;
      evidence.push({ kind: "DERIVED", statement: `${label(subject)}'s main hand is ${mainHand!.name} (${mainHand!.subtype}), which this enhancement applies to.`, source: "observed equipment + Forever item record" });
      drafts.push({
        id: `craft-${recipe.recipeID}`,
        category: "CRAFT_ENHANCEMENT",
        title: `Make ${output.name}s for your ${mainHand!.subtype?.toLowerCase()}`,
        what: `Craft ${output.name} and apply it to ${mainHand!.name} while leveling.`,
        why: `${output.useText} ${skillUp} Every craft also raises ${recipe.profession}.`,
        supports: "BOTH",
        feasibility: allInBags && missingTools.length === 0 ? "READY_NOW" : anySource ? "NEEDS_TRANSFER" : "NEEDS_INPUTS",
        evidence,
        prerequisites,
        costs: reagentLines,
        alternatives: [],
        tradeoffs: ["Small, temporary damage bonus; its main value is cheap skill-ups."],
        unknowns: [],
        nextActions: [...transfers, `Craft ${output.name} several times (skill-ups), apply one to your weapon.`],
        value: 0.42,
        objectives: ["DEVELOP_PROFESSIONS", "SELF_SUFFICIENCY", "IMPROVE_CHARACTER"],
      });
    }
  }
  return drafts;
}

function generateConsumables(subject: CharacterEvidence, characters: CharacterEvidence[]): Draft[] {
  const drafts = generateConsumablesEach(subject, characters);
  if (drafts.length <= 1) return drafts;
  const [first, ...rest] = drafts.sort((a, b) => (a.feasibility === "READY_NOW" ? -1 : 0) - (b.feasibility === "READY_NOW" ? -1 : 0));
  return [{ ...first, id: "food-buffs", title: "Use the well-fed food already on your realm while leveling", what: [first, ...rest].map((draft) => draft.what).join(" "), evidence: [first, ...rest].flatMap((draft) => draft.evidence.filter((line) => line.kind !== "EXTERNAL" || !line.statement.startsWith("Forever cooked food"))).concat(first.evidence.filter((line) => line.statement.startsWith("Forever cooked food"))), nextActions: [...new Set([first, ...rest].flatMap((draft) => draft.nextActions))], value: Math.min(0.5, first.value + 0.05 * rest.length) }];
}

function generateConsumablesEach(subject: CharacterEvidence, characters: CharacterEvidence[]): Draft[] {
  const drafts: Draft[] = [];
  for (const owner of characters) {
    if (owner !== subject && !sameRealmFaction(owner, subject)) continue;
    for (const item of owner.held) {
      if (owner !== subject && item.bound) continue;
      const knowledge = foreverItem(item.itemId);
      if (!knowledge?.useText || !/well fed/i.test(knowledge.useText)) continue;
      if (drafts.some((draft) => draft.id === `food-${item.itemId}`)) continue;
      drafts.push({
        id: `food-${item.itemId}`,
        category: "CONSUMABLE",
        title: `Use ${knowledge.name} while leveling`,
        what: owner === subject ? `Eat ${knowledge.name} before pulling.` : `Mail ${label(owner)}'s ${knowledge.name} x${item.qty} to ${label(subject)} and eat one before long leveling sessions.`,
        why: `${knowledge.useText} Forever food is a leveling buff, not just health.`,
        supports: "IMMEDIATE_POWER",
        feasibility: owner === subject ? "READY_NOW" : "NEEDS_TRANSFER",
        evidence: [heldEvidence(item, owner), externalItem(knowledge), { kind: "EXTERNAL", statement: foreverSystemFactStatement("cooked-food-buffs"), source: FOREVER_SYSTEM_FACTS.find((fact) => fact.key === "cooked-food-buffs")!.sources[0] }],
        prerequisites: knowledge.requiredLevel && subject.brief.level !== undefined && subject.brief.level < knowledge.requiredLevel ? [`Requires level ${knowledge.requiredLevel}.`] : [],
        costs: owner === subject ? ["None."] : ["Mail postage."],
        alternatives: ["Learn Cooking and make your own (see the Camping 101: Cooking quest if active)."],
        tradeoffs: ["Small effect; only worth it for longer sessions."],
        unknowns: item.state === "LAST_SEEN" ? ["Last seen in an earlier observation."] : [],
        nextActions: owner === subject ? [`Eat ${knowledge.name} before your next pull session.`] : [...transferSteps(owner, subject, item), "Eat it before a leveling session."],
        value: 0.3 + Math.min(0.1, item.qty * 0.02),
        objectives: ["LEVELING", "IMPROVE_CHARACTER"],
      });
    }
  }
  return drafts;
}

function foreverSystemFactStatement(key: string): string { return FOREVER_SYSTEM_FACTS.find((fact) => fact.key === key)?.statement ?? ""; }

function generateSecondaryProfessions(subject: CharacterEvidence): Draft[] {
  const drafts: Draft[] = [];
  if (subject.brief.professionsState !== "OBSERVED") return drafts;
  const has = (name: string) => subject.brief.professions.some((profession) => profession.name === name);
  const linen = subject.held.filter((item) => item.itemId === 2589 && item.state === "OBSERVED").reduce((sum, item) => sum + item.qty, 0);
  const bandageSpell = foreverSpell(3275);
  const bandage = foreverItem(1251);
  if (!has("First Aid") && linen > 0 && bandage) {
    drafts.push({
      id: "learn-first-aid",
      category: "SECONDARY_PROFESSION",
      title: "Learn First Aid and turn your Linen into bandages",
      what: `Learn First Aid, then make Linen Bandages from the ${linen} Linen Cloth already in ${label(subject)}'s bags.`,
      why: `Bandages are free out-of-combat healing for a class with no self-heal, and the cloth is already owned. ${bandage.useText ?? ""}`.trim(),
      supports: "BOTH",
      feasibility: "NEEDS_INPUTS",
      evidence: [
        { kind: "OBSERVED", statement: `${label(subject)}'s observed professions do not include First Aid (${subject.brief.professions.map((profession) => profession.name).join(", ") || "none"}).`, source: "observed professions" },
        { kind: "OBSERVED", statement: `${label(subject)} holds Linen Cloth x${linen} in bags.`, source: "observed bags", observedAt: subject.bagsObservedAt },
        ...(bandageSpell ? [{ kind: "EXTERNAL" as const, statement: `Forever recipe Linen Bandage: ${bandageSpell.reagents.map((reagent) => `${reagent.name} x${reagent.quantity}`).join(", ")}.`, source: bandageSpell.sourceUrl }] : []),
        externalItem(bandage),
      ],
      prerequisites: ["Find a First Aid trainer (location and training cost not in the knowledge base)."],
      costs: ["First Aid training fee (unknown in Forever data)."],
      alternatives: [`Sell the Linen Cloth instead (vendor ${foreverItem(2589)?.sellPriceCopper !== undefined ? formatCopper(foreverItem(2589)!.sellPriceCopper!) : "price unknown"} each; auction price unknown).`],
      tradeoffs: ["Uses cloth you could otherwise sell or send to a tailor."],
      unknowns: ["Whether First Aid counts against a profession limit in Forever is not established."],
      nextActions: ["Find the First Aid trainer and learn it.", `Craft Linen Bandages from your ${linen} Linen Cloth.`],
      value: 0.45,
      costUnknown: true,
      objectives: ["DEVELOP_PROFESSIONS", "SELF_SUFFICIENCY", "IMPROVE_CHARACTER", "LEVELING"],
    });
  }
  return drafts;
}

function generateGoldConstraint(subject: CharacterEvidence): Draft[] {
  const gold = subject.brief.gold.copper;
  const junk = subject.held.filter((item) => item.storage === "bags" && item.state === "OBSERVED" && foreverItem(item.itemId)?.quality === 0 && foreverItem(item.itemId)?.sellPriceCopper);
  const junkValue = junk.reduce((sum, item) => sum + (foreverItem(item.itemId)!.sellPriceCopper ?? 0) * item.qty, 0);
  if (gold === undefined || gold >= 10_000) return [];
  return [{
    id: "gold-bottleneck",
    category: "GOLD_BOTTLENECK",
    title: "Fix the gold bottleneck before training",
    what: `${label(subject)} has ${formatCopper(gold)}. Raise cash from quest coin${junk.length ? " and vendoring grey items" : ""}, and from the stable (see the goldmaking answer), before the next trainer visit.`,
    why: "Class training and profession training cost gold; with this balance the next trainer visit will likely be blocked.",
    supports: "IMMEDIATE_POWER",
    feasibility: "READY_NOW",
    evidence: [{ kind: subject.brief.gold.state, statement: `${label(subject)} has ${formatCopper(gold)}.`, source: "observed money" }, ...junk.map((item) => externalItem(foreverItem(item.itemId)!, `${item.name} (grey) sells for ${formatCopper(foreverItem(item.itemId)!.sellPriceCopper!)} each.`))],
    prerequisites: [],
    costs: [],
    alternatives: [],
    tradeoffs: [],
    unknowns: subject.trainerVisits.some((visit) => visit.kind === "CLASS") ? [] : ["Forever class-training costs are not captured for this character (no class trainer visit)."],
    nextActions: [junk.length ? `Vendor grey items (${formatCopper(junkValue)}).` : "Turn in quests for coin.", "Open the class trainer at your next even level so GearExport records abilities and costs."],
    value: 0.35,
    objectives: ["IMPROVE_CHARACTER", "MAKE_GOLD", "LEVELING"],
  }];
}

// ---------------------------------------------------------------------------------------------
// Generators: goldmaking (realm-scoped)

function generateGoldmaking(characters: CharacterEvidence[], realm: string): Draft[] {
  // characters is one economy (same realm and faction, or a single character of unknown faction); realm is its label.
  const drafts: Draft[] = [];
  const onRealm = characters;
  // 1. Vendor floor: grey items that have no use, one line per character.
  const greyRows = onRealm.map((character) => ({ character, greys: character.held.filter((item) => !item.bound && foreverItem(item.itemId)?.quality === 0 && (foreverItem(item.itemId)?.sellPriceCopper ?? 0) > 0) })).filter((row) => row.greys.length);
  if (greyRows.length) {
    const valueOfRow = (row: { greys: HeldItem[] }) => row.greys.reduce((sum, item) => sum + foreverItem(item.itemId)!.sellPriceCopper! * item.qty, 0);
    const total = greyRows.reduce((sum, row) => sum + valueOfRow(row), 0);
    drafts.push({
      id: `vendor-greys-${realm.toLowerCase().replace(/\W+/g, "-")}`,
      category: "VENDOR",
      title: `Vendor grey items across the realm (${formatCopper(total)} guaranteed)`,
      what: greyRows.map((row) => `${label(row.character)}: ${row.greys.map((item) => `${item.name} x${item.qty}`).join(", ")} (${formatCopper(valueOfRow(row))}).`).join(" "),
      why: "Grey items only have vendor value; selling them is guaranteed money and frees bag space for gathering.",
      supports: "GOLD",
      feasibility: greyRows.every((row) => row.greys.every((item) => item.state === "OBSERVED")) ? "READY_NOW" : "UNCERTAIN",
      evidence: greyRows.flatMap((row) => row.greys.map((item) => ({ ...heldEvidence(item, row.character), statement: `${heldEvidence(item, row.character).statement} Vendor ${formatCopper(foreverItem(item.itemId)!.sellPriceCopper!)} each (${foreverItem(item.itemId)!.sourceUrl}).` }))),
      prerequisites: [],
      costs: [],
      alternatives: [],
      tradeoffs: [],
      unknowns: greyRows.some((row) => row.character.brief.snapshotFreshness === "stale") ? ["Some exports are stale."] : [],
      nextActions: greyRows.map((row) => `On ${label(row.character)}, sell the grey items at the next vendor.`),
      value: Math.min(0.5, 0.15 + total / 2_000),
      objectives: ["MAKE_GOLD"],
    });
  }
  // 2. Material conversion: owned reagents + a recipe someone on the realm knows, valued at vendor floor.
  const conversions: Array<{ spellId: number; who: CharacterEvidence[]; why: string }> = [];
  for (const spell of foreverSpells()) {
    if (!spell.createsItemId || spell.reagents.length !== 1 || !foreverItem(spell.createsItemId)) continue;
    const input = spell.reagents[0];
    const holders = onRealm.flatMap((owner) => owner.held.filter((item) => item.itemId === input.itemId && !item.bound).map((item) => ({ owner, item })));
    if (!holders.length) continue;
    const makers = onRealm.filter((character) => character.recipes.some((recipe) => recipe.recipeID === spell.id) || (/^Smelt /.test(spell.name) && character.spells.some((name) => /smelting/i.test(name))) || (spell.id === 3275 && character.brief.professions.some((profession) => profession.name === "First Aid")));
    if (!makers.length) continue;
    conversions.push({ spellId: spell.id, who: makers, why: "" });
    const inputItem = foreverItem(input.itemId);
    const outputItem = foreverItem(spell.createsItemId);
    const units = holders.reduce((sum, holder) => sum + holder.item.qty, 0);
    const crafts = Math.floor(units / input.quantity);
    const inputVendor = inputItem?.sellPriceCopper !== undefined ? inputItem.sellPriceCopper * units : undefined;
    const outputVendorPerCraft = outputItem?.sellPriceCopper;
    const outputVendorMin = outputVendorPerCraft !== undefined ? outputVendorPerCraft * crafts : undefined;
    const evidence: EvidenceLine[] = holders.map((holder) => heldEvidence(holder.item, holder.owner));
    evidence.push({ kind: "EXTERNAL", statement: `Forever recipe ${spell.name}: ${input.name} x${input.quantity} -> ${outputItem?.name ?? `item ${spell.createsItemId}`}${spell.tools.length ? `; tools ${spell.tools.join(", ")}` : ""}${spell.description ? `. ${spell.description}` : ""}.`, source: spell.sourceUrl });
    if (inputItem) evidence.push(externalItem(inputItem, `${inputItem.name}: vendor ${inputItem.sellPriceCopper !== undefined ? formatCopper(inputItem.sellPriceCopper) : "unknown"} each.`));
    if (outputItem) evidence.push(externalItem(outputItem, `${outputItem.name}: vendor ${outputItem.sellPriceCopper !== undefined ? formatCopper(outputItem.sellPriceCopper) : "unknown"} each.`));
    for (const maker of makers) evidence.push({ kind: "OBSERVED", statement: `${label(maker)} can perform ${spell.name} (${maker.recipes.some((recipe) => recipe.recipeID === spell.id) ? "learned recipe observed" : "profession/spell observed"}).`, source: "observed professions/spellbook" });
    const gain = inputVendor !== undefined && outputVendorMin !== undefined ? outputVendorMin - inputVendor : undefined;
    const economyRealm = onRealm[0]?.brief.realm, economyFaction = onRealm[0]?.brief.faction;
    const inputMarket = marketPrice(input.itemId, economyRealm, economyFaction);
    const outputMarket = marketPrice(spell.createsItemId, economyRealm, economyFaction);
    const marketGain = inputMarket?.unit !== undefined && outputMarket?.unit !== undefined ? outputMarket.unit * crafts - inputMarket.unit * units : undefined;
    if (gain !== undefined && gain < 0 && marketGain === undefined) continue;
    if (inputMarket) evidence.push(priceEvidence(input.name, inputMarket));
    if (outputMarket) evidence.push(priceEvidence(outputItem?.name ?? `item ${spell.createsItemId}`, outputMarket));
    if (marketGain !== undefined) evidence.push({ kind: "DERIVED", statement: `At market values (7-day median where known): ${units} ${input.name} = ${formatCopper(inputMarket!.unit! * units)}; ${crafts} ${outputItem?.name ?? "products"} = ${formatCopper(outputMarket!.unit! * crafts)} (${marketGain >= 0 ? "+" : "-"}${formatCopper(Math.abs(marketGain))} for converting). Auction House cut and deposit are not deducted.`, source: "observed quantities + AHledger medians" });
    if (gain !== undefined) evidence.push({ kind: "DERIVED", statement: `${units} ${input.name} vendor for ${formatCopper(inputVendor!)}; converted (at least one ${outputItem?.name} per craft, ${crafts} crafts) they vendor for at least ${formatCopper(outputVendorMin!)}: ${gain >= 0 ? "+" : ""}${formatCopper(Math.abs(gain))}${gain < 0 ? " worse" : ""} at vendor prices.`, source: "observed quantities + Forever vendor prices" });
    const skillUps = makers.some((maker) => maker.brief.professions.some((profession) => profession.skill < profession.maxSkill));
    drafts.push({
      id: `convert-${spell.id}`,
      category: "CONVERT_MATERIALS",
      title: `Convert ${input.name} into ${outputItem?.name ?? "its product"} (${makers.map((maker) => label(maker)).join(" or ")})`,
      what: `${label(makers[0])} turns the stable's ${units} ${input.name} into ${outputItem?.name}${holders.some((holder) => holder.owner !== makers[0]) ? ` (move the ${input.name} first)` : ""}.`,
      why: `${marketGain !== undefined ? (marketGain >= 0 ? `On the Auction House the ${outputItem?.name ?? "product"} is worth ${formatCopper(marketGain)} more than the raw ${input.name}. ` : `On the Auction House the raw ${input.name} sells for ${formatCopper(-marketGain)} more than the ${outputItem?.name ?? "product"}: convert only for skill-ups, otherwise sell it raw. `) : ""}${gain !== undefined ? `At vendor prices the conversion is ${gain >= 0 ? "worth" : "loses"} ${formatCopper(Math.abs(gain))}. ` : ""}${skillUps ? "It also raises the crafter's skill toward profitable recipes. " : ""}${marketGain === undefined ? "Auction prices are unknown here, so this is a floor, not a market estimate." : "Market prices are crowd-sourced scans and move; check before listing."}`,
      supports: skillUps ? "BOTH" : "GOLD",
      feasibility: holders.some((holder) => holder.owner === makers[0] && holder.item.state === "OBSERVED" && holder.item.qty >= input.quantity) ? "READY_NOW" : holders.every((holder) => holder.owner === makers[0]) ? "UNCERTAIN" : "NEEDS_TRANSFER",
      evidence,
      prerequisites: [...spell.tools.map((tool) => `${tool} in the crafter's bags.`), ...(spell.description && /forge/i.test(spell.description) ? ["Must be at a forge."] : [])],
      costs: ["Time only at vendor floor; postage if moving materials."],
      alternatives: [`Keep ${input.name} raw for ${makers.find((maker) => maker.brief.professions.some((profession) => profession.name === "Blacksmithing"))?.brief.name ?? "a crafter"}'s own projects instead of selling.`],
      tradeoffs: holders.some((holder) => holder.item.state === "LAST_SEEN") ? ["Some quantities are last-seen bank contents."] : [],
      unknowns: [...(marketGain === undefined ? ["Auction House prices."] : ["Auction House cut and deposit rates for Forever."]), "Exact product count per craft is not verified in-client (Wowhead marker not used as yield)."],
      nextActions: [...[...new Set(holders.map((holder) => holder.owner))].flatMap((owner) => transferSteps(owner, makers[0], holders.find((holder) => holder.owner === owner)!.item)), `${label(makers[0])}: perform ${spell.name}${spell.description && /forge/i.test(spell.description) ? " at a forge" : ""}.`],
      value: Math.min(0.8, 0.3 + (marketGain !== undefined ? (marketGain > 0 ? Math.min(0.3, marketGain / 2_000) : -0.1) : gain !== undefined && gain > 0 ? Math.min(0.25, gain / 1_000) : 0) + (skillUps ? 0.15 : 0)),
      objectives: ["MAKE_GOLD", "DEVELOP_PROFESSIONS", "SELF_SUFFICIENCY"],
    });
  }
  // 3. Gathering capacity: who can gather, how close to the skill cap, and whether they carry the tool.
  for (const character of onRealm) {
    for (const profession of character.brief.professions.filter((entry) => ["Mining", "Skinning", "Herbalism"].includes(entry.name))) {
      const tool = profession.name === "Mining" ? "Mining Pick" : profession.name === "Skinning" ? "Skinning Knife" : undefined;
      const hasTool = !tool || character.held.some((item) => item.name === tool && item.storage === "bags" && item.state === "OBSERVED");
      const nearCap = profession.maxSkill - profession.skill <= 20;
      drafts.push({
        id: `gather-${character.brief.name.toLowerCase()}-${profession.name.toLowerCase()}`,
        category: "GATHERING",
        title: `${label(character)}: gather with ${profession.name} (${profession.skill}/${profession.maxSkill})`,
        what: `Use ${label(character)}'s ${profession.name} while questing to stockpile raw materials for the stable's crafters or to sell.`,
        why: `${label(character)} already has the skill${tool ? (hasTool ? " and carries the tool" : `, but no ${tool} was observed in bags`) : ""}; gathering while leveling adds income with little extra time.${nearCap ? ` Skill is within ${profession.maxSkill - profession.skill} of the ${profession.maxSkill} cap: train the next rank to keep gaining skill.` : ""}`,
        supports: "BOTH",
        feasibility: hasTool ? "READY_NOW" : "NEEDS_INPUTS",
        evidence: [{ kind: character.brief.professionsState, statement: `${label(character)} has ${profession.name} ${profession.skill}/${profession.maxSkill}.`, source: "observed professions" }, ...(tool ? [{ kind: hasTool ? "OBSERVED" as const : "OBSERVED" as const, statement: `${label(character)}'s observed bags ${hasTool ? "contain" : "do not contain"} a ${tool}.`, source: "observed bags", observedAt: character.bagsObservedAt }] : [])],
        prerequisites: [...(hasTool ? [] : [`Get a ${tool}.`]), ...(nearCap ? [`Train the next ${profession.name} rank (requirements and cost not in the knowledge base).`] : [])],
        costs: nearCap ? ["Next-rank training fee (unknown)."] : [],
        alternatives: [],
        tradeoffs: [currentForeverPrices() ? "Raw materials sold at vendor are worth little; their value is feeding your own crafters or the Auction House (see market values in the gathering item)." : "Raw materials sold at vendor are worth little; their value is feeding your own crafters or the Auction House (prices unknown)."],
        unknowns: ["Node locations by zone are not in the knowledge base."],
        nextActions: [nearCap ? `Train the next ${profession.name} rank on ${label(character)}.` : `Keep ${profession.name} tracking on while questing with ${label(character)}.`],
        value: 0.2 + Math.min(0.2, profession.skill / 300) + (nearCap ? 0.05 : 0),
        costUnknown: nearCap,
        objectives: ["MAKE_GOLD", "SELF_SUFFICIENCY", "DEVELOP_PROFESSIONS"],
      });
    }
  }
  // 4. Tradeable equipment: route it to a character it improves, otherwise its value depends on an unknown market.
  for (const owner of onRealm) {
    for (const item of owner.held) {
      const knowledge = foreverItem(item.itemId);
      if (item.bound || !knowledge?.slot || (knowledge.quality ?? 0) < 2 || TOOL_ITEM_IDS.has(item.itemId) || knowledge.binding === "BIND_ON_PICKUP") continue;
      const ownUse = compareToEquipped(knowledge, owner);
      if (ownUse && ["UPGRADE", "FILLS_EMPTY_SLOT"].includes(ownUse.verdict) && !eligibility(knowledge, owner).blocked) {
        drafts.push({
          id: `keep-gear-${item.itemId}-${owner.brief.identityKey}`, category: "ALLOCATE_RESOURCES",
          title: `Don't sell ${item.name}: ${label(owner)} should wear it`,
          what: `${label(owner)} equips ${item.name} (${ownUse.slotName}) instead of selling it.`,
          why: `It improves ${label(owner)}: ${ownUse.deltas.join(", ")} vs ${ownUse.equipped?.empty ? "an empty slot" : ownUse.equipped?.name}. Vendor value is only ${knowledge.sellPriceCopper !== undefined ? formatCopper(knowledge.sellPriceCopper) : "unknown"}.`,
          supports: "IMMEDIATE_POWER", feasibility: item.state === "OBSERVED" ? "READY_NOW" : "UNCERTAIN", evidence: [heldEvidence(item, owner), externalItem(knowledge)],
          prerequisites: eligibility(knowledge, owner).prerequisites, costs: ["None."], alternatives: [], tradeoffs: ownUse.notes, unknowns: [],
          nextActions: [`On ${label(owner)}, equip ${item.name}.`], value: 0.5, objectives: ["MAKE_GOLD", "GEAR"],
        });
        continue;
      }
      const users = onRealm.filter((other) => other !== owner && sameRealmFaction(other, owner)).map((other) => ({ other, comparison: compareToEquipped(knowledge, other), check: eligibility(knowledge, other) })).filter((entry) => entry.comparison && ["UPGRADE", "FILLS_EMPTY_SLOT", "TRADEOFF"].includes(entry.comparison.verdict) && !entry.check.blocked);
      const evidence: EvidenceLine[] = [heldEvidence(item, owner), externalItem(knowledge)];
      if (users.length) {
        const best = users.sort((a, b) => b.comparison!.magnitude - a.comparison!.magnitude)[0];
        evidence.push({ kind: "DERIVED", statement: `For ${label(best.other)} (${best.comparison!.slotName}): ${best.comparison!.deltas.join(", ")} vs ${best.comparison!.equipped?.empty ? "an empty slot" : best.comparison!.equipped?.name}.`, source: "observed equipment + Forever item records" });
        drafts.push({
          id: `allocate-gear-${item.itemId}`, category: "ALLOCATE_RESOURCES",
          title: `Give ${item.name} to ${label(best.other)} instead of selling it`,
          what: `${item.name} is worth more as gear for ${label(best.other)} than as a sale.`,
          why: `Selling yields ${knowledge.sellPriceCopper !== undefined ? `${formatCopper(knowledge.sellPriceCopper)} at a vendor` : "an unknown vendor amount"} and an unknown auction price; on ${label(best.other)} it changes ${best.comparison!.deltas.join(", ")}. Not buying a replacement is also gold saved.`,
          supports: "IMMEDIATE_POWER", feasibility: "NEEDS_TRANSFER", evidence,
          prerequisites: best.check.prerequisites, costs: ["Postage."], alternatives: [`Sell it (vendor floor ${knowledge.sellPriceCopper !== undefined ? formatCopper(knowledge.sellPriceCopper) : "unknown"}).`],
          tradeoffs: best.comparison!.notes, unknowns: knowledge.randomEnchantment ? ["Random-enchantment bonus stats on this copy are not captured."] : [],
          nextActions: transferSteps(owner, best.other, item), value: 0.45, objectives: ["MAKE_GOLD", "SELF_SUFFICIENCY", "GEAR"],
        });
      } else {
        const market = marketPrice(item.itemId, owner.brief.realm, owner.brief.faction);
        if (market) evidence.push(priceEvidence(item.name, market));
        const thin = !!market && (market.price.salesPerDay ?? 0) < 1;
        drafts.push({
          id: `sell-${item.itemId}-${owner.brief.identityKey}`, category: "SELL_ON_MARKET",
          title: `Sell ${item.name} (no character on the realm can use it better)${market ? ` - market about ${formatCopper(market.unit!)}` : ""}`,
          what: market && market.unit! > (knowledge.sellPriceCopper ?? 0) * 1.2 ? `List ${item.name} on the Auction House near ${formatCopper(market.unit!)}.` : `List ${item.name} on the Auction House, or vendor it for the floor price.`,
          why: `No observed same-realm character gains from it. Vendor floor ${knowledge.sellPriceCopper !== undefined ? formatCopper(knowledge.sellPriceCopper) : "unknown"}; ${market ? `market median ${formatCopper(market.unit!)}${thin ? ", but it rarely sells" : ""}.` : "its auction value is UNKNOWN."}`,
          supports: "GOLD", feasibility: "READY_NOW", evidence, prerequisites: [], costs: ["Auction deposit (unknown)."], alternatives: ["Keep it for an alt you have not imported."], tradeoffs: thin ? ["Few sales per day: it may take several listings to sell."] : [],
          unknowns: market ? ["Auction House cut and deposit rates for Forever."] : ["Auction House price."], nextActions: [market ? `On ${label(owner)}, list ${item.name} near ${formatCopper(market.unit!)} (check the current lowest listing first).` : `On ${label(owner)}, check the Auction House price; if it is not clearly above ${knowledge.sellPriceCopper !== undefined ? formatCopper(knowledge.sellPriceCopper) : "the vendor price"}, vendor it.`],
          value: 0.3 + Math.min(0.3, (market?.unit ?? knowledge.sellPriceCopper ?? 0) / (market ? 5_000 : 2_000)) - (thin ? 0.1 : 0), objectives: ["MAKE_GOLD"],
        });
      }
    }
  }
  // 4b. Surplus trade goods with a real market: worth listing rather than vendoring, unless a crafter here uses them.
  const usedByCrafters = new Set(onRealm.flatMap((crafter) => crafter.recipes.flatMap((recipe) => recipe.reagents.map((reagent) => reagent.itemId))));
  // Professions whose recipe lists were never captured still use their materials: count every known recipe of an owned profession.
  const knowledgeIndex = currentForeverKnowledge();
  for (const profession of new Set(onRealm.flatMap((character) => character.brief.professions.map((entry) => entry.name)))) {
    for (const id of knowledgeIndex?.bundle.recipesByProfession[profession] ?? []) for (const reagent of foreverSpell(id)?.reagents ?? []) usedByCrafters.add(reagent.itemId);
    // Recipe items (patterns, plans, recipes) for a profession someone here has are worth learning, not selling.
    for (const [id, recipeItem] of Object.entries(knowledgeIndex?.bundle.recipeItems ?? {})) if (recipeItem.profession === profession) usedByCrafters.add(Number(id));
  }
  const surplus = onRealm.flatMap((owner) => owner.held.filter((item) => !item.bound && !TOOL_ITEM_IDS.has(item.itemId) && !foreverItem(item.itemId)?.slot && foreverItem(item.itemId)?.quality !== 0 && !usedByCrafters.has(item.itemId))
    .flatMap((item) => { const market = marketPrice(item.itemId, owner.brief.realm, owner.brief.faction); const vendor = foreverItem(item.itemId)?.sellPriceCopper ?? 0; return market && market.unit! > vendor * 1.5 && (market.price.salesPerDay ?? 0) >= 1 ? [{ owner, item, market, total: market.unit! * item.qty, vendor }] : []; }))
    .sort((a, b) => b.total - a.total).slice(0, 6);
  if (surplus.length && surplus.reduce((sum, entry) => sum + entry.total, 0) >= 100) {
    const total = surplus.reduce((sum, entry) => sum + entry.total, 0);
    drafts.push({
      id: `sell-materials-${realm.toLowerCase().replace(/\W+/g, "-")}`, category: "SELL_ON_MARKET",
      title: `Sell surplus materials on the Auction House (about ${formatCopper(total)} at 7-day medians)`,
      what: surplus.map((entry) => `${label(entry.owner)}: ${entry.item.name} x${entry.item.qty} near ${formatCopper(entry.market.unit!)} each (vendor ${formatCopper(entry.vendor)})`).join("; ") + ".",
      why: "No profession in this economy uses these, they sell steadily, and the market pays well above vendor.",
      supports: "GOLD", feasibility: surplus.every((entry) => entry.item.state === "OBSERVED") ? "READY_NOW" : "UNCERTAIN",
      evidence: [...surplus.map((entry) => heldEvidence(entry.item, entry.owner)), ...[...new Map(surplus.map((entry) => [entry.item.itemId, entry])).values()].map((entry) => priceEvidence(entry.item.name, entry.market))],
      prerequisites: [], costs: ["Auction deposits (rates unverified for Forever)."], alternatives: ["Keep them if you plan to pick up a profession that uses them."],
      tradeoffs: ["Medians move; a large stack can push the price down."], unknowns: ["Auction House cut and deposit rates for Forever."],
      nextActions: [...new Set(surplus.map((entry) => entry.owner))].map((owner) => `On ${label(owner)}, list ${surplus.filter((entry) => entry.owner === owner).map((entry) => entry.item.name).join(", ")} after checking the lowest current listing.`),
      value: Math.min(0.7, 0.3 + total / 10_000), objectives: ["MAKE_GOLD"],
    });
  }
  // 5. Crafting skills whose recipes were never captured: the opportunity cannot be valued yet.
  drafts.push(...recipeEvidenceGaps(onRealm));
  // 6. Account allocation: raw materials sitting on a non-crafter while a same-realm crafter needs them.
  for (const crafter of onRealm) {
    for (const recipe of crafter.recipes) {
      for (const reagent of recipe.reagents) {
        const chain = foreverSpells().find((spell) => spell.createsItemId === reagent.itemId && spell.reagents.length === 1);
        const rawId = chain?.reagents[0].itemId ?? reagent.itemId;
        const holders = onRealm.filter((owner) => owner !== crafter && sameRealmFaction(owner, crafter)).flatMap((owner) => owner.held.filter((item) => item.itemId === rawId && !item.bound).map((item) => ({ owner, item })));
        if (!holders.length || drafts.some((draft) => draft.id === `allocate-${rawId}-${label(crafter)}`)) continue;
        const total = holders.reduce((sum, holder) => sum + holder.item.qty, 0);
        drafts.push({
          id: `allocate-${rawId}-${label(crafter)}`,
          category: "ALLOCATE_RESOURCES",
          title: `Route ${holders[0].item.name} to ${label(crafter)} instead of selling it`,
          what: `Send the stable's ${total} ${holders[0].item.name} to ${label(crafter)} for ${recipe.profession} (${recipe.name} and skill-ups).`,
          why: `${label(crafter)}'s ${recipe.profession} needs ${foreverItem(reagent.itemId)?.name ?? "this material"}; using owned materials avoids buying them and turns cheap raw goods into gear and skill.`,
          supports: "SELF_SUFFICIENCY",
          feasibility: "NEEDS_TRANSFER",
          evidence: [...holders.map((holder) => heldEvidence(holder.item, holder.owner)), { kind: recipe.state === "LAST_SEEN" ? "LAST_SEEN" : "OBSERVED", statement: `${label(crafter)} knows ${recipe.name} (${recipe.profession}).`, source: "recipe sidecar" }],
          prerequisites: [],
          costs: ["Postage."],
          alternatives: [`Vendor them instead (${foreverItem(rawId)?.sellPriceCopper !== undefined ? `${formatCopper(foreverItem(rawId)!.sellPriceCopper!)} each` : "price unknown"}).`],
          tradeoffs: ["Gives up a small vendor sale for future self-sufficiency."],
          unknowns: holders.some((holder) => holder.item.state === "LAST_SEEN") ? ["Part of the stock is last-seen bank contents."] : [],
          nextActions: [...new Set(holders.map((holder) => holder.owner))].flatMap((owner) => transferSteps(owner, crafter, holders.find((holder) => holder.owner === owner)!.item)),
          value: 0.45,
          objectives: ["SELF_SUFFICIENCY", "DEVELOP_PROFESSIONS", "MAKE_GOLD"],
        });
      }
    }
  }
  return drafts.map((draft) => ({ ...draft, realm }));
}

const CRAFTING_PROFESSIONS = ["Blacksmithing", "Leatherworking", "Tailoring", "Engineering", "Alchemy", "Enchanting", "Cooking", "First Aid"];

function recipeEvidenceGaps(characters: CharacterEvidence[]): Draft[] {
  const drafts: Draft[] = [];
  for (const character of characters) {
    const missing = character.brief.professions.filter((entry) => CRAFTING_PROFESSIONS.includes(entry.name) && entry.skill >= 10 && !character.recipes.some((recipe) => recipe.profession === entry.name));
    if (!missing.length) continue;
    const names = missing.map((profession) => `${profession.name} ${profession.skill}/${profession.maxSkill}`).join(", ");
    const byItem = new Map<number, HeldItem>();
    for (const item of character.held.filter((held) => !held.bound && foreverItem(held.itemId)?.craftingReagent)) {
      const existing = byItem.get(item.itemId);
      byItem.set(item.itemId, existing ? { ...existing, qty: existing.qty + item.qty, state: existing.state === "OBSERVED" && item.state === "OBSERVED" ? "OBSERVED" : "LAST_SEEN" } : item);
    }
    const materials = [...byItem.values()];
    drafts.push({
      id: `capture-recipes-${character.brief.identityKey}`,
      category: "EVIDENCE_GAP",
      title: `Capture ${label(character)}'s recipes (${names})`,
      what: `On ${label(character)}, open each profession window (${missing.map((profession) => profession.name).join(", ")}), then /wowsync and /reload so WoWSync records which recipes are known.`,
      why: `${label(character)} has ${names}, but no recipe list has been captured, so the co-pilot cannot say what ${label(character)} can craft or sell${materials.length ? ` from the ${materials.map((item) => `${item.name} x${item.qty}`).join(", ")} already held` : ""}. This is the cheapest way to unlock more goldmaking advice.`,
      supports: "INFORMATION",
      feasibility: "READY_NOW",
      evidence: [{ kind: character.brief.professionsState, statement: `${label(character)} has ${names}.`, source: "observed professions" }, { kind: "UNKNOWN", statement: `No recipe observations exist for ${missing.map((profession) => profession.name).join(", ")} on ${label(character)}.`, source: "recipe sidecar" }, ...materials.slice(0, 4).map((item) => heldEvidence(item, character))],
      prerequisites: [],
      costs: ["About a minute in game."],
      alternatives: [],
      tradeoffs: [],
      unknowns: missing.map((profession) => `${profession.name} recipes, outputs and their value.`),
      nextActions: [`Log in ${label(character)}, open ${missing.map((profession) => profession.name).join(" and ")}, run /wowsync, then /reload.`],
      value: 0.3 + Math.min(0.15, Math.max(...missing.map((profession) => profession.skill)) / 400) + (materials.length ? 0.05 : 0),
      objectives: ["MAKE_GOLD", "DEVELOP_PROFESSIONS"],
    });
  }
  return drafts;
}

function goldBucket(rec: CopilotRecommendation): GoldBucket {
  if (rec.category === "EVIDENCE_GAP" || rec.category === "PROFESSION_INVESTMENT") return "NEEDS_INPUTS_OR_PROGRESSION";
  if (rec.category === "GATHERING_DISCOVERY") return "MARKET_DEPENDENT";
  if (rec.category === "SELL_ON_MARKET") return "MARKET_DEPENDENT";
  if (rec.category === "GATHERING") return "NEEDS_INPUTS_OR_PROGRESSION";
  if (rec.feasibility === "NEEDS_INPUTS" || rec.feasibility === "NEEDS_PROGRESSION" || rec.feasibility === "UNCERTAIN") return "NEEDS_INPUTS_OR_PROGRESSION";
  return "SUPPORTED_NOW";
}

// ---------------------------------------------------------------------------------------------
// Orchestration

const PLAYER_CONTROL = "Read-only advice. WoWSync never plays, buys, sells, mails, or moves items. Every transfer or /bankx move is yours to run, one move at a time.";

const TOPIC_CATEGORIES: Record<string, string[]> = {
  gear: ["EQUIP_OWNED_ITEM", "TRANSFER_OWNED_ITEM", "DISCOVERED_GEAR", "CRAFT_UPGRADE"],
  professions: ["PROFESSION_CHOICE", "PROFESSION_TRAINING", "PROFESSION_TOOL", "CRAFT_ENHANCEMENT", "SECONDARY_PROFESSION", "CONVERT_MATERIALS"],
  quests: ["QUEST_ROUTE", "QUEST_TURN_IN", "DISCOVERED_QUESTS", "QUEST_PROGRESS", "DUNGEON"],
  class: ["CLASS_TRAINING", "CLASS_QUEST", "CLASS_TALENTS"],
};

function topicsFor(objective: CopilotAnswer["objective"], question: string): string[] {
  const topics = new Set<string>();
  if (objective.objectives.includes("GEAR")) topics.add("gear");
  if (objective.objectives.includes("DEVELOP_PROFESSIONS")) topics.add("professions");
  if (objective.objectives.includes("LEVELING")) topics.add("quests");
  if (objective.objectives.includes("IMPROVE_CHARACTER") || /\b(class|train|training|abilit|spell|talent|form)\b/i.test(question)) topics.add("class");
  return [...topics];
}

/** Top recommendations, but every requested topic keeps its best item (and gear keeps up to three). */
function selectWithCoverage(ranked: CopilotRecommendation[], limit: number, topics: string[]): CopilotRecommendation[] {
  const selected = ranked.slice(0, limit);
  for (const topic of topics) {
    const categories = TOPIC_CATEGORIES[topic] ?? [];
    const want = topic === "gear" ? 3 : topic === "class" ? 2 : 1;
    const present = selected.filter((rec) => categories.includes(rec.category)).length;
    const missing = ranked.filter((rec) => categories.includes(rec.category) && !selected.includes(rec)).slice(0, Math.max(0, want - present));
    selected.push(...missing);
  }
  return selected.sort((a, b) => b.score.total - a.score.total);
}

/** Economies: same realm and same known faction can mail; unknown faction stands alone. */
export function economiesOf(characters: CharacterEvidence[]): Array<{ key: string; label: string; members: CharacterEvidence[] }> {
  const map = new Map<string, { key: string; label: string; members: CharacterEvidence[] }>();
  for (const character of characters) {
    const faction = character.brief.faction;
    const key = faction ? `${character.brief.realm}|${faction}` : `${character.brief.realm}|unknown:${character.brief.identityKey}`;
    const entry = map.get(key) ?? { key, label: faction ? `${character.brief.realm}, ${faction}` : `${character.brief.realm}, faction unknown (${character.brief.name})`, members: [] };
    entry.members.push(character);
    map.set(key, entry);
  }
  return [...map.values()];
}

export function answerForeverCopilot(readModel: DashboardReadModel, request: CopilotRequest, knowledgeIndex?: ForeverKnowledgeIndex, prices?: ForeverPriceIndex, marketRegion = "us"): CopilotAnswer {
  return useForeverPrices(prices, () => useForeverKnowledge(knowledgeIndex, () => answerWithKnowledge(readModel, request, knowledgeIndex)), marketRegion);
}

/** EXTERNAL evidence line for a market price, crediting AHledger as its terms require. */
function priceEvidence(name: string, found: PriceLookup): EvidenceLine {
  return { kind: "EXTERNAL", statement: describePrice(name, found), source: AHLEDGER_ATTRIBUTION };
}

function answerWithKnowledge(readModel: DashboardReadModel, request: CopilotRequest, knowledgeIndex: ForeverKnowledgeIndex | undefined): CopilotAnswer {
  const objective = understandObjective(request);
  const knowledge = {
    source: knowledgeIndex ? knowledgeIndex.bundle.sources.map((source) => source.name).join("; ") : "No Forever knowledge bundle is installed: answers use account evidence only.",
    refreshedAt: knowledgeIndex?.bundle.builtAt,
    ageDays: knowledgeIndex ? Math.max(0, Math.floor((Date.now() - Date.parse(knowledgeIndex.bundle.builtAt)) / 86_400_000)) : undefined,
    available: knowledgeIndex !== undefined,
    sources: (knowledgeIndex?.bundle.sources ?? []).map(({ name, url, usage, confidence }) => ({ name, url, usage, confidence })),
    systemFacts: [...FOREVER_SYSTEM_FACTS],
  };
  const base = { version: request.version, question: request.question, objective, scope: { realms: [], characters: [], note: "" }, playerGoals: [], challenges: [], recommendations: [], otherOpportunities: [], limitations: [], knowledge, playerControl: PLAYER_CONTROL, plan: [] };
  if (request.version !== "forever") {
    const answer: CopilotAnswer = { ...base, status: "UNSUPPORTED_VERSION", message: `The co-pilot answers Forever questions only. "${request.version}" data is never mixed in.`, markdown: "" };
    return { ...answer, markdown: renderCopilotMarkdown(answer) };
  }
  const summaries = readModel.listCharacters({ version: "forever" }) as unknown as Loose[];
  if (!summaries.length) {
    const answer: CopilotAnswer = { ...base, status: "NO_DATA", message: "No Forever characters have been imported.", markdown: "" };
    return { ...answer, markdown: renderCopilotMarkdown(answer) };
  }
  const subjectResolution = resolveSubject(request, summaries);
  if (subjectResolution.status === "NOT_FOUND" || subjectResolution.status === "AMBIGUOUS") {
    const answer: CopilotAnswer = { ...base, status: subjectResolution.status === "NOT_FOUND" ? "CHARACTER_NOT_FOUND" : "CHARACTER_AMBIGUOUS", message: subjectResolution.message, markdown: "" };
    return { ...answer, markdown: renderCopilotMarkdown(answer) };
  }
  const subjectSummary = subjectResolution.status === "FOUND" ? subjectResolution.summary : undefined;
  const realms = subjectSummary ? [String(subjectSummary.realm)] : request.realm ? [request.realm] : [...new Set(summaries.map((summary) => String(summary.realm)))].sort();
  const inScope = summaries.filter((summary) => realms.some((realm) => realm.toLowerCase() === String(summary.realm).toLowerCase()));
  const characters = inScope.map((summary) => gatherCharacter(readModel, summary));
  assignLabels(characters);
  const subject = subjectSummary ? characters.find((character) => character.brief.identityKey === subjectSummary.identityKey) : undefined;

  const drafts: Draft[] = [];
  const wantsCharacter = subject !== undefined;
  const wantsGold = objective.objectives.includes("MAKE_GOLD");
  let plan: LevelPlanStep[] = [];
  let discoveryStats: CopilotAnswer["discovery"];
  if (subject && knowledgeIndex) {
    const discovered = discoveryDrafts(knowledgeIndex, subject, characters);
    drafts.push(...discovered.drafts.map((draft) => ({ ...draft, realm: subject.brief.realm })));
    plan = discovered.plan;
    discoveryStats = { questsConsidered: discovered.quests.length, gearCandidates: discovered.gear.length, professionOptions: discovered.professions.length };
  }
  if (subject) {
    drafts.push(...[...generateOwnedGear(subject, characters), ...generateQuests(subject, characters), ...generateProfessionTools(subject, characters), ...generateCrafting(subject, characters), ...generateConsumables(subject, characters), ...generateSecondaryProfessions(subject), ...generateGoldConstraint(subject)].map((draft) => ({ ...draft, realm: subject.brief.realm })));
  }
  const economies = economiesOf(characters);
  if (wantsGold || !wantsCharacter) for (const economy of economies) {
    drafts.push(...generateGoldmaking(economy.members, economy.label));
    if (knowledgeIndex) drafts.push(...goldDiscoveryDrafts(knowledgeIndex, economy.members, economy.label));
  }
  if (subject && objective.objectives.some((value) => value === "SELF_SUFFICIENCY" || value === "DEVELOP_PROFESSIONS")) {
    const own = economies.find((economy) => economy.members.includes(subject));
    if (own) drafts.push(...generateGoldmaking(own.members, own.label).filter((draft) => draft.category === "ALLOCATE_RESOURCES" && draft.id.endsWith(subject.brief.name)).map((draft) => ({ ...draft, realm: subject.brief.realm })));
  }

  // Minor active quests collapse into one item so they do not crowd out other topics.
  const progress = drafts.filter((draft) => draft.category === "QUEST_PROGRESS").sort((a, b) => b.value - a.value);
  const keepProgress = new Set(progress.filter((draft) => draft.feasibility === "NEEDS_TRANSFER").concat(progress.slice(0, 1)).map((draft) => draft.id));
  const minor = progress.filter((draft) => !keepProgress.has(draft.id));
  const compacted = drafts.filter((draft) => draft.category !== "QUEST_PROGRESS" || keepProgress.has(draft.id));
  if (minor.length > 1) compacted.push({
    id: "quest-progress-others", category: "QUEST_PROGRESS", realm: minor[0].realm,
    title: `Keep working the ${minor.length} other quests in your log`,
    what: minor.map((draft) => `${draft.title.replace(/^Finish /, "")}: ${draft.what.replace(/^Complete: /, "")}`).join(" "),
    why: "They are already accepted; finishing them while you pass through their areas is the cheapest XP.",
    supports: "IMMEDIATE_POWER", feasibility: "NEEDS_INPUTS", evidence: minor.flatMap((draft) => draft.evidence.slice(0, 1)), prerequisites: [], costs: ["Time."], alternatives: [], tradeoffs: [], unknowns: [], nextActions: minor.slice(0, 3).flatMap((draft) => draft.nextActions.slice(0, 1)),
    value: Math.max(...minor.map((draft) => draft.value)), objectives: ["LEVELING", "IMPROVE_CHARACTER"],
  });
  else compacted.push(...minor);
  const unique = new Map<string, Draft>();
  for (const draft of compacted) if (!unique.has(draft.id)) unique.set(draft.id, draft);
  const available = subject ? subject.brief.gold.copper : undefined;
  const ranked = [...unique.values()].map((draft) => finalize(draft, objective, available, request.preferences?.avoidSpending === true)).map((rec) => wantsGold ? { ...rec, goldBucket: goldBucket(rec) } : rec).sort((a, b) => b.score.total - a.score.total || a.id.localeCompare(b.id));
  const limit = Math.max(1, Math.min(request.limit ?? 10, 20));
  // Stable-wide answers keep realms apart: each realm gets its own top list.
  const selected = subject ? selectWithCoverage(ranked, limit, topicsFor(objective, request.question)) : economies.flatMap((economy) => ranked.filter((rec) => rec.realm === economy.label).slice(0, limit));
  const rest = ranked.filter((rec) => !selected.includes(rec));

  // Player goals: existing ERP projects are the durable goal store; the co-pilot reads them, never writes.
  const playerGoals: CopilotAnswer["playerGoals"] = [];
  for (const project of readModel.getErpProjects({ version: "forever" }) as unknown as Loose[]) {
    if (project.status !== "ACTIVE" && project.status !== "PAUSED") continue;
    const relevant = !subject || JSON.stringify(project.needs ?? []).includes(subject.brief.identityKey) || String(project.objective ?? "").includes(subject.brief.identityKey);
    if (!relevant || /\[DEV TEST\]/.test(String(project.title))) continue;
    playerGoals.push({ title: String(project.title), status: String(project.status), openSteps: ((project.workOrders ?? []) as Loose[]).filter((order) => !["COMPLETED", "CANCELLED"].includes(String(order.status))).map((order) => `${order.title} [${order.status}]`), source: `ERP project ${project.stableId} revision ${project.revision}` });
  }
  for (const goal of request.preferences?.goals ?? []) playerGoals.push({ title: goal, status: "STATED_IN_REQUEST", openSteps: [], source: "this request" });

  const challenges: string[] = [];
  const equipNow = ranked.filter((rec) => rec.category === "EQUIP_OWNED_ITEM" && rec.feasibility === "READY_NOW");
  if (subject && equipNow.length) challenges.push(`Before crafting or buying anything: ${label(subject)} is already carrying ${equipNow.length} better item${equipNow.length > 1 ? "s" : ""} (${equipNow.map((rec) => rec.title.replace(/^Equip the /, "").replace(/ already in your \w+$/, "")).join(", ")}). Equipping them is free and immediate.`);
  if (subject) {
    const blockedCrafts = subject.recipes.filter((recipe) => recipe.outputItemID && subject.held.some((item) => item.itemId === recipe.outputItemID));
    for (const recipe of blockedCrafts) challenges.push(`${label(subject)} learned ${recipe.name}, but already owns its output. Craft it only for skill-ups, not for the item.`);
  }
  if (wantsGold) {
    challenges.push(`Gold on the beta is expected to disappear: ${foreverSystemFactStatement("beta-window")} ${foreverSystemFactStatement("beta-wipe")} Treat beta goldmaking as funding training and testing your launch plan, not as savings.`);
    const priced = currentForeverPrices();
    const marketsInScope = [...new Set(characters.map((character) => foreverMarketFor(character.brief.realm, character.brief.faction)).filter((market): market is string => !!market))];
    const covered = priced ? marketsInScope.filter((market) => priced.markets().includes(market)) : [];
    challenges.push(covered.length
      ? `Auction House prices are crowd-sourced player scans from AHledger (https://ahledger.com) for ${covered.join(", ")}, fetched ${priced!.bundle.fetchedAt.slice(0, 16).replace("T", " ")} UTC. They are EXTERNAL observations with scan times, not guarantees; vendor prices remain the guaranteed floor.`
      : "Market prices are not available to WoWSync for these characters' markets. Every value below is a vendor floor from the Forever database; Auction House value is UNKNOWN, never estimated.");
  }
  const projectMentionsBlacksmithing = playerGoals.some((goal) => /blacksmith/i.test(goal.title));
  if (subject && projectMentionsBlacksmithing) challenges.push(`Your active project targets "${playerGoals.find((goal) => /blacksmith/i.test(goal.title))!.title}". The fastest version of that goal is the equip-now step above; Blacksmithing's real value now is skill-ups and future upgrades.`);

  const limitations: string[] = [];
  for (const character of subject ? [subject] : characters) {
    if (character.brief.bankState === "UNKNOWN") limitations.push(`${label(character)}'s bank has never been observed; it may hold more resources.`);
    if (character.brief.bankState === "LAST_SEEN") limitations.push(`${label(character)}'s bank is last-seen, not current.`);
    if (character.brief.snapshotFreshness === "stale") limitations.push(`${label(character)}'s latest export is stale (generated ${isoDay(character.brief.generatedAt)}).`);
  }
  if (subject && !subject.trainerVisits.some((visit) => visit.kind === "CLASS")) limitations.push("No class trainer visit has been captured for this character, so training costs are unknown: open the class trainer once and /reload.");
  if (subject && !subject.talents) limitations.push("Talents are not yet exported for this character (/wowsync and /reload with the current GearExport).");
  if (subject) limitations.push("Reputation is not used in these recommendations; read standings with get_character_progression.");
  limitations.push(currentForeverPrices() ? "Auction House prices are AHledger crowd-sourced scans (median of the latest scan); the Auction House cut and deposit are not deducted, and items without a recent scan stay UNKNOWN." : "Auction House prices are unavailable; no recommendation depends on an invented price.", "Crafting station locations are not in the knowledge base.");
  if (knowledge.ageDays !== undefined && knowledge.ageDays > 7) limitations.push(`Game knowledge was built ${knowledge.ageDays} days ago; newer Forever data may exist.`);
  const otherRealms = [...new Set(summaries.map((summary) => String(summary.realm)))].filter((realm) => !realms.includes(realm));
  const scopeNote = otherRealms.length ? `Realms are separate economies; ${otherRealms.join(", ")} ${otherRealms.length > 1 ? "were" : "was"} not mixed in.` : realms.length > 1 ? `${realms.length} realms, analysed separately: gold, materials and mail never cross realms.` : "All imported Forever characters are on this realm.";

  const answer: CopilotAnswer = {
    status: "ANSWERED",
    version: "forever",
    question: request.question,
    objective,
    subject: subject?.brief,
    scope: { realms, characters: characters.map((character) => character.brief), note: scopeNote },
    playerGoals,
    challenges,
    recommendations: selected,
    otherOpportunities: rest.map((rec) => ({ title: `${rec.title}${!subject && realms.length > 1 ? ` [${rec.realm}]` : ""}`, reason: `score ${rec.score.total}; ${rec.feasibility}` })),
    limitations: [...new Set(limitations)],
    knowledge,
    playerControl: PLAYER_CONTROL,
    plan,
    discovery: discoveryStats,
    markdown: "",
  };
  return { ...answer, markdown: renderCopilotMarkdown(answer) };
}

// ---------------------------------------------------------------------------------------------
// Rendering

export function renderCopilotMarkdown(answer: CopilotAnswer): string {
  const lines: string[] = [];
  if (answer.status !== "ANSWERED") return `**Forever Co-Pilot:** ${answer.message ?? answer.status}`;
  const subject = answer.subject;
  lines.push(`## Forever Co-Pilot${subject ? `: ${subject.name} (${subject.level ? `level ${subject.level} ` : ""}${subject.race ? `${subject.race} ` : ""}${subject.class ? subject.class.charAt(0) + subject.class.slice(1).toLowerCase() : ""}, ${subject.realm})` : `: ${answer.scope.realms.join(" + ")}`}`);
  lines.push("");
  lines.push(`*Objective:* ${answer.objective.objectives.join(", ").toLowerCase().replace(/_/g, " ")} (${answer.objective.basis})`);
  lines.push(`*Scope:* ${answer.scope.characters.map((character) => `${character.name} L${character.level ?? "?"} ${character.class?.toLowerCase() ?? ""} [${character.professions.map((profession) => `${profession.name} ${profession.skill}/${profession.maxSkill}`).join(", ") || "no professions observed"}; gold ${character.gold.copper !== undefined ? formatCopper(character.gold.copper) : "unknown"}]`).join("; ")}. ${answer.scope.note}`);
  if (answer.playerGoals.length) {
    lines.push("");
    lines.push("**Your recorded goals**");
    for (const goal of answer.playerGoals) lines.push(`- ${goal.title} (${goal.status})${goal.openSteps.length ? `: next open step "${goal.openSteps[0]}"` : ""}`);
  }
  if (answer.challenges.length) {
    lines.push("");
    lines.push("**Before you start**");
    for (const challenge of answer.challenges) lines.push(`- ${challenge}`);
  }
  if (answer.plan.length) {
    lines.push("");
    lines.push(`**Level plan (${answer.plan[0].level} to ${answer.plan[answer.plan.length - 1].level})**`);
    for (const step of answer.plan) {
      const parts = [
        step.training.length ? `train ${step.training.join(", ")}` : "",
        step.milestones.length ? step.milestones.join("; ") : "",
        step.quests.length ? `quests ${step.quests.join(", ")}` : "",
        step.gear.length ? `gear ${step.gear.join("; ")}` : "",
      ].filter(Boolean);
      lines.push(`- **Level ${step.level}:** ${parts.join(" | ") || "keep questing"}${step.goldNeeded ? ` (training so far: ${formatCopper(step.goldNeeded)})` : ""}`);
    }
  }
  const BUCKET_TITLES: Record<GoldBucket, string> = { SUPPORTED_NOW: "Supported by resources you already have", NEEDS_INPUTS_OR_PROGRESSION: "Needs more inputs, time, or progression", MARKET_DEPENDENT: "Depends on unknown market prices" };
  const groups: Array<{ heading: string; recs: CopilotRecommendation[] }> = [];
  const realmScore = (realm: string) => answer.recommendations.filter((rec) => (rec.realm ?? "") === realm).reduce((sum, rec) => sum + rec.score.total, 0);
  const realmsInAnswer = [...new Set(answer.recommendations.map((rec) => rec.realm ?? ""))].sort((a, b) => realmScore(b) - realmScore(a));
  for (const realm of realmsInAnswer) {
    const realmRecs = answer.recommendations.filter((rec) => (rec.realm ?? "") === realm);
    const members = answer.scope.characters.filter((character) => character.realm === realm || `${character.realm}, ${character.faction}` === realm || realm.endsWith(`(${character.name})`) && realm.startsWith(character.realm));
    const realmHeading = realmsInAnswer.length > 1 ? `${realm.includes(",") ? "Economy" : "Realm"}: ${realm}${realm.endsWith(")") ? "" : ` (${members.map((character) => character.name).join(", ")})`}` : "Recommendations";
    if (realmRecs.some((rec) => rec.goldBucket)) {
      for (const bucket of ["SUPPORTED_NOW", "NEEDS_INPUTS_OR_PROGRESSION", "MARKET_DEPENDENT"] as GoldBucket[]) {
        const recs = realmRecs.filter((rec) => rec.goldBucket === bucket);
        if (recs.length) groups.push({ heading: `${realmHeading}: ${BUCKET_TITLES[bucket]}`, recs });
      }
    } else groups.push({ heading: `${realmHeading} (ranked)`, recs: realmRecs });
  }
  let index = 0;
  for (const group of groups) {
    lines.push("");
    lines.push(`**${group.heading}**`);
    for (const rec of group.recs) {
    index += 1;
    lines.push("");
    lines.push(`### ${index}. ${rec.title}`);
    lines.push(`- **Do:** ${rec.what}`);
    lines.push(`- **Why:** ${rec.why}`);
    lines.push(`- **Supports:** ${rec.supports.toLowerCase().replace(/_/g, " ")} | **Feasibility:** ${rec.feasibility.toLowerCase().replace(/_/g, " ")} | **Score:** ${rec.score.total}`);
    lines.push(`- **Evidence:**`);
    for (const line of rec.evidence.slice(0, 8)) lines.push(`  - [${line.kind}] ${line.statement}${line.source.startsWith("http") ? ` (${line.source})` : ` (${line.source}${line.observedAt ? `, ${isoDay(line.observedAt)}` : ""})`}`);
    if (rec.prerequisites.length) lines.push(`- **Prerequisites:** ${rec.prerequisites.join(" ")}`);
    if (rec.costs.length) lines.push(`- **Costs/resources:** ${rec.costs.join(" ")}`);
    if (rec.alternatives.length || rec.tradeoffs.length) lines.push(`- **Alternatives/tradeoffs:** ${[...rec.alternatives, ...rec.tradeoffs].join(" ")}`);
    if (rec.unknowns.length) lines.push(`- **Unknown:** ${rec.unknowns.join(" ")}`);
    if (rec.nextActions.length) lines.push(`- **Next:** ${rec.nextActions.map((action, step) => `(${step + 1}) ${action}`).join(" ")}`);
    }
  }
  if (answer.otherOpportunities.length) {
    lines.push("");
    lines.push("**Also considered (lower priority)**");
    for (const other of answer.otherOpportunities.slice(0, 10)) lines.push(`- ${other.title} (${other.reason})`);
  }
  lines.push("");
  lines.push("**What WoWSync could not establish**");
  for (const limitation of answer.limitations) lines.push(`- ${limitation}`);
  lines.push("");
  lines.push(`*Game knowledge:* ${answer.knowledge.source}${answer.knowledge.refreshedAt ? `, built ${answer.knowledge.refreshedAt.slice(0, 10)}${answer.knowledge.ageDays !== undefined ? ` (${answer.knowledge.ageDays === 0 ? "today" : `${answer.knowledge.ageDays} day${answer.knowledge.ageDays === 1 ? "" : "s"} old`})` : ""}` : ""}${answer.discovery ? ` (${answer.discovery.questsConsidered} quests and ${answer.discovery.gearCandidates} gear candidates checked against this character)` : ""}. ${answer.playerControl}`);
  return lines.join("\n");
}
