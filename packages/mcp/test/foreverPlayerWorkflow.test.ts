// End-to-end Forever co-pilot workflow over the real STDIO MCP server: a
// multi-character Forever account on a future (unverified) client build,
// with a crafter whose latest export missed the profession panel and bank,
// a separate miner holding materials, and a same-named Classic Era twin.
// Fixtures are relative to the wall clock so freshness stays "recent".
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { SqliteSnapshotStore } from "@wowsync-dashboard/core";
import { buildWowSyncExport } from "../../core/test/fixtureBuilder.ts";

const packageRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const entrypoint = path.join(packageRoot, "src", "index.ts");
const REALM = "Forever Launch";
const LAUNCH = { clientFamily: "Forever", clientVersion: "1.61.0", clientBuild: "71234", interface: "16100" };
const PROFILE = "Forever:1.61.0:71234:16100";
const bar = (qty: number) => ({ itemRef: "item:2840::::::::10:1491:::::::::", name: "Copper Bar", qty });

function structured<T>(result: { isError?: boolean; structuredContent?: unknown }): T {
  assert.equal(result.isError, undefined, JSON.stringify(result).slice(0, 600));
  return result.structuredContent as T;
}

function recipes(observedAt: number) {
  const recipe = (recipeID: number, name: string, outputItemID: number, equipLocation: string, quantity: number) => ({
    recipeID, name, learned: true, learnedState: "OBSERVED_TRUE", evidence: "OBSERVED", observedAt, outputItemID,
    outputItemInfo: { state: "OBSERVED", itemID: outputItemID, itemType: "Armor", itemSubType: "Mail", equipLocation },
    reagentSlots: [{ required: true, reagents: [{ itemID: 2840 }], quantityRequired: quantity }],
  });
  return { observedAt, completeness: "partial", data: {
    formatVersion: 1, ownerScope: "CHARACTER", coverage: { state: "PARTIAL", candidateCompleteness: "UNKNOWN", returnedRecipeCount: 2 },
    professions: [{ baseSkillLineID: 164, skillLineID: 2938, professionName: "Blacksmithing", evidence: "OBSERVED", observedAt, recipes: [
      recipe(2663, "Copper Bracers", 2853, "INVTYPE_WRIST", 2), recipe(12260, "Rough Copper Vest", 10421, "INVTYPE_CHEST", 4),
    ] }],
  } };
}

test("FOREVER WORKFLOW: a multi-character launch-build account answers crafting, materials, and storage questions honestly over MCP", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wowsync-forever-workflow-"));
  const databasePath = path.join(dir, "fixture.sqlite");
  const now = Math.floor(Date.now() / 1000);
  const smith = { name: "Smith", realm: REALM, class: "Warrior", level: 8, ...LAUNCH };
  const writer = new SqliteSnapshotStore(databasePath);
  try {
    // Export 1: profession panel and bank open.
    const t1 = now - 3_000;
    writer.importSnapshot(buildWowSyncExport({ generatedAt: t1, character: smith, professions: { entries: [{ name: "Blacksmithing", skill: 10, maxSkill: 75 }, { name: "Mining", skill: 15, maxSkill: 75 }] },
      bags: { containers: [{ id: 0, capacity: 16, items: [bar(1)] }] }, bank: { containers: [{ id: -1, capacity: 24, items: [bar(10)] }] } }),
    { foreverGearObservation: { clientProfile: PROFILE, name: "Smith", realm: REALM, generatedAt: t1, sourceCharacterGuid: "Player-1-SMITH", professionRecipes: recipes(t1 - 5) } });
    // Export 2 (latest): no profession panel, bank not opened, fresh complete bags.
    const t2 = now - 60;
    writer.importSnapshot(buildWowSyncExport({ generatedAt: t2, character: smith, professions: { entries: [{ name: "Blacksmithing", skill: 12, maxSkill: 75 }, { name: "Mining", skill: 18, maxSkill: 75 }] },
      bags: { containers: [{ id: 0, capacity: 16, items: [bar(3)] }] }, bank: { unknown: true } }),
    { foreverGearObservation: { clientProfile: PROFILE, name: "Smith", realm: REALM, generatedAt: t2, sourceCharacterGuid: "Player-1-SMITH" } });
    // A separate miner on the same realm.
    writer.importSnapshot(buildWowSyncExport({ generatedAt: now - 120, character: { name: "Miner", realm: REALM, class: "Rogue", level: 6, ...LAUNCH },
      professions: { entries: [{ name: "Mining", skill: 40, maxSkill: 75 }] }, bags: { containers: [{ id: 0, capacity: 16, items: [bar(20)] }] }, bank: { unknown: true } }));
    // A same-named Classic Era character is a different identity.
    writer.importSnapshot(buildWowSyncExport({ generatedAt: now - 100, character: { name: "Smith", realm: REALM, class: "Warrior", level: 40, clientVersion: "1.15.9", clientBuild: "69547" },
      professions: { entries: [{ name: "Blacksmithing", skill: 200, maxSkill: 225 }] } }));
  } finally {
    writer.close();
  }
  const before = createHash("sha256").update(readFileSync(databasePath)).digest("hex");

  const client = new Client({ name: "wowsync-forever-workflow-test", version: "0.1.0" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [entrypoint], cwd: packageRoot, env: { ...process.env, WOWSYNC_MCP_DB_PATH: databasePath }, stderr: "pipe" });
  try {
    await client.connect(transport);
    const call = async <T>(name: string, args: Record<string, unknown>) => structured<T>(await client.callTool({ name, arguments: args }));

    // "Which characters do I have?" — Forever only, no Classic twin.
    const roster = await call<{ characters?: Array<{ name: string }> } | Array<{ name: string }>>("list_characters", { version: "forever" });
    const names = (Array.isArray(roster) ? roster : roster.characters ?? []).map((row) => row.name).sort();
    assert.deepEqual(names, ["Miner", "Smith"]);

    // "Which recipes does Smith know?" — LAST_SEEN from export 1, never current.
    const professions = await call<{ status: string; value: { data: { recipeKnowledge: { status: { state: string }; evidence: { sourceSnapshotId: number } } } } }>("get_character_professions", { version: "forever", name: "Smith" });
    assert.equal(professions.value.data.recipeKnowledge.status.state, "LAST_SEEN");

    // "Who can make Copper Bracers?" — Smith (LAST_SEEN); Miner has no capture, not "cannot".
    const crafters = await call<{ data: { learned: Array<{ name: string; recipe: { evidence: string } }>; charactersWithoutRecipeEvidence: Array<{ name: string }> } }>("find_recipe_crafters", { version: "forever", outputItemID: 2853 });
    assert.deepEqual(crafters.data.learned.map((row) => [row.name, row.recipe.evidence]), [["Smith", "LAST_SEEN"]]);
    assert.deepEqual(crafters.data.charactersWithoutRecipeEvidence.map((row) => row.name), ["Miner"]);

    // "Can Smith craft the vest? Where are the bars?" — 3 carried < 4 needed; bank LAST_SEEN 10; Miner holds 20 separately.
    const reagents = await call<{ status: string; value: { data: { craftability: string; reagents: Array<{ perAlternative: Array<{ carriedConclusion: string; holdings: Array<{ ownerScope: string; name: string; state: string; quantity?: number; usableForCraftingWithoutMove: boolean | string }> }> }> } } }>("get_recipe_reagent_availability", { version: "forever", name: "Smith", recipeID: 12260 });
    const copper = reagents.value.data.reagents[0]!.perAlternative[0]!;
    assert.equal(reagents.value.data.craftability, "NOT_ESTABLISHED");
    assert.equal(copper.carriedConclusion, "INSUFFICIENT_IN_COMPLETE_CURRENT_BAGS");
    const holding = (owner: string, name: string) => copper.holdings.find((row) => row.ownerScope === owner && row.name === name);
    assert.deepEqual([holding("CRAFTER_BAGS", "Smith")?.state, holding("CRAFTER_BAGS", "Smith")?.quantity], ["OBSERVED", 3]);
    assert.deepEqual([holding("CRAFTER_BANK", "Smith")?.state, holding("CRAFTER_BANK", "Smith")?.quantity], ["LAST_SEEN", 10], "the earlier bank observation is kept, labelled historical");
    assert.deepEqual([holding("OTHER_CHARACTER", "Miner")?.quantity, holding("OTHER_CHARACTER", "Miner")?.usableForCraftingWithoutMove], [20, false]);

    // "Where is my Copper Bar across the account?" — search agrees with the reagent view.
    const search = await call<{ data: { items: Array<{ item: { locations: Array<{ name?: string; characterName?: string; identityKey: string; storage: string; state: string }> } }> } }>("search_items", { version: "forever", query: "Copper Bar" });
    const locations = search.data.items.flatMap((row) => row.item.locations).map((row) => `${row.identityKey}|${row.storage}|${row.state}`).sort();
    assert.ok(locations.includes("forever::forever launch::smith|bank|LAST_SEEN"), locations.join(","));
    assert.ok(locations.includes("forever::forever launch::miner|bags|OBSERVED"), locations.join(","));

    // "What can Smith craft as gear?" — launch build accepted, labelled unverified; upgrades stay UNKNOWN.
    const assessment = await call<{ value: { data: { snapshot: { buildVerification: string }; recipeEvidence: { state: string }; candidates: Array<{ recipe: { recipeID: number }; crafting: { state: string }; upgradeConclusion: { state: string } }> } } }>("get_forever_crafted_upgrade_assessment", { version: "forever", name: "Smith", realm: REALM });
    assert.equal(assessment.value.data.snapshot.buildVerification, "UNVERIFIED_BUILD");
    assert.equal(assessment.value.data.recipeEvidence.state, "LAST_SEEN");
    assert.deepEqual(assessment.value.data.candidates.map((row) => [row.recipe.recipeID, row.crafting.state, row.upgradeConclusion.state]), [[2663, "NOT_ESTABLISHED", "UNKNOWN"], [12260, "BLOCKED_BY_OBSERVED_REAGENTS", "UNKNOWN"]]);

    // Version isolation: the Classic Era twin never gets Forever recipes.
    const era = await call<{ data: { learned: unknown[]; charactersWithoutRecipeEvidence: Array<{ name: string }> } }>("find_recipe_crafters", { version: "classic-era", outputItemID: 2853 });
    assert.deepEqual(era.data.learned, []);
    assert.deepEqual(era.data.charactersWithoutRecipeEvidence.map((row) => row.name), ["Smith"], "the Classic twin has no recipe capture: UNKNOWN, not unable");
  } finally {
    await client.close();
  }
  assert.equal(createHash("sha256").update(readFileSync(databasePath)).digest("hex"), before, "the MCP workflow is read-only");
  rmSync(dir, { recursive: true, force: true });
});
