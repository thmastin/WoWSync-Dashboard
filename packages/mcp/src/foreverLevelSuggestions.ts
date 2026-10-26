import type { CodexRecord } from "@wowsync-dashboard/core/polestarCodex.ts";

const normalized = (value: unknown) => String(value ?? "").toLocaleLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const NON_DUNGEON_INSTANCES = new Set(["excavation site wetlands", "ruins of lordaeron"]);

export function suggestForeverForLevel(level: number, faction: "Alliance" | "Horde" | undefined, instances: CodexRecord[], quests: CodexRecord[], items: CodexRecord[], npcs: CodexRecord[]) {
  const npcNames = new Map(npcs.map((npc) => [String(npc.id), npc.name ?? "UNKNOWN"]));
  const dungeons = instances.filter((d) => {
    const kind = normalized(d.instanceKind);
    const range = d.levelRange as number[] | undefined;
    if (!(kind.includes("dungeon") || kind === "5 player" || kind === "5 player instance") || kind.includes("raid") || NON_DUNGEON_INSTANCES.has(normalized(d.name)) || !range || range.length < 2 || level < range[0]! || level > range.at(-1)!) return false;
    if (faction === "Alliance" && normalized(d.name) === "ragefire chasm") return false;
    const f = normalized(d.faction);
    return !faction || !f || f === "both" || f === normalized(faction);
  }).map((d) => {
    const range = d.levelRange as number[];
    const linked = quests.flatMap((q) => {
      const zone = String(q.zone ?? "");
      const text = normalized([q.objectives, q.objective, q.objectiveText, q.zoneName].join(" "));
      const qFaction = normalized(q.faction);
      if (faction && qFaction && qFaction !== normalized(faction) && qFaction !== "both" && qFaction !== "0") return [];
      const exact = d.areaId !== undefined && (q.zone !== undefined && zone === String(d.areaId) || q.areaId !== undefined && String(q.areaId) === String(d.areaId));
      const inferred = !exact && (d.map !== undefined && q.zone !== undefined && zone === String(d.map) || !!d.name && !!normalized(d.name) && text.includes(normalized(d.name)) || d.areaId !== undefined && text.includes(normalized(d.areaId)));
      return exact || inferred ? [{ q, provenance: exact ? "REFERENCE" as const : "DERIVED" as const }] : [];
    });
    const giverIds = [...new Set(linked.flatMap(({q}) => (q.startNpc as number[] | undefined) ?? []))];
    return { name: d.name, levelRange: range, questCount: linked.length, questGivers: giverIds.slice(0, 3).map((id) => ({ id, name: npcNames.get(String(id)) ?? "UNKNOWN", linkProvenance: linked.some(({q,provenance}) => (q.startNpc as number[] | undefined)?.includes(id) && provenance === "REFERENCE") ? "REFERENCE" as const : "DERIVED" as const })) };
  }).sort((a, b) => Math.abs((a.levelRange[0]! + a.levelRange.at(-1)!)/2-level) - Math.abs((b.levelRange[0]! + b.levelRange.at(-1)!)/2-level) || String(a.name).localeCompare(String(b.name))).slice(0, 8);
  const notableSources = items.flatMap((item) => ((item.sources as Array<Record<string, unknown>> | undefined) ?? []).flatMap((source) => {
    const min = Number(source.minLevel ?? item.requiredLevel), max = Number(source.maxLevel ?? source.minLevel ?? item.requiredLevel);
    const type = normalized(source.type);
    if (!Number.isFinite(min) || !Number.isFinite(max) || level < min || level > max || !["drop", "quest"].includes(type)) return [];
    if (source.faction && faction && normalized(source.faction) !== normalized(faction) && normalized(source.faction) !== "both") return [];
    return [{ id: item.id, name: item.name, requiredLevel: item.requiredLevel ?? "UNKNOWN", source: type, npc: source.npc, quest: source.quest }];
  })).sort((a, b) => (a.source === "quest" ? 0 : 1) - (b.source === "quest" ? 0 : 1) || Math.abs(Number(a.requiredLevel)-level) - Math.abs(Number(b.requiredLevel)-level) || String(a.name).localeCompare(String(b.name))).slice(0, 10);
  return { level, faction: faction ?? "UNKNOWN", dungeons: dungeons.length ? dungeons : "UNKNOWN", notableSources: notableSources.length ? notableSources : "UNKNOWN" };
}
