import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { test } from "node:test";
import { SqliteSnapshotStore } from "@wowsync-dashboard/core";
import { buildWowSyncExport } from "../../core/test/fixtureBuilder.ts";
import { parseSavedExports } from "../../server/src/importSaved.ts";
import { savedVariables } from "../../server/test/savedVariablesFixtures.ts";

const root = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const entrypoint = path.join(root, "packages", "mcp", "src", "index.ts");
const packageRoot = path.join(root, "packages", "mcp");

test("Forever race written only at sections.character.data.race reaches MCP roster and state", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "wowsync-mcp-race-"));
  const databasePath = path.join(directory, "race.sqlite");
  const generatedAt = 1_791_500_000;
  // The real addon shape: no identity.race, and no `Race:` line in the export text.
  const text = buildWowSyncExport({ generatedAt, character: { name: "Hallo", realm: "Hallo", clientFamily: "Forever", clientVersion: "1.60.1", clientBuild: "70291", interface: "16001" } });
  assert.match(text, /^Race: \?$/m);
  const [saved] = parseSavedExports(savedVariables([{ guid: "Player-1-HALLO", name: "Hallo", realm: "Hallo", text, generatedAt, captureProfile: "Forever:1.60.1:70291:16001", sectionRace: "Dwarf" }]), "fixture");
  assert.equal((saved.foreverGearObservation as { race?: string } | undefined)?.race, "Dwarf");
  const writer = new SqliteSnapshotStore(databasePath);
  writer.importSnapshot(saved.text!, { foreverGearObservation: saved.foreverGearObservation });
  writer.close();
  const client = new Client({ name: "forever-race-test", version: "0.1.0" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [entrypoint], cwd: packageRoot, env: { ...process.env as Record<string, string>, WOWSYNC_MCP_DB_PATH: databasePath, WOWSYNC_MCP_PROFILE: "forever" }, stderr: "pipe" });
  try {
    await client.connect(transport);
    const roster = (await client.callTool({ name: "list_forever_characters", arguments: { version: "forever" } })).structuredContent as { characters: Array<{ name: string; race: string }> };
    assert.equal(roster.characters.find((character) => character.name === "Hallo")?.race, "Dwarf");
    const state = (await client.callTool({ name: "get_character_state", arguments: { version: "forever", name: "Hallo", realm: "Hallo" } })).structuredContent as { value: { data: { identity: { race: string } } } };
    assert.equal(state.value.data.identity.race, "Dwarf");
  } finally {
    await client.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
