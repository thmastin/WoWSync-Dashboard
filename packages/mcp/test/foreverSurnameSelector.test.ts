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

const root = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const entrypoint = path.join(root, "packages", "mcp", "src", "index.ts");
const packageRoot = path.join(root, "packages", "mcp");
const NOW = 1_800_000_000;
const REALM = "Twin Realm";

function foreverCharacter(surname: string, level: number, className: string, profession: string, skill: number, recipeID: number) {
  const generatedAt = NOW - 10;
  const text = buildWowSyncExport({
    generatedAt,
    character: { name: "Hallo", surname, realm: REALM, class: className, level, faction: "Alliance", clientFamily: "Forever", clientVersion: "1.60.1", clientBuild: "70338", interface: "16001" },
    professions: { entries: [{ name: profession, skill, maxSkill: 75 }] },
    bank: { unknown: true },
  });
  return {
    text,
    extras: {
      foreverGearObservation: {
        clientProfile: "Forever:1.60.1:70338:16001", name: "Hallo", realm: REALM, generatedAt, sourceCharacterGuid: `Player-1-${surname}`,
        professionRecipes: {
          observedAt: generatedAt, completeness: "partial",
          data: {
            formatVersion: 1, ownerScope: "CHARACTER",
            coverage: { state: "PARTIAL", candidateCompleteness: "UNKNOWN", returnedRecipeCount: 1 },
            professions: [{ baseSkillLineID: 1, skillLineID: 1, professionName: profession, evidence: "OBSERVED", observedAt: generatedAt, recipes: [{ recipeID, name: `${surname} recipe`, learned: true, learnedState: "OBSERVED_TRUE", evidence: "OBSERVED", observedAt: generatedAt }] }],
          },
        },
      },
    },
  };
}

test("Forever MCP selects surname-colliding characters exactly and keeps name/realm callers compatible", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "wowsync-mcp-surname-"));
  const databasePath = path.join(directory, "surname.sqlite");
  const writer = new SqliteSnapshotStore(databasePath);
  const ashwick = foreverCharacter("Ashwick", 17, "Warlock", "Mining", 20, 111);
  const oldbeard = foreverCharacter("Oldbeard", 2, "Hunter", "Skinning", 5, 222);
  writer.importSnapshot(ashwick.text, ashwick.extras);
  writer.importSnapshot(oldbeard.text, oldbeard.extras);
  writer.importSnapshot(buildWowSyncExport({ generatedAt: NOW - 5, character: { name: "Solo", realm: REALM, class: "Mage", level: 4, clientFamily: "Forever", clientVersion: "1.60.1", clientBuild: "70338", interface: "16001" }, professions: { entries: [{ name: "Tailoring", skill: 1, maxSkill: 75 }] } }));
  writer.close();

  const client = new Client({ name: "forever-surname-selector-test", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entrypoint],
    cwd: packageRoot,
    env: { ...process.env, WOWSYNC_MCP_PROFILE: "forever", WOWSYNC_MCP_DB_PATH: databasePath },
    stderr: "pipe",
  });
  await client.connect(transport);
  try {
    const listed = await client.listTools();
    const schemaOf = (name: string) => listed.tools.find((tool) => tool.name === name)?.inputSchema as { required?: string[]; additionalProperties?: boolean; properties?: Record<string, unknown> };
    for (const name of ["get_character_summary", "get_character_professions"]) {
      const schema = schemaOf(name);
      assert.equal(schema.additionalProperties, false, name);
      assert.deepEqual(schema.required?.slice().sort(), ["name", "version"]);
      assert.ok(schema.properties?.surname, `${name} exposes surname`);
      assert.ok(schema.properties?.identityKey, `${name} exposes identityKey`);
      assert.equal(schema.properties?.characterId, undefined, `${name} does not add a storage row id selector`);
    }
    const professions = schemaOf("get_character_professions");
    for (const property of ["profession", "includeRecipes", "offset", "limit", "realm"]) assert.ok(professions.properties?.[property], property);

    const call = async (name: string, arguments_: Record<string, unknown>) => client.callTool({ name, arguments: arguments_ });
    const body = (result: Awaited<ReturnType<typeof call>>) => result.structuredContent as { status?: string; reason?: string; candidates?: Array<{ surname?: string; identityKey?: string }>; value?: { data?: { surname?: string; level?: number; entries?: Array<{ name: string; skill?: number; recipes?: Array<{ name?: string }> }> }; provenance?: { identityKey?: string; version?: string } } };

    const ambiguous = body(await call("get_character_summary", { version: "forever", name: "Hallo", realm: REALM }));
    assert.equal(ambiguous.status, "AMBIGUOUS");
    assert.deepEqual(ambiguous.candidates?.map((candidate) => candidate.surname).sort(), ["Ashwick", "Oldbeard"]);
    assert.equal(body(await call("get_character_professions", { version: "forever", name: "Hallo", realm: REALM })).status, "AMBIGUOUS");
    assert.equal(body(await call("get_character_summary", { version: "forever", name: "Hallo Ashwick", realm: REALM })).status, "NOT_FOUND");
    assert.equal(body(await call("get_character_professions", { version: "forever", name: "Hallo Oldbeard", realm: REALM })).status, "NOT_FOUND");

    const surnameSummary = body(await call("get_character_summary", { version: "forever", name: "Hallo", realm: REALM, surname: "Ashwick" }));
    const keySummary = body(await call("get_character_summary", { version: "forever", name: "Hallo", realm: REALM, identityKey: "forever::twin realm::hallo::oldbeard" }));
    assert.equal(surnameSummary.status, "FOUND");
    assert.equal(keySummary.status, "FOUND");
    assert.equal(surnameSummary.value?.data?.surname, "Ashwick");
    assert.equal(surnameSummary.value?.data?.level, 17);
    assert.equal(surnameSummary.value?.provenance?.identityKey, "forever::twin realm::hallo::ashwick");
    assert.equal(keySummary.value?.data?.surname, "Oldbeard");
    assert.equal(keySummary.value?.data?.level, 2);

    const ashwickProfessions = body(await call("get_character_professions", { version: "forever", name: "Hallo", realm: REALM, surname: "Ashwick", profession: "Mining", includeRecipes: true }));
    const oldbeardProfessions = body(await call("get_character_professions", { version: "forever", name: "Hallo", realm: REALM, identityKey: "forever::twin realm::hallo::oldbeard", profession: "Skinning", includeRecipes: true }));
    const mining = ashwickProfessions.value?.data?.entries?.find((entry) => entry.name === "Mining");
    const skinning = oldbeardProfessions.value?.data?.entries?.find((entry) => entry.name === "Skinning");
    assert.equal(mining?.skill, 20);
    assert.equal(mining?.recipes?.[0]?.name, "Ashwick recipe");
    assert.equal(skinning?.skill, 5);
    assert.equal(skinning?.recipes?.[0]?.name, "Oldbeard recipe");
    assert.equal(ashwickProfessions.value?.data?.entries?.some((entry) => entry.recipes?.some((recipe) => recipe.name === "Oldbeard recipe")), false);

    const conflict = body(await call("get_character_summary", { version: "forever", name: "Hallo", realm: REALM, surname: "Oldbeard", identityKey: "forever::twin realm::hallo::ashwick" }));
    assert.equal(conflict.status, "SELECTOR_CONFLICT");
    assert.match(conflict.reason ?? "", /does not match/);
    assert.equal(body(await call("get_character_professions", { version: "forever", name: "Hallo", realm: REALM, identityKey: "retail::twin realm::hallo" })).status, "SELECTOR_CONFLICT");
    assert.equal(body(await call("get_character_summary", { version: "forever", name: "Hallo", realm: "Other Realm", identityKey: "forever::twin realm::hallo::ashwick" })).status, "SELECTOR_CONFLICT");
    assert.equal((await call("get_character_summary", { version: "forever", name: "Hallo", realm: REALM, surname: "" })).isError, true);
    assert.equal((await call("get_character_professions", { version: "forever", name: "Hallo", realm: REALM, characterId: 62 })).isError, true);

    const solo = body(await call("get_character_summary", { version: "forever", name: "Solo", realm: REALM }));
    assert.equal(solo.status, "FOUND");
    assert.equal(solo.value?.data?.level, 4);
    assert.equal(solo.value?.provenance?.version, "forever");
    const soloProfessions = body(await call("get_character_professions", { version: "forever", name: "Solo", realm: REALM }));
    assert.equal(soloProfessions.status, "FOUND");
    assert.equal(soloProfessions.value?.data?.entries?.some((entry) => entry.name === "Tailoring"), true);
  } finally {
    await client.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
