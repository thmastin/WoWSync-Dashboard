// HTTP tests for reconciled shared storage (checkpoint C4): GET /api/shared-storage and the explicit
// owner-scoped DELETE routes. Everything goes through the real app over real sockets; exports are
// rendered to real WOWSYNC text (the core test helpers) and imported through POST /api/import, so the
// parser, importer, journal, projection and serializer are all exercised end to end.
//
// What is pinned: the response is the DERIVED domain projection (never reconciled in the server); an
// UNKNOWN scalar is omitted, never 0; opaque GuildClubIDs survive byte for byte; provenance is bounded and
// deterministic; a damaged journal fails loudly with a distinct code; deletion is explicit, confirmed and
// owner-scoped (character deletion still keeps shared history); new exports may recreate a deleted owner
// while stored old snapshots never do; the server security baseline is unchanged; and shared storage stays
// out of AccountFacts / diffs / AccountContext / the LLM context.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, mock, test } from "node:test";
import { SqliteSnapshotStore, buildLlmContext } from "@wowsync-dashboard/core";
import { createApp } from "../src/app.ts";
import { LOOPBACK_HOSTNAMES, listenOnce, resolveHost } from "../src/net.ts";
import { BIG_ID, guild, warband } from "../../core/test/sharedStorageBuilders.ts";
import { renderExport, type ExportSpec } from "../../core/test/sharedStorageExports.ts";
import { NARROW, T, VIREK_1, VIREK_2, WIDE, mats } from "../../core/test/sharedStorageHarness.ts";

const CLOCK_MS = 1_800_000_000_000;
const NOW = 1_800_000_100;
const WARBAND_KEY = "retail::warband::local";
const KEY_X = "retail::guild::111";
const KEY_Y = "retail::guild::222";

before(() => mock.timers.enable({ apis: ["Date"], now: CLOCK_MS }));
after(() => mock.timers.reset());

// --- harness ----------------------------------------------------------------------------------------------

interface Reply {
  status: number;
  body: any;
  text: string;
  headers: http.IncomingHttpHeaders;
}

interface Client {
  port: number;
  store: SqliteSnapshotStore;
  get(path: string): Promise<Reply>;
  del(path: string, body?: unknown, options?: { headers?: Record<string, string>; rawBody?: string }): Promise<Reply>;
  imp(spec: ExportSpec | string): Promise<Reply>;
  /** A request with full control of headers (Host / Origin), which fetch will not allow. */
  raw(opts: { method?: string; path: string; headers?: Record<string, string>; body?: string }): Promise<Reply>;
  shared(): Promise<any>;
  ownerKeys(): Promise<string[]>;
}

function rawRequest(port: number, opts: { method?: string; path: string; headers?: Record<string, string>; body?: string }): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Host: `127.0.0.1:${port}`, ...opts.headers };
    // Node does not frame a DELETE body on its own: state the length explicitly.
    if (opts.body !== undefined) headers["Content-Length"] = String(Buffer.byteLength(opts.body));
    const req = http.request({ host: "127.0.0.1", port, method: opts.method ?? "GET", path: opts.path, headers }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => {
        let body: unknown;
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
        resolve({ status: res.statusCode ?? 0, body, text, headers: res.headers });
      });
    });
    req.on("error", reject);
    req.end(opts.body);
  });
}

const closeServer = (server: http.Server) => new Promise<void>((r) => server.close(() => r()));

/** An in-process app on an ephemeral loopback port. `file` makes the database survive across servers (a restart); `guarded` turns on the Host/Origin guard exactly like a default loopback bind. */
async function withServer(options: { file?: string; guarded?: boolean }, run: (c: Client) => Promise<void>): Promise<void> {
  const store = new SqliteSnapshotStore(options.file ?? ":memory:");
  const app = createApp(store, 0, undefined, options.guarded ? { allowedHosts: LOOPBACK_HOSTNAMES } : {});
  const server = await listenOnce(app, "127.0.0.1", 0);
  const port = (server.address() as AddressInfo).port;
  const client: Client = {
    port,
    store,
    get: (path) => rawRequest(port, { path }),
    del: (path, body, o = {}) =>
      rawRequest(port, {
        method: "DELETE",
        path,
        headers: { ...(body !== undefined && o.rawBody === undefined ? { "Content-Type": "application/json" } : {}), ...o.headers },
        body: o.rawBody ?? (body !== undefined ? JSON.stringify(body) : undefined),
      }),
    imp: (spec) =>
      rawRequest(port, {
        method: "POST",
        path: "/api/import",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: typeof spec === "string" ? spec : renderExport(spec) }),
      }),
    raw: (opts) => rawRequest(port, opts),
    shared: async () => (await rawRequest(port, { path: `/api/shared-storage?now=${NOW}` })).body,
    ownerKeys: async () => {
      const r = (await rawRequest(port, { path: `/api/shared-storage?now=${NOW}` })).body;
      return [...(r.warband ? [r.warband.owner.ownerKey] : []), ...r.guilds.map((g: any) => g.owner.ownerKey)];
    },
  };
  try {
    await run(client);
  } finally {
    await closeServer(server);
    store.close();
  }
}

const confirm = (key: string) => ({ confirmOwnerKey: key });
const path = (id: string) => `/api/shared-storage/guilds/${encodeURIComponent(id)}`;

/** Three owners: Warband (Alpha live + Bravo replay), Guild X (same two carriers), Guild Y (Charlie). */
async function seed(c: Client) {
  await c.imp({ name: "Alpha", realm: "Cairne", generated: T + 10, warband: warband({ observedAt: T, items: mats() }), guild: guild({ clubId: "111", name: "Guild X", observedAt: T, tabs: WIDE }) });
  await c.imp({ name: "Bravo", realm: "Thrall", generated: T + 500, warband: warband({ observedAt: T, state: "LAST_SEEN", items: mats() }), guild: guild({ clubId: "111", name: "Guild X", observedAt: T, state: "LAST_SEEN", tabs: WIDE }) });
  await c.imp({ name: "Charlie", realm: "Cairne", generated: T + 900, guild: guild({ clubId: "222", name: "Guild Y", observedAt: T + 800, tabs: NARROW }) });
}

function withTempFile(run: (file: string) => Promise<void>): Promise<void> {
  const folder = mkdtempSync(join(tmpdir(), "wowsync-c4-"));
  return run(join(folder, "c4.sqlite")).finally(() => rmSync(folder, { recursive: true, force: true }));
}

// =============================================================================================================
// READ
// =============================================================================================================

test("GET on an empty journal succeeds with a stable empty shape (never a 404)", async () => {
  await withServer({}, async (c) => {
    const r = await c.get(`/api/shared-storage?now=${NOW}`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { schema: "shared-storage-1", asOf: NOW, warband: null, guilds: [] });
    assert.equal((await c.get("/api/shared-storage")).status, 200, "and without ?now");
  });
});

test("GET rejects an invalid ?now like /api/account-context does", async () => {
  await withServer({}, async (c) => {
    for (const bad of ["abc", "", "NaN"]) assert.equal((await c.get(`/api/shared-storage?now=${bad}`)).status, 400, bad);
  });
});

test("[REAL] the Warband projection after the first Virek export: identity, DERIVED basis, observation, coverage, provenance", async () => {
  await withServer({}, async (c) => {
    assert.equal((await c.imp(VIREK_1)).status, 200);
    const r = await c.get("/api/shared-storage?now=1789970000");
    assert.equal(r.status, 200);
    const w = r.body.warband;
    assert.deepEqual(w.owner, { kind: "warband", ownerKey: WARBAND_KEY, accountScope: "installation-local" });
    assert.equal(w.basis, "DERIVED");
    assert.deepEqual(r.body.guilds, [], "the UNKNOWN [GUILD BANK] created no guild owner");
    assert.equal(w.latestPartial, null);
    assert.equal(w.broaderCoverageEarlier, null);
    assert.equal(w.conflict, null);
    assert.deepEqual(w.observationCount, { total: 1, complete: 1, partial: 0, informationless: 0 });

    const cur = w.current;
    assert.equal(cur.claimedObservedAt, 1789965174);
    assert.equal(cur.effectiveObservedAt, 1789965174);
    assert.equal(cur.claimedAfterCarrier, false);
    assert.equal(cur.ageSeconds, 1789970000 - 1789965174);
    assert.equal(cur.freshness, "recent");
    assert.equal(cur.completeness, "complete");
    assert.equal(cur.informative, true);
    assert.equal(cur.liveAtExport, false, "LAST_SEEN first: nobody saw it open");
    assert.deepEqual(cur.carrierStates, ["LAST_SEEN"]);
    assert.match(cur.contentHash, /^[0-9a-f]{64}$/);
    assert.deepEqual(cur.coverage, { observedTabs: [], inaccessibleTabs: [], unconfirmedTabs: [], unidentifiedTabs: 0, observedContainerIds: [12] });
    assert.equal(cur.content.items.length, 98);
    assert.equal(cur.content.purchasedTabs, 1);
    assert.equal(cur.content.freeSlots, 0, "an OBSERVED 0 is present");
    assert.equal(cur.content.totalSlots, 98);
    assert.deepEqual(cur.provenance, {
      totalSources: 1,
      totalCharacters: 1,
      truncated: false,
      sources: [{ characterName: "Virek", characterRealm: "Cairne", characterIdentityKey: "retail::cairne::virek", carrierState: "LAST_SEEN", exportObservedAt: 1789965184, snapshotVisit: 1789965173, visitedNpc: "Elana", visitedZone: "Silvermoon City" }],
    });
  });
});

test("[REAL] the second Virek export adds a SOURCE, never a second observation", async () => {
  await withServer({}, async (c) => {
    await c.imp(VIREK_1);
    await c.imp(VIREK_2);
    const w = (await c.shared()).warband;
    assert.equal(w.observationCount.total, 1);
    assert.equal(w.current.provenance.totalSources, 2);
    assert.equal(w.current.provenance.totalCharacters, 1);
    assert.deepEqual(w.current.provenance.sources.map((s: any) => s.exportObservedAt), [1789965777, 1789965184], "newest export first");
    assert.equal(w.current.effectiveObservedAt, 1789965174, "the observation time is not advanced by replays");
  });
});

test("a guild projection carries the opaque GuildClubID as identity and the guild name as display data", async () => {
  await withServer({}, async (c) => {
    await c.imp({ name: "Alpha", generated: T + 10, guild: guild({ clubId: BIG_ID, name: "Fixture Guild", observedAt: T, tabs: WIDE }) });
    const r = await c.get(`/api/shared-storage?now=${NOW}`);
    assert.equal(r.body.warband, null);
    assert.equal(r.body.guilds.length, 1);
    const g = r.body.guilds[0];
    assert.deepEqual(g.owner, { kind: "guild", ownerKey: `retail::guild::${BIG_ID}`, guildClubId: BIG_ID, guildName: "Fixture Guild" });
    assert.equal(g.basis, "DERIVED");
    assert.deepEqual(g.current.coverage.observedTabs, [1, 2, 3, 4]);
    assert.deepEqual(g.current.content.tabs.map((t: any) => t.name).sort(), ["Consumables", "Materials", "Officers", "Raid"]);
    assert.equal(g.current.content.tabs.length, 4);
    assert.equal(g.current.content.items.length, 4);
  });
});

test("several guilds are listed sorted by owner key, independent of the Warband", async () => {
  await withServer({}, async (c) => {
    await seed(c);
    const r = await c.get(`/api/shared-storage?now=${NOW}`);
    assert.equal(r.body.warband.owner.ownerKey, WARBAND_KEY);
    assert.deepEqual(r.body.guilds.map((g: any) => g.owner.ownerKey), [KEY_X, KEY_Y]);
    assert.deepEqual(r.body.guilds.map((g: any) => g.owner.guildName), ["Guild X", "Guild Y"]);
    assert.equal(r.body.guilds[0].current.provenance.totalSources, 2);
    assert.equal(r.body.guilds[1].current.provenance.totalSources, 1);
  });
});

test("an OBSERVED carrier plus a LAST_SEEN replay: one observation, both carrier states, live at export", async () => {
  await withServer({}, async (c) => {
    await seed(c);
    const cur = (await c.shared()).warband.current;
    assert.deepEqual(cur.carrierStates, ["LAST_SEEN", "OBSERVED"]);
    assert.equal(cur.liveAtExport, true);
    assert.equal(cur.effectiveObservedAt, T);
  });
});

test("provenance is BOUNDED and deterministic: the total is exact, the list is the 10 most recent exports, newest first", async () => {
  await withServer({}, async (c) => {
    for (let i = 0; i < 13; i++) {
      await c.imp({ name: `Char${String(i).padStart(2, "0")}`, generated: T + 100 + i * 10, warband: warband({ observedAt: T, state: "LAST_SEEN", items: mats() }) });
    }
    const first = (await c.shared()).warband;
    const p = first.current.provenance;
    assert.equal(first.observationCount.total, 1);
    assert.equal(p.totalSources, 13);
    assert.equal(p.totalCharacters, 13);
    assert.equal(p.truncated, true);
    assert.equal(p.sources.length, 10);
    assert.deepEqual(p.sources.map((s: any) => s.exportObservedAt), Array.from({ length: 10 }, (_, i) => T + 100 + (12 - i) * 10));
    assert.equal(p.sources[0].characterName, "Char12");
    assert.deepEqual((await c.shared()).warband, first, "the same request answers identically");
  });
});

test("provenance ties (same export time) are ordered deterministically by character", async () => {
  await withServer({}, async (c) => {
    await c.imp({ name: "Zed", generated: T + 100, warband: warband({ observedAt: T, state: "LAST_SEEN", items: mats() }) });
    await c.imp({ name: "Abe", generated: T + 100, level: 2, warband: warband({ observedAt: T, state: "LAST_SEEN", items: mats() }) });
    const names = (await c.shared()).warband.current.provenance.sources.map((s: any) => s.characterName);
    assert.deepEqual(names, ["Abe", "Zed"]);
  });
});

test("a newer PARTIAL is exposed separately and never merged into the complete current observation", async () => {
  await withServer({}, async (c) => {
    await c.imp({ name: "Alpha", generated: T + 10, guild: guild({ clubId: "111", observedAt: T, tabs: [{ id: 1, name: "A", items: [["Complete item", 1]] }] }) });
    await c.imp({ name: "Alpha", generated: T + 3010, level: 2, guild: guild({ clubId: "111", observedAt: T + 3000, completeness: "partial", tabs: [{ id: 1, name: "A", items: [["Partial item", 1]] }, { id: 2, name: "B", state: "UNKNOWN" }] }) });
    const g = (await c.shared()).guilds[0];
    assert.equal(g.current.completeness, "complete");
    assert.deepEqual(g.current.content.items.map((i: any) => i.name), ["Complete item"]);
    assert.equal(g.latestPartial.completeness, "partial");
    assert.deepEqual(g.latestPartial.content.items.map((i: any) => i.name), ["Partial item"]);
    assert.deepEqual(g.latestPartial.coverage.unconfirmedTabs, [2]);
    assert.deepEqual(g.observationCount, { total: 2, complete: 1, partial: 1, informationless: 0 });
  });
});

test("broaderCoverageEarlier is exposed for a newer NARROWER guild observation, with nothing spliced", async () => {
  await withServer({}, async (c) => {
    await c.imp({ name: "Officer", generated: T + 10, guild: guild({ clubId: "111", observedAt: T, tabs: WIDE }) });
    await c.imp({ name: "Member", generated: T + 2010, guild: guild({ clubId: "111", observedAt: T + 2000, tabs: NARROW }) });
    const g = (await c.shared()).guilds[0];
    assert.equal(g.current.effectiveObservedAt, T + 2000);
    assert.deepEqual(g.current.coverage.observedTabs, [1, 2]);
    assert.deepEqual(g.current.coverage.inaccessibleTabs, [3, 4]);
    assert.deepEqual(g.current.content.items.map((i: any) => i.name).sort(), ["Health Potion", "Linen Cloth"]);
    assert.equal(g.broaderCoverageEarlier.effectiveObservedAt, T);
    assert.deepEqual(g.broaderCoverageEarlier.coverage.observedTabs, [1, 2, 3, 4]);
    assert.ok(g.broaderCoverageEarlier.content.items.some((i: any) => i.name === "Officer Sword"));
  });
});

test("a same-second conflict is represented: current picked by a fixed rule, the others listed", async () => {
  await withServer({}, async (c) => {
    await c.imp({ name: "A", generated: T + 10, guild: guild({ clubId: "111", observedAt: T, tabs: [{ id: 1, name: "Materials", items: [["X", 1]] }] }) });
    await c.imp({ name: "B", generated: T + 10, guild: guild({ clubId: "111", observedAt: T, tabs: [{ id: 1, name: "Materials", items: [["X", 2]] }] }) });
    const g = (await c.shared()).guilds[0];
    assert.equal(g.conflict.effectiveObservedAt, T);
    assert.equal(g.conflict.others.length, 1);
    assert.notEqual(g.conflict.others[0].contentHash, g.current.contentHash);
    assert.ok(g.current.contentHash < g.conflict.others[0].contentHash, "the smaller content hash wins, not arrival order");
  });
});

test("INACCESSIBLE guild tabs stay inaccessible (never empty), and an informationless observation is current-less but still names the guild", async () => {
  await withServer({}, async (c) => {
    await c.imp({ name: "Alpha", generated: T + 10, guild: guild({ clubId: "111", observedAt: T, tabs: NARROW }) });
    const g1 = (await c.shared()).guilds[0];
    assert.deepEqual(g1.current.content.tabs.filter((t: any) => t.state === "INACCESSIBLE").map((t: any) => [t.id, t.viewable]), [[3, false], [4, false]]);
    assert.equal(g1.current.content.itemsKnownEmpty, false);

    await withServer({}, async (d) => {
      await d.imp({ name: "Alpha", generated: T + 10, guild: guild({ clubId: "333", name: "Locked Guild", observedAt: T, tabs: [{ id: 1, name: "A", state: "INACCESSIBLE" }] }) });
      const g = (await d.shared()).guilds[0];
      assert.equal(g.current, null, "unknown, not empty");
      assert.equal(g.owner.guildName, "Locked Guild");
      assert.deepEqual(g.observationCount, { total: 1, complete: 1, partial: 0, informationless: 1 });
    });
  });
});

test("an UNKNOWN scalar is omitted, never 0: a section that never reported free slots has no freeSlots key", async () => {
  await withServer({}, async (c) => {
    const w = warband({ observedAt: T, items: mats() });
    w.freeSlots = undefined;
    w.purchasedBankTabs = undefined;
    w.snapshotVisit = undefined;
    await c.imp({ name: "Alpha", generated: T + 10, warband: w });
    const content = (await c.shared()).warband.current.content;
    assert.equal("freeSlots" in content, false);
    assert.equal("purchasedTabs" in content, false);
    assert.equal(content.totalSlots, 98);
    // The same holds for provenance: this carrier reported no SnapshotVisit / visit NPC / zone, so those keys are absent (never 0 or "").
    const source = (await c.shared()).warband.current.provenance.sources[0];
    assert.deepEqual(Object.keys(source).sort(), ["carrierState", "characterIdentityKey", "characterName", "characterRealm", "exportObservedAt"]);
  });
});

test("opaque GuildClubIDs survive exactly: above 2^53, its JS-number sibling, and scientific-notation-looking text", async () => {
  await withServer({}, async (c) => {
    const ids = [BIG_ID, "18014398509481984", "1.8014398509482e+16"];
    for (const [i, id] of ids.entries()) await c.imp({ name: "Alpha", generated: T + 10 + i, level: i + 1, guild: guild({ clubId: id, observedAt: T + i, tabs: [{ id: 1, name: "A", items: [["X", 1]] }] }) });
    const r = await c.get(`/api/shared-storage?now=${NOW}`);
    assert.deepEqual(r.body.guilds.map((g: any) => g.owner.guildClubId).sort(), [...ids].sort());
    for (const id of ids) assert.ok(r.text.includes(`"guildClubId":"${id}"`), `${id} is a JSON string, byte for byte`);
    assert.equal(r.body.guilds.length, 3, "three distinct owners although two ids are the same JS number");
  });
});

test("the projection survives a server restart unchanged", async () => {
  await withTempFile(async (file) => {
    let before: unknown;
    await withServer({ file }, async (c) => {
      await seed(c);
      before = (await c.get(`/api/shared-storage?now=${NOW}`)).body;
    });
    await withServer({ file }, async (c) => {
      assert.deepEqual((await c.get(`/api/shared-storage?now=${NOW}`)).body, before);
    });
  });
});

test("no database ids leak: no row id, snapshot id, observation id or snake_case key anywhere outside the observation content", async () => {
  await withServer({}, async (c) => {
    await seed(c);
    await c.imp(VIREK_1);
    const banned = new Set(["id", "rowid", "snapshotId", "snapshot_id", "observationId", "observation_id", "characterId", "character_id", "identity"]);
    const walk = (value: unknown, where: string) => {
      if (Array.isArray(value)) return value.forEach((v, i) => walk(v, `${where}[${i}]`));
      if (value && typeof value === "object") {
        for (const [k, v] of Object.entries(value)) {
          if (k === "content") continue; // tab/container ids inside an observation are the game's, not ours
          assert.equal(banned.has(k), false, `${where}.${k}`);
          assert.equal(/_/.test(k), false, `${where}.${k} (snake_case)`);
          walk(v, `${where}.${k}`);
        }
      }
    };
    walk((await c.get(`/api/shared-storage?now=${NOW}`)).body, "$");
  });
});

// --- damaged journal ----------------------------------------------------------------------------------------------

test("a corrupt journal FAILS LOUDLY with a distinct code, names the damaged owners, and leaks no stack or SQL", async () => {
  await withTempFile(async (file) => {
    await withServer({ file }, async (c) => {
      await seed(c);
      const raw = new DatabaseSync(file);
      raw.exec(`UPDATE shared_observations SET content_json = '{not json' WHERE owner_key = '${WARBAND_KEY}'`);
      raw.exec(`UPDATE shared_observations SET owner_json = 'garbage' WHERE owner_key = '${KEY_X}'`);
      raw.close();

      const r = await c.get(`/api/shared-storage?now=${NOW}`);
      assert.equal(r.status, 500);
      assert.equal(r.body.code, "SHARED_STORAGE_INTEGRITY");
      assert.deepEqual(r.body.damagedOwners, [
        { ownerKey: KEY_X, kind: "guild", guildClubId: "111" },
        { ownerKey: WARBAND_KEY, kind: "warband" },
      ]);
      assert.match(r.body.error, /integrity check/);
      assert.match(r.body.error, /nothing was skipped or guessed/);
      for (const leak of ["SELECT", "content_json", "owner_json", "not json", "    at ", "sqlite", ".ts:"]) assert.equal(r.text.includes(leak), false, `response must not contain "${leak}"`);
      assert.equal("warband" in r.body, false, "the corrupt owner is not silently omitted from a partial answer");
    });
  });
});

test("a corrupt journal blocks an import that touches the damaged owner (whole import rolled back), but not one with no shared storage", async () => {
  await withTempFile(async (file) => {
    await withServer({ file }, async (c) => {
      await c.imp({ name: "Alpha", generated: T + 10, warband: warband({ observedAt: T, items: mats() }) });
      const raw = new DatabaseSync(file);
      raw.exec("UPDATE shared_observations SET content_json = 'x'");
      raw.close();

      const blocked = await c.imp({ name: "Beta", generated: T + 20, warband: warband({ observedAt: T + 10, items: [["New", 1]] }) });
      assert.equal(blocked.status, 500);
      assert.equal(blocked.body.code, "SHARED_STORAGE_INTEGRITY");
      assert.match(blocked.body.error, /NOT imported/);
      assert.equal(c.store.getCharacter("retail::cairne::beta"), undefined, "no snapshot or character was stored");

      const fine = await c.imp({ name: "Gamma", generated: T + 30 }); // both shared sections UNKNOWN: nothing to reconcile
      assert.equal(fine.status, 200);
    });
  });
});

// =============================================================================================================
// DELETE
// =============================================================================================================

test("DELETE the Warband: confirmed, counts reported, gone from GET, guilds and snapshots untouched", async () => {
  await withServer({}, async (c) => {
    await seed(c);
    const snapshots = c.store.listCharacters("retail").map((ch) => ch.snapshotCount);
    const r = await c.del("/api/shared-storage/warband", confirm(WARBAND_KEY));
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { deleted: { owner: { kind: "warband", ownerKey: WARBAND_KEY, accountScope: "installation-local" }, existed: true, observationsDeleted: 1, sourcesDeleted: 2 } });
    assert.deepEqual(await c.ownerKeys(), [KEY_X, KEY_Y]);
    assert.deepEqual(c.store.listCharacters("retail").map((ch) => ch.snapshotCount), snapshots);
  });
});

test("DELETE a guild leaves the other guild and the Warband; DELETE the Warband leaves the guilds", async () => {
  await withServer({}, async (c) => {
    await seed(c);
    const r = await c.del(path("111"), confirm(KEY_X));
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.deleted, { owner: { kind: "guild", ownerKey: KEY_X, guildClubId: "111" }, existed: true, observationsDeleted: 1, sourcesDeleted: 2 });
    assert.deepEqual(await c.ownerKeys(), [WARBAND_KEY, KEY_Y], "Guild Y and the Warband remain");
    assert.equal((await c.del("/api/shared-storage/warband", confirm(WARBAND_KEY))).status, 200);
    assert.deepEqual(await c.ownerKeys(), [KEY_Y], "Guild Y remains");
  });
});

test("deleting a CHARACTER never deletes shared history; the explicit owner delete does", async () => {
  await withServer({}, async (c) => {
    await seed(c);
    const before = await c.shared();
    assert.equal((await c.del("/api/characters/retail%3A%3Acairne%3A%3Aalpha", { confirmIdentityKey: "retail::cairne::alpha" })).status, 200);
    assert.deepEqual(await c.shared(), before, "identical, including the deleted character's provenance");
    assert.equal((await c.del("/api/shared-storage/warband", confirm(WARBAND_KEY))).status, 200);
    assert.equal((await c.shared()).warband, null);
  });
});

test("a nonexistent owner follows the character contract: 404 with a stable code, nothing deleted (also on repeat)", async () => {
  await withServer({}, async (c) => {
    let r = await c.del("/api/shared-storage/warband", confirm(WARBAND_KEY));
    assert.equal(r.status, 404);
    assert.equal(r.body.code, "SHARED_OWNER_NOT_FOUND");
    await seed(c);
    r = await c.del(path("999"), confirm("retail::guild::999"));
    assert.equal(r.status, 404);
    assert.equal(r.body.code, "SHARED_OWNER_NOT_FOUND");
    assert.deepEqual(await c.ownerKeys(), [WARBAND_KEY, KEY_X, KEY_Y]);
    assert.equal((await c.del("/api/shared-storage/warband", confirm(WARBAND_KEY))).status, 200);
    assert.equal((await c.del("/api/shared-storage/warband", confirm(WARBAND_KEY))).status, 404, "already deleted");
  });
});

test("malformed guild ids are rejected with 400 before anything is touched: padded, whitespace-only, control, over-long, bad percent-encoding", async () => {
  await withServer({}, async (c) => {
    await seed(c);
    const before = await c.shared();
    const cases: Array<[string, string]> = [
      ["padded left", "/api/shared-storage/guilds/%20111"],
      ["padded right", "/api/shared-storage/guilds/111%20"],
      ["whitespace only", "/api/shared-storage/guilds/%20"],
      ["tab", "/api/shared-storage/guilds/%09"],
      ["control character", "/api/shared-storage/guilds/1%0111"],
      ["over-long", `/api/shared-storage/guilds/${"1".repeat(201)}`],
    ];
    for (const [label, p] of cases) {
      const r = await c.del(p, confirm(KEY_X));
      assert.equal(r.status, 400, label);
      assert.equal(r.body.code, "INVALID_GUILD_CLUB_ID", label);
    }
    const bad = await c.del("/api/shared-storage/guilds/%E0%A4%A", confirm(KEY_X));
    assert.equal(bad.status, 400, "a malformed percent-encoding is the client's mistake");
    assert.equal((await c.del("/api/shared-storage/guilds/", confirm(KEY_X))).status, 404, "an empty id matches no route");
    assert.deepEqual(await c.shared(), before, "nothing was deleted");
  });
});

test("an id above 2^53 is matched as text: deleting it leaves the sibling id that is the same JS number", async () => {
  await withServer({}, async (c) => {
    const sibling = "18014398509481984";
    await c.imp({ name: "Alpha", generated: T + 10, guild: guild({ clubId: BIG_ID, observedAt: T, tabs: WIDE }) });
    await c.imp({ name: "Alpha", generated: T + 20, level: 2, guild: guild({ clubId: sibling, observedAt: T + 5, tabs: NARROW }) });
    const r = await c.del(path(BIG_ID), confirm(`retail::guild::${BIG_ID}`));
    assert.equal(r.status, 200);
    assert.equal(r.body.deleted.owner.guildClubId, BIG_ID);
    assert.deepEqual(await c.ownerKeys(), [`retail::guild::${sibling}`]);
    assert.equal((await c.del(path(BIG_ID), confirm(`retail::guild::${BIG_ID}`))).status, 404, "the sibling was not what got deleted");
  });
});

test("a scientific-notation-looking id is opaque text, whether the '+' arrives encoded or not", async () => {
  await withServer({}, async (c) => {
    const sci = "1.8014398509482e+16";
    await c.imp({ name: "Alpha", generated: T + 10, guild: guild({ clubId: sci, observedAt: T, tabs: WIDE }) });
    await c.imp({ name: "Alpha", generated: T + 20, level: 2, guild: guild({ clubId: "18014398509482000", observedAt: T + 5, tabs: NARROW }) });
    assert.equal((await c.del(`/api/shared-storage/guilds/${sci}`, confirm(`retail::guild::${sci}`))).status, 200, "raw +");
    await c.imp({ name: "Alpha", generated: T + 30, level: 3, guild: guild({ clubId: sci, observedAt: T + 25, tabs: WIDE }) });
    assert.equal((await c.del(path(sci), confirm(`retail::guild::${sci}`))).status, 200, "encoded %2B");
    assert.deepEqual(await c.ownerKeys(), ["retail::guild::18014398509482000"], "its numeric expansion is a different owner and untouched");
  });
});

test("confirmation is required and must name exactly the owner in the URL; a display guild name is never identity", async () => {
  await withServer({}, async (c) => {
    await seed(c);
    const before = await c.shared();
    const required: Array<[string, Reply]> = [
      ["no body", await c.del("/api/shared-storage/warband")],
      ["empty object", await c.del("/api/shared-storage/warband", {})],
      ["empty key", await c.del("/api/shared-storage/warband", confirm(""))],
      ["non-string key", await c.del("/api/shared-storage/warband", { confirmOwnerKey: 42 })],
      ["guild name only", await c.del(path("111"), { guildName: "Guild X" })],
      ["text/plain body", await c.del(path("111"), undefined, { rawBody: JSON.stringify(confirm(KEY_X)), headers: { "Content-Type": "text/plain" } })],
    ];
    for (const [label, r] of required) {
      assert.equal(r.status, 400, label);
      assert.equal(r.body.code, "CONFIRMATION_REQUIRED", label);
    }
    const mismatched: Array<[string, Reply]> = [
      ["another guild's key", await c.del(path("111"), confirm(KEY_Y))],
      ["the warband key on a guild route", await c.del(path("111"), confirm(WARBAND_KEY))],
      ["a guild key on the warband route", await c.del("/api/shared-storage/warband", confirm(KEY_X))],
      ["right name, wrong id", await c.del(path("111"), { confirmOwnerKey: KEY_Y, guildName: "Guild X" })],
    ];
    for (const [label, r] of mismatched) {
      assert.equal(r.status, 400, label);
      assert.equal(r.body.code, "CONFIRMATION_MISMATCH", label);
    }
    assert.deepEqual(await c.shared(), before, "nothing was deleted by any of them");

    const ok = await c.del(path("111"), { confirmOwnerKey: KEY_X, guildName: "A completely different name" });
    assert.equal(ok.status, 200, "a wrong display name neither blocks nor changes which guild is deleted");
    assert.equal(ok.body.deleted.owner.guildClubId, "111");
    assert.equal(ok.body.deleted.owner.guildName, undefined, "the response never echoes a client-supplied name as identity");
  });
});

test("a corrupt owner can still be deleted (deletion never parses journal content), after which the journal reads again", async () => {
  await withTempFile(async (file) => {
    await withServer({ file }, async (c) => {
      await seed(c);
      const raw = new DatabaseSync(file);
      raw.exec(`UPDATE shared_observations SET content_json = '{not json' WHERE owner_key = '${WARBAND_KEY}'`);
      raw.close();
      assert.equal((await c.get(`/api/shared-storage?now=${NOW}`)).status, 500);

      const r = await c.del("/api/shared-storage/warband", confirm(WARBAND_KEY));
      assert.equal(r.status, 200);
      assert.deepEqual([r.body.deleted.observationsDeleted, r.body.deleted.sourcesDeleted], [1, 2]);
      const after = await c.get(`/api/shared-storage?now=${NOW}`);
      assert.equal(after.status, 200);
      assert.deepEqual(after.body.guilds.map((g: any) => g.owner.ownerKey), [KEY_X, KEY_Y]);
      assert.equal(after.body.warband, null);
    });
  });
});

test("a genuinely NEW export after deletion recreates the owner; an already-stored export is a duplicate and restores nothing", async () => {
  await withServer({}, async (c) => {
    await c.imp(VIREK_1);
    assert.equal((await c.del("/api/shared-storage/warband", confirm(WARBAND_KEY))).status, 200);
    const dup = await c.imp(VIREK_1);
    assert.equal(dup.body.result.isDuplicate, true);
    assert.equal((await c.shared()).warband, null, "a duplicate import is not new evidence");

    const fresh = await c.imp(VIREK_2.replaceAll("1789965777", "1789969999"));
    assert.equal(fresh.body.result.sharedStorage[0].outcome, "recorded");
    const w = (await c.shared()).warband;
    assert.equal(w.current.provenance.totalSources, 1, "only the new export is a source");
    assert.equal(w.current.effectiveObservedAt, 1789965174, "the addon replays the same observation; its time is not advanced");
  });
});

test("historical snapshots never recreate a deleted owner, even after a restart with a lost backfill marker", async () => {
  await withTempFile(async (file) => {
    await withServer({ file }, async (c) => {
      await c.imp(VIREK_1);
      await c.imp(VIREK_2);
      assert.equal((await c.del("/api/shared-storage/warband", confirm(WARBAND_KEY))).status, 200);
    });
    const raw = new DatabaseSync(file);
    raw.exec("DELETE FROM store_meta"); // the automatic backfill will run again on the next start
    raw.close();
    await withServer({ file }, async (c) => {
      assert.equal((await c.shared()).warband, null);
      assert.equal(c.store.listSnapshots("retail::cairne::virek").length, 2, "the snapshots that still carry the observation are untouched");
    });
  });
});

// =============================================================================================================
// SECURITY (the existing baseline applies to the new routes, unchanged)
// =============================================================================================================

test("Host guard: a rebinding hostname is refused on the read and the delete route, and nothing is deleted", async () => {
  await withServer({ guarded: true }, async (c) => {
    await seed(c);
    const before = await c.shared();
    for (const host of ["evil.example", `127.0.0.1.evil.example:${c.port}`, `192.168.1.5:${c.port}`]) {
      const read = await c.raw({ path: "/api/shared-storage", headers: { Host: host } });
      assert.equal(read.status, 403, host);
      assert.equal(read.body.code, "HOST_NOT_ALLOWED");
      const del = await c.raw({ method: "DELETE", path: "/api/shared-storage/warband", headers: { Host: host, "Content-Type": "application/json" }, body: JSON.stringify(confirm(WARBAND_KEY)) });
      assert.equal(del.status, 403, host);
    }
    assert.deepEqual(await c.shared(), before);
    for (const host of [`localhost:${c.port}`, `127.0.0.1:${c.port}`, `[::1]:${c.port}`]) {
      assert.equal((await c.raw({ path: "/api/shared-storage", headers: { Host: host } })).status, 200, host);
    }
  });
});

test("Origin guard: a state-changing request from a foreign Origin is refused; same-origin and Origin-less ones pass", async () => {
  await withServer({ guarded: true }, async (c) => {
    await seed(c);
    const headers = (origin?: string) => ({ "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) });
    const del = (origin?: string) => c.raw({ method: "DELETE", path: "/api/shared-storage/warband", headers: headers(origin), body: JSON.stringify(confirm(WARBAND_KEY)) });
    for (const evil of ["https://evil.example", "null", "http://192.168.1.5:4173"]) {
      const r = await del(evil);
      assert.equal(r.status, 403, evil);
      assert.equal(r.body.code, "HOST_NOT_ALLOWED");
    }
    assert.ok((await c.shared()).warband, "still there after every refused attempt");
    assert.equal((await del(`http://127.0.0.1:${c.port}`)).status, 200, "same origin");
    assert.equal((await c.del(path("111"), confirm(KEY_X))).status, 200, "no Origin at all (curl/scripts)");
  });
});

test("no CORS: no route sends an Access-Control-* header, a preflight is not granted, and a foreign Origin can read nothing cross-site", async () => {
  await withServer({ guarded: true }, async (c) => {
    await seed(c);
    const replies = [
      await c.raw({ path: "/api/shared-storage", headers: { Origin: "https://evil.example" } }),
      await c.raw({ method: "OPTIONS", path: "/api/shared-storage/warband", headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "DELETE" } }),
      await c.raw({ method: "OPTIONS", path: "/api/shared-storage", headers: { Origin: "http://localhost:5173", "Access-Control-Request-Method": "GET" } }),
      await c.raw({ method: "DELETE", path: "/api/shared-storage/warband", headers: { "Content-Type": "application/json", Origin: "https://evil.example" }, body: JSON.stringify(confirm(WARBAND_KEY)) }),
    ];
    for (const r of replies) {
      assert.deepEqual(Object.keys(r.headers).filter((h) => h.startsWith("access-control-")), [], `${r.status} must carry no CORS headers`);
    }
    assert.equal(replies[1].status === 200 || replies[1].status === 204, false, "a cross-origin preflight for DELETE is not granted");
    assert.ok((await c.shared()).warband);
  });
});

test("destructive requests need a JSON confirmation: a form-style body cannot delete (the same-origin model, unchanged)", async () => {
  await withServer({ guarded: true }, async (c) => {
    await seed(c);
    for (const contentType of ["application/x-www-form-urlencoded", "text/plain", "multipart/form-data; boundary=x"]) {
      const r = await c.raw({ method: "DELETE", path: "/api/shared-storage/warband", headers: { "Content-Type": contentType }, body: `confirmOwnerKey=${WARBAND_KEY}` });
      assert.equal(r.status, 400, contentType);
      assert.equal(r.body.code, "CONFIRMATION_REQUIRED", contentType);
    }
    assert.ok((await c.shared()).warband);
  });
});

function lanAddress(): string | undefined {
  for (const list of Object.values(os.networkInterfaces())) for (const i of list ?? []) if (i.family === "IPv4" && !i.internal) return i.address;
  return undefined;
}

function connectOutcome(host: string, port: number): Promise<"connected" | "refused"> {
  return new Promise((resolve) => {
    const s = net.connect({ host, port, timeout: 1500 });
    s.on("connect", () => (s.destroy(), resolve("connected")));
    s.on("error", () => resolve("refused"));
    s.on("timeout", () => (s.destroy(), resolve("refused")));
  });
}

test("LAN exposure is unchanged: with the default bind the shared-storage API answers on loopback only, and WOWSYNC_HOST=0.0.0.0 remains the explicit opt-in", async () => {
  const store = new SqliteSnapshotStore(":memory:");
  try {
    const app = createApp(store, 0);
    const local = await listenOnce(app, resolveHost({}).host, 0);
    try {
      const { address, port } = local.address() as AddressInfo;
      assert.equal(address, "127.0.0.1");
      assert.equal((await rawRequest(port, { path: "/api/shared-storage" })).status, 200);
      const lan = lanAddress();
      if (lan) assert.notEqual(await connectOutcome(lan, port), "connected", `${lan} must not reach a loopback-bound server`);
    } finally {
      await closeServer(local);
    }
    const open = await listenOnce(app, resolveHost({ WOWSYNC_HOST: "0.0.0.0" }).host, 0);
    try {
      const { port } = open.address() as AddressInfo;
      const lan = lanAddress();
      if (lan) assert.equal(await connectOutcome(lan, port), "connected");
    } finally {
      await closeServer(open);
    }
  } finally {
    store.close();
  }
});

// =============================================================================================================
// CONSUMER ISOLATION
// =============================================================================================================

test("shared storage stays OUT of AccountFacts, recent changes, AccountContext and the LLM context (byte-identical with and without shared sections)", async () => {
  const specs = (withShared: boolean): ExportSpec[] => [
    { name: "Alpha", realm: "Cairne", generated: T + 10, level: 1, ...(withShared ? { warband: warband({ observedAt: T, items: mats() }), guild: guild({ clubId: "111", name: "Guild X", observedAt: T, tabs: WIDE }) } : {}) },
    { name: "Alpha", realm: "Cairne", generated: T + 500, level: 2, ...(withShared ? { warband: warband({ observedAt: T + 400, items: [["Changed stock", 3]] }), guild: guild({ clubId: "111", name: "Guild X", observedAt: T + 400, tabs: NARROW }) } : {}) },
    { name: "Bravo", realm: "Thrall", generated: T + 900, level: 3, ...(withShared ? { guild: guild({ clubId: "222", name: "Guild Y", observedAt: T + 800, tabs: NARROW }) } : {}) },
  ];
  const world = async (withShared: boolean) => {
    let out = "";
    await withServer({}, async (c) => {
      for (const s of specs(withShared)) assert.equal((await c.imp(s)).status, 200);
      // Exercise the shared-storage API too: reading it must not change anything else.
      await c.get("/api/shared-storage");
      const context = (await c.get(`/api/account-context?now=${NOW}`)).body;
      out = JSON.stringify({
        facts: (await c.get("/api/versions/retail/account-facts")).body,
        changes: (await c.get("/api/versions/retail/recent-changes")).body,
        versions: (await c.get("/api/versions")).body,
        context,
        llm: buildLlmContext(context),
      });
      if (withShared) assert.equal((await c.shared()).guilds.length, 2, "the shared journal is populated in this run");
    });
    return out;
  };
  const withShared = await world(true);
  assert.equal(withShared, await world(false), "AccountFacts, recent changes, versions, AccountContext and the LLM context do not depend on shared storage");
  for (const shared of ["Linen Cloth", "Changed stock", "Officer Sword", "Guild X", "Guild Y", "18014398509481985"]) assert.equal(withShared.includes(shared), false, shared);
});
