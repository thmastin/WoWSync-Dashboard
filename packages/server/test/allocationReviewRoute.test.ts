// HTTP tests for the Dashboard Allocation tab milestone: GET /api/versions/:version/allocation-review (the narrow
// Dashboard consumer of DashboardReadModel) and the demand-route hardening the tab relies on (version-scoped
// PATCH/deactivate, no mutation of INACTIVE demands). Real app, real sockets, real SqliteSnapshotStore with
// imported exports — the same pattern as demandRoutes.test.ts.
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { DashboardReadModel, SqliteSnapshotStore } from "@wowsync-dashboard/core";
import { createApp } from "../src/app.ts";
import { LOOPBACK_HOSTNAMES, listenOnce } from "../src/net.ts";
import { renderExport, type ExportSpec } from "../../core/test/sharedStorageExports.ts";
import { T, guildSection, observedSection, row, warbandSection } from "../../core/test/allocationFixtures.ts";

type Call = (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>;

async function withServer(exports: ExportSpec[], run: (call: Call, store: SqliteSnapshotStore) => Promise<void>) {
  const store = new SqliteSnapshotStore(":memory:");
  for (const spec of exports) store.importSnapshot(renderExport(spec));
  const server = await listenOnce(createApp(store, 0, undefined, { allowedHosts: LOOPBACK_HOSTNAMES }), "127.0.0.1", 0);
  const port = (server.address() as AddressInfo).port;
  const call: Call = (method, path, body) =>
    new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const headers: Record<string, string> = { Host: `127.0.0.1:${port}`, ...(payload ? { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(payload)) } : {}) };
      const req = http.request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : undefined }));
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

const HERB = 930001;
const ORE = 930002;
const GUILD_ONLY = 930003;
const ACCOUNT: ExportSpec = {
  name: "Anchor",
  generated: T,
  bags: observedSection([row(HERB, 40, { name: "Mycobloom" }), row(ORE, 12, { name: "Bismuth" })]),
  bank: observedSection([row(HERB, 77, { name: "Mycobloom" })]),
  warband: warbandSection("OBSERVED", []),
  guild: guildSection("gclub-route", [row(GUILD_ONLY, 500, { name: "Guild Hoard" }), row(HERB, 1000, { name: "Mycobloom" })]),
};
const REVIEW = "/api/versions/retail/allocation-review?demandedLimit=100&unallocatedLimit=100";
const demandedFor = (body: any, id: number) => body.data.demanded.items.find((r: any) => r.commodity.baseItemId === id);
const unallocatedIds = (body: any) => body.data.unallocated.items.map((e: any) => e.baseItemId);

test("allocation-review returns exactly DashboardReadModel.getAllocationReview's ReadValue (data and provenance), including search and paging", async () => {
  await withServer([ACCOUNT], async (call, store) => {
    store.createDemand({ baseItemId: ORE, requiredQuantity: 5, purpose: "Smithing" });
    const model = new DashboardReadModel(store);
    for (const [qs, query] of [
      ["", {}],
      ["?demandedLimit=1&unallocatedLimit=1", { demandedLimit: 1, unallocatedLimit: 1 }],
      ["?q=MYCO", { q: "MYCO" }],
      ["?q=930001&unallocatedOffset=0", { q: "930001", unallocatedOffset: 0 }],
    ] as const) {
      const res = await call("GET", `/api/versions/retail/allocation-review${qs}`);
      assert.equal(res.status, 200, qs);
      assert.deepEqual(res.body, JSON.parse(JSON.stringify(model.getAllocationReview({ version: "retail", ...query }))), qs);
    }
  });
});

test("allocation-review on a non-Retail version answers UNKNOWN provenance with no data (never Retail data, never fabricated)", async () => {
  await withServer([ACCOUNT], async (call, store) => {
    store.createDemand({ baseItemId: ORE, requiredQuantity: 5 });
    for (const version of ["classic-era", "tbc-anniversary", "forever"]) {
      const res = await call("GET", `/api/versions/${version}/allocation-review`);
      assert.equal(res.status, 200);
      assert.equal(res.body.provenance.state, "UNKNOWN");
      assert.equal(res.body.data, undefined);
    }
    assert.equal((await call("GET", "/api/versions/not-a-version/allocation-review")).status, 400);
  });
});

test("allocation-review rejects invalid paging and query input with 400 and a stable code", async () => {
  await withServer([ACCOUNT], async (call) => {
    for (const qs of ["demandedOffset=-1", "demandedLimit=0", "unallocatedOffset=abc", "unallocatedLimit=1.5", "unallocatedLimit=12abc", "demandedOffset=", "unallocatedLimit=1&unallocatedLimit=2"]) {
      const res = await call("GET", `/api/versions/retail/allocation-review?${qs}`);
      assert.equal(res.status, 400, qs);
      assert.equal(res.body.code, "INVALID_PAGING", qs);
    }
    const tooLong = await call("GET", `/api/versions/retail/allocation-review?q=${"x".repeat(201)}`);
    assert.equal(tooLong.status, 400);
    assert.equal(tooLong.body.code, "INVALID_QUERY");
    const repeated = await call("GET", "/api/versions/retail/allocation-review?q=a&q=b");
    assert.equal(repeated.status, 400);
    assert.equal(repeated.body.code, "INVALID_QUERY");
    assert.equal((await call("GET", "/api/versions/retail/allocation-review?unallocatedLimit=500")).status, 200, "an over-large limit is clamped by the read model, as everywhere else");
  });
});

test("gear allocation read routes are bounded references and never claim missing candidate rows", async () => {
  await withServer([ACCOUNT], async (call) => {
    const evidence = await call("GET", "/api/versions/retail/gear-candidates");
    assert.equal(evidence.status, 200);
    assert.equal(evidence.body.provenance.state, "DERIVED");
    const invalid = await call("GET", "/api/versions/retail/gear-allocation?exporterIdentityKey=retail%3A%3Acairne%3A%3Aanchor&snapshotId=1&rowOrdinal=1");
    assert.equal(invalid.status, 200);
    assert.equal(invalid.body.status, "CANDIDATE_EVIDENCE_NOT_FOUND");
    assert.equal((await call("GET", "/api/versions/retail/gear-allocation")).status, 400);
    assert.equal((await call("GET", "/api/versions/classic-era/gear-allocation?exporterIdentityKey=x&snapshotId=1&rowOrdinal=1")).body.status, "UNKNOWN");
  });
});

test("round trip: no target -> set target -> demanded -> edit -> arithmetic updates -> remove -> no target again, with no surplus semantics left", async () => {
  await withServer([ACCOUNT], async (call) => {
    let review = await call("GET", REVIEW);
    assert.ok(unallocatedIds(review.body).includes(HERB));
    assert.equal(demandedFor(review.body, HERB), undefined);
    const heldEntry = review.body.data.unallocated.items.find((e: any) => e.baseItemId === HERB);
    for (const field of ["confirmedSurplus", "disposition", "allocated", "confirmedDeficit"]) assert.ok(!(field in heldEntry), `no-target entry has no ${field}`);

    const created = await call("POST", "/api/versions/retail/demands", { baseItemId: HERB, requiredQuantity: 200, purpose: "Alchemy" });
    assert.equal(created.status, 201);
    const stableId = created.body.demand.stableId;

    review = await call("GET", REVIEW);
    assert.ok(!unallocatedIds(review.body).includes(HERB), "a demanded item leaves the no-target list");
    let result = demandedFor(review.body, HERB);
    assert.equal(result.resolution, "RESOLVED");
    assert.equal(result.demand.requiredQuantity, 200);
    assert.equal(result.confirmedAvailable, 117, "bags 40 + bank 77; the guild's 1000 is never counted");
    assert.equal(result.confirmedDeficit, 83);
    assert.equal(result.disposition, "HOLD_ALLOCATED");
    assert.equal(review.body.data.itemNames[String(HERB)], "Mycobloom");

    const patched = await call("PATCH", `/api/versions/retail/demands/${stableId}`, { requiredQuantity: 100, purpose: "Alchemy (less)" });
    assert.equal(patched.status, 200);
    review = await call("GET", REVIEW);
    result = demandedFor(review.body, HERB);
    assert.equal(result.demand.requiredQuantity, 100);
    assert.equal(result.demand.purpose, "Alchemy (less)");
    assert.equal(result.confirmedDeficit, 0);
    assert.equal(result.confirmedSurplus, 17);
    assert.equal(result.disposition, "SEND_HELLOMAGS");

    const removed = await call("POST", `/api/versions/retail/demands/${stableId}/deactivate`);
    assert.equal(removed.status, 200);
    assert.equal(removed.body.demand.status, "INACTIVE");
    review = await call("GET", REVIEW);
    assert.equal(demandedFor(review.body, HERB), undefined);
    assert.ok(unallocatedIds(review.body).includes(HERB), "back to no target");
    const again = review.body.data.unallocated.items.find((e: any) => e.baseItemId === HERB);
    for (const field of ["confirmedSurplus", "disposition", "allocated", "confirmedDeficit", "demand"]) assert.ok(!(field in again), `after removal: no ${field}`);
    assert.equal(again.confirmedQuantity, 117);

    const history = await call("GET", "/api/versions/retail/demands");
    assert.deepEqual(history.body.demands.map((d: any) => [d.stableId, d.status]), [[stableId, "INACTIVE"]], "removal kept the record as history");
  });
});

test("a target for an item not held: Keep 100 · Have 0 · Short 100", async () => {
  await withServer([ACCOUNT], async (call) => {
    assert.equal((await call("POST", "/api/versions/retail/demands", { baseItemId: 12345, requiredQuantity: 100 })).status, 201);
    const result = demandedFor((await call("GET", REVIEW)).body, 12345);
    assert.equal(result.resolution, "RESOLVED");
    assert.equal(result.demand.requiredQuantity, 100);
    assert.equal(result.confirmedAvailable, 0);
    assert.equal(result.confirmedDeficit, 100);
  });
});

test("duplicate active target -> 409 DEMAND_CONFLICT with existingStableId; nothing is created", async () => {
  await withServer([ACCOUNT], async (call) => {
    const first = await call("POST", "/api/versions/retail/demands", { baseItemId: ORE, requiredQuantity: 5 });
    const second = await call("POST", "/api/versions/retail/demands", { baseItemId: ORE, requiredQuantity: 9 });
    assert.equal(second.status, 409);
    assert.equal(second.body.code, "DEMAND_CONFLICT");
    assert.equal(second.body.existingStableId, first.body.demand.stableId);
    assert.equal((await call("GET", "/api/versions/retail/demands")).body.demands.length, 1);
  });
});

test("Keep 0 is a real target: everything confirmed is surplus (unlike no target, which has no surplus at all)", async () => {
  await withServer([ACCOUNT], async (call) => {
    const created = await call("POST", "/api/versions/retail/demands", { baseItemId: ORE, requiredQuantity: 0 });
    assert.equal(created.status, 201);
    assert.equal(created.body.demand.requiredQuantity, 0);
    const result = demandedFor((await call("GET", REVIEW)).body, ORE);
    assert.equal(result.resolution, "RESOLVED");
    assert.equal(result.allocated, 0);
    assert.equal(result.confirmedSurplus, 12);
    assert.equal(result.disposition, "SEND_HELLOMAGS");
  });
});

test("PATCH and deactivate of an INACTIVE demand -> 409 DEMAND_INACTIVE and the record is not touched", async () => {
  await withServer([ACCOUNT], async (call, store) => {
    const created = await call("POST", "/api/versions/retail/demands", { baseItemId: ORE, requiredQuantity: 5, purpose: "Old" });
    const stableId = created.body.demand.stableId;
    await call("POST", `/api/versions/retail/demands/${stableId}/deactivate`);
    const before = store.listDemands("retail").find((d) => d.stableId === stableId);
    const patch = await call("PATCH", `/api/versions/retail/demands/${stableId}`, { requiredQuantity: 99, purpose: "New" });
    assert.equal(patch.status, 409);
    assert.equal(patch.body.code, "DEMAND_INACTIVE");
    const again = await call("POST", `/api/versions/retail/demands/${stableId}/deactivate`);
    assert.equal(again.status, 409);
    assert.equal(again.body.code, "DEMAND_INACTIVE");
    assert.deepEqual(store.listDemands("retail").find((d) => d.stableId === stableId), before, "unchanged: quantity, purpose, status, updatedAt");
    assert.equal(demandedFor((await call("GET", REVIEW)).body, ORE), undefined, "no reactivation");
  });
});

test("wrong-version PATCH and deactivate -> 404 DEMAND_NOT_FOUND and the Retail demand is not mutated", async () => {
  await withServer([ACCOUNT], async (call, store) => {
    const created = await call("POST", "/api/versions/retail/demands", { baseItemId: ORE, requiredQuantity: 5, purpose: "Keep" });
    const stableId = created.body.demand.stableId;
    const before = store.listDemands("retail").find((d) => d.stableId === stableId);
    for (const version of ["classic-era", "tbc-anniversary", "forever"]) {
      const patch = await call("PATCH", `/api/versions/${version}/demands/${stableId}`, { requiredQuantity: 99 });
      assert.equal(patch.status, 404, version);
      assert.equal(patch.body.code, "DEMAND_NOT_FOUND");
      const deactivate = await call("POST", `/api/versions/${version}/demands/${stableId}/deactivate`);
      assert.equal(deactivate.status, 404, version);
      assert.equal(deactivate.body.code, "DEMAND_NOT_FOUND");
    }
    assert.deepEqual(store.listDemands("retail").find((d) => d.stableId === stableId), before, "nothing changed through a wrong-version route");
    assert.equal(before!.status, "ACTIVE");
  });
});

test("Guild-owned quantity never enters allocation: a guild-only item is never unallocated, and a target for it is short by the full amount", async () => {
  await withServer([ACCOUNT], async (call) => {
    let review = await call("GET", REVIEW);
    assert.ok(!unallocatedIds(review.body).includes(GUILD_ONLY));
    await call("POST", "/api/versions/retail/demands", { baseItemId: GUILD_ONLY, requiredQuantity: 10 });
    review = await call("GET", REVIEW);
    const result = demandedFor(review.body, GUILD_ONLY);
    assert.equal(result.confirmedAvailable, 0);
    assert.equal(result.potentialAdditionalAvailable, 0);
    assert.equal(result.confirmedDeficit, 10, "500 guild-owned units satisfy nothing");
    assert.equal(result.guildContext.find((g: any) => g.quantity === 500)?.quantity, 500, "reported as guild context only");
    assert.ok(!(String(GUILD_ONLY) in review.body.data.itemNames), "a guild name is not borrowed for account presentation");
  });
});
