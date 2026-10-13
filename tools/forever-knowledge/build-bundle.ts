// Builds the private Forever knowledge bundle used by the co-pilot at runtime.
//
//   node tools/forever-knowledge/build-bundle.ts --questie <QuestieDB checkout> --out <bundle.json>
//        [--db <wowsync.sqlite> | --observed-url <Dashboard origin>] [--cache <dir>] [--max-req-level 22] [--offline]
//
// Inputs and their terms:
//   - QuestieDB (https://github.com/Questie/QuestieDB) data/Forever and support/Forever. The repository
//     publishes no license, so the output is a private runtime cache: do not commit or redistribute it.
//   - Wowhead Forever tooltip API (nether.wowhead.com/forever/tooltip/...), one ID per request,
//     ~3 requests/second, cached under --cache so reruns only fetch new IDs. www.wowhead.com pages are
//     not fetched (its robots policy excludes AI agents). Auction prices are never stored.
//   - Optional: a WoWSync database (read-only) to add every ID the account has observed.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { DashboardReadModel, SqliteSnapshotReadStore, collectForeverObservedIds } from "../../packages/core/src/index.ts";
import { luaArray, parseQuestieDataBlock, type LuaTable, type LuaValue } from "../../packages/core/src/luaLiteral.ts";
import { parseItemTooltip, parseSpellTooltip, type ForeverItemKnowledge, type ForeverSpellKnowledge } from "../../packages/core/src/foreverKnowledge.ts";
import type { BundleItem, BundleNpc, BundleObject, BundleQuest, ForeverKnowledgeBundle } from "../../packages/core/src/foreverKnowledgeBundle.ts";

const arg = (name: string) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; };
const questieRoot = arg("--questie");
const out = arg("--out");
if (!questieRoot || !out) throw new Error("--questie <QuestieDB checkout> and --out <bundle.json> are required");
const cacheDir = arg("--cache") ?? path.join(path.dirname(out), "forever-tooltip-cache");
const maxReqLevel = Number(arg("--max-req-level") ?? 22);
const offline = process.argv.includes("--offline");
mkdirSync(cacheDir, { recursive: true });

// Classic recipe spell IDs used only as lookup seeds; each is kept only if the Forever database has it,
// and every value used comes from the Forever record, not from Classic.
const RECIPE_SEEDS: Record<string, number[]> = {
  Leatherworking: [2881, 2149, 2152, 2153, 3753, 7126, 9058, 9059, 2160, 2161, 2162, 3756, 3816, 2163, 2164, 2158, 2159, 3763, 3759, 9065, 2165, 2166, 2167, 3760, 3761, 9064, 9068, 3762, 5244, 3817, 9070, 9072, 9074],
  Tailoring: [2387, 2963, 2385, 12044, 3914, 2386, 3915, 7623, 7624, 8776, 3755, 12045, 2392, 2393, 2389, 2394, 2397, 3841, 3840, 2395, 2396, 3842, 12046, 8465, 2964, 3843, 3845, 3847, 3848, 6686, 3850, 3852],
  Alchemy: [2330, 2329, 3170, 7183, 2331, 2332, 2334, 2337, 3171, 7836, 2335, 3172, 7179, 3173, 2333, 3176, 3447, 7255, 7256],
  "First Aid": [3275, 3276, 3277, 3278, 7928, 7929],
  Cooking: [2538, 2540, 2795, 8604, 6412, 2541, 6413, 7751, 2542, 6499, 3371, 2544, 2546, 6414, 2545, 2547, 6415, 3370, 2539],
  Engineering: [3918, 3919, 3920, 3922, 3923, 3925, 3977, 3926, 3929, 3928, 3924, 3930, 3931, 3932, 3936, 3937, 3938, 3939, 3966, 3940],
  Blacksmithing: [2660, 2663, 3115, 12260, 2661, 2662, 2664, 2665, 2666, 2667, 2737, 2738, 2739, 2740, 2741, 3116, 3292, 3293, 3294, 3319, 3320, 3321, 3323, 3324, 3325, 3326, 7408, 7817, 7818, 8880, 9983, 9985, 9986, 9987],
  Mining: [2575, 2656, 2657, 2658, 3304, 2659],
  Herbalism: [2366],
  Skinning: [8613],
};

const dataDir = path.join(questieRoot, "data", "Forever");
const read = (file: string) => readFileSync(path.join(dataDir, file), "utf8");
const num = (value: LuaValue | undefined) => typeof value === "number" ? value : undefined;
const nums = (value: LuaValue | undefined): number[] | undefined => { const list = luaArray(value).filter((entry): entry is number => typeof entry === "number"); return list.length ? list : undefined; };
const firstOf = (value: LuaValue | undefined) => luaArray(value).map((entry) => typeof entry === "object" && entry ? luaArray(entry)[0] : entry).filter((entry): entry is number => typeof entry === "number");
const drop = <T extends object>(object: T): T => { for (const key of Object.keys(object) as Array<keyof T>) if (object[key] === undefined) delete object[key]; return object; };

console.log("Parsing QuestieDB Forever data...");
const questRaw = parseQuestieDataBlock(read("foreverQuestDB.lua"), "QuestieDB.questData");
const itemRaw = parseQuestieDataBlock(read("foreverItemDB.lua"), "QuestieDB.itemData");
const npcRaw = parseQuestieDataBlock(read("foreverNpcDB.lua"), "QuestieDB.npcData");
const objectRaw = parseQuestieDataBlock(read("foreverObjectDB.lua"), "QuestieDB.objectData");

const xpByQuest = new Map<number, number>();
const xpFile = path.join(questieRoot, "support", "Forever", "QuestXP", "xpDB-classic.lua");
if (existsSync(xpFile)) for (const match of readFileSync(xpFile, "utf8").matchAll(/\[(\d+)\] = \{(-?\d+), (\d+)\}/g)) xpByQuest.set(Number(match[1]), Number(match[3]));
const zones: Record<string, string> = {};
const zoneFile = path.join(questieRoot, "support", "Forever", "Zones", "areaIdToUiMapId.lua");
if (existsSync(zoneFile)) for (const match of readFileSync(zoneFile, "utf8").matchAll(/\[(\d+)\] = \d+, -- ([^\r\n]+)/g)) zones[match[1]] = (match[2].split(" -> ")[1] ?? match[2]).trim();

const quests: Record<string, BundleQuest> = {};
for (const [id, raw] of Object.entries(questRaw)) {
  const q = luaArray(raw);
  const started = luaArray(q[1]);
  const objectives = luaArray(q[9]);
  quests[id] = drop({
    name: String(q[0]),
    reqLevel: num(q[3]), level: num(q[4]), races: num(q[5]), classes: num(q[6]),
    text: luaArray(q[7]).filter((line) => typeof line === "string").join(" ") || undefined,
    objectiveNpcs: objectives[0] ? firstOf(objectives[0]) : undefined,
    objectiveItems: objectives[2] ? firstOf(objectives[2]) : undefined,
    startNpcs: nums(started[0]), startObjects: nums(started[1]), startItem: nums(started[2])?.[0],
    endNpcs: nums(luaArray(q[2])[0]),
    preGroup: nums(q[11]), preSingle: nums(q[12]), exclusiveTo: nums(q[15]),
    zone: num(q[16]),
    reqSkill: (() => { const skill = luaArray(q[17]); return typeof skill[0] === "number" && typeof skill[1] === "number" ? [skill[0], skill[1]] as [number, number] : undefined; })(),
    next: num(q[21]), special: num(q[23]),
    rep: (() => { const list = luaArray(q[25]).map((pair) => luaArray(pair)).filter((pair) => typeof pair[0] === "number" && typeof pair[1] === "number").map((pair) => [pair[0], pair[1]] as [number, number]); return list.length ? list : undefined; })(),
    breadcrumbFor: num(q[26]), maxLevel: num(q[31]),
    xp: xpByQuest.get(Number(id)),
  });
}
const items: Record<string, BundleItem> = {};
for (const [id, raw] of Object.entries(itemRaw)) {
  const r = luaArray(raw);
  const drops = nums(r[1]);
  items[id] = drop({ name: String(r[0]), dropNpcs: drops && drops.length <= 25 ? drops : drops?.slice(0, 25), dropObjects: nums(r[2])?.slice(0, 25), startQuest: num(r[4]), questRewards: nums(r[5]), ilvl: num(r[8]), reqLevel: num(r[9]), cls: num(r[11]), sub: num(r[12]), vendors: nums(r[13]) });
  for (const questId of items[id].questRewards ?? []) { const quest = quests[String(questId)]; if (quest) (quest.rewardItems ??= []).push(Number(id)); }
}
const npcs: Record<string, BundleNpc> = {};
for (const [id, raw] of Object.entries(npcRaw)) {
  const r = luaArray(raw);
  const spawns = r[6] && typeof r[6] === "object" ? r[6] as LuaTable : undefined;
  const firstZone = spawns ? Object.keys(spawns)[0] : undefined;
  const firstCoord = firstZone ? luaArray(luaArray(spawns![firstZone])[0]) : [];
  npcs[id] = drop({ name: String(r[0]), level: typeof r[3] === "number" && typeof r[4] === "number" ? [r[3], r[4]] as [number, number] : undefined, zone: num(r[8]) ?? (firstZone ? Number(firstZone) : undefined), coord: typeof firstCoord[0] === "number" && typeof firstCoord[1] === "number" ? [firstCoord[0], firstCoord[1]] as [number, number] : undefined, friendly: typeof r[12] === "string" ? r[12] : undefined, sub: typeof r[13] === "string" ? r[13] : undefined, flags: num(r[14]), rank: num(r[5]) });
}
const objects: Record<string, BundleObject> = {};
for (const [id, raw] of Object.entries(objectRaw)) {
  const r = luaArray(raw);
  const spawns = r[3] && typeof r[3] === "object" ? Object.keys(r[3] as LuaTable).map(Number) : undefined;
  objects[id] = drop({ name: String(r[0]), zones: spawns?.length ? spawns.slice(0, 12) : undefined });
}
// Dungeons: "[area] = {"Name",{alt areas}|nil,parentZone,{{zone, x, y},...}}," rows from QuestieDB's zone table.
const dungeons: ForeverKnowledgeBundle["dungeons"] = {};
const dungeonFile = path.join(questieRoot, "support", "Forever", "Zones", "dungeons.lua");
if (existsSync(dungeonFile)) for (const match of readFileSync(dungeonFile, "utf8").matchAll(/^\s*\[(\d+)\] = \{"([^"]+)",(\{[^}]*\}|nil),(\d+),\{\{(\d+), ([\d.]+), ([\d.]+)\}/gm)) {
  const alternatives = match[3] === "nil" ? [] : match[3].replace(/[{}]/g, "").split(",").map(Number).filter(Number.isFinite);
  dungeons[match[1]] = { name: match[2], areas: [Number(match[1]), ...alternatives], parentZone: Number(match[4]), entrance: [Number(match[5]), Number(match[6]), Number(match[7])] };
}
console.log(`QuestieDB: ${Object.keys(dungeons).length} dungeons, ${Object.keys(quests).length} quests, ${Object.keys(items).length} items, ${Object.keys(npcs).length} npcs, ${Object.keys(objects).length} objects, ${xpByQuest.size} quest XP rows, ${Object.keys(zones).length} zones`);

// ---- Tooltip targets
const itemTargets = new Set<number>();
const spellTargets = new Set<number>(Object.values(RECIPE_SEEDS).flat());
// Raw materials the co-pilot values for gathering advice (leather, ore/stone, herbs) and common vendor reagents.
for (const id of [2934, 783, 2318, 4232, 2319, 4234, 2770, 2835, 2771, 2836, 2775, 774, 1210, 818, 2840, 2841, 3576, 2447, 765, 2449, 785, 2450, 2452, 2453, 3820, 3355, 2589, 2592, 2320, 2321, 3371, 2324, 4340, 2880, 6260, 2901, 5956, 7005]) itemTargets.add(id);
for (const [id, item] of Object.entries(items)) {
  if ((item.cls === 2 || item.cls === 4) && (item.reqLevel ?? 0) <= maxReqLevel && (item.questRewards || item.vendors || (item.dropNpcs && item.dropNpcs.length <= 12))) itemTargets.add(Number(id));
  if (item.cls === 9 && (item.ilvl ?? 0) <= 40) itemTargets.add(Number(id));
}
const dbPath = arg("--db");
const observedUrl = arg("--observed-url");
const addObserved = (ids: { items: number[]; spells: number[]; quests: number[] }) => { for (const id of ids.items) itemTargets.add(id); for (const id of ids.spells) spellTargets.add(id); };
if (dbPath) {
  const store = new SqliteSnapshotReadStore(dbPath);
  try { addObserved(collectForeverObservedIds(new DashboardReadModel(store) as never)); } finally { store.close(); }
}
if (observedUrl) {
  const response = await fetch(new URL("/api/versions/forever/knowledge/observed-ids", observedUrl), { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`observed-ids request failed: HTTP ${response.status}`);
  addObserved(await response.json() as { items: number[]; spells: number[]; quests: number[] });
}

// ---- Fetch with cache
let fetched = 0, cached = 0, missing = 0;
async function tooltip(kind: "item" | "spell", id: number): Promise<{ name?: string; quality?: number; tooltip?: string } | undefined> {
  const file = path.join(cacheDir, `${kind}-${id}.json`);
  if (existsSync(file)) { cached += 1; const text = readFileSync(file, "utf8"); return text === "null" ? undefined : JSON.parse(text); }
  if (offline) return undefined;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(`https://nether.wowhead.com/forever/tooltip/${kind}/${id}`, { headers: { "user-agent": "Mozilla/5.0 (WoWSync personal knowledge cache)" }, signal: AbortSignal.timeout(20_000) });
      await new Promise((resolve) => setTimeout(resolve, 330));
      if (response.status === 404) { writeFileSync(file, "null"); missing += 1; return undefined; }
      if (response.ok) {
        const body = await response.json() as { name?: string; error?: string };
        if (body.error || !body.name) { writeFileSync(file, "null"); missing += 1; return undefined; }
        writeFileSync(file, JSON.stringify(body)); fetched += 1; return body;
      }
      if (response.status === 429) await new Promise((resolve) => setTimeout(resolve, 15_000));
    } catch { await new Promise((resolve) => setTimeout(resolve, 2_000 * (attempt + 1))); }
  }
  return undefined;
}

const tooltipItems: Record<string, ForeverItemKnowledge> = {};
const tooltipSpells: Record<string, ForeverSpellKnowledge> = {};
const retrievedAt = new Date().toISOString();
const spellList = [...spellTargets];
console.log(`Tooltips: ${itemTargets.size} items, ${spellList.length} spells (cache ${cacheDir})`);
for (const id of spellList) {
  const payload = await tooltip("spell", id);
  const parsed = payload ? parseSpellTooltip(id, payload, retrievedAt) : undefined;
  if (parsed) { tooltipSpells[id] = parsed; if (parsed.createsItemId) itemTargets.add(parsed.createsItemId); for (const reagent of parsed.reagents) itemTargets.add(reagent.itemId); }
}
let progress = 0;
for (const id of itemTargets) {
  const payload = await tooltip("item", id);
  const parsed = payload ? parseItemTooltip(id, payload, retrievedAt) : undefined;
  if (parsed) tooltipItems[id] = parsed;
  progress += 1;
  if (progress % 200 === 0) console.log(`  items ${progress}/${itemTargets.size} (fetched ${fetched}, cached ${cached}, missing ${missing})`);
}

const recipesByProfession: Record<string, number[]> = {};
for (const [profession, ids] of Object.entries(RECIPE_SEEDS)) recipesByProfession[profession] = ids.filter((id) => tooltipSpells[id]);
const recipeItems: ForeverKnowledgeBundle["recipeItems"] = {};
for (const [id, item] of Object.entries(tooltipItems)) {
  const source = items[id];
  if (source?.cls !== 9 || !item.requiresSkill) continue;
  recipeItems[id] = { profession: item.requiresSkill.name, skill: item.requiresSkill.level, teaches: item.name.replace(/^(Pattern|Plans|Recipe|Schematic|Formula|Manual): /, "") };
}

let questieRevision: string | undefined;
try { questieRevision = readFileSync(path.join(questieRoot, ".git", "HEAD"), "utf8").trim(); if (questieRevision.startsWith("ref:")) questieRevision = readFileSync(path.join(questieRoot, ".git", questieRevision.slice(5).trim()), "utf8").trim(); } catch { /* unknown */ }

const bundle: ForeverKnowledgeBundle = {
  schema: 2, version: "forever", builtAt: retrievedAt,
  sources: [
    { id: "questie", name: "QuestieDB Forever data", url: "https://github.com/Questie/QuestieDB", revision: questieRevision, usage: "Quests, quest chains, givers, item sources (quest rewards, vendors, drops), NPC locations and faction, zones. No published license: private cache, not redistributed.", confidence: "FOREVER_COMMUNITY_DATABASE" },
    { id: "questie-xp", name: "QuestieDB quest XP (Classic seed)", url: "https://github.com/Questie/QuestieDB", revision: questieRevision, usage: "Quest experience. Seeded from Classic Era; spot checks match Wowhead Forever (e.g. quest 384: 630 XP).", confidence: "CLASSIC_SEED_UNVERIFIED" },
    { id: "wowhead-forever", name: "Wowhead Forever tooltips", url: "https://www.wowhead.com/forever/", usage: "Item stats, slots, required level, vendor sell price; recipe reagents, tools and outputs; pattern skill requirements.", confidence: "FOREVER_DATABASE" },
  ],
  zones, quests, items, npcs, objects, dungeons,
  tooltips: { items: tooltipItems, spells: tooltipSpells },
  recipesByProfession, recipeItems,
};
writeFileSync(out, JSON.stringify(bundle));
console.log(`Wrote ${out}: ${Object.keys(tooltipItems).length} item tooltips, ${Object.keys(tooltipSpells).length} spell tooltips, ${Object.keys(recipeItems).length} recipe items; fetched ${fetched}, cached ${cached}, missing ${missing}.`);
