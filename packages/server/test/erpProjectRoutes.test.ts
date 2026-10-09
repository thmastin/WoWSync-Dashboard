import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { SqliteSnapshotStore } from "@wowsync-dashboard/core";
import { buildWowSyncExport } from "../../core/test/fixtureBuilder.ts";
import { createApp } from "../src/app.ts";
import { LOOPBACK_HOSTNAMES, listenOnce } from "../src/net.ts";

async function withServer(run: (call: (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>, store: SqliteSnapshotStore) => Promise<void>) {
  const store = new SqliteSnapshotStore(":memory:");
  store.importSnapshot(buildWowSyncExport({ character: { name: "Mira", realm: "PvP 2", clientVersion: "1.15.7", clientBuild: "60927", moneyCopper: 10000 }, bags: { containers: [{ id: 0, capacity: 16, items: [{ itemRef: "item:159", name: "Rough Stone", qty: 3 }] }] }, bank: { unknown: true } }));
  const server = await listenOnce(createApp(store, 0, undefined, { allowedHosts: LOOPBACK_HOSTNAMES }), "127.0.0.1", 0);
  const port = (server.address() as AddressInfo).port;
  const call = (method: string, path: string, body?: unknown) => new Promise<{ status: number; body: any }>((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = { Host: `127.0.0.1:${port}`, ...(payload ? { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(payload)) } : {}) };
    const req = http.request({ host: "127.0.0.1", port, method, path, headers }, (res) => { let text = ""; res.on("data", (chunk) => text += chunk); res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : undefined })); });
    req.on("error", reject); req.end(payload);
  });
  try { await run(call, store); } finally { await new Promise<void>((resolve) => server.close(() => resolve())); store.close(); }
}

test("project REST persists explicit plans and returns evidence from the shared core read model", async () => {
  await withServer(async (call, store) => {
    const character = store.listCharacters("classic-era")[0]!;
    const created = await call("POST", "/api/versions/classic-era/erp/projects", { title: "Prepare first craft", priority: 4, needs: [{ stableId: "stone", kind: "ITEM_REF", resourceKey: "item:159", label: "Rough Stone", requiredQuantity: 5, sourceIdentityKey: character.identityKey }], reservations: [{ stableId: "reserve", needId: "stone", sourceIdentityKey: character.identityKey, quantity: 2, status: "ACTIVE", createdAt: 1700000000, updatedAt: 1700000000 }], workOrders: [{ stableId: "gather", kind: "GATHER", status: "PLANNED", title: "Gather one more", resourceNeedIds: ["stone"], dependsOn: [] }] });
    assert.equal(created.status, 201);
    assert.equal(created.body.project.needEvidence[0].state, "UNKNOWN", "unobserved bank prevents claiming a complete shortfall");
    assert.equal(created.body.project.needEvidence[0].observedQuantity, 3);
    assert.equal(created.body.project.reservationReview[0].state, "WITHIN_OBSERVED_SUPPLY");
    assert.equal(created.body.project.workOrderProgress[0].recordedStatus, "PLANNED");
    assert.equal(created.body.project.workOrderProgress[0].linkedNeedState, "STALE_OR_UNKNOWN");
    assert.equal(created.body.project.workOrderProgress[0].reconciliation, "INSUFFICIENT_EVIDENCE");
    assert.deepEqual(created.body.project.history.map((event: any) => [event.revision, event.kind]), [[1, "CREATED"]]);
    const listed = await call("GET", "/api/versions/classic-era/erp/projects");
    assert.equal(listed.body.projects[0].stableId, created.body.project.stableId);
    assert.equal(listed.body.resourceCommitments.totalCount, 1);
    assert.equal(listed.body.resourceCommitments.items[0].activeNeedQuantity, 5);
    assert.equal(listed.body.resourceCommitments.items[0].activeReservationQuantity, 2);
    assert.equal(listed.body.resourceCommitments.items[0].observedQuantity, 3, "REST commitment view reuses one observed source quantity rather than multiplying it by projects");
    const context = await call("GET", "/api/account-context");
    assert.equal(context.body.planning.projects[0].title, "Prepare first craft");
    assert.equal(context.body.planning.projects[0].version, "classic-era");
    assert.equal(context.body.planning.projects[0].revision, 1);
    assert.equal(context.body.planning.projects[0].historyEventCount, 1);
    assert.deepEqual(context.body.planning.projects[0].workOrderProgressStates, { INSUFFICIENT_EVIDENCE: 1 }, "AccountContext summarizes the same reconciliation state exposed by REST");
    assert.deepEqual((await call("GET", "/api/versions/retail/erp/projects")).body.projects, []);
  });
});

test("manual supply readiness is summarized by AccountContext from the REST planning projection", async () => {
  await withServer(async (call, store) => {
    const generatedAt = Math.floor(Date.now() / 1000) + 1;
    store.importSnapshot(buildWowSyncExport({ generatedAt, character: { name: "Mira", realm: "PvP 2", clientVersion: "1.15.7", clientBuild: "60927", moneyCopper: 10000 }, bags: { containers: [{ id: 0, capacity: 16, items: [{ itemRef: "item:159", name: "Rough Stone", qty: 3 }] }] }, bank: { containers: [] } }));
    const character = store.listCharacters("classic-era")[0]!;
    const created = await call("POST", "/api/versions/classic-era/erp/projects", { title: "Gather for the repair", needs: [{ stableId: "stone", kind: "ITEM_REF", resourceKey: "item:159", label: "Rough Stone", requiredQuantity: 5, sourceIdentityKey: character.identityKey }], workOrders: [{ stableId: "gather", kind: "GATHER", status: "PLANNED", title: "Gather the shortage", resourceNeedIds: ["stone"], dependsOn: [] }] });
    assert.equal(created.status, 201);
    assert.equal(created.body.project.workOrderReadiness[0].state, "MANUAL_SUPPLY_STEP_RECOMMENDED");
    assert.deepEqual(created.body.project.workOrderReadiness[0].actionTargetNeedIds, ["stone"]);
    const context = await call("GET", "/api/account-context");
    assert.equal(context.body.schemaVersion, "11");
    assert.deepEqual(context.body.planning.projects[0].workOrderReadinessStates, { MANUAL_SUPPLY_STEP_RECOMMENDED: 1 }, "AccountContext carries the count for the exact core/REST readiness state");
    assert.deepEqual(context.body.planning.resourceCommitments["classic-era"], { lineCount: 1, linesWithReservations: 0, unknownSourceLines: 0, overlappingScopeLines: 0, truncated: false });
  });
});

test("REST and AccountContext do not reconcile covered stock as work-order progress when another plan reserves it", async () => {
  await withServer(async (call, store) => {
    const generatedAt = Math.floor(Date.now() / 1000) + 1;
    store.importSnapshot(buildWowSyncExport({ generatedAt, character: { name: "Mira", realm: "PvP 2", clientVersion: "1.15.7", clientBuild: "60927", moneyCopper: 10000 }, bags: { containers: [{ id: 0, capacity: 16, items: [{ itemRef: "item:159", name: "Rough Stone", qty: 4 }] }] }, bank: { containers: [] } }));
    const character = store.listCharacters("classic-era")[0]!;
    const target = await call("POST", "/api/versions/classic-era/erp/projects", { title: "Craft with available stock", needs: [{ stableId: "target", kind: "ITEM_REF", resourceKey: "item:159", label: "Rough Stone", requiredQuantity: 3, sourceIdentityKey: character.identityKey }], workOrders: [{ stableId: "craft", kind: "CRAFT", status: "IN_PROGRESS", title: "Craft manually", resourceNeedIds: ["target"], dependsOn: [] }] });
    assert.equal(target.status, 201);
    const competing = await call("POST", "/api/versions/classic-era/erp/projects", { title: "Reserve same observed stock", needs: [{ stableId: "held", kind: "ITEM_REF", resourceKey: "item:159", label: "Rough Stone", requiredQuantity: 3, sourceIdentityKey: character.identityKey }], reservations: [{ stableId: "hold", needId: "held", sourceIdentityKey: character.identityKey, quantity: 3, status: "ACTIVE", createdAt: generatedAt, updatedAt: generatedAt }] });
    assert.equal(competing.status, 201);
    const plans = await call("GET", "/api/versions/classic-era/erp/projects");
    const targetView = plans.body.projects.find((entry: any) => entry.stableId === target.body.project.stableId);
    assert.equal(targetView.workOrderReadiness[0].state, "RESOURCE_ALLOCATION_REQUIRES_REVIEW");
    assert.equal(targetView.workOrderProgress[0].reconciliation, "RESOURCE_ALLOCATION_REQUIRES_REVIEW");
    assert.deepEqual(targetView.workOrderProgress[0].allocationConflictNeedIds, ["target"]);
    const context = await call("GET", "/api/account-context");
    const contextTarget = context.body.planning.projects.find((entry: any) => entry.stableId === target.body.project.stableId);
    assert.deepEqual(contextTarget.workOrderProgressStates, { RESOURCE_ALLOCATION_REQUIRES_REVIEW: 1 }, "AccountContext reconciles the same reservation-aware progress state as REST");
  });
});

test("project REST preserves explicit work-order plan details and histories task status changes as saved intent", async () => {
  await withServer(async (call, store) => {
    const character = store.listCharacters("classic-era")[0]!;
    const created = await call("POST", "/api/versions/classic-era/erp/projects", { title: "Provision", workOrders: [{ stableId: "manual", kind: "TRANSFER", status: "PLANNED", title: "Move materials manually", instructions: "Confirm the item in the source export before acting.", sourceIdentityKey: character.identityKey, destinationIdentityKey: character.identityKey, resourceNeedIds: [], dependsOn: [] }] });
    const project = created.body.project;
    assert.equal(project.workOrders[0].instructions, "Confirm the item in the source export before acting.");
    assert.equal(project.workOrders[0].sourceIdentityKey, character.identityKey);
    assert.equal(project.workOrders[0].destinationIdentityKey, character.identityKey);
    const updated = await call("PUT", `/api/versions/classic-era/erp/projects/${project.stableId}`, { expectedRevision: project.revision, project: { ...project, workOrders: [{ ...project.workOrders[0], status: "IN_PROGRESS" }] } });
    assert.equal(updated.status, 200);
    assert.deepEqual(updated.body.project.history[0].workOrderStatusChanges, [{ workOrderId: "manual", title: "Move materials manually", fromStatus: "PLANNED", toStatus: "IN_PROGRESS" }]);
    assert.equal(updated.body.project.workOrderReadiness[0].state, "READY_FOR_PLAYER_REVIEW");
    assert.match(updated.body.project.workOrderReadiness[0].reason, /does not establish access or a transfer route/);
  });
});

test("project REST uses optimistic revisions and never writes completion without player evidence", async () => {
  await withServer(async (call) => {
    const created = await call("POST", "/api/versions/retail/erp/projects", { title: "Provision", workOrders: [{ stableId: "manual", kind: "TRANSFER", status: "PLANNED", title: "Move materials manually", resourceNeedIds: [], dependsOn: [] }] });
    const p = created.body.project;
    const updated = await call("PUT", `/api/versions/retail/erp/projects/${p.stableId}`, { expectedRevision: p.revision, project: { ...p, title: "Provision the character", workOrders: [{ ...p.workOrders[0], status: "COMPLETED" }] } });
    assert.equal(updated.status, 400);
    assert.equal(updated.body.code, "COMPLETION_EVIDENCE_REQUIRED");
    const good = await call("PUT", `/api/versions/retail/erp/projects/${p.stableId}`, { expectedRevision: p.revision, project: { ...p, title: "Provision the character" } });
    assert.equal(good.status, 200);
    assert.equal(good.body.project.revision, 2);
    assert.deepEqual(good.body.project.history.map((event: any) => [event.revision, event.kind, event.changedFields]), [[2, "UPDATED", ["title"]], [1, "CREATED", ["project"]]]);
    const conflict = await call("PUT", `/api/versions/retail/erp/projects/${p.stableId}`, { expectedRevision: p.revision, project: { ...p, title: "stale edit" } });
    assert.equal(conflict.status, 409);
    const completed = await call("PUT", `/api/versions/retail/erp/projects/${p.stableId}`, { expectedRevision: 2, project: { ...good.body.project, status: "COMPLETED", completionNote: "Player observed the provisioning tasks complete." } });
    assert.equal(completed.status, 200);
    assert.equal(completed.body.project.completionNote, "Player observed the provisioning tasks complete.");
    assert.equal(completed.body.project.history[0].kind, "STATUS_CHANGED", "completion is a user intent edit and preserves history rather than asserting a game observation");
    assert.deepEqual(completed.body.project.history.map((event: any) => [event.revision, event.changedFields]), [[3, ["status", "completionNote"]], [2, ["title"]], [1, ["project"]]]);
    const context = await call("GET", "/api/account-context");
    const summary = context.body.planning.projects.find((entry: any) => entry.stableId === p.stableId);
    assert.equal(summary.revision, 3);
    assert.equal(summary.historyEventCount, 3);
  });
});

test("character-scoped Retail currency project evidence agrees in REST and AccountContext", async () => {
  await withServer(async (call, store) => {
    const imported = store.importSnapshot(buildWowSyncExport({ generatedAt: 1_700_000_000, character: { name: "Currency Holder", realm: "Retail Realm", clientFamily: "Retail", clientVersion: "12.1.0" } }), {
      currencies: { observedAt: 1_700_000_000, data: { listRead: true, formatVersion: 1, currencies: [{ currencyID: 1822, name: "Flightstones", quantity: 8, isAccountWide: false }] } },
    });
    const project = store.createErpProject({ version: "retail", title: "Retail currency plan", needs: [{ stableId: "flightstones", kind: "CURRENCY", resourceKey: "1822", label: "Flightstones", requiredQuantity: 6, sourceIdentityKey: imported.character.identityKey }] });
    const rest = await call("GET", "/api/versions/retail/erp/projects");
    assert.equal(rest.status, 200);
    const view = rest.body.projects.find((entry: any) => entry.stableId === project.stableId);
    assert.equal(view.needEvidence[0].state, "COVERED_BY_OBSERVED");
    assert.equal(view.needEvidence[0].observedQuantity, 8);
    assert.equal(view.needEvidence[0].sourceIdentityKey, imported.character.identityKey);
    const context = await call("GET", "/api/account-context");
    const summary = context.body.planning.projects.find((entry: any) => entry.stableId === project.stableId);
    assert.equal(summary.version, "retail");
    assert.deepEqual(summary.needStates, { COVERED_BY_OBSERVED: 1 });
  });
});

test("shared owner planning keeps Warband contents separate and historical in REST and AccountContext", async () => {
  await withServer(async (call, store) => {
    const imported = store.importSnapshot(readFileSync(new URL("../../core/test/fixtures/sanitized/virek-warband-last-seen-1789965777.wowsync.txt", import.meta.url), "utf8"));
    const project = store.createErpProject({ version: "retail", title: "Use observed Warband supply", needs: [{ stableId: "leather", kind: "ITEM_REF", resourceKey: "item:2318::::::::85:253:::::::::", label: "Light Leather", requiredQuantity: 3, sourceOwnerKey: "retail::warband::local", destinationIdentityKey: imported.character.identityKey }] });
    const rest = await call("GET", "/api/versions/retail/erp/projects");
    const view = rest.body.projects.find((entry: any) => entry.stableId === project.stableId);
    assert.equal(view.needEvidence[0].state, "POTENTIAL_COVERAGE_LAST_SEEN");
    assert.equal(view.needEvidence[0].potentialQuantity, 3);
    assert.equal(view.needEvidence[0].sourceOwnerKey, "retail::warband::local");
    assert.match(view.needEvidence[0].reason, /not current supply or character access/);
    const context = await call("GET", "/api/account-context");
    const summary = context.body.planning.projects.find((entry: any) => entry.stableId === project.stableId);
    assert.deepEqual(summary.needStates, { POTENTIAL_COVERAGE_LAST_SEEN: 1 });
  });
});
