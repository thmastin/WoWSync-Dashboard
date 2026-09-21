// Item metadata over the real HTTP API and into the web app's presentation logic: a real Virek Warband export carrying the
// addon's [ITEM METADATA] goes through the real importer, out of GET /api/versions/:version/item-metadata, and into the
// wording the UI shows - while every excluded consumer (shared-storage API, AccountFacts, AccountContext, the LLM
// context) stays byte-identical to what the same export WITHOUT metadata produces.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, mock, test } from "node:test";
import { fileURLToPath } from "node:url";
import { SqliteSnapshotStore, buildLlmContext, type AccountContext } from "@wowsync-dashboard/core";
import { createApp } from "../src/app.ts";
import { LOOPBACK_HOSTNAMES, listenOnce } from "../src/net.ts";
import { ITEM_INFO_NOTE, buildItemInfoLookup, describeItemInfo, itemInfoSuffix } from "../../web/src/itemMetadata.ts";
import type { ItemMetadataResponse } from "../../web/src/types.ts";
import { renderExport } from "../../core/test/sharedStorageExports.ts";

before(() => mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 }));
after(() => mock.timers.reset());

const fixtures = fileURLToPath(new URL("../../core/test/fixtures/", import.meta.url));
const PLAIN = readFileSync(`${fixtures}sanitized/virek-warband-last-seen-1789965777.wowsync.txt`, "utf8");
const ENRICHED = readFileSync(`${fixtures}derived/virek-warband-item-metadata-1789965777.wowsync.txt`, "utf8");
const NOW = 1_789_970_000;

async function withServer(run: (call: (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any; text: string }>, store: SqliteSnapshotStore) => Promise<void>) {
  const store = new SqliteSnapshotStore(":memory:");
  const server = await listenOnce(createApp(store, 0, undefined, { allowedHosts: LOOPBACK_HOSTNAMES }), "127.0.0.1", 0);
  const port = (server.address() as AddressInfo).port;
  const call = (method: string, path: string, body?: unknown) =>
    new Promise<{ status: number; body: any; text: string }>((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const headers: Record<string, string> = { Host: `127.0.0.1:${port}`, ...(payload ? { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(payload)) } : {}) };
      const req = http.request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : undefined, text }));
      });
      req.on("error", reject);
      req.end(payload);
    });
  try {
    await run(call, store);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  }
}

test("a real Retail export with [ITEM METADATA] imports over HTTP and Mote of Light is served as a Midnight crafting reagent", async () => {
  await withServer(async (call) => {
    const imported = await call("POST", "/api/import", { text: ENRICHED });
    assert.equal(imported.status, 200);
    // The import result still carries the parsed export; the new section is just carried alongside, unchanged items and all.
    assert.equal(imported.body.result.snapshot.parsed.accountBank.items.length, 98);
    assert.equal(imported.body.result.snapshot.parsed.itemMetadata.rows.length, 98);

    const res = await call("GET", "/api/versions/retail/item-metadata");
    assert.equal(res.status, 200);
    const body = res.body as ItemMetadataResponse;
    assert.equal(body.schema, "item-metadata-1");
    assert.equal(body.version, "retail");
    assert.deepEqual(body.items.map((i) => i.baseItemId), [89112, 236949], "only items with a known facet are served; the 96 all-UNKNOWN rows are absent");
    const mote = body.items.find((i) => i.baseItemId === 236949)!;
    assert.deepEqual(mote.craftingReagent, { state: "KNOWN", value: true, sources: ["game-client"] });
    assert.deepEqual(mote.expansionId, { state: "KNOWN", value: 11, sources: ["game-client"] });
    assert.deepEqual(mote.expansion, { state: "KNOWN", rawValue: 11, label: "Midnight", text: "Midnight" });
    assert.equal(JSON.stringify(mote).includes("Mote of Light"), false, "nothing is inferred from, or keyed by, the item name");
  });
});

test("the web presentation resolves the same Mote of Light record for a character-bag row, a Warband row and a guild row", async () => {
  await withServer(async (call) => {
    await call("POST", "/api/import", { text: ENRICHED });
    const lookup = buildItemInfoLookup(((await call("GET", "/api/versions/retail/item-metadata")).body as ItemMetadataResponse).items);
    assert.equal(lookup.available, true);
    // Different embedded levels (the observing character's) and different stores, one base item.
    const rows = ["item:236949::::::::85:253:::::::::", "item:236949::::::::86:253:::::::::", "item:236949::::::::90:12345:::::::::"];
    for (const ref of rows) {
      const display = describeItemInfo(lookup.forItemRef(ref));
      assert.equal(display.expansionText, "Midnight");
      assert.equal(display.expansionKnown, true);
      assert.equal(display.reagent, "yes");
      assert.equal(display.cell, "Midnight · Reagent");
      assert.equal(itemInfoSuffix(lookup.forItemRef(ref)), "Midnight · Reagent");
    }
    // An item the export listed but the client had not reported is "?", never a guessed label.
    assert.equal(describeItemInfo(lookup.forItemRef("item:239142::::::::85:253:::::::::")).cell, "?");
    assert.equal(itemInfoSuffix(lookup.forItemRef("item:239142::::::::85:253:::::::::")), "");
    assert.match(ITEM_INFO_NOTE, /nothing is guessed/);
  });
});

test("an item list rendered with no metadata behaves exactly as before: nothing extra, nothing guessed", () => {
  const empty = buildItemInfoLookup(undefined);
  assert.equal(empty.available, false);
  assert.equal(empty.forItemRef("item:236949::::::::85:253:::::::::"), undefined);
  assert.equal(describeItemInfo(undefined).cell, "?");
  assert.equal(describeItemInfo(undefined).summary, "Expansion unknown. Crafting reagent status unknown.");
});

test("the item-metadata endpoint is version-scoped, validated, and empty (not an error) where nothing was exported", async () => {
  await withServer(async (call) => {
    await call("POST", "/api/import", { text: ENRICHED });
    for (const version of ["classic-era", "tbc-anniversary", "forever", "unknown-version"]) {
      const res = await call("GET", `/api/versions/${version}/item-metadata`);
      assert.equal(res.status, 200, version);
      assert.deepEqual(res.body, { schema: "item-metadata-1", version, items: [] }, version);
    }
    const bad = await call("GET", "/api/versions/not-a-version/item-metadata");
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /Unknown version/);
  });
});

test("a server that never received metadata answers with an empty list", async () => {
  await withServer(async (call) => {
    await call("POST", "/api/import", { text: PLAIN });
    const res = await call("GET", "/api/versions/retail/item-metadata");
    assert.deepEqual(res.body, { schema: "item-metadata-1", version: "retail", items: [] });
  });
});

test("an export with malformed [ITEM METADATA] is refused (422) and stores nothing", async () => {
  await withServer(async (call, store) => {
    const bad = renderExport({ name: "Virek", generated: 1_790_000_000, itemMetadata: "[ITEM METADATA]\nbaseItemID\tclassID\tsubclassID\tbindType\texpansionID\tisCraftingReagent\n236949\t7\t11\t0\t11\tmaybe" });
    const res = await call("POST", "/api/import", { text: bad });
    assert.equal(res.status, 422);
    assert.match(res.body.error, /isCraftingReagent/);
    assert.equal(store.listCharacters("retail").length, 0, "the whole import was refused");
    assert.deepEqual(store.loadItemEvidence("retail"), []);
  });
});

test("EXCLUSIONS UNCHANGED: with metadata, the shared-storage API, AccountFacts, AccountContext and the LLM context are byte-identical to the same export without it", async () => {
  const read = async (text: string) => {
    let out: Record<string, string> = {};
    await withServer(async (call) => {
      assert.equal((await call("POST", "/api/import", { text })).status, 200);
      const context = (await call("GET", `/api/account-context?now=${NOW}`)).body as AccountContext;
      out = {
        shared: (await call("GET", `/api/shared-storage?now=${NOW}`)).text,
        facts: JSON.stringify(context.versions),
        context: JSON.stringify(context),
        llm: JSON.stringify(buildLlmContext(context)),
        recent: (await call("GET", "/api/versions/retail/recent-changes")).text,
        characters: JSON.stringify(((await call("GET", "/api/versions/retail/characters")).body as { characters: unknown[] }).characters),
      };
    });
    return out;
  };
  const without = await read(PLAIN);
  const withMeta = await read(ENRICHED);
  assert.equal(withMeta.shared, without.shared, "GET /api/shared-storage");
  assert.equal(withMeta.facts, without.facts, "AccountFacts");
  assert.equal(withMeta.context, without.context, "AccountContext");
  assert.equal(withMeta.llm, without.llm, "LLM context");
  assert.equal(withMeta.recent, without.recent, "recent changes");
  assert.equal(withMeta.characters, without.characters, "character summaries");
  // And nothing metadata-shaped leaked into any of them.
  for (const [name, body] of Object.entries(withMeta)) {
    assert.doesNotMatch(body, /itemMetadata|expansionId|craftingReagent|item-metadata/i, name);
  }
});
