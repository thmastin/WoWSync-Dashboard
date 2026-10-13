// Runtime Forever game-knowledge bundle and its query index.
//
// The bundle is built by tools/forever-knowledge/build-bundle.ts from:
//   - QuestieDB's Forever data (quests, items and their sources, NPCs, objects, zones, quest XP).
//     QuestieDB has no license, so the bundle is a private runtime cache: it is never committed to
//     this public repository and never redistributed.
//   - Wowhead Forever tooltips (public tooltip API) for item stats/slots and recipe reagents/outputs,
//     fetched per ID with rate limiting and cached locally.
// Everything here is Forever-only and EXTERNAL knowledge; it never says what a character owns.
import type { ForeverItemKnowledge, ForeverSpellKnowledge } from "./foreverKnowledge.ts";

export type BundleConfidence = "FOREVER_DATABASE" | "FOREVER_COMMUNITY_DATABASE" | "CLASSIC_SEED_UNVERIFIED";

export interface BundleSource { id: string; name: string; url: string; revision?: string; usage: string; confidence: BundleConfidence }

export interface BundleQuest {
  name: string;
  level?: number;
  reqLevel?: number;
  maxLevel?: number;
  races?: number;
  classes?: number;
  zone?: number;
  startNpcs?: number[];
  startObjects?: number[];
  startItem?: number;
  endNpcs?: number[];
  text?: string;
  objectiveItems?: number[];
  objectiveNpcs?: number[];
  preGroup?: number[];
  preSingle?: number[];
  next?: number;
  exclusiveTo?: number[];
  breadcrumbFor?: number;
  reqSkill?: [number, number];
  rep?: Array<[number, number]>;
  rewardItems?: number[];
  special?: number;
  xp?: number;
}

export interface BundleItem {
  name: string;
  ilvl?: number;
  reqLevel?: number;
  cls?: number;
  sub?: number;
  vendors?: number[];
  dropNpcs?: number[];
  dropObjects?: number[];
  questRewards?: number[];
  startQuest?: number;
}

export interface BundleNpc {
  name: string;
  level?: [number, number];
  zone?: number;
  coord?: [number, number];
  friendly?: string;
  sub?: string;
  flags?: number;
  rank?: number;
}

export interface BundleObject { name: string; zones?: number[] }

/** Dungeon instance from QuestieDB's zone table: area IDs, parent zone and entrance coordinates. */
export interface BundleDungeon { name: string; areas: number[]; parentZone?: number; entrance?: [number, number, number] }

export interface ForeverKnowledgeBundle {
  schema: 2;
  version: "forever";
  builtAt: string;
  sources: BundleSource[];
  zones: Record<string, string>;
  quests: Record<string, BundleQuest>;
  items: Record<string, BundleItem>;
  npcs: Record<string, BundleNpc>;
  objects: Record<string, BundleObject>;
  dungeons?: Record<string, BundleDungeon>;
  tooltips: { items: Record<string, ForeverItemKnowledge>; spells: Record<string, ForeverSpellKnowledge> };
  /** Recipe spell IDs by profession name (seeded IDs verified to exist in the Forever database). */
  recipesByProfession: Record<string, number[]>;
  /** Recipe items (patterns/plans/recipes) with the profession and skill they require. */
  recipeItems: Record<string, { profession: string; skill: number; teaches?: string }>;
}

// Vanilla/Forever bitmasks used by QuestieDB.
export const RACE_BITS: Record<string, number> = { HUMAN: 1, ORC: 2, DWARF: 4, NIGHTELF: 8, "NIGHT ELF": 8, UNDEAD: 16, SCOURGE: 16, TAUREN: 32, GNOME: 64, TROLL: 128 };
export const CLASS_BITS: Record<string, number> = { WARRIOR: 1, PALADIN: 2, HUNTER: 4, ROGUE: 8, PRIEST: 16, SHAMAN: 64, MAGE: 128, WARLOCK: 256, DRUID: 1024 };
export const NPC_FLAG = { QUESTGIVER: 2, VENDOR: 4, TRAINER: 16, REPAIR: 16384 } as const;
export const ITEM_CLASS = { WEAPON: 2, ARMOR: 4, RECIPE: 9 } as const;
export const ARMOR_SUBCLASS: Record<number, string> = { 0: "Miscellaneous", 1: "Cloth", 2: "Leather", 3: "Mail", 4: "Plate", 6: "Shield" };

/** Bit test that tolerates QuestieDB's high Forever bits (masks above 2^31). */
export function hasBit(mask: number | undefined, bit: number): boolean {
  if (!mask) return true;
  return Math.floor(mask / bit) % 2 === 1;
}

export class ForeverKnowledgeIndex {
  readonly bundle: ForeverKnowledgeBundle;
  private questsByStartNpc = new Map<number, number[]>();
  private rewardsByQuest = new Map<number, number[]>();
  private itemsByVendor = new Map<number, number[]>();

  constructor(bundle: ForeverKnowledgeBundle) {
    if (bundle.version !== "forever" || bundle.schema !== 2) throw new TypeError("Not a Forever knowledge bundle (schema 2).");
    this.bundle = bundle;
    for (const [id, quest] of Object.entries(bundle.quests)) {
      for (const npc of quest.startNpcs ?? []) this.push(this.questsByStartNpc, npc, Number(id));
      if (quest.rewardItems) this.rewardsByQuest.set(Number(id), quest.rewardItems);
    }
    for (const [id, item] of Object.entries(bundle.items)) for (const vendor of item.vendors ?? []) this.push(this.itemsByVendor, vendor, Number(id));
  }

  private push(map: Map<number, number[]>, key: number, value: number) { const list = map.get(key); if (list) list.push(value); else map.set(key, [value]); }

  quest(id: number): BundleQuest | undefined { return this.bundle.quests[String(id)]; }
  item(id: number): BundleItem | undefined { return this.bundle.items[String(id)]; }
  npc(id: number): BundleNpc | undefined { return this.bundle.npcs[String(id)]; }
  zoneName(id: number | undefined): string | undefined { return id === undefined ? undefined : this.bundle.zones[String(id)]; }
  tooltipItem(id: number | undefined): ForeverItemKnowledge | undefined { return id === undefined ? undefined : this.bundle.tooltips.items[String(id)]; }
  tooltipSpell(id: number | undefined): ForeverSpellKnowledge | undefined { return id === undefined ? undefined : this.bundle.tooltips.spells[String(id)]; }
  questRewards(questId: number): number[] { return this.rewardsByQuest.get(questId) ?? []; }
  vendorItems(npcId: number): number[] { return this.itemsByVendor.get(npcId) ?? []; }
  quests(): Array<[number, BundleQuest]> { return Object.entries(this.bundle.quests).map(([id, quest]) => [Number(id), quest]); }
  items(): Array<[number, BundleItem]> { return Object.entries(this.bundle.items).map(([id, item]) => [Number(id), item]); }
  questStarter(quest: BundleQuest): BundleNpc | undefined { return quest.startNpcs?.length ? this.npc(quest.startNpcs[0]) : undefined; }
  /** Where an NPC is, in words, from its first recorded spawn. */
  npcLocation(npc: BundleNpc | undefined): string | undefined {
    if (!npc) return undefined;
    const zone = this.zoneName(npc.zone);
    return [npc.name + (npc.sub ? ` <${npc.sub}>` : ""), zone ? `in ${zone}` : "", npc.coord ? `(${npc.coord[0].toFixed(1)}, ${npc.coord[1].toFixed(1)})` : ""].filter(Boolean).join(" ");
  }
  /** Is an NPC usable by this faction? "A"/"H" from QuestieDB; unknown stays unknown. */
  npcFriendlyTo(npc: BundleNpc | undefined, faction: string | undefined): boolean | undefined {
    if (!npc || !faction || npc.friendly === undefined) return undefined;
    return npc.friendly.includes(faction.startsWith("H") ? "H" : "A");
  }
  sourceLabel(id: string): BundleSource | undefined { return this.bundle.sources.find((source) => source.id === id); }

  private dungeonCache?: Array<{ id: number; dungeon: BundleDungeon; npcs: number[]; minLevel?: number; maxLevel?: number }>;
  /** Dungeons with the creatures QuestieDB places inside them and the level range those creatures span. */
  dungeons(): Array<{ id: number; dungeon: BundleDungeon; npcs: number[]; minLevel?: number; maxLevel?: number }> {
    if (this.dungeonCache) return this.dungeonCache;
    const byArea = new Map<number, number>();
    for (const [id, dungeon] of Object.entries(this.bundle.dungeons ?? {})) for (const area of dungeon.areas) byArea.set(area, Number(id));
    const npcs = new Map<number, number[]>();
    for (const [npcId, npc] of Object.entries(this.bundle.npcs)) {
      const dungeonId = npc.zone !== undefined ? byArea.get(npc.zone) : undefined;
      if (dungeonId !== undefined) npcs.set(dungeonId, [...(npcs.get(dungeonId) ?? []), Number(npcId)]);
    }
    this.dungeonCache = Object.entries(this.bundle.dungeons ?? {}).map(([id, dungeon]) => {
      const inside = npcs.get(Number(id)) ?? [];
      const levels = inside.map((npcId) => this.npc(npcId)?.level).filter((level): level is [number, number] => !!level && level[0] > 0 && level[0] < 70);
      levels.sort((a, b) => a[0] - b[0]);
      const trimmed = levels.length > 6 ? levels.slice(Math.floor(levels.length * 0.1), Math.ceil(levels.length * 0.9)) : levels;
      return { id: Number(id), dungeon, npcs: inside, minLevel: trimmed.length ? Math.min(...trimmed.map((level) => level[0])) : undefined, maxLevel: trimmed.length ? Math.max(...trimmed.map((level) => level[1])) : undefined };
    });
    return this.dungeonCache;
  }
}

/** IDs the account has actually observed on Forever: equipped/bag/bank items, recipe outputs and reagents, learned recipes, active quests. */
export interface ForeverObservedIds { items: number[]; spells: number[]; quests: number[] }

// Structural view of the read-model methods used, so this module does not import the read model.
interface ObservedIdReader {
  listCharacters(query: { version: "forever" }): Array<{ name: string; realm: string }>;
  getCharacterEquipment(query: { version: "forever"; name: string; realm: string }): unknown;
  getCharacterStorage(query: { version: "forever"; name: string; realm: string; storage: "bags" | "bank"; limit: number }): unknown;
  getCharacterProfessions(query: { version: "forever"; name: string; realm: string }): unknown;
  getForeverQuestObservation(query: { version: "forever"; name: string; realm: string }): unknown;
}

export function collectForeverObservedIds(readModel: ObservedIdReader): ForeverObservedIds {
  type Loose = Record<string, any>;
  const items = new Set<number>(), spells = new Set<number>(), quests = new Set<number>();
  const data = (resolution: unknown): Loose | undefined => (resolution as Loose)?.status === "FOUND" ? (resolution as Loose).value?.data : undefined;
  const ref = (value: unknown) => { const match = typeof value === "string" ? /^item:(\d+)/.exec(value) : null; if (match) items.add(Number(match[1])); };
  for (const character of readModel.listCharacters({ version: "forever" })) {
    const query = { version: "forever" as const, name: character.name, realm: character.realm };
    for (const slot of (data(readModel.getCharacterEquipment(query))?.slots ?? []) as Loose[]) ref(slot.itemRef);
    for (const storage of ["bags", "bank"] as const) for (const item of (data(readModel.getCharacterStorage({ ...query, storage, limit: 100 }))?.items ?? []) as Loose[]) ref(item.itemRef);
    for (const profession of (data(readModel.getCharacterProfessions(query))?.recipeKnowledge?.data?.professions ?? []) as Loose[]) {
      for (const recipe of (profession.recipes ?? []) as Loose[]) {
        if (typeof recipe.outputItemID === "number") items.add(recipe.outputItemID);
        if (recipe.learnedState === "OBSERVED_TRUE" && typeof recipe.recipeID === "number") spells.add(recipe.recipeID);
        for (const slot of (recipe.reagentSlots ?? []) as Loose[]) for (const reagent of (slot.reagents ?? []) as Loose[]) if (typeof reagent.itemID === "number") items.add(reagent.itemID);
      }
    }
    for (const quest of (data(readModel.getForeverQuestObservation(query))?.active ?? []) as Loose[]) if (typeof quest.questID === "number") quests.add(quest.questID);
  }
  const sorted = (set: Set<number>) => [...set].sort((a, b) => a - b);
  return { items: sorted(items), spells: sorted(spells), quests: sorted(quests) };
}
