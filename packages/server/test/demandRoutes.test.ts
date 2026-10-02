// HTTP tests for the Explicit Demand API (Azeroth ERP Vertical Slice 1): create/list/update/deactivate,
// the 409 conflict response for a duplicate active demand, validation 400s, and 404s on an unknown
// stableId. Real app, real sockets, real SqliteSnapshotStore — the same pattern as sharedStorage.test.ts
// and itemMetadata.test.ts.
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { SqliteSnapshotStore } from "@wowsync-dashboard/core";
import { createApp } from "../src/app.ts";
import { LOOPBACK_HOSTNAMES, listenOnce } from "../src/net.ts";

async function withServer(run: (call: (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>) => Promise<void>) {
  const store = new SqliteSnapshotStore(":memory:");
  const server = await listenOnce(createApp(store, 0, undefined, { allowedHosts: LOOPBACK_HOSTNAMES }), "127.0.0.1", 0);
  const port = (server.address() as AddressInfo).port;
  const call = (method: string, path: string, body?: unknown) =>
    new Promise<{ status: number; body: any }>((resolve, reject) => {
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
    await run(call);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  }
}

test("GET on an empty version returns an empty list, never a 404", async () => {
  await withServer(async (call) => {
    const res = await call("GET", "/api/versions/retail/demands");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { demands: [] });
  });
});

test("POST creates an ACTIVE STOCK_TARGET demand and GET lists it", async () => {
  await withServer(async (call) => {
    const created = await call("POST", "/api/versions/retail/demands", { baseItemId: 9001, requiredQuantity: 40, purpose: "Enchanting mats" });
    assert.equal(created.status, 201);
    assert.equal(created.body.demand.status, "ACTIVE");
    assert.equal(created.body.demand.commodity.baseItemId, 9001);
    assert.equal(created.body.demand.requiredQuantity, 40);
    assert.equal(created.body.demand.purpose, "Enchanting mats");

    const listed = await call("GET", "/api/versions/retail/demands");
    assert.equal(listed.status, 200);
    assert.equal(listed.body.demands.length, 1);
    assert.equal(listed.body.demands[0].stableId, created.body.demand.stableId);
  });
});

test("demand is Retail-only in this slice: POST to a non-Retail version is rejected", async () => {
  await withServer(async (call) => {
    const res = await call("POST", "/api/versions/classic-era/demands", { baseItemId: 9001, requiredQuantity: 40 });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, "UNSUPPORTED_VERSION");
  });
});

test("POST with invalid input returns 400 with a stable error code, and nothing is created", async () => {
  await withServer(async (call) => {
    const res = await call("POST", "/api/versions/retail/demands", { baseItemId: -1, requiredQuantity: 40 });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, "INVALID_BASE_ITEM_ID");
    assert.equal((await call("GET", "/api/versions/retail/demands")).body.demands.length, 0);
  });
});

test("a second active demand for the same base item id is rejected with 409 and the existing demand's id, not silently resolved", async () => {
  await withServer(async (call) => {
    const first = await call("POST", "/api/versions/retail/demands", { baseItemId: 9002, requiredQuantity: 10 });
    assert.equal(first.status, 201);
    const second = await call("POST", "/api/versions/retail/demands", { baseItemId: 9002, requiredQuantity: 999 });
    assert.equal(second.status, 409);
    assert.equal(second.body.code, "DEMAND_CONFLICT");
    assert.equal(second.body.existingStableId, first.body.demand.stableId);
    assert.equal((await call("GET", "/api/versions/retail/demands")).body.demands.length, 1, "nothing new was created");
  });
});

test("PATCH updates requiredQuantity/purpose in place", async () => {
  await withServer(async (call) => {
    const created = await call("POST", "/api/versions/retail/demands", { baseItemId: 9003, requiredQuantity: 10 });
    const stableId = created.body.demand.stableId;
    const updated = await call("PATCH", `/api/versions/retail/demands/${stableId}`, { requiredQuantity: 25, purpose: "Updated" });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.demand.requiredQuantity, 25);
    assert.equal(updated.body.demand.purpose, "Updated");
    assert.equal(updated.body.demand.stableId, stableId);
  });
});

test("PATCH on an unknown stableId returns 404", async () => {
  await withServer(async (call) => {
    const res = await call("PATCH", "/api/versions/retail/demands/demand_nonexistent", { requiredQuantity: 1 });
    assert.equal(res.status, 404);
    assert.equal(res.body.code, "DEMAND_NOT_FOUND");
  });
});

test("deactivate sets status to INACTIVE (not a delete) and frees the key for a new active demand", async () => {
  await withServer(async (call) => {
    const created = await call("POST", "/api/versions/retail/demands", { baseItemId: 9004, requiredQuantity: 10 });
    const stableId = created.body.demand.stableId;
    const deactivated = await call("POST", `/api/versions/retail/demands/${stableId}/deactivate`);
    assert.equal(deactivated.status, 200);
    assert.equal(deactivated.body.demand.status, "INACTIVE");

    const list = await call("GET", "/api/versions/retail/demands");
    assert.equal(list.body.demands.length, 1, "the row still exists, deactivation is not a delete");
    assert.equal(list.body.demands[0].status, "INACTIVE");

    const recreated = await call("POST", "/api/versions/retail/demands", { baseItemId: 9004, requiredQuantity: 50 });
    assert.equal(recreated.status, 201, "the key is free again after deactivation");
  });
});

test("deactivate on an unknown stableId returns 404", async () => {
  await withServer(async (call) => {
    const res = await call("POST", "/api/versions/retail/demands/demand_nonexistent/deactivate");
    assert.equal(res.status, 404);
    assert.equal(res.body.code, "DEMAND_NOT_FOUND");
  });
});
