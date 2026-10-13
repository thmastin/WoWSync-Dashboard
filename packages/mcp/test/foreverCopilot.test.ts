// The Forever Co-Pilot over the real STDIO MCP server, using the exact import payloads the
// SavedVariables bridge sent for Rordin, Hallo and Fizzwick (Forever 1.60.1 / 70338).
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { SqliteSnapshotStore } from "@wowsync-dashboard/core";

const packageRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const entrypoint = path.join(packageRoot, "src", "index.ts");
const fixtureDir = path.resolve(packageRoot, "..", "core", "test", "fixtures", "forever");

test("MCP ask_forever_copilot answers both acceptance questions from real Forever fixtures, read-only", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wowsync-copilot-mcp-"));
  const databasePath = path.join(dir, "fixture.sqlite");
  const writer = new SqliteSnapshotStore(databasePath);
  try {
    for (const name of ["rordin", "hallo-pvp2", "fizzwick"]) {
      const { text, ...extras } = JSON.parse(readFileSync(path.join(fixtureDir, `copilot-${name}.import.json`), "utf8"));
      writer.importSnapshot(text, extras);
    }
  } finally { writer.close(); }
  const client = new Client({ name: "copilot-test", version: "0.0.0" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [entrypoint], cwd: packageRoot, env: { ...process.env, WOWSYNC_MCP_DB_PATH: databasePath, WOWSYNC_FOREVER_KNOWLEDGE_PATH: path.join(fixtureDir, "knowledge-fixture.json") }, stderr: "pipe" });
  try {
    await client.connect(transport);
    const tool = (await client.listTools()).tools.find((entry) => entry.name === "ask_forever_copilot");
    assert.ok(tool);
    assert.equal(tool!.annotations?.readOnlyHint, true);

    const a = await client.callTool({ name: "ask_forever_copilot", arguments: { version: "forever", question: "I'm playing Rordin. What are the most valuable things I could do to improve this character, including things I haven't considered?" } });
    assert.equal(a.isError, undefined);
    const answer = a.structuredContent as { status: string; subject: { name: string }; recommendations: Array<{ id: string; evidence: Array<{ kind: string }> }>; markdown: string };
    assert.equal(answer.status, "ANSWERED");
    assert.equal(answer.subject.name, "Rordin");
    assert.equal(answer.recommendations[0]?.id, "equip-10421");
    assert.ok(answer.recommendations.every((rec) => rec.evidence.length > 0));

    const b = await client.callTool({ name: "ask_forever_copilot", arguments: { version: "forever", question: "Look at my Forever stable and tell me how I can make gold using the characters, professions, and resources I actually have.", format: "markdown" } });
    const compact = b.structuredContent as { status: string; markdown: string };
    assert.equal(compact.status, "ANSWERED");
    assert.match(compact.markdown, /Supported by resources you already have/);
    assert.match(compact.markdown, /Economy: Classic Beta PvP 2, Alliance/);

    const wrongVersion = await client.callTool({ name: "ask_forever_copilot", arguments: { version: "retail", question: "x" } });
    assert.equal(wrongVersion.isError, true, "schema refuses non-Forever versions");
  } finally {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MCP lookup_forever_knowledge and Forever get_character_progression are read-only and sourced", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wowsync-lookup-mcp-"));
  const databasePath = path.join(dir, "fixture.sqlite");
  const writer = new SqliteSnapshotStore(databasePath);
  try {
    const { text, ...extras } = JSON.parse(readFileSync(path.join(fixtureDir, "copilot-rordin.import.json"), "utf8"));
    writer.importSnapshot(text, extras);
  } finally { writer.close(); }
  const client = new Client({ name: "lookup-test", version: "0.0.0" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [entrypoint], cwd: packageRoot, env: { ...process.env, WOWSYNC_MCP_DB_PATH: databasePath, WOWSYNC_FOREVER_KNOWLEDGE_PATH: path.join(fixtureDir, "knowledge-fixture.json"), WOWSYNC_FOREVER_PRICES_PATH: path.join(fixtureDir, "prices-fixture.json") }, stderr: "pipe" });
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools;
    assert.equal(tools.find((entry) => entry.name === "lookup_forever_knowledge")?.annotations?.readOnlyHint, true);
    assert.equal(tools.find((entry) => entry.name === "get_forever_market_prices")?.annotations?.readOnlyHint, true);
    const priced = (await client.callTool({ name: "get_forever_market_prices", arguments: { version: "forever", character: { name: "Rordin" }, items: [2770, 2840, 999999] } })).structuredContent as { status: string; market: string; attribution: string; prices: Array<{ itemId?: number; status: string; median?: number }> };
    assert.equal(priced.status, "FOUND");
    assert.equal(priced.market, "forever.pvp.alliance.us", "Rordin's PvP realm and Alliance faction pick the market");
    assert.equal(priced.prices[0]!.median, 153);
    assert.ok(["OBSERVED_EXTERNAL", "STALE"].includes(priced.prices[0]!.status));
    assert.equal(priced.prices[2]!.status, "UNKNOWN", "an unpriced item is UNKNOWN, not zero");
    assert.match(priced.attribution, /ahledger\.com/);
    assert.equal((await client.callTool({ name: "get_forever_market_prices", arguments: { version: "forever", items: [2770] } })).isError, true, "character or market is required");
    const quest = (await client.callTool({ name: "lookup_forever_knowledge", arguments: { version: "forever", kind: "quest", id: 990001 } })).structuredContent as { status: string; results: Array<{ zone: string }>; knowledge: { sources: unknown[] } };
    assert.equal(quest.status, "FOUND");
    assert.equal(quest.results[0]!.zone, "Mulgore");
    assert.ok(quest.knowledge.sources.length > 0);
    const missing = await client.callTool({ name: "lookup_forever_knowledge", arguments: { version: "forever", kind: "item" } });
    assert.equal(missing.isError, true, "id or name is required");
    const progression = (await client.callTool({ name: "get_character_progression", arguments: { version: "forever", name: "Rordin" } })).structuredContent as { status: string; value: { provenance: { state: string } } };
    assert.equal(progression.status, "FOUND");
    assert.equal(progression.value.provenance.state, "UNKNOWN", "no talents or reputation in this export yet");
  } finally {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
