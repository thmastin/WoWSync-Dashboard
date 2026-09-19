// HTTP-level tests for Forever version support and the character-deletion
// endpoint. Real Forever/TBC fixtures (shared with the core tests) are
// imported through the real POST /api/import route, and every assertion goes
// through the real HTTP API - including the derived views (account facts,
// account context, recent changes) that must reflect a deletion on their
// own, with nothing to invalidate.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SqliteSnapshotStore } from "@wowsync-dashboard/core";
import { createApp } from "../src/app.ts";

const fixtures = fileURLToPath(new URL("../../core/test/fixtures/", import.meta.url));
const read = (path: string) => readFileSync(`${fixtures}${path}`, "utf8");

const HALLO = "forever::classic beta pvp 2::hallo emberstone";
const VOODAN = "tbc-anniversary::dreamscythe::voodan";
const TORAHN = "tbc-anniversary::dreamscythe::torahn";

async function withApp(run: (api: Api) => Promise<void>) {
  const store = new SqliteSnapshotStore(":memory:");
  const app = createApp(store, 0);
  const server = await new Promise<http.Server>((resolve) => {
    const s = http.createServer(app);
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const api: Api = {
    base,
    async get(path) {
      const res = await fetch(base + path);
      return { status: res.status, body: await res.json() };
    },
    async import(file) {
      const res = await fetch(base + "/api/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: read(file) }),
      });
      return { status: res.status, body: await res.json() };
    },
    async del(identityKey, body, rawBody) {
      const res = await fetch(`${base}/api/characters/${encodeURIComponent(identityKey)}`, {
        method: "DELETE",
        headers: body !== undefined || rawBody !== undefined ? { "Content-Type": "application/json" } : {},
        body: rawBody ?? (body !== undefined ? JSON.stringify(body) : undefined),
      });
      const text = await res.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
      return { status: res.status, body: parsed as Record<string, any> };
    },
  };
  try {
    await run(api);
  } finally {
    await new Promise((r) => server.close(() => r(undefined)));
    store.close();
  }
}

interface Api {
  base: string;
  get(path: string): Promise<{ status: number; body: any }>;
  import(file: string): Promise<{ status: number; body: any }>;
  del(identityKey: string, body?: unknown, rawBody?: string): Promise<{ status: number; body: Record<string, any> }>;
}

async function seed(api: Api) {
  for (const f of [
    "tbc-anniversary/voodan-1789484723.wowsync.txt",
    "tbc-anniversary/voodan-1789492666.wowsync.txt",
    "tbc-anniversary/torahn-1789492498.wowsync.txt",
    "forever/hallo-1789693144.wowsync.txt",
    "forever/hallo-1789731867.wowsync.txt",
  ]) {
    const r = await api.import(f);
    assert.equal(r.status, 200, `importing ${f}`);
  }
}

// --- Forever over the API -----------------------------------------------------------------

test("[REAL] a Forever export imports through POST /api/import as a Forever character", async () => {
  await withApp(async (api) => {
    const r = await api.import("forever/hallo-1789731867.wowsync.txt");
    assert.equal(r.status, 200);
    assert.equal(r.body.result.character.version, "forever");
    assert.equal(r.body.result.character.identityKey, HALLO);
    assert.equal(r.body.result.character.latestMoneyCopper, 291);
  });
});

test("[REAL] /api/versions lists Forever with a label, and its own totals", async () => {
  await withApp(async (api) => {
    await seed(api);
    const { body } = await api.get("/api/versions");
    assert.deepEqual(
      body.versions.map((v: { version: string }) => v.version),
      ["classic-era", "tbc-anniversary", "retail", "forever", "unknown-version"],
    );
    assert.equal(body.labels["forever"], "Forever");
    const forever = body.versions.find((v: { version: string }) => v.version === "forever");
    assert.equal(forever.characterCount, 1);
    assert.equal(forever.totalMoneyCopper, 291);
    assert.equal(body.versions.find((v: { version: string }) => v.version === "classic-era").characterCount, 0);
  });
});

test("[REAL] the version-scoped routes accept 'forever' and return only Forever data", async () => {
  await withApp(async (api) => {
    await seed(api);
    const chars = await api.get("/api/versions/forever/characters");
    assert.equal(chars.status, 200);
    assert.deepEqual(chars.body.characters.map((c: { name: string }) => c.name), ["Hallo Emberstone"]);

    const facts = await api.get("/api/versions/forever/account-facts");
    assert.equal(facts.status, 200);
    assert.equal(facts.body.facts.version, "forever");
    assert.equal(facts.body.facts.aggregationScope, "realm");
    assert.equal(facts.body.facts.realms[0].realm, "Classic Beta PvP 2");

    const changes = await api.get("/api/versions/forever/recent-changes");
    assert.equal(changes.status, 200);
    assert.equal(changes.body.changes[0].identityKey, HALLO);

    assert.equal((await api.get("/api/versions/not-a-version/characters")).status, 400);
  });
});

test("[REAL] /api/account-context includes forever alongside the other versions", async () => {
  await withApp(async (api) => {
    await seed(api);
    const { body } = await api.get("/api/account-context?now=1789740000");
    assert.deepEqual(Object.keys(body.versions), ["classic-era", "tbc-anniversary", "retail", "forever"]);
    assert.equal(body.versions.forever.characters[0].name, "Hallo Emberstone");
    assert.equal(body.versions.forever.facts.gold.totalKnownCopper, 291);
    assert.equal(body.versions["tbc-anniversary"].characters.length, 2);
  });
});

// --- Deletion -------------------------------------------------------------------------------

test("[REAL] DELETE with a matching confirmation removes the character and its whole history, and derived views follow", async () => {
  await withApp(async (api) => {
    await seed(api);
    assert.equal((await api.get("/api/versions/tbc-anniversary/recent-changes")).body.changes.length, 1);

    const res = await api.del(VOODAN, { confirmIdentityKey: VOODAN });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.deleted, {
      identityKey: VOODAN,
      version: "tbc-anniversary",
      realm: "Dreamscythe",
      name: "Voodan",
      snapshotsDeleted: 2,
    });

    assert.equal((await api.get(`/api/characters/${encodeURIComponent(VOODAN)}`)).status, 404);
    assert.deepEqual((await api.get(`/api/characters/${encodeURIComponent(VOODAN)}/snapshots`)).body.snapshots, []);
    assert.deepEqual(
      (await api.get("/api/versions/tbc-anniversary/characters")).body.characters.map((c: { name: string }) => c.name),
      ["Torahn"],
    );
    assert.deepEqual((await api.get("/api/versions/tbc-anniversary/recent-changes")).body.changes, []);
    const facts = (await api.get("/api/versions/tbc-anniversary/account-facts")).body.facts;
    assert.equal(facts.characterCount, 1);
    assert.equal(facts.gold.byCharacter.some((g: { name: string }) => g.name === "Voodan"), false);
    const ctx = await api.get("/api/account-context");
    assert.equal(JSON.stringify(ctx.body).includes("Voodan"), false);
    assert.equal(
      (await api.get("/api/versions")).body.versions.find((v: { version: string }) => v.version === "tbc-anniversary").characterCount,
      1,
    );
  });
});

test("[REAL] deleting a Forever character leaves other versions untouched (version isolation over HTTP)", async () => {
  await withApp(async (api) => {
    await seed(api);
    const before = (await api.get("/api/versions/tbc-anniversary/account-facts")).body.facts;
    const res = await api.del(HALLO, { confirmIdentityKey: HALLO });
    assert.equal(res.status, 200);
    assert.equal(res.body.deleted.snapshotsDeleted, 2);
    assert.equal(res.body.deleted.version, "forever");

    assert.equal((await api.get("/api/versions/forever/account-facts")).body.facts.characterCount, 0);
    const after = (await api.get("/api/versions/tbc-anniversary/account-facts")).body.facts;
    // generatedAt is the wall clock; everything else must be identical.
    assert.deepEqual({ ...after, generatedAt: 0 }, { ...before, generatedAt: 0 });
  });
});

test("DELETE without a body, with a non-string confirmation, or with an empty confirmation is rejected (400) and deletes nothing", async () => {
  await withApp(async (api) => {
    await seed(api);
    for (const attempt of [
      await api.del(VOODAN),
      await api.del(VOODAN, {}),
      await api.del(VOODAN, { confirmIdentityKey: "" }),
      await api.del(VOODAN, { confirmIdentityKey: 42 }),
      await api.del(VOODAN, { confirmIdentityKey: null }),
      await api.del(VOODAN, { confirmIdentityKey: [VOODAN] }),
      await api.del(VOODAN, { confirmIdentityKey: { key: VOODAN } }),
      await api.del(VOODAN, { confirm: VOODAN }), // wrong field name
      await api.del(VOODAN, [VOODAN]),
    ]) {
      assert.equal(attempt.status, 400, JSON.stringify(attempt.body));
      assert.match(String(attempt.body.error), /confirm/i);
    }
    assert.equal((await api.get(`/api/characters/${encodeURIComponent(VOODAN)}`)).body.character.snapshotCount, 2);
  });
});

test("DELETE with malformed JSON is rejected (400) and deletes nothing", async () => {
  await withApp(async (api) => {
    await seed(api);
    for (const raw of ["{ this is not json", "null", '"just a string"']) {
      const res = await api.del(VOODAN, undefined, raw);
      assert.equal(res.status, 400, raw);
      assert.match(String(res.body.error), /JSON/, "reported as a JSON error, not an HTML page");
    }
    assert.equal((await api.get(`/api/characters/${encodeURIComponent(VOODAN)}`)).status, 200);
  });
});

test("DELETE whose confirmation names a different character is rejected (400) and deletes neither", async () => {
  await withApp(async (api) => {
    await seed(api);
    for (const wrong of [TORAHN, VOODAN.toUpperCase(), ` ${VOODAN}`, "voodan", HALLO]) {
      const res = await api.del(VOODAN, { confirmIdentityKey: wrong });
      assert.equal(res.status, 400, `confirmation ${JSON.stringify(wrong)}`);
      assert.match(String(res.body.error), /does not match/i);
    }
    assert.equal((await api.get(`/api/characters/${encodeURIComponent(VOODAN)}`)).status, 200);
    assert.equal((await api.get(`/api/characters/${encodeURIComponent(TORAHN)}`)).status, 200);
    assert.equal((await api.get(`/api/characters/${encodeURIComponent(HALLO)}`)).status, 200);
  });
});

test("DELETE of a nonexistent or already-deleted character returns 404, and a repeat delete is safe", async () => {
  await withApp(async (api) => {
    await seed(api);
    const ghost = "tbc-anniversary::dreamscythe::nobody";
    const missing = await api.del(ghost, { confirmIdentityKey: ghost });
    assert.equal(missing.status, 404);
    assert.match(String(missing.body.error), /not found/i);

    assert.equal((await api.del(VOODAN, { confirmIdentityKey: VOODAN })).status, 200);
    const again = await api.del(VOODAN, { confirmIdentityKey: VOODAN });
    assert.equal(again.status, 404);
    // Nothing else was affected by the failed repeat.
    assert.equal((await api.get(`/api/characters/${encodeURIComponent(TORAHN)}`)).body.character.snapshotCount, 1);
  });
});

test("DELETE has no bulk or wildcard form: pattern-shaped keys match nothing and delete nothing", async () => {
  await withApp(async (api) => {
    await seed(api);
    for (const pattern of ["%", "_", "tbc-anniversary::dreamscythe::%", "*", ".*"]) {
      const res = await api.del(pattern, { confirmIdentityKey: pattern });
      assert.equal(res.status, 404, `pattern ${pattern}`);
    }
    // The bare collection route does not accept DELETE at all.
    const bare = await fetch(`${api.base}/api/characters`, { method: "DELETE" });
    assert.notEqual(bare.status, 200);
    assert.equal((await api.get("/api/versions/tbc-anniversary/characters")).body.characters.length, 2);
    assert.equal((await api.get("/api/versions/forever/characters")).body.characters.length, 1);
  });
});

test("a deleted character can be imported again and starts fresh", async () => {
  await withApp(async (api) => {
    await seed(api);
    await api.del(HALLO, { confirmIdentityKey: HALLO });
    const again = await api.import("forever/hallo-1789731867.wowsync.txt");
    assert.equal(again.body.result.isFirstSnapshot, true);
    assert.equal(again.body.result.character.snapshotCount, 1);
  });
});
