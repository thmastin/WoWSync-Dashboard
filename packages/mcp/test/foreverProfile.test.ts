import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { test } from "node:test";
import { SqliteSnapshotStore } from "@wowsync-dashboard/core";

const root = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const entrypoint = path.join(root, "packages", "mcp", "src", "index.ts");
const packageRoot = path.join(root, "packages", "mcp");
const defaultNames = ["analyze_retail_gear_candidate", "ask_forever_copilot", "find_recipe_crafters", "get_account_changes", "get_account_currencies", "get_account_overview", "get_allocation_review", "get_character_changes", "get_character_currencies", "get_character_equipment", "get_character_history", "get_character_professions", "get_character_progression", "get_character_quests", "get_character_spells", "get_character_state", "get_character_storage", "get_character_summary", "get_character_trainer", "get_erp_change_proposal", "get_erp_change_proposals", "get_erp_operations_context", "get_erp_project", "get_erp_projects", "get_forever_character_quests", "get_forever_crafted_upgrade_assessment", "get_forever_gear_allocation", "get_forever_gear_observation", "get_forever_mail_plan", "get_forever_market_prices", "get_gear_candidate_evidence", "get_gear_candidate_recipient_screen", "get_item_allocation", "get_item_metadata", "get_profession_coverage", "get_recipe_reagent_availability", "get_renown", "get_research_document", "get_research_section", "get_shared_storage", "list_characters", "list_research_documents", "list_versions", "lookup_forever_knowledge", "search_items", "search_research"];
const foreverNames = ["find_recipe_crafters", "get_character_professions", "get_character_progression", "get_character_state", "get_character_trainer", "get_forever_character_quests", "get_forever_gear_allocation", "get_forever_gear_observation", "get_forever_items", "get_forever_mail_plan", "get_forever_market_prices", "get_recipe_reagent_availability", "list_forever_characters", "lookup_forever_knowledge"];

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
  writer.close();
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
    const normal = await connect();
    try {
      let tools;
      try { tools = await normal.client.listTools(); }
      catch (error) { throw new Error(`Default tools/list failed: ${error instanceof Error ? error.stack : String(error)}\nChild stderr:\n${normal.getStderr()}`); }
      assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), defaultNames);
    }
    finally { await normal.client.close(); }
    const forever = await connect("forever");
    try {
      let listed;
      try { listed = await forever.client.listTools(); }
      catch (error) { throw new Error(`Forever tools/list failed: ${error instanceof Error ? error.stack : String(error)}\nChild stderr:\n${forever.getStderr()}`); }
      assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), foreverNames);
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
      const state = (await forever.client.callTool({ name: "get_character_state", arguments: { version: "forever", name: "Hallo", realm: "Classic Beta PvP 2" } })).structuredContent as { value: { data: { identity: { race: string; sex: string } } } };
      assert.equal(state.value.data.identity.race, "Gnome");
      assert.equal(state.value.data.identity.sex, "UNKNOWN");
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
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
