// Routing helpers: zone adjacency (Classic map baseline, labelled unverified for Forever) and quest-hub
// clustering from QuestieDB quest-giver coordinates.

/** Zones that border each other or connect by a normal road/tunnel/boat. Classic map; Forever-only zones are unknown. */
const EDGES: Array<[string, string]> = [
  ["Mulgore", "The Barrens"], ["Mulgore", "Thunder Bluff"], ["Durotar", "The Barrens"], ["Durotar", "Orgrimmar"],
  ["The Barrens", "Stonetalon Mountains"], ["The Barrens", "Ashenvale"], ["The Barrens", "Dustwallow Marsh"], ["The Barrens", "Thousand Needles"],
  ["Teldrassil", "Darnassus"], ["Teldrassil", "Darkshore"], ["Darkshore", "Ashenvale"], ["Ashenvale", "Stonetalon Mountains"],
  ["Ashenvale", "Azshara"], ["Ashenvale", "Felwood"], ["Stonetalon Mountains", "Desolace"], ["Desolace", "Feralas"],
  ["Thousand Needles", "Feralas"], ["Thousand Needles", "Tanaris"], ["Tanaris", "Un'Goro Crater"], ["Un'Goro Crater", "Silithus"],
  ["Felwood", "Winterspring"], ["Felwood", "Moonglade"],
  ["Elwynn Forest", "Stormwind City"], ["Elwynn Forest", "Westfall"], ["Elwynn Forest", "Redridge Mountains"], ["Elwynn Forest", "Duskwood"],
  ["Westfall", "Duskwood"], ["Duskwood", "Stranglethorn Vale"], ["Duskwood", "Deadwind Pass"], ["Redridge Mountains", "Burning Steppes"],
  ["Redridge Mountains", "Swamp of Sorrows"], ["Deadwind Pass", "Swamp of Sorrows"], ["Swamp of Sorrows", "Blasted Lands"],
  ["Dun Morogh", "Ironforge"], ["Dun Morogh", "Loch Modan"], ["Loch Modan", "Wetlands"], ["Loch Modan", "Badlands"],
  ["Loch Modan", "Searing Gorge"], ["Badlands", "Searing Gorge"], ["Searing Gorge", "Burning Steppes"], ["Wetlands", "Arathi Highlands"],
  ["Arathi Highlands", "Hillsbrad Foothills"], ["Arathi Highlands", "The Hinterlands"], ["Hillsbrad Foothills", "Silverpine Forest"],
  ["Hillsbrad Foothills", "Alterac Mountains"], ["Silverpine Forest", "Tirisfal Glades"], ["Tirisfal Glades", "Undercity"],
  ["Tirisfal Glades", "Western Plaguelands"], ["Western Plaguelands", "Eastern Plaguelands"], ["Alterac Mountains", "Western Plaguelands"],
];
const NEIGHBORS = new Map<string, Set<string>>();
for (const [a, b] of EDGES) {
  if (!NEIGHBORS.has(a)) NEIGHBORS.set(a, new Set());
  if (!NEIGHBORS.has(b)) NEIGHBORS.set(b, new Set());
  NEIGHBORS.get(a)!.add(b); NEIGHBORS.get(b)!.add(a);
}
export const ZONE_ADJACENCY_NOTE = "Classic zone connections, not verified for Forever";

/** Steps between two zones on the adjacency graph; undefined when either zone is not in it. */
export function zoneDistance(from: string | undefined, to: string | undefined): number | undefined {
  if (!from || !to) return undefined;
  if (from === to) return 0;
  if (!NEIGHBORS.has(from) || !NEIGHBORS.has(to)) return undefined;
  const seen = new Set([from]);
  let frontier = [from];
  for (let depth = 1; frontier.length && depth <= 8; depth += 1) {
    const next: string[] = [];
    for (const zone of frontier) for (const neighbor of NEIGHBORS.get(zone) ?? []) {
      if (neighbor === to) return depth;
      if (!seen.has(neighbor)) { seen.add(neighbor); next.push(neighbor); }
    }
    frontier = next;
  }
  return undefined;
}

export interface QuestHub<T> { zone: string; center?: [number, number]; givers: string[]; items: T[] }

/** Groups quests by zone, then by quest-giver position (within about 7 map units) into hubs. */
export function questHubs<T>(entries: Array<{ zone?: string; coord?: [number, number]; giver?: string; item: T }>, radius = 7): Array<QuestHub<T>> {
  const hubs: Array<QuestHub<T> & { points: Array<[number, number]> }> = [];
  for (const entry of entries) {
    const zone = entry.zone ?? "Unknown zone";
    const hub = entry.coord ? hubs.find((candidate) => candidate.zone === zone && candidate.center && Math.hypot(candidate.center[0] - entry.coord![0], candidate.center[1] - entry.coord![1]) <= radius) : hubs.find((candidate) => candidate.zone === zone && !candidate.center);
    if (hub) {
      hub.items.push(entry.item);
      if (entry.giver && !hub.givers.includes(entry.giver)) hub.givers.push(entry.giver);
      if (entry.coord) { hub.points.push(entry.coord); hub.center = [hub.points.reduce((sum, point) => sum + point[0], 0) / hub.points.length, hub.points.reduce((sum, point) => sum + point[1], 0) / hub.points.length]; }
    } else hubs.push({ zone, center: entry.coord, givers: entry.giver ? [entry.giver] : [], items: [entry.item], points: entry.coord ? [entry.coord] : [] });
  }
  return hubs.map(({ points: _points, ...hub }) => hub);
}

export function hubLabel(hub: QuestHub<unknown>): string {
  return `${hub.zone}${hub.center ? ` around (${hub.center[0].toFixed(0)}, ${hub.center[1].toFixed(0)})` : ""}${hub.givers.length ? `, ${hub.givers.slice(0, 2).join(" and ")}` : ""}`;
}
