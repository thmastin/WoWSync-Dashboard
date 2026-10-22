// Synthetic system acceptance: durable Retail stock-target intent is written through the real
// Dashboard HTTP API, recomputed through the real allocation read model, and read through MCP's
// real stdio process. The fixture is invented test data, not observed gameplay or market evidence.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { DashboardReadModel, SqliteSnapshotStore } from "@wowsync-dashboard/core";
import { T, guildSection, observedSection, row, warbandSection } from "../../core/test/allocationFixtures.ts";
import { renderExport } from "../../core/test/sharedStorageExports.ts";
import { createApp } from "../../server/src/app.ts";
import { LOOPBACK_HOSTNAMES, listenOnce } from "../../server/src/net.ts";

const packageRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const mcpEntrypoint = path.join(packageRoot, "src", "index.ts");
const HERB = 930101;
const OTHER = 930102;
const GUILD_ONLY = 930103;

function durableDatabaseState(file: string): Record<string, string | undefined> {
  return Object.fromEntries([file, `${file}-wal`].map((entry) => [
    path.basename(entry),
    existsSync(entry) ? createHash("sha256").update(readFileSync(entry)).digest("hex") : undefined,
  ]));
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function structured<T>(result: { isError?: boolean; structuredContent?: unknown }): T {
  assert.equal(result.isError, undefined);
  assert.notEqual(result.structuredContent, undefined);
  return result.structuredContent as T;
}

test("[SYNTHETIC ACCEPTANCE] demand lifecycle survives REST -> SQLite -> MCP and returns to unallocated without surplus claims", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "wowsync-erp-journey-"));
  const databasePath = path.join(directory, "journey.sqlite");
  let writer: SqliteSnapshotStore | undefined;
  let appServer: http.Server | undefined;
  let client: Client | undefined;
  let stableId = "";
  try {
  writer = new SqliteSnapshotStore(databasePath);
  const source = renderExport({
    name: "ERP Fixture",
    realm: "Cairne",
    generated: T,
    bags: observedSection([row(HERB, 40, { name: "Mycobloom" }), row(OTHER, 12, { name: "Bismuth" })]),
    bank: observedSection([row(HERB, 77, { name: "Mycobloom" })]),
    warband: warbandSection("OBSERVED", []),
    guild: guildSection("gclub-erp-journey", [row(HERB, 1000, { name: "Guild Mycobloom" }), row(GUILD_ONLY, 500, { name: "Guild Hoard" })]),
  });
  writer.importSnapshot(source);

  const server = await listenOnce(createApp(writer, 0, undefined, { allowedHosts: LOOPBACK_HOSTNAMES }), "127.0.0.1", 0);
  appServer = server;
  const port = (server.address() as AddressInfo).port;
  const call = (method: string, route: string, body?: unknown) => new Promise<{ status: number; body: any }>((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = { Host: `127.0.0.1:${port}` };
    if (payload !== undefined) Object.assign(headers, { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(payload)) });
    const request = http.request({ host: "127.0.0.1", port, method, path: route, headers }, (response) => {
      let text = "";
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: text ? JSON.parse(text) : undefined }));
    });
    request.on("error", reject);
    request.end(payload);
  });

  const mcpClient = new Client({ name: "wowsync-erp-journey-test", version: "0.1.0" });
  client = mcpClient;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [mcpEntrypoint],
    cwd: packageRoot,
    env: { ...process.env, WOWSYNC_MCP_DB_PATH: databasePath },
    stderr: "pipe",
  });
    await mcpClient.connect(transport);

    const initial = await call("GET", "/api/versions/retail/allocation-review?demandedLimit=100&unallocatedLimit=100");
    assert.equal(initial.status, 200);
    const initialHerb = initial.body.data.unallocated.items.find((entry: any) => entry.baseItemId === HERB);
    assert.equal(initialHerb.confirmedQuantity, 117, "only observed character bags and character bank are personal/account-owned evidence");
    for (const field of ["confirmedSurplus", "disposition", "allocated", "confirmedDeficit"]) assert.ok(!(field in initialHerb), `no target has no ${field}`);
    assert.ok(!initial.body.data.unallocated.items.some((entry: any) => entry.baseItemId === GUILD_ONLY), "guild-only items do not enter account-owned inventory");
    assert.deepEqual(structured(await mcpClient.callTool({ name: "get_allocation_review", arguments: { version: "retail", demandedLimit: 100, unallocatedLimit: 100 } })), initial.body);

    const created = await call("POST", "/api/versions/retail/demands", { baseItemId: HERB, requiredQuantity: 200, purpose: "Synthetic crafting plan" });
    assert.equal(created.status, 201);
    stableId = created.body.demand.stableId;
    let restReview = await call("GET", "/api/versions/retail/allocation-review?demandedLimit=100&unallocatedLimit=100");
    assert.equal(restReview.body.data.unallocated.items.some((entry: any) => entry.baseItemId === HERB), false);
    let mcpReview = structured<any>(await mcpClient.callTool({ name: "get_allocation_review", arguments: { version: "retail", demandedLimit: 100, unallocatedLimit: 100 } }));
    assert.deepEqual(mcpReview, restReview.body, "REST and MCP expose the same canonical allocation review");
    let result = mcpReview.data.demanded.items.find((entry: any) => entry.commodity.baseItemId === HERB);
    assert.equal(result.confirmedAvailable, 117);
    assert.equal(result.confirmedDeficit, 83);
    assert.equal(result.disposition, "HOLD_ALLOCATED");
    assert.equal(structured<any>(await mcpClient.callTool({ name: "get_item_allocation", arguments: { version: "retail", baseItemId: HERB } })).data.resolution, "RESOLVED");
    assert.deepEqual(
      structured<any>(await mcpClient.callTool({ name: "get_item_allocation", arguments: { version: "retail", baseItemId: HERB } })).data,
      result,
      "the item-level MCP result is the same allocation as its review row",
    );

    const patched = await call("PATCH", `/api/versions/retail/demands/${stableId}`, { requiredQuantity: 100, purpose: "Synthetic adjusted plan" });
    assert.equal(patched.status, 200);
    restReview = await call("GET", "/api/versions/retail/allocation-review?demandedLimit=100&unallocatedLimit=100");
    mcpReview = structured<any>(await mcpClient.callTool({ name: "get_allocation_review", arguments: { version: "retail", demandedLimit: 100, unallocatedLimit: 100 } }));
    assert.deepEqual(mcpReview, restReview.body);
    result = mcpReview.data.demanded.items.find((entry: any) => entry.commodity.baseItemId === HERB);
    assert.equal(result.confirmedSurplus, 17);
    assert.equal(result.disposition, "SEND_HELLOMAGS");
    assert.equal(result.demand.stableId, stableId, "an update changes current intent in place while preserving its stable identity");

    const deactivated = await call("POST", `/api/versions/retail/demands/${stableId}/deactivate`);
    assert.equal(deactivated.status, 200);
    assert.equal(deactivated.body.demand.status, "INACTIVE");
    restReview = await call("GET", "/api/versions/retail/allocation-review?demandedLimit=100&unallocatedLimit=100");
    mcpReview = structured<any>(await mcpClient.callTool({ name: "get_allocation_review", arguments: { version: "retail", demandedLimit: 100, unallocatedLimit: 100 } }));
    assert.deepEqual(mcpReview, restReview.body);
    assert.equal(mcpReview.data.demanded.totalCount, 0);
    const unallocatedAgain = mcpReview.data.unallocated.items.find((entry: any) => entry.baseItemId === HERB);
    assert.equal(unallocatedAgain.confirmedQuantity, 117);
    for (const field of ["confirmedSurplus", "disposition", "allocated", "confirmedDeficit", "demand"]) assert.ok(!(field in unallocatedAgain), `deactivated target is not an active demand and has no ${field}`);

    const databaseBeforeReadOnlyCalls = durableDatabaseState(databasePath);
    await mcpClient.callTool({ name: "get_allocation_review", arguments: { version: "retail", demandedLimit: 100, unallocatedLimit: 100 } });
    await mcpClient.callTool({ name: "get_item_allocation", arguments: { version: "retail", baseItemId: HERB } });
    assert.deepEqual(durableDatabaseState(databasePath), databaseBeforeReadOnlyCalls, "MCP reads leave the database and its WAL unchanged");

    await mcpClient.close();
    client = undefined;
    await closeServer(server);
    appServer = undefined;
    writer.close();
    writer = undefined;
    const reopened = new SqliteSnapshotStore(databasePath);
    try {
      const demands = reopened.listDemands("retail");
      assert.equal(demands.length, 1);
      assert.equal(demands[0]?.status, "INACTIVE", "the removal is durably represented as history after database reopen");
      assert.equal(demands[0]?.stableId, stableId);
      const replayed = new DashboardReadModel(reopened).getAllocationReview({ version: "retail" });
      assert.equal(replayed.data?.demanded.totalCount, 0);
      assert.equal(replayed.data?.unallocated.items.find((entry) => entry.baseItemId === HERB)?.confirmedQuantity, 117);
    } finally {
      reopened.close();
    }
  } finally {
    if (client) await client.close().catch(() => undefined);
    if (appServer) await closeServer(appServer).catch(() => undefined);
    try { writer?.close(); } catch { /* cleanup must not skip removal of this disposable fixture */ }
    rmSync(directory, { recursive: true, force: true });
  }
});
