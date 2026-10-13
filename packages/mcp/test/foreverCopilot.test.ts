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
