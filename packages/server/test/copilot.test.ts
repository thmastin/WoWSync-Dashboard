// HTTP-level tests for the read-only Forever Co-Pilot route. The real bridge payloads for Rordin,
// Hallo and Fizzwick are imported through the real POST /api/import route first.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { SqliteSnapshotStore } from "@wowsync-dashboard/core";
import { createApp } from "../src/app.ts";
import { fileURLToPath } from "node:url";

const KNOWLEDGE_FIXTURE = fileURLToPath(new URL("../../core/test/fixtures/forever/knowledge-fixture.json", import.meta.url));

const fixture = (name: string) => readFileSync(new URL(`../../core/test/fixtures/forever/copilot-${name}.import.json`, import.meta.url), "utf8");

async function withApp(run: (base: string, store: SqliteSnapshotStore) => Promise<void>, knowledgePath = KNOWLEDGE_FIXTURE) {
  const store = new SqliteSnapshotStore(":memory:");
  const server = await new Promise<http.Server>((resolve) => { const s = http.createServer(createApp(store, 0, undefined, { foreverKnowledgePath: knowledgePath })); s.listen(0, "127.0.0.1", () => resolve(s)); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    for (const name of ["rordin", "hallo-pvp2", "fizzwick"]) {
      const res = await fetch(`${base}/api/import`, { method: "POST", headers: { "content-type": "application/json" }, body: fixture(name) });
      assert.ok(res.status === 200 || res.status === 201, `import ${name}: ${res.status}`);
    }
    await run(base, store);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    store.close();
  }
}

const post = async (base: string, path: string, body: unknown) => { const res = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: res.status, body: await res.json() as Record<string, any> }; };

test("POST /api/versions/forever/copilot answers Scenario A and B and changes nothing", async () => {
  await withApp(async (base, store) => {
    const before = JSON.stringify(store.listCharacters("forever"));
    const a = await post(base, "/api/versions/forever/copilot", { question: "I'm playing Rordin. What are the most valuable things I could do to improve this character?" });
    assert.equal(a.status, 200);
    assert.equal(a.body.subject.name, "Rordin");
    assert.equal(a.body.recommendations[0].id, "equip-10421");
    assert.match(a.body.markdown, /Equip the Rough Copper Vest/);
    const b = await post(base, "/api/versions/forever/copilot", { question: "How can I make gold with my Forever stable?", limit: 5 });
    assert.equal(b.status, 200);
    const perEconomy = new Map<string, number>();
    for (const rec of b.body.recommendations as Array<{ realm: string }>) perEconomy.set(rec.realm, (perEconomy.get(rec.realm) ?? 0) + 1);
    assert.ok([...perEconomy.values()].every((count) => count <= 5), "limit applies per faction economy");
    assert.ok(b.body.recommendations.every((rec: { goldBucket?: string }) => rec.goldBucket));
    assert.equal(JSON.stringify(store.listCharacters("forever")), before, "read-only");
  });
});

test("the co-pilot route validates input and keeps versions isolated", async () => {
  await withApp(async (base) => {
    assert.equal((await post(base, "/api/versions/retail/copilot", { question: "gold?" })).status, 422);
    assert.equal((await post(base, "/api/versions/forever/copilot", { question: "" })).status, 400);
    assert.equal((await post(base, "/api/versions/forever/copilot", { question: "x", objectives: ["WIN"] })).status, 400);
    assert.equal((await post(base, "/api/versions/forever/copilot", { question: "x", limit: 99 })).status, 400);
    assert.equal((await post(base, "/api/versions/forever/copilot", { question: "x", character: { name: "Nobody" } })).status, 404);
    const emphasis = await post(base, "/api/versions/forever/copilot", { question: "Improve Rordin", preferences: { emphasis: "SELF_SUFFICIENCY", avoidSpending: true, goals: ["Self-sufficient Blacksmithing"] } });
    assert.equal(emphasis.status, 200);
    assert.equal(emphasis.body.objective.emphasis, "SELF_SUFFICIENCY");
    assert.ok(emphasis.body.playerGoals.some((goal: { title: string }) => goal.title === "Self-sufficient Blacksmithing"));
  });
});

test("knowledge bundle status and install routes validate and replace the private bundle", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = mkdtempSync(path.join(os.tmpdir(), "wowsync-knowledge-route-"));
  try {
    await withApp(async (base) => {
      assert.equal((await (await fetch(base + "/api/versions/forever/knowledge")).json() as { installed: boolean }).installed, false);
      const bad = await fetch(base + "/api/versions/forever/knowledge", { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: JSON.stringify({ schema: 2, version: "retail" }) });
      assert.equal(bad.status, 400);
      const good = await fetch(base + "/api/versions/forever/knowledge", { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: readFileSync(KNOWLEDGE_FIXTURE) });
      assert.equal(good.status, 200);
      const status = await good.json() as { installed: boolean; counts: { quests: number } };
      assert.equal(status.installed, true);
      assert.ok(status.counts.quests > 0);
      const answer = await post(base, "/api/versions/forever/copilot", { question: "I'm playing Rordin. What should I improve?" });
      assert.equal(answer.body.knowledge.available, true);
    }, path.join(dir, "forever-knowledge.json"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("GET /api/versions/forever/knowledge/observed-ids lists the account's observed IDs read-only", async () => {
  await withApp(async (base) => {
    const res = await fetch(base + "/api/versions/forever/knowledge/observed-ids");
    assert.equal(res.status, 200);
    const ids = await res.json() as { items: number[]; spells: number[]; quests: number[] };
    assert.ok(ids.items.includes(10421) && ids.spells.includes(2663) && ids.quests.includes(384));
  });
});
