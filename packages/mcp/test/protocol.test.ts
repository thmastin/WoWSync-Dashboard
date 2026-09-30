import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
  const exported = buildWowSyncExport({
    generatedAt: now,
    character: { name, realm, clientFamily: "Retail", clientVersion: "12.1.0", clientBuild: "69933", level: 90 },
    equipment: { slots: [{ slot: 1, slotName: "Head", itemRef: "item:1", name: "Observed Helm", itemLevel: 279 }] },
    professions: professions ? { entries: [{ name: "Engineering", skill: 100, maxSkill: 100 }, { name: "Alchemy", skill: 100, maxSkill: 100 }], retail: true } : undefined,
    bags: { containers: [{ id: 0, capacity: 20, free: 19, items: [{ itemRef: "item:777", name: "Observed Bag Item", qty: 2 }] }] },
    bank: { containers: [{ id: 1, capacity: 28, free: 27, items: [{ itemRef: "item:888", name: "Observed Bank Item", qty: 1 }] }] },
  });
  return exported.replace(/\n\[END\]$/, "\n\n[ITEM METADATA]\nbaseItemID\tclassID\tsubclassID\tbindType\texpansionID\tisCraftingReagent\n777\t7\t5\t1\t11\tyes\n\n[END]");
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
    writer.importSnapshot(readFileSync(new URL("../../core/test/fixtures/sanitized/virek-warband-last-seen-1789965777.wowsync.txt", import.meta.url), "utf8"));
    writer.importSnapshot(readFileSync(new URL("../../core/test/fixtures/derived/ezaller-shared-storage-1789478317.wowsync.txt", import.meta.url), "utf8"));
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
      "get_character_storage",
      "get_character_summary",
      "get_item_metadata",
      "get_profession_coverage",
      "get_renown",
      "get_research_section",
      "get_shared_storage",
      "list_characters",
      "list_research_documents",
      "list_versions",
      "search_items",
      "search_research",
    ]);
    const tools = (await client.listTools()).tools;
    assert.ok(tools.every((tool) => tool.annotations?.readOnlyHint === true && tool.annotations?.destructiveHint === false));
    assert.equal(tools.some((tool) => /sql|file|shell|command|account_facts/i.test(tool.name)), false);

    const versions = structured<{ versions: Array<{ version: string }> }>(await client.callTool({ name: "list_versions", arguments: {} }));
    assert.deepEqual(versions.versions.map((entry) => entry.version).sort(), ["classic-era", "retail"]);

    const listed = structured<{ version: string; totalCount: number; truncated: boolean }>(await client.callTool({ name: "list_characters", arguments: { version: "retail" } }));
    assert.equal(listed.version, "retail");
    assert.equal(listed.totalCount, 3);
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

    const bag = structured<{ status: string; value?: { data?: { items?: Array<{ name: string }>; metadata?: Array<{ state: string }> }; provenance: { state: string } } }>(await client.callTool({ name: "get_character_storage", arguments: { version: "retail", name: "Virek", realm: "Cairne", storage: "bags" } }));
    assert.equal(bag.status, "FOUND");
    assert.equal(bag.value?.data?.items?.[0]?.name, "Observed Bag Item");
    assert.equal(bag.value?.data?.metadata?.[0]?.state, "KNOWN");
    const bank = structured<{ status: string; value?: { data?: { items?: Array<{ name: string }> }; provenance: { state: string } } }>(await client.callTool({ name: "get_character_storage", arguments: { version: "retail", name: "Virek", realm: "Cairne", storage: "bank" } }));
    assert.equal(bank.status, "FOUND");
    assert.equal(bank.value?.data?.items?.[0]?.name, "Observed Bank Item");
    const itemSearch = structured<{ data?: { items: Array<{ item: { name: string } }> }; provenance: { version: string } }>(await client.callTool({ name: "search_items", arguments: { version: "retail", query: "Observed Bag Item", limit: 1 } }));
    assert.equal(itemSearch.data?.items[0]?.item.name, "Observed Bag Item");
    assert.equal(itemSearch.provenance.version, "retail");
    const crossVersionSearch = structured<{ data?: { totalCount: number } }>(await client.callTool({ name: "search_items", arguments: { version: "classic-era", query: "Observed Bag Item" } }));
    assert.equal(crossVersionSearch.data?.totalCount, 0);
    const itemMetadata = structured<{ data?: Array<{ baseItemId: number; state: string; metadata?: { expansionId: { state: string }; craftingReagent: { state: string } } }> }>(await client.callTool({ name: "get_item_metadata", arguments: { version: "retail", itemIds: [777, 99999] } }));
    assert.deepEqual(itemMetadata.data?.map((item) => item.state), ["KNOWN", "UNKNOWN"]);
    assert.equal(itemMetadata.data?.[0]?.metadata?.expansionId.state, "KNOWN");
    assert.equal(itemMetadata.data?.[0]?.metadata?.craftingReagent.state, "KNOWN");
    const warband = structured<{ data?: { owners: Array<{ owner: { kind: string }; current?: { liveAtExport: boolean; provenance: { sources: Array<{ carrierState: string }> } | { } | undefined; content: { items: unknown[] } } }> }; provenance: { state: string } }>(await client.callTool({ name: "get_shared_storage", arguments: { version: "retail", kind: "warband", limit: 1 } }));
    assert.equal(warband.provenance.state, "DERIVED");
    assert.equal(warband.data?.owners[0]?.owner.kind, "warband");
    assert.equal(warband.data?.owners[0]?.current?.liveAtExport, false);
    const guild = structured<{ data?: { owners: Array<{ owner: { kind: string; guildClubId?: string }; current?: { coverage: { inaccessibleTabs: number[] }; provenance: { sources: Array<{ carrierState: string }> } } }> } }>(await client.callTool({ name: "get_shared_storage", arguments: { version: "retail", kind: "guild", limit: 1 } }));
    assert.equal(guild.data?.owners[0]?.owner.kind, "guild");
    assert.equal(typeof guild.data?.owners[0]?.owner.guildClubId, "string");
    assert.deepEqual(guild.data?.owners[0]?.current?.coverage.inaccessibleTabs, [3]);
    assert.equal(guild.data?.owners[0]?.current?.provenance.sources[0]?.carrierState, "OBSERVED");

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

test("the direct Node STDIO entrypoint supports modern discovery with protocol-only stdout", async () => {
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "wowsync-mcp-modern-"));
  const databasePath = path.join(temporaryDirectory, "fixture.sqlite");
  const writer = new SqliteSnapshotStore(databasePath);
  try {
    writer.importSnapshot(retail("Probe", "Cairne"));
  } finally {
    writer.close();
  }
  const databaseBefore = digest(databasePath);
  const child = spawn(process.execPath, [entrypoint], {
    cwd: packageRoot,
    env: { ...process.env, WOWSYNC_MCP_DB_PATH: databasePath },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  let stdoutBuffer = "";
  let stderr = "";
  const frames: Array<Record<string, unknown>> = [];
  const parseErrors: string[] = [];
  const responseWaiters = new Map<string | number, Array<(message: Record<string, unknown>) => void>>();
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    let newline = stdoutBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = stdoutBuffer.slice(0, newline).replace(/\r$/, "");
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (line.length === 0) {
        parseErrors.push("<empty stdout line>");
      } else {
        try {
          const message = JSON.parse(line) as Record<string, unknown>;
          frames.push(message);
          const id = message.id;
          if (typeof id === "string" || typeof id === "number") {
            const waiters = responseWaiters.get(id) ?? [];
            responseWaiters.delete(id);
            for (const resolve of waiters) resolve(message);
          }
        } catch {
          parseErrors.push(line);
        }
      }
      newline = stdoutBuffer.indexOf("\n");
    }
  });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });

  const waitForResponse = (id: number): Promise<Record<string, unknown>> => {
    const existing = frames.find((frame) => frame.id === id);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Timed out waiting for MCP response ${id}; stderr: ${stderr}`)), 5_000);
      const waiters = responseWaiters.get(id) ?? [];
      waiters.push((message) => {
        clearTimeout(timeout);
        resolve(message);
      });
      responseWaiters.set(id, waiters);
    });
  };
  const send = (message: unknown) => {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };
  const modernMeta = {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientCapabilities": {},
  };

  try {
    send({ jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: modernMeta } });
    const discovery = await waitForResponse(1);
    assert.equal(discovery.error, undefined, JSON.stringify(discovery.error));
    const discoveryResult = discovery.result as { supportedVersions?: string[] };
    assert.ok(discoveryResult.supportedVersions?.includes("2026-07-28"));

    send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: { _meta: modernMeta } });
    const toolListResponse = await waitForResponse(2);
    assert.equal(toolListResponse.error, undefined, JSON.stringify(toolListResponse.error));
    const listedTools = (toolListResponse.result as { tools: Array<{ name: string }> }).tools;
    assert.deepEqual(listedTools.map((tool) => tool.name).sort(), [
      "get_character_currencies",
      "get_character_equipment",
      "get_character_professions",
      "get_character_storage",
      "get_character_summary",
      "get_item_metadata",
      "get_profession_coverage",
      "get_renown",
      "get_research_section",
      "get_shared_storage",
      "list_characters",
      "list_research_documents",
      "list_versions",
      "search_items",
      "search_research",
    ]);
  } finally {
    child.stdin.end();
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error("Modern MCP stdio child did not exit after stdin closed"));
      }, 5_000);
      child.once("close", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    assert.equal(stdoutBuffer.trim(), "", "the process left a partial stdout frame");
    assert.deepEqual(parseErrors, [], "stdout included non-JSON protocol content");
    assert.equal(frames.length, 2, "stdout contained an unexpected MCP frame");
    assert.doesNotMatch(stderr, /WoWSync MCP startup failed/);
    assert.equal(digest(databasePath), databaseBefore, "the MCP process did not modify the fixture database");
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
