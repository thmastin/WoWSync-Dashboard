// Read-only lookups into the private Forever knowledge bundle (QuestieDB Forever + Wowhead Forever
// tooltips) for MCP clients. Every record carries its source; nothing here reads account state.
import { hasBit, NPC_FLAG, type BundleQuest, type ForeverKnowledgeIndex } from "./foreverKnowledgeBundle.ts";
import type { ForeverTalent } from "./foreverSkills.ts";

export type ForeverKnowledgeKind = "item" | "quest" | "npc" | "spell" | "dungeon" | "zone";
export interface ForeverKnowledgeQuery { kind: ForeverKnowledgeKind; id?: number; name?: string; limit?: number }

const QUESTIE = "QuestieDB Forever (private runtime cache; Forever-only quests are partly covered)";

function factionOf(races: number | undefined): string {
  if (!races) return "both factions";
  const alliance = [1, 4, 8, 64].some((bit) => hasBit(races, bit));
  const horde = [2, 16, 32, 128].some((bit) => hasBit(races, bit));
  return alliance && horde ? "both factions (race-limited)" : alliance ? "Alliance" : horde ? "Horde" : "unknown";
}

function matches<T extends { name: string }>(entries: Array<[number, T]>, name: string, limit: number): Array<[number, T]> {
  const needle = name.trim().toLowerCase();
  const exact = entries.filter(([, entry]) => entry.name.toLowerCase() === needle);
  const partial = entries.filter(([, entry]) => entry.name.toLowerCase() !== needle && entry.name.toLowerCase().includes(needle));
  return [...exact, ...partial.sort((a, b) => a[1].name.length - b[1].name.length)].slice(0, limit);
}

export function lookupForeverKnowledge(index: ForeverKnowledgeIndex | undefined, query: ForeverKnowledgeQuery): Record<string, unknown> {
  if (!index) return { status: "UNAVAILABLE", reason: "No Forever knowledge bundle is installed on this Dashboard." };
  if (query.id === undefined && !query.name) return { status: "INVALID", reason: "Pass id or name." };
  const limit = Math.min(Math.max(query.limit ?? 5, 1), 10);
  const bundle = index.bundle;
  const meta = { builtAt: bundle.builtAt, sources: bundle.sources.map((source) => ({ name: source.name, url: source.url, revision: source.revision, usage: source.usage })) };
  const questName = (id: number) => index.quest(id)?.name ?? `quest ${id}`;
  const itemName = (id: number) => index.item(id)?.name ?? index.tooltipItem(id)?.name ?? `item ${id}`;
  const npcLabel = (id: number) => index.npcLocation(index.npc(id)) ?? `npc ${id}`;

  const describeQuest = (id: number, quest: BundleQuest) => ({
    id, name: quest.name, level: quest.level, requiredLevel: quest.reqLevel, zone: index.zoneName(quest.zone), faction: factionOf(quest.races),
    classLimited: !!quest.classes, startedBy: [...(quest.startNpcs ?? []).slice(0, 3).map(npcLabel), ...(quest.startItem ? [`item ${itemName(quest.startItem)}`] : [])],
    turnInTo: (quest.endNpcs ?? []).slice(0, 3).map(npcLabel), objective: quest.text,
    objectiveItems: (quest.objectiveItems ?? []).slice(0, 8).map(itemName), objectiveCreatures: (quest.objectiveNpcs ?? []).slice(0, 8).map((npc) => index.npc(npc)?.name ?? `npc ${npc}`),
    requiresQuests: [...(quest.preSingle ?? []), ...(quest.preGroup ?? [])].slice(0, 6).map(questName), leadsTo: quest.next ? questName(quest.next) : undefined,
    rewards: (quest.rewardItems ?? []).slice(0, 8).map((item) => ({ id: item, name: itemName(item) })), xp: quest.xp, xpBasis: quest.xp !== undefined ? "Classic-seeded XP table, unverified for Forever" : undefined,
    reputation: quest.rep?.map(([faction, amount]) => ({ factionID: faction, amount })),
    source: `${QUESTIE}; https://www.wowhead.com/forever/quest=${id}`,
  });

  const describeItem = (id: number) => {
    const item = index.item(id); const tooltip = index.tooltipItem(id);
    if (!item && !tooltip) return undefined;
    return {
      id, name: tooltip?.name ?? item?.name, itemLevel: tooltip?.itemLevel ?? item?.ilvl, requiredLevel: tooltip?.requiredLevel ?? item?.reqLevel,
      slot: tooltip?.slot, subtype: tooltip?.subtype, armor: tooltip?.armor, damage: tooltip?.damageMin !== undefined ? `${tooltip.damageMin}-${tooltip.damageMax}` : undefined, speed: tooltip?.speed, dps: tooltip?.dps,
      stats: tooltip?.stats, equip: tooltip?.equipText, use: tooltip?.useText, binding: tooltip?.binding, classes: tooltip?.classes, requiresSkill: tooltip?.requiresSkill,
      vendorSellPriceCopper: tooltip?.sellPriceCopper, vendorBuyPrice: "UNKNOWN", auctionPrice: "UNKNOWN",
      soldBy: (item?.vendors ?? []).slice(0, 6).map((npc) => ({ npc: npcLabel(npc), faction: index.npc(npc)?.friendly })),
      dropsFrom: (item?.dropNpcs ?? []).slice(0, 8).map((npc) => { const n = index.npc(npc); return n ? `${n.name}${n.level ? ` (level ${n.level[0]}-${n.level[1]})` : ""}${n.zone ? ` in ${index.zoneName(n.zone)}` : ""}` : `npc ${npc}`; }),
      questReward: (item?.questRewards ?? []).slice(0, 6).map(questName), startsQuest: item?.startQuest ? questName(item.startQuest) : undefined,
      dropChance: "UNKNOWN",
      source: tooltip ? `Wowhead Forever tooltip ${tooltip.sourceUrl} (retrieved ${tooltip.retrievedAt}); sources from ${QUESTIE}` : QUESTIE,
    };
  };

  const describeNpc = (id: number) => {
    const npc = index.npc(id);
    if (!npc) return undefined;
    const roles = Object.entries(NPC_FLAG).filter(([, bit]) => npc.flags !== undefined && hasBit(npc.flags, bit) && npc.flags !== 0).map(([role]) => role.toLowerCase());
    return {
      id, name: npc.name, title: npc.sub, level: npc.level, location: index.npcLocation(npc), friendlyTo: npc.friendly === undefined ? "UNKNOWN" : npc.friendly.replace("A", "Alliance ").replace("H", "Horde").trim(),
      roles, elite: npc.rank ? npc.rank > 0 : undefined,
      startsQuests: index.questsStartedBy(id).slice(0, 12).map((quest) => ({ id: quest, name: questName(quest), level: index.quest(quest)?.level })),
      sells: index.vendorItems(id).slice(0, 20).map((item) => ({ id: item, name: itemName(item) })), vendorBuyPrices: "UNKNOWN",
      source: QUESTIE,
    };
  };

  const describeSpell = (id: number) => {
    const spell = index.tooltipSpell(id);
    return spell ? { id, name: spell.name, description: spell.description, reagents: spell.reagents.length ? spell.reagents : undefined, tools: spell.tools.length ? spell.tools : undefined, creates: spell.createsItemId ? { id: spell.createsItemId, name: itemName(spell.createsItemId) } : undefined, source: `Wowhead Forever tooltip ${spell.sourceUrl} (retrieved ${spell.retrievedAt})` } : undefined;
  };

  let results: unknown[] = [];
  switch (query.kind) {
    case "item": {
      const ids = query.id !== undefined ? [query.id] : matches([...index.items(), ...Object.entries(bundle.tooltips.items).map(([id, tip]) => [Number(id), tip] as [number, { name: string }]).filter(([id]) => !index.item(id))], query.name!, limit).map(([id]) => id);
      results = ids.flatMap((id) => describeItem(id) ?? []);
      break;
    }
    case "quest": {
      const entries = query.id !== undefined ? (index.quest(query.id) ? [[query.id, index.quest(query.id)!] as [number, BundleQuest]] : []) : matches(index.quests(), query.name!, limit);
      results = entries.map(([id, quest]) => describeQuest(id, quest));
      break;
    }
    case "npc": {
      const ids = query.id !== undefined ? [query.id] : matches(Object.entries(bundle.npcs).map(([id, npc]) => [Number(id), npc] as [number, { name: string }]), query.name!, limit).map(([id]) => id);
      results = ids.flatMap((id) => describeNpc(id) ?? []);
      break;
    }
    case "spell": {
      const ids = query.id !== undefined ? [query.id] : matches(Object.entries(bundle.tooltips.spells).map(([id, spell]) => [Number(id), spell] as [number, { name: string }]), query.name!, limit).map(([id]) => id);
      results = ids.flatMap((id) => describeSpell(id) ?? []);
      break;
    }
    case "dungeon": {
      const all = index.dungeons();
      const picked = query.id !== undefined ? all.filter((entry) => entry.id === query.id) : matches(all.map((entry) => [entry.id, { ...entry, name: entry.dungeon.name }] as [number, typeof entry & { name: string }]), query.name!, limit).map(([, entry]) => entry);
      results = picked.map((entry) => {
        const areas = new Set(entry.dungeon.areas);
        const quests = index.quests().filter(([, quest]) => quest.zone !== undefined && areas.has(quest.zone)).slice(0, 12);
        return {
          id: entry.id, name: entry.dungeon.name, creatureLevels: entry.minLevel !== undefined ? `${entry.minLevel}-${entry.maxLevel}` : "UNKNOWN", levelBasis: "DERIVED: middle 80% of creatures QuestieDB places inside",
          entrance: entry.dungeon.entrance ? { zone: index.zoneName(entry.dungeon.entrance[0]), x: entry.dungeon.entrance[1], y: entry.dungeon.entrance[2] } : undefined,
          quests: quests.map(([id, quest]) => ({ id, name: quest.name, level: quest.level, faction: factionOf(quest.races), startedBy: quest.startNpcs?.[0] !== undefined ? npcLabel(quest.startNpcs[0]) : undefined })),
          source: QUESTIE,
        };
      });
      break;
    }
    case "zone": {
      const zones = Object.entries(bundle.zones).map(([id, name]) => [Number(id), { name }] as [number, { name: string }]);
      const picked = query.id !== undefined ? zones.filter(([id]) => id === query.id) : matches(zones, query.name!, limit);
      results = picked.map(([id, zone]) => {
        const quests = index.quests().filter(([, quest]) => quest.zone === id || (quest.startNpcs?.[0] !== undefined && index.npc(quest.startNpcs[0])?.zone === id));
        const levels = quests.flatMap(([, quest]) => quest.level ?? []).sort((a, b) => a - b);
        return {
          id, name: zone.name, questCount: quests.length, questLevels: levels.length ? `${levels[Math.floor(levels.length * 0.1)]}-${levels[Math.ceil(levels.length * 0.9) - 1]}` : "UNKNOWN",
          quests: quests.sort((a, b) => (a[1].level ?? 0) - (b[1].level ?? 0)).slice(0, 25).map(([questId, quest]) => ({ id: questId, name: quest.name, level: quest.level, faction: factionOf(quest.races) })),
          source: QUESTIE,
        };
      });
      break;
    }
  }
  return { status: results.length ? "FOUND" : "NOT_FOUND", kind: query.kind, results, knowledge: meta, notes: "Game knowledge, not account state. Vendor buy prices, Auction House prices and drop chances are UNKNOWN." };
}

/** Adds the Forever tooltip description (rank 1 text) to each talent that has a known spell. */
export function describeForeverTalents<T extends { trees: Array<{ talents: ForeverTalent[] }> }>(view: T, index: ForeverKnowledgeIndex | undefined): T {
  if (!index) return view;
  return {
    ...view,
    trees: view.trees.map((tree) => ({
      ...tree,
      talents: tree.talents.map((talent) => {
        const spell = index.tooltipSpell(talent.spellID);
        return spell?.description ? { ...talent, description: spell.description, descriptionSource: `${spell.sourceUrl} (rank 1 text)` } : talent;
      }),
    })),
  };
}
