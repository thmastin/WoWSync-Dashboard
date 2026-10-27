import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { test } from "node:test";
import { SqliteSnapshotStore } from "@wowsync-dashboard/core";
import { importPolestarCodex, parsePolestarCodexFiles } from "@wowsync-dashboard/core/polestarCodex.ts";
import { buildWowSyncExport } from "../../core/test/fixtureBuilder.ts";

const root = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const entrypoint = path.join(root, "packages", "mcp", "src", "index.ts");
const packageRoot = path.join(root, "packages", "mcp");
const foreverNames = ["lookup_item_sources", "lookup_npc", "lookup_dungeon", "suggest_for_level", "analyze_retail_gear_candidate", "ask_forever_copilot", "find_recipe_crafters", "get_account_changes", "get_account_currencies", "get_account_overview", "get_allocation_review", "get_character_bags", "get_character_changes", "get_character_currencies", "get_character_equipment", "get_character_history", "get_character_professions", "get_character_progression", "get_character_quests", "get_character_spells", "get_character_state", "get_character_storage", "get_character_summary", "get_character_trainer", "get_erp_change_proposal", "get_erp_change_proposals", "get_erp_operations_context", "get_erp_project", "get_erp_projects", "get_forever_character_quests", "get_forever_crafted_upgrade_assessment", "get_forever_gear_allocation", "get_forever_gear_observation", "get_forever_items", "get_forever_mail_plan", "get_forever_market_prices", "get_gear_candidate_evidence", "get_gear_candidate_recipient_screen", "get_item_allocation", "get_item_metadata", "get_planned_professions", "get_profession_coverage", "get_recipe_reagent_availability", "get_renown", "get_research_document", "get_research_section", "get_shared_storage", "list_characters", "list_forever_characters", "list_research_documents", "list_versions", "lookup_forever_knowledge", "search_items", "search_research", "set_planned_professions"].sort();
const classicEraNames = ["get_character_bags", "get_character_professions", "get_character_progression", "get_character_quests", "get_character_state", "get_character_trainer", "get_classic_era_mail_plan", "get_planned_professions", "get_recipe_reagent_availability", "list_classic_era_characters", "set_planned_professions"].sort();

test("MCP profile exposes exactly its documented tools and bounds crafter results", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "wowsync-mcp-profile-"));
  const databasePath = path.join(directory, "profile.sqlite");
  // The MCP opens its database read-only and refuses a missing file, so create the (empty) schema first.
  const writer = new SqliteSnapshotStore(databasePath);
  const fixtureDir = path.join(root, "packages", "core", "test", "fixtures", "forever");
  const { text: fixtureText, ...extras } = JSON.parse(readFileSync(path.join(fixtureDir, "copilot-hallo-pvp2.import.json"), "utf8"));
  const text = fixtureText.replace("Race: Dwarf\n", "");
  const observedAt = 1_791_741_120;
  extras.foreverGearObservation.professionRecipes = { observedAt, completeness: "partial", data: { formatVersion: 1, ownerScope: "CHARACTER", coverage: { state: "PARTIAL", candidateCompleteness: "UNKNOWN", returnedRecipeCount: 4 }, professions: [{ baseSkillLineID: 186, skillLineID: 186, professionName: "Mining", evidence: "OBSERVED", observedAt, recipes: [11, 12, 13, 14].map((recipeID) => ({ recipeID, name: `Hallo recipe ${recipeID}`, learned: true, learnedState: "OBSERVED_TRUE", evidence: "OBSERVED", observedAt })) }] } };
  extras.foreverGearObservation.race = "Gnome";
  writer.importSnapshot(text, extras);
  writer.importSnapshot(buildWowSyncExport({ generatedAt: observedAt, character: { name: "OtherForever", realm: "Classic Beta PvP 2", class: "Mage", faction: "Alliance", level: 20, clientFamily: "Forever", clientVersion: "1.60.1", clientBuild: "70338", interface: "16001" }, professions: { entries: [] }, bags: { containers: [{ id: 0, capacity: 16, items: [] }] }, bank: { unknown: true } }));
  const eraRaw = buildWowSyncExport({ generatedAt: observedAt, character: { name: "EraOne", realm: "Nightslayer", class: "Warrior", faction: "Alliance", level: 60, clientVersion: "1.15.9", clientBuild: "70003" }, bags: { containers: [{ id: 0, capacity: 16, free: 15, items: [{ itemRef: "item:529", name: "Era item", qty: 1, vendorEachCopper: 47 }] }] }, professions: { entries: [] } })
    .replace("Client: 1.15.9 build 70003\n", "Client: 1.15.9 build 70003\nGUID: Player-529-ANON\nTalentStatus: OBSERVED\ntalentTree\tname\tpointsSpent\ntalentTree\tArms\t31\ntalentTree\tFury\t20\ntalentTree\tProtection\t0\n");
  writer.importSnapshot(eraRaw);
  writer.close();
  const observer = new SqliteSnapshotStore(databasePath);
  importPolestarCodex(databasePath, parsePolestarCodexFiles({
    "Meta.lua": 'C.Register("meta", { build = "fixture.1", schema = 1 })',
    "Items1.lua": 'C.Register("item", [[\n100\t\tFixture Blade]], [[\n100\t3;10;;;;;;v42,100,0,e]], 100, 100)',
  }));
  const connect = async (profile?: string) => {
    const client = new Client({ name: "forever-profile-test", version: "0.1.0" });
    const environment: Record<string, string> = { ...process.env as Record<string, string>, WOWSYNC_MCP_DB_PATH: databasePath };
    if (profile) environment.WOWSYNC_MCP_PROFILE = profile;
    else delete environment.WOWSYNC_MCP_PROFILE;
    const transport = new StdioClientTransport({ command: process.execPath, args: [entrypoint], cwd: packageRoot, env: environment, stderr: "pipe" });
    let stderr = "";
    (transport.stderr as NodeJS.ReadableStream | null)?.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    try { await client.connect(transport); }
    catch (error) { throw new Error(`${profile ?? "default"} MCP initialize failed: ${error instanceof Error ? error.stack : String(error)}\nChild stderr:\n${stderr}`); }
    return { client, transport, getStderr: () => stderr };
  };
  try {
    for (const invalidProfile of [undefined, "retail", "Classic-Era"]) {
      const env: Record<string, string> = { ...process.env as Record<string, string>, WOWSYNC_MCP_DB_PATH: databasePath };
      if (invalidProfile) env.WOWSYNC_MCP_PROFILE = invalidProfile;
      else delete env.WOWSYNC_MCP_PROFILE;
      const failed = spawnSync(process.execPath, [entrypoint], { cwd: packageRoot, env, encoding: "utf8", timeout: 5_000 });
      assert.equal(failed.status, 1);
      assert.match(failed.stderr, /WOWSYNC_MCP_PROFILE must be exactly/);
    }
    const forever = await connect("forever");
    try {
      let listed;
      try { listed = await forever.client.listTools(); }
      catch (error) { throw new Error(`Forever tools/list failed: ${error instanceof Error ? error.stack : String(error)}\nChild stderr:\n${forever.getStderr()}`); }
      assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), foreverNames);
      const codexItem = await forever.client.callTool({ name: "lookup_item_sources", arguments: { query: 100 } });
      assert.equal((codexItem.structuredContent as { provenance?: string }).provenance, "REFERENCE");
      assert.equal((codexItem.structuredContent as { codexVersion?: string }).codexVersion, "fixture.1");
      let result;
      try { result = await forever.client.callTool({ name: "find_recipe_crafters", arguments: { version: "forever", nameContains: "copper" } }); }
      catch (error) { throw new Error(`Forever tools/call failed: ${error instanceof Error ? error.stack : String(error)}\nChild stderr:\n${forever.getStderr()}`); }
      assert.equal(result.isError, undefined);
      const serialized = JSON.stringify(result.structuredContent);
      assert.ok(serialized.length <= 40_000, `find_recipe_crafters exceeded the shared result limit (${serialized.length})`);
      assert.equal((result.structuredContent as { truncated?: boolean }).truncated, undefined);
      const roster = (await forever.client.callTool({ name: "list_forever_characters", arguments: { version: "forever", realm: "Classic Beta PvP 2" } })).structuredContent as { characters: Array<{ name: string; race: string; sex: string }> };
      const hallo = roster.characters.find((character) => character.name === "Hallo");
      assert.equal(hallo?.race, "Gnome");
      assert.equal(hallo?.sex, "UNKNOWN");
      const mailPlan = await forever.client.callTool({ name: "get_forever_mail_plan", arguments: { version: "forever", name: "Hallo", realm: "Classic Beta PvP 2" } });
      assert.equal(mailPlan.isError, undefined);
      const mailPlanData = (mailPlan.structuredContent as { value?: { data?: { ruleset?: string; plannedSpecs?: Array<{ provenance: string; informational: boolean }>; recipientNotObserved?: string[] } } }).value?.data;
      assert.equal(mailPlanData?.ruleset, "forever-min-70291-allocation-screen-v3");
      assert.ok(mailPlanData?.plannedSpecs?.every((spec) => spec.provenance === "USER_CONFIGURED" && spec.informational));
      assert.deepEqual(mailPlanData?.plannedSpecs, [], "the optional user configuration hook is empty by default");
      const foreverRoster = observer.listCharacters("forever");
      const halloSummary = foreverRoster.find((character) => character.name === "Hallo")!;
      const otherSummary = foreverRoster.find((character) => character.name === "OtherForever")!;
      observer.setMailPlanSettings({ accountId: "default", version: "forever", realm: halloSummary.realm, faction: "Alliance", auctionCharacterIdentityKey: otherSummary.identityKey, mainCharacterIdentityKey: otherSummary.identityKey, plannedProfessionsByCharacter: { [halloSummary.identityKey]: ["Tailoring"], [otherSummary.identityKey]: ["Alchemy"] }, updatedAt: observedAt, provenance: "USER_CONFIGURED" });
      const capturedCounts = () => {
        const db = new DatabaseSync(databasePath, { readOnly: true });
        try {
          const tables = ["characters", "snapshots", "snapshot_currency_sections", "snapshot_currencies", "snapshot_equipment_observations", "shared_observations", "shared_observation_sources", "demands", "erp_projects"];
          return Object.fromEntries(tables.map((table) => [table, Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n)]));
        } finally { db.close(); }
      };
      const beforePreferenceWrite = capturedCounts();
      const dryRun = await forever.client.callTool({ name: "set_planned_professions", arguments: { character: halloSummary.identityKey, professions: ["Mining", "Cooking"], confirm: false } });
      assert.equal(dryRun.isError, undefined);
      assert.deepEqual(dryRun.structuredContent, { mode: "DRY_RUN", character: { identityKey: halloSummary.identityKey, name: "Hallo", realm: halloSummary.realm, version: "forever" }, current: ["Tailoring"], proposed: ["Mining", "Cooking"], diff: { added: ["Mining", "Cooking"], removed: ["Tailoring"] }, written: false });
      assert.deepEqual(capturedCounts(), beforePreferenceWrite, "dry run leaves captured tables untouched");
      assert.deepEqual(observer.getMailPlanSettings({ accountId: "default", version: "forever", realm: halloSummary.realm, faction: "Alliance" })?.plannedProfessionsByCharacter?.[halloSummary.identityKey], ["Tailoring"], "dry run leaves the stored preference untouched");
      const badProfession = await forever.client.callTool({ name: "set_planned_professions", arguments: { character: halloSummary.identityKey, professions: ["Archaeology"], confirm: false } });
      assert.equal(badProfession.isError, true);
      assert.match(JSON.stringify(badProfession.structuredContent), /Unknown forever profession/);
      const badCharacter = await forever.client.callTool({ name: "get_planned_professions", arguments: { character: "missing-identity-key" } });
      assert.equal(badCharacter.isError, true);
      const badWriteCharacter = await forever.client.callTool({ name: "set_planned_professions", arguments: { character: "missing-identity-key", professions: ["Mining"], confirm: true } });
      assert.equal(badWriteCharacter.isError, true);
      const saved = await forever.client.callTool({ name: "set_planned_professions", arguments: { character: halloSummary.identityKey, professions: ["Mining", "Cooking"], confirm: true } });
      assert.equal(saved.isError, undefined);
      assert.deepEqual(saved.structuredContent, { mode: "SAVED", character: { identityKey: halloSummary.identityKey, name: "Hallo", realm: halloSummary.realm, version: "forever" }, professions: ["Mining", "Cooking"], provenance: "USER_CONFIGURED" });
      const verifiedSettings = observer.getMailPlanSettings({ accountId: "default", version: "forever", realm: halloSummary.realm, faction: "Alliance" })!;
      assert.deepEqual(verifiedSettings, { accountId: "default", version: "forever", realm: halloSummary.realm, faction: "Alliance", auctionCharacterIdentityKey: otherSummary.identityKey, mainCharacterIdentityKey: otherSummary.identityKey, plannedProfessionsByCharacter: { [halloSummary.identityKey]: ["Mining", "Cooking"], [otherSummary.identityKey]: ["Alchemy"] }, updatedAt: observedAt, provenance: "USER_CONFIGURED" });
      assert.deepEqual(capturedCounts(), beforePreferenceWrite, "confirmed preference changes leave captured table row counts unchanged");
      const readBack = await forever.client.callTool({ name: "get_planned_professions", arguments: { character: { name: "Hallo", realm: halloSummary.realm } } });
      assert.deepEqual((readBack.structuredContent as { professions: string[] }).professions, ["Mining", "Cooking"]);
      const state = (await forever.client.callTool({ name: "get_character_state", arguments: { version: "forever", name: "Hallo", realm: "Classic Beta PvP 2" } })).structuredContent as { value: { data: { identity: { race: string; sex: string } } } };
      assert.equal(state.value.data.identity.race, "Gnome");
      assert.equal(state.value.data.identity.sex, "UNKNOWN");
      const bags = await forever.client.callTool({ name: "get_character_bags", arguments: { version: "forever", name: "Hallo", realm: "Classic Beta PvP 2" } });
      assert.equal(bags.isError, undefined);
      const bagRows = (bags.structuredContent as { value?: { data?: { items?: Array<{ name?: string; itemID?: number; quantity?: number; quality?: { state: string }; provenance?: { version: string } }> } } }).value?.data?.items ?? [];
      assert.ok(bagRows.length > 0, "Forever MCP exposes actual bag rows");
      assert.ok(bagRows.every((row) => row.quality?.state === "UNKNOWN" && row.provenance?.version === "forever"));
      const summaryResult = await forever.client.callTool({ name: "get_character_professions", arguments: { version: "forever", name: "Hallo", realm: "Classic Beta PvP 2" } });
      const summaryText = JSON.stringify(summaryResult.structuredContent);
      assert.ok(summaryText.length < 10_000, `Hallo profession summary should stay compact (${summaryText.length} chars)`);
      const summary = summaryResult.structuredContent as { value?: { data?: { entries?: Array<{ name: string; recipeCount: number; recipes?: unknown[] }> } } };
      assert.ok(summary.value?.data?.entries?.some((entry) => entry.name === "Mining" && entry.recipeCount === 4), JSON.stringify(summaryResult.structuredContent).slice(0, 1200));
      assert.ok(summary.value?.data?.entries?.every((entry) => entry.recipes === undefined));
      const paged = await forever.client.callTool({ name: "get_character_professions", arguments: { version: "forever", name: "Hallo", realm: "Classic Beta PvP 2", profession: "Mining", includeRecipes: true, offset: 1, limit: 2 } });
      const page = paged.structuredContent as { value?: { data?: { entries?: Array<{ name: string; recipeCount: number; recipes?: unknown[]; recipePaging?: { offset: number; limit: number; totalCount: number } }> } } };
      const mining = page.value?.data?.entries?.find((entry) => entry.name.toLowerCase() === "mining");
      assert.equal(mining?.recipes?.length, 2);
      assert.equal(mining?.recipePaging?.offset, 1);
      assert.equal(mining?.recipePaging?.totalCount, mining?.recipeCount);
      assert.equal((await forever.client.callTool({ name: "get_character_professions", arguments: { version: "forever", name: "Hallo", realm: "Classic Beta PvP 2", includeRecipes: true } })).isError, true, "recipe inclusion requires a profession");
    } finally { await forever.client.close(); }

    const era = await connect("classic-era");
    try {
      const listed = await era.client.listTools();
      const eraToolNames = listed.tools.map((tool) => tool.name).sort();
      assert.ok(classicEraNames.every((name) => eraToolNames.includes(name)), "all documented Classic Era tools remain exposed");
      assert.ok(!eraToolNames.some((name) => name.startsWith("get_forever_") || name === "ask_forever_copilot" || name === "lookup_forever_knowledge" || ["lookup_item_sources", "lookup_npc", "lookup_dungeon", "suggest_for_level"].includes(name)), "Forever-only data, prices, catalog and mail tools stay isolated");
      const roster = (await era.client.callTool({ name: "list_classic_era_characters", arguments: { version: "classic-era", realm: "Nightslayer" } })).structuredContent as { characters: Array<{ name: string }> };
      assert.deepEqual(roster.characters.map((character) => character.name), ["EraOne"], "Era profile reads only Classic Era rows");
      const plan = await era.client.callTool({ name: "get_classic_era_mail_plan", arguments: { version: "classic-era", name: "EraOne", realm: "Nightslayer" } });
      assert.equal(plan.isError, undefined);
      const planData = (plan.structuredContent as { value?: { data?: { version?: string; buildVerification?: string; auctionHouse?: { state: string }; items?: Array<{ name: string; vendorEachCopper?: number }> } } }).value?.data;
      assert.equal(planData?.version, "classic-era");
      assert.equal(planData?.buildVerification, "VERIFIED");
      assert.equal(planData?.auctionHouse?.state, "UNKNOWN");
      assert.equal(planData?.items?.[0]?.name, "Era item");
      assert.equal(planData?.items?.[0]?.vendorEachCopper, 47);
      const eraDryRun = await era.client.callTool({ name: "set_planned_professions", arguments: { character: { name: "EraOne", realm: "Nightslayer" }, professions: ["Alchemy"], confirm: false } });
      assert.equal(eraDryRun.isError, undefined);
      assert.equal((eraDryRun.structuredContent as { mode: string }).mode, "DRY_RUN");
      const eraBadProfession = await era.client.callTool({ name: "set_planned_professions", arguments: { character: { name: "EraOne", realm: "Nightslayer" }, professions: ["Jewelcrafting"], confirm: false } });
      assert.equal(eraBadProfession.isError, true);
      const bags = await era.client.callTool({ name: "get_character_bags", arguments: { version: "classic-era", name: "EraOne", realm: "Nightslayer" } });
      const bagRows = (bags.structuredContent as { value?: { data?: { items?: Array<{ name?: string; itemID?: number; quantity?: number; vendorValue?: { state: string }; provenance?: { version: string } }> } } }).value?.data?.items ?? [];
      assert.deepEqual([bagRows[0]?.name, bagRows[0]?.itemID, bagRows[0]?.quantity, bagRows[0]?.vendorValue?.state, bagRows[0]?.provenance?.version], ["Era item", 529, 1, "OBSERVED", "classic-era"]);
    } finally { await era.client.close(); }
  } finally { observer.close(); rmSync(directory, { recursive: true, force: true }); }
});
