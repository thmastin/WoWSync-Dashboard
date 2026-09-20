// API reliability: every failure is a JSON error the client can classify (never
// an HTML page, never a stack trace or filesystem path), invalid input is
// rejected rather than silently turned into an empty result, imports are
// idempotent over HTTP, and "unknown" is never serialised as zero.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SqliteSnapshotStore, type SnapshotStore } from "@wowsync-dashboard/core";
import { createApp } from "../src/app.ts";

const fixtures = fileURLToPath(new URL("../../core/test/fixtures/", import.meta.url));
const read = (path: string) => readFileSync(`${fixtures}${path}`, "utf8");

async function withApp(run: (base: string, store: SnapshotStore) => Promise<void>, storeOverride?: (s: SqliteSnapshotStore) => SnapshotStore) {
  const real = new SqliteSnapshotStore(":memory:");
  const store = storeOverride ? storeOverride(real) : real;
  const server = await new Promise<http.Server>((resolve) => {
    const s = http.createServer(createApp(store, 0));
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, store);
  } finally {
    await new Promise((r) => server.close(() => r(undefined)));
    real.close();
  }
}

async function json(res: Response) {
  const text = await res.text();
  assert.ok(res.headers.get("content-type")?.includes("application/json"), `expected JSON, got ${res.headers.get("content-type")}: ${text.slice(0, 80)}`);
  return JSON.parse(text);
}

const post = (base: string, text: string) =>
  fetch(`${base}/api/import`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });

// --- JSON errors, everywhere ---------------------------------------------------------------------

test("an unknown API path is a JSON 404, not Express's HTML page", async () => {
  await withApp(async (base) => {
    for (const path of ["/api/nope", "/api/versions/classic-era/nope", "/api"]) {
      const res = await fetch(base + path);
      assert.equal(res.status, 404, path);
      assert.equal((await json(res)).code, "NOT_FOUND");
    }
    // ...and non-GET methods on unknown routes likewise.
    const del = await fetch(`${base}/api/characters`, { method: "DELETE" });
    assert.equal(del.status, 404);
    assert.equal((await json(del)).code, "NOT_FOUND");
  });
});

test("an unexpected server error is a JSON 500 that leaks neither the message, a stack trace, nor a filesystem path", async () => {
  const saved = console.error;
  const logged: string[] = [];
  console.error = (...a: unknown[]) => logged.push(a.join(" "));
  try {
    await withApp(
      async (base) => {
        const res = await fetch(`${base}/api/versions`);
        assert.equal(res.status, 500);
        const text = await res.text();
        assert.deepEqual(JSON.parse(text), { error: "Internal server error." });
        assert.equal(/boom|D:\\|at .*\.ts|node_modules/.test(text), false, "nothing internal in the response body");
        assert.ok(logged.some((l) => l.includes("boom")), "the detail is logged server-side instead");
      },
      (real) =>
        Object.assign(real, {
          listVersions() {
            throw new Error("boom at D:\\secret\\path\\store.ts");
          },
        }),
    );
  } finally {
    console.error = saved;
  }
});

test("a malformed percent-encoded URL is a JSON 400 (Express's default is an HTML page with a stack trace)", async () => {
  await withApp(async (base) => {
    for (const method of ["GET", "DELETE"]) {
      const res = await fetch(`${base}/api/characters/%E0%A4%A`, { method });
      assert.equal(res.status, 400, method);
      const body = await json(res);
      assert.deepEqual(body, { error: "Bad request." });
    }
  });
});

test("malformed JSON bodies are a JSON 400 on every route that reads one", async () => {
  await withApp(async (base) => {
    for (const [method, path] of [["POST", "/api/import"], ["POST", "/api/ask"], ["DELETE", "/api/characters/x"]] as const) {
      const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json" }, body: "{ not json" });
      assert.equal(res.status, 400, `${method} ${path}`);
      assert.match((await json(res)).error, /JSON/);
    }
  });
});

// --- Input validation -------------------------------------------------------------------------------

test("recent-changes rejects an invalid limit instead of returning an empty or truncated list", async () => {
  await withApp(async (base) => {
    await post(base, read("classic-era/bromrik-1789170870.wowsync.txt"));
    await post(base, read("classic-era/bromrik-1789171621.wowsync.txt"));
    for (const bad of ["abc", "0", "-1", "501", "1.5", "", " ", "1e2", "NaN"]) {
      const res = await fetch(`${base}/api/versions/classic-era/recent-changes?limit=${encodeURIComponent(bad)}`);
      assert.equal(res.status, 400, `limit=${JSON.stringify(bad)}`);
      assert.match((await json(res)).error, /limit/);
    }
    const ok = await json(await fetch(`${base}/api/versions/classic-era/recent-changes?limit=5`));
    assert.equal(ok.changes.length, 1);
    assert.equal((await json(await fetch(`${base}/api/versions/classic-era/recent-changes`))).changes.length, 1);
  });
});

test("404s for a missing character carry a stable code, so a client can tell them from any other 404", async () => {
  await withApp(async (base) => {
    const get = await fetch(`${base}/api/characters/${encodeURIComponent("classic-era::x::nobody")}`);
    assert.equal(get.status, 404);
    assert.equal((await json(get)).code, "CHARACTER_NOT_FOUND");

    const key = "classic-era::x::nobody";
    const del = await fetch(`${base}/api/characters/${encodeURIComponent(key)}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmIdentityKey: key }),
    });
    assert.equal(del.status, 404);
    assert.equal((await json(del)).code, "CHARACTER_NOT_FOUND");
  });
});

// --- Import over HTTP -----------------------------------------------------------------------------------

test("[REAL] POST /api/import is idempotent: the second identical export is reported as a duplicate and stores nothing", async () => {
  await withApp(async (base) => {
    const a = read("classic-era/bromrik-1789170870.wowsync.txt");
    const b = read("classic-era/bromrik-1789171621.wowsync.txt");
    assert.equal((await post(base, a)).status, 200);
    const second = await json(await post(base, b));
    assert.equal(second.result.isDuplicate, false);
    assert.equal(second.result.diff.level.delta, 1);

    const again = await json(await post(base, b));
    assert.equal(again.result.isDuplicate, true);
    assert.equal(again.result.character.snapshotCount, 2);
    assert.equal(again.result.snapshot.id, second.result.snapshot.id);
    assert.equal(again.result.diff, undefined, "a duplicate carries no comparison");

    const key = encodeURIComponent(second.result.character.identityKey);
    assert.equal((await json(await fetch(`${base}/api/characters/${key}/snapshots`))).snapshots.length, 2);
    // The real +1 level transition is still what "recent changes" reports.
    const changes = (await json(await fetch(`${base}/api/versions/classic-era/recent-changes`))).changes;
    assert.equal(changes.length, 1);
    assert.equal(changes[0].diff.level.delta, 1);
  });
});

test("[REAL] importing an older export after a newer one does not become the current state and reports no reversed change", async () => {
  await withApp(async (base) => {
    await post(base, read("tbc-anniversary/voodan-1789492666.wowsync.txt")); // newer
    const older = await json(await post(base, read("tbc-anniversary/voodan-1789484723.wowsync.txt")));
    assert.equal(older.result.isLatest, false);
    assert.equal(older.result.isDuplicate, false);
    assert.equal(older.result.isFirstSnapshot, false);
    assert.equal(older.result.diff, undefined);

    const key = encodeURIComponent(older.result.character.identityKey);
    const { snapshots } = await json(await fetch(`${base}/api/characters/${key}/snapshots`));
    assert.deepEqual(snapshots.map((s: { generatedAt: number }) => s.generatedAt), [1789492666, 1789484723], "newest observation first");
    const { character } = await json(await fetch(`${base}/api/characters/${key}`));
    assert.equal(character.latestGeneratedAt, 1789492666);
  });
});

// --- Unknown is not zero on the wire ----------------------------------------------------------------------

test("/api/versions never fabricates a 0 total: empty and unobserved versions have no total, an observed zero does", async () => {
  await withApp(async (base) => {
    const empty = await json(await fetch(`${base}/api/versions`));
    for (const v of empty.versions) {
      assert.equal("totalMoneyCopper" in v, false, `${v.version}: no characters -> no total`);
      assert.equal("totalPlayedSeconds" in v, false);
      assert.equal(v.characterCount, 0);
    }

    // Tenivard's gold IS known (a real observed value) - the version reports a real total.
    await post(base, read("tbc-anniversary/tenivard-1789492580.wowsync.txt"));
    const after = await json(await fetch(`${base}/api/versions`));
    const tbc = after.versions.find((v: { version: string }) => v.version === "tbc-anniversary");
    assert.equal(typeof tbc.totalMoneyCopper, "number");
    assert.ok(tbc.charactersWithKnownGold >= 1);
    // ...while untouched versions still report none.
    assert.equal("totalMoneyCopper" in after.versions.find((v: { version: string }) => v.version === "retail"), false);
  });
});

test("the canonical account context declares schema 3 and explains realm-partitioned totals in-band", async () => {
  await withApp(async (base) => {
    await post(base, read("classic-era/bromrik-1789171621.wowsync.txt"));
    const ctx = await json(await fetch(`${base}/api/account-context`));
    assert.equal(ctx.schemaVersion, "3");
    assert.match(ctx.versions["classic-era"].scopeNote, /realm-partitioned/);
    assert.equal("scopeNote" in ctx.versions["retail"], false);
    assert.match(ctx.currency.note, /NOT zero gold/);
    // Per-realm gold carries the freshness fields.
    const gold = ctx.versions["classic-era"].facts.realms[0].gold;
    assert.equal(typeof gold.staleCharactersWithKnownGold, "number");
    assert.equal(gold.oldestKnownGoldObservedAt, 1789171621);
  });
});

// --- Query-parameter validation gaps found in review ----------------------------------------------------

test("array/object query values are rejected like any other invalid limit/now (limit[]=1, now=, now[]=1)", async () => {
  await withApp(async (base) => {
    for (const q of ["limit[]=1", "limit[a]=1", "limit=1&limit=2"]) {
      const res = await fetch(`${base}/api/versions/classic-era/recent-changes?${q}`);
      assert.equal(res.status, 400, q);
    }
    for (const q of ["now=", "now=%20", "now[]=1", "now=abc", "now=1&now=2"]) {
      const res = await fetch(`${base}/api/account-context?${q}`);
      assert.equal(res.status, 400, q);
      assert.match((await json(res)).error, /now/);
    }
    assert.equal((await fetch(`${base}/api/account-context?now=1790000000`)).status, 200);
  });
});
