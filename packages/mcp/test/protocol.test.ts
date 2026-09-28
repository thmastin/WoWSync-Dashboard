import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
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
const now = 1_800_000_000;

function retail(name: string, realm: string, professions = false) {
  return buildWowSyncExport({
    generatedAt: now,
    character: { name, realm, clientFamily: "Retail", clientVersion: "12.1.0", clientBuild: "69933", level: 90 },
    equipment: { slots: [{ slot: 1, slotName: "Head", itemRef: "item:1", name: "Observed Helm", itemLevel: 279 }] },
    professions: professions ? { entries: [{ name: "Engineering", skill: 100, maxSkill: 100 }, { name: "Alchemy", skill: 100, maxSkill: 100 }], retail: true } : undefined,
  });
}

function structured<T>(result: { isError?: boolean; structuredContent?: unknown }): T {
  assert.equal(result.isError, undefined);
  assert.notEqual(result.structuredContent, undefined);
  return result.structuredContent as T;
}

function digest(pathname: string): string {
  return createHash("sha256").update(readFileSync(pathname)).digest("hex");
}

test("the local STDIO MCP server exposes only bounded read tools over the read-only store", async () => {
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "wowsync-mcp-"));
  const databasePath = path.join(temporaryDirectory, "fixture.sqlite");
  const writer = new SqliteSnapshotStore(databasePath);
  try {
    writer.importSnapshot(retail("Virek", "Cairne", true), {
      currencies: {
        observedAt: now,
        data: {
          listRead: true,
          formatVersion: 1,
          currencies: Array.from({ length: 101 }, (_, index) => ({ currencyID: index + 1, name: `Currency ${index + 1}`, quantity: index })),
        },
      },
    });
    writer.importSnapshot(retail("Virek", "Thrall"));
    writer.importSnapshot(buildWowSyncExport({ character: { name: "Virek", realm: "Era", clientVersion: "1.15.9" } }));
  } finally {
    writer.close();
  }
  const databaseBefore = digest(databasePath);

  const client = new Client({ name: "wowsync-mcp-protocol-test", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entrypoint],
    cwd: packageRoot,
    env: { ...process.env, WOWSYNC_MCP_DB_PATH: databasePath },
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    const toolNames = (await client.listTools()).tools.map((tool) => tool.name).sort();
    assert.deepEqual(toolNames, [
      "get_character_currencies",
      "get_character_equipment",
      "get_character_professions",
      "get_character_summary",
      "get_profession_coverage",
      "get_renown",
      "get_research_section",
      "list_characters",
      "list_research_documents",
      "list_versions",
      "search_research",
    ]);
    const tools = (await client.listTools()).tools;
    assert.ok(tools.every((tool) => tool.annotations?.readOnlyHint === true && tool.annotations?.destructiveHint === false));
    assert.equal(tools.some((tool) => /sql|file|shell|command|storage|account_facts/i.test(tool.name)), false);

    const versions = structured<{ versions: Array<{ version: string }> }>(await client.callTool({ name: "list_versions", arguments: {} }));
    assert.deepEqual(versions.versions.map((entry) => entry.version).sort(), ["classic-era", "retail"]);

    const listed = structured<{ version: string; totalCount: number; truncated: boolean }>(await client.callTool({ name: "list_characters", arguments: { version: "retail" } }));
    assert.equal(listed.version, "retail");
    assert.equal(listed.totalCount, 2);
    assert.equal(listed.truncated, false);

    const summary = structured<{ status: string; value?: { provenance: { state: string; version: string } } }>(await client.callTool({ name: "get_character_summary", arguments: { version: "retail", name: "Virek", realm: "Cairne" } }));
    assert.equal(summary.status, "FOUND");
    assert.equal(summary.value?.provenance.state, "OBSERVED");
    assert.equal(summary.value?.provenance.version, "retail");

    const equipment = structured<{ status: string; value?: { provenance: { state: string } } }>(await client.callTool({ name: "get_character_equipment", arguments: { version: "retail", name: "Virek", realm: "Cairne" } }));
    assert.equal(equipment.status, "FOUND");
    assert.equal(equipment.value?.provenance.state, "OBSERVED");
    const professions = structured<{ status: string; value?: { provenance: { state: string } } }>(await client.callTool({ name: "get_character_professions", arguments: { version: "retail", name: "Virek", realm: "Cairne" } }));
    assert.equal(professions.status, "FOUND");
    assert.equal(professions.value?.provenance.state, "OBSERVED");

    const ambiguity = structured<{ status: string; candidates?: Array<{ realm: string }> }>(await client.callTool({ name: "get_character_summary", arguments: { version: "retail", name: "Virek" } }));
    assert.equal(ambiguity.status, "AMBIGUOUS");
    assert.deepEqual(ambiguity.candidates?.map((candidate) => candidate.realm).sort(), ["Cairne", "Thrall"]);

    const wrongVersion = structured<{ status: string }>(await client.callTool({ name: "get_character_summary", arguments: { version: "classic-era", name: "Virek", realm: "Cairne" } }));
    assert.equal(wrongVersion.status, "NOT_FOUND");

    const coverage = structured<{ provenance: { state: string; derivedFrom?: string[] } }>(await client.callTool({ name: "get_profession_coverage", arguments: { version: "retail" } }));
    assert.equal(coverage.provenance.state, "DERIVED");
    assert.ok(coverage.provenance.derivedFrom?.length);

    const renown = structured<{ status: string; value?: { provenance: { state: string; reason?: string } } }>(await client.callTool({ name: "get_renown", arguments: { version: "retail", name: "Virek", realm: "Cairne" } }));
    assert.equal(renown.status, "FOUND");
    assert.equal(renown.value?.provenance.state, "UNKNOWN");
    assert.match(renown.value?.provenance.reason ?? "", /does not currently capture Renown/);

    const currencies = structured<{ status: string; value?: { returnedCount?: number; totalCount?: number; truncated?: boolean; data?: { currencies?: unknown[] } } }>(await client.callTool({ name: "get_character_currencies", arguments: { version: "retail", name: "Virek", realm: "Cairne" } }));
    assert.equal(currencies.status, "FOUND");
    assert.equal(currencies.value?.returnedCount, 100);
    assert.equal(currencies.value?.totalCount, 101);
    assert.equal(currencies.value?.truncated, true);
    assert.equal(currencies.value?.data?.currencies?.length, 100);

    const search = structured<{ matches: Array<{ document: { documentId: string }; section: { sectionId: string }; citations: unknown[] }> }>(await client.callTool({ name: "search_research", arguments: { query: "Ritual Sites", version: "retail", patch: "12.1.x" } }));
    assert.ok(search.matches.length > 0 && search.matches.length <= 5);
    assert.equal(search.matches[0]?.document.documentId, "midnight-12-1-renown");
    assert.ok(search.matches.some((match) => match.citations.length > 0));

    const first = search.matches[0];
    assert.ok(first);
    const section = structured<{ document: { documentId: string }; section: { sectionId: string; citations: unknown[] }; truncated: boolean }>(await client.callTool({ name: "get_research_section", arguments: { documentId: first.document.documentId, sectionId: first.section.sectionId } }));
    assert.equal(section.document.documentId, "midnight-12-1-renown");
    assert.equal(section.section.sectionId, first.section.sectionId);
    assert.ok(section.section.citations.length > 0);
    assert.equal(typeof section.truncated, "boolean");

    const invalid = await client.callTool({ name: "get_research_section", arguments: { documentId: "outside-root", sectionId: "missing" } });
    assert.equal(invalid.isError, true);
    assert.match(JSON.stringify(invalid.structuredContent), /RESEARCH_SECTION_NOT_FOUND/);
    const escapedPath = await client.callTool({ name: "get_research_section", arguments: { documentId: "../outside", sectionId: "missing" } });
    assert.equal(escapedPath.isError, true);

    const missingVersion = await client.callTool({ name: "list_characters", arguments: {} });
    assert.equal(missingVersion.isError, true);
    const excessiveLimit = await client.callTool({ name: "list_characters", arguments: { version: "retail", limit: 101 } });
    assert.equal(excessiveLimit.isError, true);
  } finally {
    await client.close();
    assert.equal(digest(databasePath), databaseBefore, "the spawned MCP process did not modify the primary fixture database");
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
