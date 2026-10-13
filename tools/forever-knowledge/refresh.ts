// Refreshes the committed Forever game-knowledge dataset (packages/core/src/foreverKnowledgeData.ts).
//
// Source: Wowhead's Forever database (https://www.wowhead.com/forever/...), via its public tooltip
// endpoint (https://nether.wowhead.com/forever/tooltip/<type>/<id>) and quest pages. Only the
// /forever/ data environment is ever requested, so Retail, Classic Era, Anniversary and other
// versions cannot leak in. Auction prices (avgbuyout) are deliberately never ingested.
//
// The IDs to fetch come from what the account has actually observed (equipment, bags, banks,
// learned recipes and their reagents/outputs, active quests) in one Dashboard database opened
// read-only, plus a small seed list of profession tools and inputs. Existing entries are kept;
// pass --force to refetch them.
//
//   node tools/forever-knowledge/refresh.ts --db <wowsync.sqlite> [--force] [--dry-run]
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DashboardReadModel, SqliteSnapshotReadStore } from "../../packages/core/src/index.ts";
import { parseItemTooltip, parseSpellTooltip, parseQuestPage, type ForeverKnowledgeDataset } from "../../packages/core/src/foreverKnowledge.ts";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const OUT = path.join(REPO_ROOT, "packages", "core", "src", "foreverKnowledgeData.ts");
const USER_AGENT = "Mozilla/5.0";

// Profession tools, common inputs and outputs that matter for low-level planning even when no
// character currently carries them.
const SEED_ITEMS = [2901, 5956, 7005, 2770, 2775, 2771, 2835, 2836, 2840, 2841, 2842, 2862, 3470, 2589, 2592, 1251, 2581, 2318, 2319, 783, 2934, 4470, 4471, 159, 117, 2894, 2886, 2888, 2889, 6948];
const SEED_SPELLS = [2575, 2656, 2657, 2659, 2660, 2663, 3115, 3116, 12260, 2661, 2662, 2665, 3275, 3276, 3273, 8613, 2550, 2366, 2108, 3100, 2018, 2259];
const SEED_QUESTS: number[] = [];

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function itemIdFromRef(itemRef: unknown): number | undefined {
  if (typeof itemRef !== "string") return undefined;
  const match = /^item:(\d+)/.exec(itemRef);
  return match ? Number(match[1]) : undefined;
}

function collectIds(dbPath: string) {
  const store = new SqliteSnapshotReadStore(dbPath);
  const readModel = new DashboardReadModel(store);
  const items = new Set<number>(SEED_ITEMS);
  const spells = new Set<number>(SEED_SPELLS);
  const quests = new Set<number>(SEED_QUESTS);
  try {
    for (const character of readModel.listCharacters({ version: "forever" })) {
      const query = { version: "forever" as const, name: character.name, realm: character.realm };
      const equipment = readModel.getCharacterEquipment(query);
      if (equipment.status === "FOUND") for (const slot of (equipment.value.data?.slots ?? []) as Array<{ itemRef?: string }>) { const id = itemIdFromRef(slot.itemRef); if (id) items.add(id); }
      for (const storage of ["bags", "bank"] as const) {
        const contents = readModel.getCharacterStorage({ ...query, storage, limit: 100 });
        if (contents.status === "FOUND") for (const item of (contents.value.data?.items ?? []) as Array<{ itemRef?: string }>) { const id = itemIdFromRef(item.itemRef); if (id) items.add(id); }
      }
      const professions = readModel.getCharacterProfessions(query);
      if (professions.status === "FOUND") {
        const known = professions.value.data?.recipeKnowledge?.data?.professions ?? [];
        for (const profession of known as Array<{ recipes?: Array<Record<string, unknown>> }>) {
          for (const recipe of profession.recipes ?? []) {
            if (recipe.learnedState !== "OBSERVED_TRUE") continue;
            if (typeof recipe.recipeID === "number") spells.add(recipe.recipeID);
            if (typeof recipe.outputItemID === "number") items.add(recipe.outputItemID);
            for (const slot of (recipe.reagentSlots ?? []) as Array<{ reagents?: Array<{ itemID?: number }> }>) for (const reagent of slot.reagents ?? []) if (reagent.itemID) items.add(reagent.itemID);
          }
        }
      }
      const questsRead = readModel.getForeverQuestObservation(query);
      if (questsRead.status === "FOUND") for (const quest of (questsRead.value.data?.active ?? []) as Array<{ questID?: number }>) if (quest.questID) quests.add(quest.questID);
    }
  } finally {
    store.close();
  }
  return { items: [...items].sort((a, b) => a - b), spells: [...spells].sort((a, b) => a - b), quests: [...quests].sort((a, b) => a - b) };
}

async function fetchText(url: string): Promise<string | undefined> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(20_000) });
      if (response.status === 404) return undefined;
      if (response.status === 200) return await response.text();
    } catch { /* retry */ }
    await new Promise((resolve) => setTimeout(resolve, 1_000 * (attempt + 1)));
  }
  return undefined;
}

function loadExisting(): ForeverKnowledgeDataset | undefined {
  if (!existsSync(OUT)) return undefined;
  const text = readFileSync(OUT, "utf8");
  const start = text.indexOf("/*DATA*/");
  const end = text.lastIndexOf("/*END*/");
  if (start < 0 || end < 0) return undefined;
  return JSON.parse(text.slice(start + "/*DATA*/".length, end)) as ForeverKnowledgeDataset;
}

async function main() {
  const dbPath = arg("--db");
  if (!dbPath) throw new Error("--db <path to a WoWSync sqlite database> is required (opened read-only).");
  const force = process.argv.includes("--force");
  const ids = collectIds(dbPath);
  const existing = loadExisting();
  const dataset: ForeverKnowledgeDataset = existing ?? { schema: 1, version: "forever", source: "Wowhead Forever database", sourceBaseUrl: "https://www.wowhead.com/forever/", items: {}, spells: {}, quests: {} };
  console.log(`IDs from account evidence + seeds: ${ids.items.length} items, ${ids.spells.length} spells, ${ids.quests.length} quests`);
  if (process.argv.includes("--dry-run")) return;
  const retrievedAt = new Date().toISOString();
  let fetched = 0;
  for (const id of ids.items) {
    if (!force && dataset.items[id]) continue;
    const json = await fetchText(`https://nether.wowhead.com/forever/tooltip/item/${id}`);
    const parsed = json ? parseItemTooltip(id, JSON.parse(json), retrievedAt) : undefined;
    if (parsed) { dataset.items[id] = parsed; fetched += 1; }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  for (const id of ids.spells) {
    if (!force && dataset.spells[id]) continue;
    const json = await fetchText(`https://nether.wowhead.com/forever/tooltip/spell/${id}`);
    const parsed = json ? parseSpellTooltip(id, JSON.parse(json), retrievedAt) : undefined;
    if (parsed) { dataset.spells[id] = parsed; fetched += 1; }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  for (const id of ids.quests) {
    if (!force && dataset.quests[id]) continue;
    const html = await fetchText(`https://www.wowhead.com/forever/quest=${id}`);
    const parsed = html ? parseQuestPage(id, html, retrievedAt) : undefined;
    if (parsed) { dataset.quests[id] = parsed; fetched += 1; }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  dataset.refreshedAt = retrievedAt;
  const body = JSON.stringify(dataset, (_key, value) => value, 1);
  writeFileSync(OUT, `// GENERATED by tools/forever-knowledge/refresh.ts from the Wowhead Forever database. Do not edit by hand.\n// Forever-only external game knowledge; every record carries its source URL and retrieval time.\nimport type { ForeverKnowledgeDataset } from "./foreverKnowledge.ts";\n\nexport const FOREVER_KNOWLEDGE_DATA: ForeverKnowledgeDataset = /*DATA*/${body}/*END*/;\n`);
  console.log(`Fetched ${fetched} new records; dataset has ${Object.keys(dataset.items).length} items, ${Object.keys(dataset.spells).length} spells, ${Object.keys(dataset.quests).length} quests.`);
}

await main();
