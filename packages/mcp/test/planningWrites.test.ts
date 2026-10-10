import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { buildErpNeedReviewSnapshot, DashboardReadModel, SqliteSnapshotStore, SqliteSnapshotReadStore } from "@wowsync-dashboard/core";
import { buildWowSyncExport } from "../../core/test/fixtureBuilder.ts";
import { createApp } from "../../server/src/app.ts";
import { LOOPBACK_HOSTNAMES } from "../../server/src/net.ts";
import { createWoWSyncMcpServer } from "../src/server.ts";
import { test } from "node:test";

const root = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const entrypoint = path.join(root, "packages", "mcp", "src", "index.ts");

test("opt-in MCP planning writes reuse REST validation and persist one atomic, version-scoped manual plan", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "wowsync-mcp-planning-write-"));
  const databasePath = path.join(directory, "fixture.sqlite");
  const seed = new SqliteSnapshotStore(databasePath);
  const now = Math.floor(Date.now() / 1000);
  const character = seed.importSnapshot(buildWowSyncExport({ generatedAt: now, character: { name: "Plan Author", realm: "Cairne", clientVersion: "1.15.7", clientBuild: "60927" }, bags: { containers: [{ id: 0, capacity: 16, items: [{ itemRef: "item:159", name: "Rough Stone", qty: 3 }] }] }, bank: { unknown: true } })).character;
  const reservedProject = seed.createErpProject({ version: "classic-era", title: "Existing reservation", needs: [{ stableId: "held_stone", kind: "ITEM_REF", resourceKey: "item:159", label: "Rough Stone", requiredQuantity: 2, sourceIdentityKey: character.identityKey }], reservations: [{ stableId: "stone_hold", needId: "held_stone", sourceIdentityKey: character.identityKey, quantity: 2, status: "ACTIVE", createdAt: now, updatedAt: now }] });
  seed.close();

  const apiStore = new SqliteSnapshotStore(databasePath);
  const api = http.createServer(createApp(apiStore, 0, undefined, { allowedHosts: LOOPBACK_HOSTNAMES }));
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  const port = (api.address() as AddressInfo).port;
  const client = new Client({ name: "wowsync-mcp-planning-write-test", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entrypoint],
    cwd: root,
    env: { ...process.env, WOWSYNC_MCP_DB_PATH: databasePath, WOWSYNC_MCP_PLANNING_API_URL: `http://127.0.0.1:${port}` },
    stderr: "pipe",
  });

  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools;
    for (const name of ["create_erp_project", "plan_erp_work_order_batch", "update_erp_project_plan", "replan_erp_reservations"]) {
      const tool = tools.find((entry) => entry.name === name);
      assert.ok(tool, `${name} is exposed only in the explicitly configured planning-write mode`);
      assert.equal(tool.annotations?.readOnlyHint, false);
      assert.equal(tool.annotations?.destructiveHint, name === "replan_erp_reservations" || name === "update_erp_project_plan", "reservation reductions and whole-plan edits are flagged for MCP client confirmation");
    }

    const created = await client.callTool({ name: "create_erp_project", arguments: {
      version: "classic-era", title: "Plan first craft", priority: 4,
      needs: [{ stableId: "stone", kind: "ITEM_REF", resourceKey: "item:159", label: "Rough Stone", requiredQuantity: 2, sourceIdentityKey: character.identityKey }],
    } });
    assert.equal(created.isError, undefined);
    const project = (created.structuredContent as { project: { stableId: string; version: string; revision: number; needs: Array<{ stableId: string }> } }).project;
    assert.equal(project.version, "classic-era");
    assert.equal(project.needs[0]?.stableId, "stone");

    const readStore = new SqliteSnapshotReadStore(databasePath);
    let reviewedProject;
    try { reviewedProject = new DashboardReadModel(readStore).getErpProjects({ version: "classic-era" }).find((entry) => entry.stableId === project.stableId); }
    finally { readStore.close(); }
    assert.ok(reviewedProject);
    const reviewSnapshot = buildErpNeedReviewSnapshot(reviewedProject, "stone");
    assert.ok(reviewSnapshot);

    const saved = await client.callTool({ name: "plan_erp_work_order_batch", arguments: {
      version: "classic-era",
      updates: [{ projectId: project.stableId, expectedRevision: project.revision, tasks: [{
        needId: "stone", kind: "GATHER", title: "Collect the observed material", instructions: "Player performs this manually and checks a later export.", reviewSnapshot,
      }] }],
    } });
    assert.equal(saved.isError, undefined);
    const savedProject = (saved.structuredContent as { projects: Array<{ stableId: string; workOrders: Array<{ stableId: string; kind: string; status: string }> }> }).projects.find((entry) => entry.stableId === project.stableId);
    assert.deepEqual(savedProject?.workOrders.map(({ kind, status }) => [kind, status]), [["GATHER", "PLANNED"]]);

    const afterSaveStore = new SqliteSnapshotReadStore(databasePath);
    let currentProject;
    try { currentProject = new DashboardReadModel(afterSaveStore).getErpProjects({ version: "classic-era" }).find((entry) => entry.stableId === project.stableId); }
    finally { afterSaveStore.close(); }
    assert.ok(currentProject);
    const updated = await client.callTool({ name: "update_erp_project_plan", arguments: {
      version: "classic-era", projectId: project.stableId, expectedRevision: project.revision + 1,
      project: {
        ...currentProject,
        workOrders: currentProject.workOrders.map((order) => ({ ...order, status: "IN_PROGRESS" })),
      },
    } });
    assert.equal(updated.isError, undefined, JSON.stringify(updated.structuredContent));

    const reduced = await client.callTool({ name: "replan_erp_reservations", arguments: {
      version: "classic-era", projects: [{ projectId: reservedProject.stableId, expectedRevision: reservedProject.revision, reservations: [{ stableId: "stone_hold", quantity: 1, status: "ACTIVE" }] }],
    } });
    assert.equal(reduced.isError, undefined, "the opt-in reservation tool reuses the atomic REST replan");
    const unsafeIncrease = await client.callTool({ name: "replan_erp_reservations", arguments: {
      version: "classic-era", projects: [{ projectId: reservedProject.stableId, expectedRevision: reservedProject.revision + 1, reservations: [{ stableId: "stone_hold", quantity: 3, status: "ACTIVE" }] }],
    } });
    assert.equal(unsafeIncrease.isError, true, "the REST-backed MCP reservation route refuses an increase");

    const stale = await client.callTool({ name: "plan_erp_work_order_batch", arguments: {
      version: "classic-era", updates: [{ projectId: project.stableId, expectedRevision: project.revision, tasks: [{ needId: "stone", kind: "GATHER", title: "Stale plan", instructions: "Must not persist.", reviewSnapshot }] }],
    } });
    assert.equal(stale.isError, true, "the existing REST optimistic revision guard rejects stale MCP planning");
    assert.equal((stale.structuredContent as { error: { code: string } }).error.code, "PLANNING_API_REJECTED");

    const restResponse = await fetch(`http://127.0.0.1:${port}/api/versions/classic-era/erp/projects`);
    const restBody = await restResponse.json() as { projects: Array<{ stableId: string; revision: number; workOrders: Array<{ stableId: string; status: string }> }> };
    const persisted = restBody.projects.find((entry) => entry.stableId === project.stableId);
    assert.equal(persisted?.revision, project.revision + 2);
    assert.equal(persisted?.workOrders.length, 1, "the rejected stale attempt creates no partial or duplicate order");
    assert.equal(persisted?.workOrders[0]?.stableId, savedProject?.workOrders[0]?.stableId);
    assert.equal(persisted?.workOrders[0]?.status, "IN_PROGRESS", "the plan update records player-declared progress without claiming a game outcome");
    assert.deepEqual(apiStore.getErpProject(reservedProject.stableId)?.reservations.map(({ stableId, quantity, status }) => [stableId, quantity, status]), [["stone_hold", 1, "ACTIVE"]], "reservation replan only reduces existing intent");
    const accountContext = await fetch(`http://127.0.0.1:${port}/api/account-context`).then((response) => response.json()) as { planning: { projects: Array<{ stableId: string; workOrderCounts: Record<string, number> }> } };
    const accountProject = accountContext.planning.projects.find((entry) => entry.stableId === project.stableId);
    assert.equal(accountProject?.workOrderCounts.IN_PROGRESS, 1, "AccountContext summarizes the same player-declared progress state");

    const readback = await client.callTool({ name: "get_erp_projects", arguments: { version: "classic-era" } });
    const mcpProject = (readback.structuredContent as { projects: Array<{ stableId: string; workOrders: Array<{ stableId: string }> }> }).projects.find((entry) => entry.stableId === project.stableId);
    assert.deepEqual(mcpProject?.workOrders.map((entry) => entry.stableId), persisted?.workOrders.map((entry) => entry.stableId), "MCP readback and REST expose the same committed manual plan");
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/versions/forever/erp/projects`).then((response) => response.json()) as { projects: Array<{ stableId: string }> }).projects.some((entry) => entry.stableId === project.stableId), false, "the plan is absent from another version bucket");
  } finally {
    await client.close();
    await new Promise<void>((resolve) => api.close(() => resolve()));
    apiStore.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("MCP planning writes reject non-loopback and path-bearing API configuration before opening a database", () => {
  for (const planningApiBaseUrl of ["https://127.0.0.1:4173", "http://example.test", "http://localhost:4173", "http://127.0.0.1:4173/proxy", "http://user@127.0.0.1:4173"]) {
    assert.throws(() => createWoWSyncMcpServer({ databasePath: path.join(os.tmpdir(), "must-not-be-opened.sqlite"), planningApiBaseUrl }), /loopback.*origin/);
  }
});
