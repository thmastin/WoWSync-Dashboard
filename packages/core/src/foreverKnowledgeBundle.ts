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
}
