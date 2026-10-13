// Forever-only external game knowledge.
//
// Two kinds of knowledge live here, both labelled EXTERNAL and never presented as account
// observations:
//   1. Database records (items, recipe spells, quests) parsed from Wowhead's Forever database by
//      tools/forever-knowledge/refresh.ts and committed as foreverKnowledgeData.ts.
//   2. A short list of curated Forever system facts (beta dates, new systems) with their sources and
//      a confidence label. Facts that only secondary guides report say so.
//
// Nothing here is Retail, Classic Era, Anniversary, or any other version's data: the refresh tool
// only requests the /forever/ data environment.
import { FOREVER_KNOWLEDGE_DATA } from "./foreverKnowledgeData.ts";

export interface ForeverItemStat { stat: string; value: number }

export interface ForeverItemKnowledge {
  id: number;
  name: string;
  quality?: number;
  itemLevel?: number;
  requiredLevel?: number;
  binding?: "BIND_ON_PICKUP" | "BIND_ON_EQUIP" | "QUEST" | "NONE_STATED";
  slot?: string;
  subtype?: string;
  armor?: number;
  damageMin?: number;
  damageMax?: number;
  speed?: number;
  dps?: number;
  stats: ForeverItemStat[];
  randomEnchantment?: boolean;
  useText?: string;
  equipText?: string[];
  requiresSkill?: { name: string; level: number };
  classes?: string[];
  sellPriceCopper?: number;
  craftingReagent?: boolean;
  maxStack?: number;
  unique?: boolean;
  sourceUrl: string;
  retrievedAt: string;
}

export interface ForeverSpellKnowledge {
  id: number;
  name: string;
  tools: string[];
  reagents: Array<{ itemId: number; name: string; quantity: number }>;
  createsItemId?: number;
  /** The number Wowhead prints after the created item. Its meaning is not verified against the client; never used as yield. */
  createsMarker?: number;
  description?: string;
  sourceUrl: string;
  retrievedAt: string;
}

export interface ForeverQuestKnowledge {
  id: number;
  name: string;
  level?: number;
  zone?: string;
  summary?: string;
  xpByLevel: Record<string, number>;
  coinByLevel: Record<string, number>;
  reputation: Array<{ faction: string; amount: number }>;
  rewardItemIds: number[];
  /** Vendor purchase prices Wowhead lists for items referenced on the quest page (e.g. a quest reagent sold by an innkeeper). */
  vendorBuyPrices: Array<{ itemId: number; name: string; buyPriceCopper: number }>;
  sourceUrl: string;
  retrievedAt: string;
}

export interface ForeverKnowledgeDataset {
  schema: 1;
  version: "forever";
  source: string;
  sourceBaseUrl: string;
  refreshedAt?: string;
  items: Record<string, ForeverItemKnowledge>;
  spells: Record<string, ForeverSpellKnowledge>;
  quests: Record<string, ForeverQuestKnowledge>;
}

export type ForeverFactConfidence = "OFFICIAL" | "DATABASE" | "SECONDARY_GUIDES" | "INFERRED_FROM_PRECEDENT";

export interface ForeverSystemFact {
  key: string;
  statement: string;
  confidence: ForeverFactConfidence;
  sources: string[];
  checkedAt: string;
}

/** Curated Forever system facts. Keep statements narrow; confidence says how far to trust them. */
export const FOREVER_SYSTEM_FACTS: readonly ForeverSystemFact[] = [
  {
    key: "beta-window",
    statement: "The World of Warcraft: Forever beta runs through October 21, 2026; launch is November 4, 2026 at 3:00 p.m. PST.",
    confidence: "OFFICIAL",
    sources: ["https://us.forums.blizzard.com/en/wow/t/2352596/1"],
    checkedAt: "2026-10-12",
  },
  {
    key: "beta-wipe",
    statement: "Beta characters, gold and professions are expected to be deleted when the beta ends. Blizzard's announcements do not state this outright; it is reported by press and follows every previous WoW beta.",
    confidence: "INFERRED_FROM_PRECEDENT",
    sources: ["https://blizzardwatch.com/2026/09/28/will-progress-wow-forever-beta-carry-game-releases/", "https://kami-labs.fr/en/wow-forever/personnages-de-la-beta-wow-forever-conserves/"],
    checkedAt: "2026-10-12",
  },
  {
    key: "beta-level-cap",
    statement: "The beta level cap has been 30 since October 1, 2026.",
    confidence: "SECONDARY_GUIDES",
    sources: ["https://lfcarry.com/guides/wow-forever-beta", "https://getboost.gg/blog/wow-forever/wow-forever-beta-guide-access-level-cap-content"],
    checkedAt: "2026-10-12",
  },
  {
    key: "cooked-food-buffs",
    statement: "Forever cooked food grants a well-fed stat bonus and increases experience from kills (for example Beer Basted Boar Ribs: +1 Strength and +5% kill experience for 15 minutes).",
    confidence: "DATABASE",
    sources: ["https://www.wowhead.com/forever/item=2888/beer-basted-boar-ribs"],
    checkedAt: "2026-10-12",
  },
  {
    key: "camping",
    statement: "Forever adds camping: campsite objects are crafted by professions and grant buffs; the Camping 101 quests introduce each profession's part.",
    confidence: "SECONDARY_GUIDES",
    sources: ["https://classicwowforever.com/professions/camping/", "https://www.mmoexp.com/News/wow-forever-beta-game-guide-undead-paladin-quests-holy-strike-campfire-buffs-new-crafting-rewards-more.html"],
    checkedAt: "2026-10-12",
  },
  {
    key: "trade-factions",
    statement: "Forever adds trade factions (Azeroth Commerce Authority for Alliance, Durotar Supply and Logistics for Horde); their profession activities award Merchant's Favor.",
    confidence: "SECONDARY_GUIDES",
    sources: ["https://www.zockify.com/forever/", "https://www.iggm.com/news/wow-forever-beta-guide-to-professions-dungeons-pvp-testing-before-hit-level-20"],
    checkedAt: "2026-10-12",
  },
];

const dataset = FOREVER_KNOWLEDGE_DATA;

export function foreverKnowledgeDataset(): ForeverKnowledgeDataset { return dataset; }
export function foreverItem(id: number | undefined): ForeverItemKnowledge | undefined { return id === undefined ? undefined : dataset.items[String(id)]; }
export function foreverSpell(id: number | undefined): ForeverSpellKnowledge | undefined { return id === undefined ? undefined : dataset.spells[String(id)]; }
export function foreverQuest(id: number | undefined): ForeverQuestKnowledge | undefined { return id === undefined ? undefined : dataset.quests[String(id)]; }
export function foreverSystemFact(key: string): ForeverSystemFact | undefined { return FOREVER_SYSTEM_FACTS.find((fact) => fact.key === key); }

// ---------------------------------------------------------------------------------------------
// Parsers (used by the refresh tool and by tests on captured tooltip text).

const decode = (text: string) => text.replace(/&nbsp;/g, " ").replace(/&quot;/g, "\"").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/&apos;/g, "'");
const stripTags = (html: string) => decode(html.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();

function sellPrice(html: string): number | undefined {
  const block = /whtt-sellprice">([\s\S]*?)<\/div>/.exec(html)?.[1];
  if (!block) return undefined;
  let copper = 0;
  for (const [, unit, amount] of block.matchAll(/class="money(gold|silver|copper)">(\d+)</g)) copper += Number(amount) * (unit === "gold" ? 10_000 : unit === "silver" ? 100 : 1);
  return copper;
}

export function parseItemTooltip(id: number, payload: { name?: string; quality?: number; tooltip?: string }, retrievedAt: string): ForeverItemKnowledge | undefined {
  const html = payload.tooltip;
  if (!payload.name || !html) return undefined;
  const number = (pattern: RegExp) => { const match = pattern.exec(html); return match ? Number(match[1]) : undefined; };
  const slotRow = /<table width="100%"><tr><td>([^<]+)<\/td>(?:<th>(?:<!--scstart[^>]*-->)?<span[^>]*>([^<]+)<\/span>)?/.exec(html);
  const damage = /<!--dmg-->(\d+) - (\d+) Damage/.exec(html);
  const stats: ForeverItemStat[] = [];
  for (const [, value, stat] of html.matchAll(/<!--stat\d+-->([+-]\d+) ([A-Za-z ]+?)</g)) stats.push({ stat: stat.trim(), value: Number(value) });
  const useMatch = /class="q2">Use: ([\s\S]*?)<!--useEffect:1-->/.exec(html);
  const equipText = [...html.matchAll(/class="q2">Equip: ([\s\S]*?)<\/span>/g)].map((match) => stripTags(match[1]));
  const skill = /Requires <a [^>]*>([^<]+)<\/a> \((\d+)\)/.exec(html);
  const classes = /Classes: ([\s\S]*?)<br/.exec(html);
  const binding = /Binds when picked up/.test(html) ? "BIND_ON_PICKUP" : /Binds when equipped/.test(html) ? "BIND_ON_EQUIP" : /Quest Item/.test(html) ? "QUEST" : "NONE_STATED";
  return {
    id,
    name: payload.name,
    quality: payload.quality,
    itemLevel: number(/<!--ilvl-->(\d+)/),
    requiredLevel: number(/<!--rlvl-->(\d+)/),
    binding,
    slot: slotRow?.[1]?.trim(),
    subtype: slotRow?.[2]?.trim(),
    armor: number(/<!--amr-->(\d+) Armor/),
    damageMin: damage ? Number(damage[1]) : undefined,
    damageMax: damage ? Number(damage[2]) : undefined,
    speed: number(/<!--spd-->([\d.]+)/),
    dps: number(/<!--dps-->\(([\d.]+) damage per second\)/),
    stats,
    randomEnchantment: /Random enchantment/.test(html) || undefined,
    useText: useMatch ? stripTags(useMatch[1]) : undefined,
    equipText: equipText.length ? equipText : undefined,
    requiresSkill: skill ? { name: skill[1], level: Number(skill[2]) } : undefined,
    classes: classes ? stripTags(classes[1]).split(/,\s*/) : undefined,
    sellPriceCopper: sellPrice(html),
    craftingReagent: /Crafting Reagent/.test(html) || undefined,
    maxStack: number(/Max Stack: (\d+)/),
    unique: /Unique/.test(html) || undefined,
    sourceUrl: `https://www.wowhead.com/forever/item=${id}`,
    retrievedAt,
  };
}

export function parseSpellTooltip(id: number, payload: { name?: string; tooltip?: string }, retrievedAt: string): ForeverSpellKnowledge | undefined {
  const html = payload.tooltip;
  if (!payload.name || !html) return undefined;
  const toolsBlock = /Tools:<br \/>([\s\S]*?)(?:Reagents:|<div class="q">|<\/td>)/.exec(html)?.[1] ?? "";
  const tools = [...toolsBlock.matchAll(/>([^<>]+)<\/a>/g)].map((match) => decode(match[1]).trim());
  const reagentsBlock = /Reagents:<br \/>([\s\S]*?)(?:<br \/>|<div class="q">)/.exec(html)?.[1] ?? "";
  const reagents = [...reagentsBlock.matchAll(/item=(\d+)\/[^"]*">([^<]+)<\/a><\/div>|item=(\d+)\/[^"]*">([^<]+)<\/a>&nbsp;\((\d+)\)<\/div>/g)].map((match) => (
    match[1] ? { itemId: Number(match[1]), name: decode(match[2]), quantity: 1 } : { itemId: Number(match[3]), name: decode(match[4]), quantity: Number(match[5]) }
  ));
  const created = /<span class="q\d"><a href="\/forever\/item=(\d+)\/[^"]*">[^<]+<\/a><\/span>(?: \((\d+)\))?/.exec(html);
  const description = /<div class="q">([\s\S]*?)<\/div>/.exec(html)?.[1];
  return {
    id,
    name: payload.name,
    tools,
    reagents,
    createsItemId: created ? Number(created[1]) : undefined,
    createsMarker: created?.[2] ? Number(created[2]) : undefined,
    description: description ? stripTags(description) : undefined,
    sourceUrl: `https://www.wowhead.com/forever/spell=${id}`,
    retrievedAt,
  };
}

export function parseQuestPage(id: number, html: string, retrievedAt: string): ForeverQuestKnowledge | undefined {
  const description = /<meta name="description" content="([^"]*)"/.exec(html)?.[1];
  const title = /<meta property="og:title" content="([^"]*)"/.exec(html)?.[1] ?? /<title>([^<]*)<\/title>/.exec(html)?.[1];
  if (!description || !title) return undefined;
  const name = decode(decode(title)).replace(/ - Quest - Forever.*$/, "").replace(/ - Wowhead$/, "").trim();
  const meta = decode(description);
  const rewardsJson = /Rewards\((\{[\s\S]*?\})\);/.exec(html)?.[1];
  let xpByLevel: Record<string, number> = {};
  let coinByLevel: Record<string, number> = {};
  if (rewardsJson) {
    try {
      const parsed = JSON.parse(rewardsJson) as { xp?: { levels?: Record<string, number> }; coin?: { levels?: Record<string, number> } };
      xpByLevel = parsed.xp?.levels ?? {};
      coinByLevel = parsed.coin?.levels ?? {};
    } catch { /* leave empty: unknown, not zero */ }
  }
  const reputation = [...meta.matchAll(/\+(\d+) reputation with ([A-Za-z' -]+?)(?= \+|$)/g)].map((match) => ({ faction: match[2].trim(), amount: Number(match[1]) }));
  const levelZone = /A level (\d+) (?:(.+?) )?Quest\./.exec(meta);
  const start = html.indexOf("Rewards</h2>");
  const end = start >= 0 ? html.indexOf("<h2", start + 12) : -1;
  const rewardSection = start >= 0 ? html.slice(start, end > start ? end : start + 4_000) : "";
  const vendorBuyPrices: ForeverQuestKnowledge["vendorBuyPrices"] = [];
  for (const [, json] of html.matchAll(/WH\.Gatherer\.addData\(3, \d+, (\{[\s\S]*?\})\);/g)) {
    try {
      for (const [itemId, entry] of Object.entries(JSON.parse(json) as Record<string, { name_enus?: string; jsonequip?: { buyprice?: number } }>)) {
        if (typeof entry.jsonequip?.buyprice === "number" && entry.name_enus) vendorBuyPrices.push({ itemId: Number(itemId), name: entry.name_enus, buyPriceCopper: entry.jsonequip.buyprice });
      }
    } catch { /* not parseable: no prices */ }
  }
  const rewardItemIds = [...new Set([...rewardSection.matchAll(/\/forever\/item=(\d+)/g)].map((match) => Number(match[1])))];
  return {
    id,
    name,
    level: levelZone ? Number(levelZone[1]) : undefined,
    zone: levelZone?.[2],
    summary: meta.replace(/ A level \d+.*$/, "").trim() || undefined,
    xpByLevel,
    coinByLevel,
    reputation,
    rewardItemIds,
    vendorBuyPrices,
    sourceUrl: `https://www.wowhead.com/forever/quest=${id}`,
    retrievedAt,
  };
}
