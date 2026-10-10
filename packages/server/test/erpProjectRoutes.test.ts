import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { buildErpNeedReviewSnapshot, SqliteSnapshotStore } from "@wowsync-dashboard/core";
import { buildWowSyncExport } from "../../core/test/fixtureBuilder.ts";
import { itemRow, warband } from "../../core/test/sharedStorageBuilders.ts";
import { renderExport } from "../../core/test/sharedStorageExports.ts";
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
    const generatedAt = Math.floor(Date.now() / 1000);
    store.importSnapshot(buildWowSyncExport({ generatedAt, character: { name: "Mira", realm: "PvP 2", clientVersion: "1.15.7", clientBuild: "60927", moneyCopper: 10000 }, bags: { containers: [{ id: 0, capacity: 16, items: [{ itemRef: "item:159", name: "Rough Stone", qty: 3 }] }] }, bank: { unknown: true } }));
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

test("cross-project manual work is saved atomically from reviewed same-version evidence", async () => {
  await withServer(async (call, store) => {
    const generatedAt = Math.floor(Date.now() / 1000);
    store.importSnapshot(buildWowSyncExport({ generatedAt, character: { name: "Mira", realm: "PvP 2", clientVersion: "1.15.7", clientBuild: "60927", moneyCopper: 10000 }, bags: { containers: [{ id: 0, capacity: 16, items: [{ itemRef: "item:159:0:0", name: "Rough Stone", qty: 3 }] }] }, bank: { unknown: true } }));
    const possibleSource = store.importSnapshot(buildWowSyncExport({ generatedAt, character: { name: "Stone Holder", realm: "PvP 2", clientVersion: "1.15.7", clientBuild: "60927", moneyCopper: 0 }, bags: { containers: [{ id: 0, capacity: 16, items: [{ itemRef: "item:159:0:0", name: "Rough Stone", qty: 2 }] }] }, bank: { unknown: true } })).character;
    const identityKey = store.listCharacters("classic-era")[0]!.identityKey;
    const first = (await call("POST", "/api/versions/classic-era/erp/projects", { title: "Provision the crafter", needs: [{ stableId: "stone", kind: "ITEM_REF", resourceKey: "item:159:0:0", label: "Exact rough stone", requiredQuantity: 5, sourceIdentityKey: identityKey, destinationIdentityKey: identityKey }], reservations: [{ stableId: "stone-hold", needId: "stone", sourceIdentityKey: identityKey, quantity: 1, status: "ACTIVE", createdAt: generatedAt, updatedAt: generatedAt }] })).body.project;
    const second = (await call("POST", "/api/versions/classic-era/erp/projects", { title: "Research the missing recipe", needs: [{ stableId: "recipe", kind: "RECIPE", resourceKey: "12345", label: "Unverified recipe requirement", requiredQuantity: 1 }] })).body.project;
    const projects = (await call("GET", "/api/versions/classic-era/erp/projects")).body.projects;
    const task = (project: any, needId: string, kind: string, sourceLeadIdentityKey?: string) => ({ projectId: project.stableId, expectedRevision: project.revision, tasks: [{ needId, reviewSnapshot: buildErpNeedReviewSnapshot(project, needId), kind, title: `Review ${needId}`, instructions: "Check current evidence and decide manually.", assignedIdentityKey: identityKey, ...(sourceLeadIdentityKey ? { sourceLeadIdentityKey } : {}) }] });
    const firstCurrent = projects.find((entry: any) => entry.stableId === first.stableId);
    const stoneCandidate = firstCurrent.resourceSourceScreens.find((entry: any) => entry.needId === "stone")?.candidates.find((entry: any) => entry.sourceIdentityKey === possibleSource.identityKey);
    assert.ok(stoneCandidate, "the same-version source screen exposes the matching observed source as a lead for investigation");
    const wrongVersionAssignee = task(firstCurrent, "stone", "INVESTIGATE");
    wrongVersionAssignee.tasks[0].assignedIdentityKey = "retail::character::not-in-classic";
    const invalidAssignee = await call("POST", "/api/versions/classic-era/erp/work-order-batches", { updates: [wrongVersionAssignee] });
    assert.equal(invalidAssignee.status, 400, "assignment must resolve to a character observed in the explicit work-order version");
    assert.equal(invalidAssignee.body.code, "INVALID_WORK_ORDER_ASSIGNMENT");
    const invalidLead = await call("POST", "/api/versions/classic-era/erp/work-order-batches", { updates: [task(firstCurrent, "stone", "GATHER", possibleSource.identityKey)] });
    assert.equal(invalidLead.status, 400, "a source lead is accepted only for INVESTIGATE work");
    assert.equal(invalidLead.body.code, "INVALID_SOURCE_INVESTIGATION_LEAD");
    const invalidCandidate = await call("POST", "/api/versions/classic-era/erp/work-order-batches", { updates: [task(firstCurrent, "stone", "INVESTIGATE", "retail::character::unobserved")] });
    assert.equal(invalidCandidate.status, 400, "a source lead must be among currently reviewed same-version candidates");
    assert.equal(invalidCandidate.body.code, "INVALID_SOURCE_INVESTIGATION_LEAD");
    const invalidProcurementBuyer: any = task(firstCurrent, "stone", "PURCHASE");
    invalidProcurementBuyer.tasks[0].assignedIdentityKey = possibleSource.identityKey;
    invalidProcurementBuyer.tasks[0].spendingCeilingCopper = 100;
    const rejectedProcurement = await call("POST", "/api/versions/classic-era/erp/work-order-batches", { updates: [invalidProcurementBuyer] });
    assert.equal(rejectedProcurement.status, 400, "a procurement ceiling cannot be attached when the item need does not name that assignee as source and recipient");
    assert.equal(rejectedProcurement.body.code, "INVALID_PROCUREMENT_PLAN");
    const saved = await call("POST", "/api/versions/classic-era/erp/work-order-batches", { updates: [task(firstCurrent, "stone", "INVESTIGATE", possibleSource.identityKey), task(projects.find((entry: any) => entry.stableId === second.stableId), "recipe", "INVESTIGATE")] });
    assert.equal(saved.status, 200);
    assert.deepEqual([saved.body.atomic, saved.body.createdCount], [true, 2]);
    assert.deepEqual(saved.body.projects.map((project: any) => [project.title, project.workOrders[0].status, project.workOrders[0].resourceNeedIds]).sort((a: any, b: any) => a[0].localeCompare(b[0])), [["Provision the crafter", "PLANNED", ["stone"]], ["Research the missing recipe", "PLANNED", ["recipe"]]]);
    const savedFirst = saved.body.projects.find((project: any) => project.stableId === first.stableId);
    assert.equal(savedFirst.reservations[0].quantity, 1, "adding manual work does not reserve or consume resources");
    assert.match(savedFirst.workOrders[0].instructions, /SYSTEM EVIDENCE BOUNDARY/);
    assert.equal(savedFirst.workOrders[0].sourceIdentityKey, identityKey, "the original requirement source intent is retained separately");
    assert.equal(savedFirst.workOrders[0].investigationSourceLeadIdentityKey, possibleSource.identityKey, "the observed candidate is attached only as a source lead");
    assert.equal(savedFirst.workOrders[0].destinationIdentityKey, identityKey);
    const context = await call("GET", "/api/account-context");
    assert.ok(context.body.planning.projects.some((entry: any) => entry.stableId === first.stableId && entry.revision === 2));
    assert.deepEqual((await call("GET", "/api/versions/retail/erp/projects")).body.projects, [], "the grouped plan remains in its explicit game version");
    const rest = await call("GET", "/api/versions/classic-era/erp/projects");
    assert.deepEqual(rest.body.projects.filter((project: any) => [first.stableId, second.stableId].includes(project.stableId)).map((project: any) => project.workOrders.length), [1, 1]);
  });
});

test("exact source lead creates an atomic supplemental provisioning review package across buyer projects", async () => {
  await withServer(async (call, store) => {
    const at = Math.floor(Date.now() / 1000);
    const capture = (name: string, quantity: number, generatedAt = at) => buildWowSyncExport({ generatedAt, character: { name, realm: "PvP 2", clientVersion: "1.15.7", clientBuild: "60927", moneyCopper: 10000 }, bags: { containers: [{ id: 0, capacity: 16, items: quantity ? [{ itemRef: "item:159:0:0", name: "Rough Stone", qty: quantity }] : [] }] }, bank: { unknown: true } });
    store.importSnapshot(capture("Mira", 0));
    const source = store.importSnapshot(capture("Stone Holder", 4)).character;
    const buyer = store.listCharacters("classic-era").find((character) => character.name === "Mira")!.identityKey;
    const createBuyerProject = async (title: string, suffix: string) => (await call("POST", "/api/versions/classic-era/erp/projects", {
      title,
      needs: [{ stableId: `stone-${suffix}`, kind: "ITEM_REF", resourceKey: "item:159:0:0", label: "Exact Rough Stone variant", requiredQuantity: 3, sourceIdentityKey: buyer, destinationIdentityKey: buyer }],
      workOrders: [{ stableId: `purchase-${suffix}`, kind: "PURCHASE", status: "PLANNED", title: "Review buyer purchase", resourceNeedIds: [`stone-${suffix}`], dependsOn: [], assignedIdentityKey: buyer, procurementPlan: { targetNeedId: `stone-${suffix}`, spendingCeilingCopper: 500 } }],
    })).body.project;
    const first = await createBuyerProject("Prepare tool A", "a");
    const second = await createBuyerProject("Prepare tool B", "b");
    const projects = (await call("GET", "/api/versions/classic-era/erp/projects")).body.projects;
    const payload = (project: any, needId: string, expectedRevision = project.revision) => ({ projectId: project.stableId, needId, expectedRevision });
    const body = { buyerIdentityKey: buyer, sourceIdentityKey: source.identityKey, resourceKey: "item:159:0:0", tasks: [payload(projects.find((project: any) => project.stableId === first.stableId), "stone-a"), payload(projects.find((project: any) => project.stableId === second.stableId), "stone-b")] };
    const single = await call("POST", "/api/versions/classic-era/erp/provisioning-review-batches", { ...body, tasks: [body.tasks[0]] });
    assert.equal(single.status, 400, "the grouped endpoint requires at least two linked requirements");
    const sameProject = await call("POST", "/api/versions/classic-era/erp/provisioning-review-batches", { ...body, tasks: [body.tasks[0], { ...body.tasks[0], needId: "stone-a-copy" }] });
    assert.equal(sameProject.status, 400, "the grouped endpoint requires distinct projects");
    const tooManyProjects = await call("POST", "/api/versions/classic-era/erp/provisioning-review-batches", { ...body, tasks: Array.from({ length: 11 }, (_, index) => ({ projectId: `project-${index}`, needId: `need-${index}`, expectedRevision: 1 })) });
    assert.equal(tooManyProjects.status, 400, "the project bound is checked before idempotent duplicate filtering or project lookup");
    const invalid = await call("POST", "/api/versions/classic-era/erp/provisioning-review-batches", { ...body, tasks: [body.tasks[0], { ...body.tasks[1], expectedRevision: 999 }] });
    assert.equal(invalid.status, 409, "a stale project revision prevents the complete multi-project write");
    let readback = (await call("GET", "/api/versions/classic-era/erp/projects")).body.projects.filter((project: any) => [first.stableId, second.stableId].includes(project.stableId));
    assert.deepEqual(readback.map((project: any) => project.workOrders.length), [1, 1], "failed batch leaves both buyer purchase plans untouched");

    const saved = await call("POST", "/api/versions/classic-era/erp/provisioning-review-batches", body);
    assert.equal(saved.status, 200);
    assert.deepEqual([saved.body.atomic, saved.body.createdCount, saved.body.skippedExistingCount], [true, 2, 0]);
    for (const project of saved.body.projects) {
      const need = project.needs[0];
      const review = project.workOrders.find((order: any) => order.kind === "PROVISION");
      assert.equal(need.sourceIdentityKey, buyer, "buyer need's planned source is unchanged");
      assert.equal(need.destinationIdentityKey, buyer);
      assert.deepEqual([review.sourceIdentityKey, review.destinationIdentityKey, review.assignedIdentityKey], [source.identityKey, buyer, buyer]);
      assert.match(review.instructions, /does not establish ownership, account membership, access, binding, or a valid transfer route/);
      assert.match(review.instructions, /No item is reserved or moved/);
    }
    readback = (await call("GET", "/api/versions/classic-era/erp/projects")).body.projects.filter((project: any) => [first.stableId, second.stableId].includes(project.stableId));
    const repeated = await call("POST", "/api/versions/classic-era/erp/provisioning-review-batches", { ...body, tasks: readback.map((project: any) => payload(project, project.needs[0].stableId)) });
    assert.deepEqual([repeated.status, repeated.body.createdCount, repeated.body.skippedExistingCount], [200, 0, 2], "retry is idempotent for existing source/destination reviews");
    const wrongVariant = await call("POST", "/api/versions/classic-era/erp/provisioning-review-batches", { ...body, resourceKey: "item:159:0:1" });
    assert.equal(wrongVariant.status, 409, "a near variant cannot be substituted for the exact buyer need");
    store.importSnapshot(capture("Stone Holder", 2, at + 60));
    store.importSnapshot(capture("Mira", 1, at + 60));
    const reconciled = (await call("GET", "/api/versions/classic-era/erp/projects")).body.projects.filter((project: any) => [first.stableId, second.stableId].includes(project.stableId));
    for (const project of reconciled) {
      const review = project.workOrderProgress.find((entry: any) => entry.workOrderId === project.workOrders.find((order: any) => order.kind === "PROVISION").stableId).provisioningObservationReviews[0];
      assert.equal(review.state, "BOTH_SIDES_CHANGED", "paired fresh source and buyer evidence is compared against the explicit provisioning source");
      assert.equal(review.sourceIntentIdentityKey, buyer, "the existing purchase need's original source intent remains visible");
      assert.equal(review.interpretation, "CAUSE_UNKNOWN", "paired inventory changes do not prove this manual review caused a movement");
    }
  });
});

test("portfolio prerequisite links are version-scoped, cycle checked, and block until current evidence covers the need", async () => {
  await withServer(async (call, store) => {
    const at = Math.floor(Date.now() / 1000);
    store.importSnapshot(buildWowSyncExport({ generatedAt: at, character: { name: "Mira", realm: "PvP 2", clientVersion: "1.15.7", clientBuild: "60927" }, bags: { containers: [{ id: 0, capacity: 16, items: [{ itemRef: "item:159:0:0", name: "Rough Stone", qty: 2 }] }] }, bank: { containers: [] } }));
    const identityKey = store.listCharacters("classic-era")[0]!.identityKey;
    const prerequisite = (await call("POST", "/api/versions/classic-era/erp/projects", { title: "First supply step", needs: [{ stableId: "shared-local-need-id", kind: "ITEM_REF", resourceKey: "item:159:0:0", label: "First supply", requiredQuantity: 5, sourceIdentityKey: identityKey }] })).body.project;
    const dependent = (await call("POST", "/api/versions/classic-era/erp/projects", { title: "Downstream work", needs: [{ stableId: "shared-local-need-id", kind: "ITEM_REF", resourceKey: "item:159:0:0", label: "Downstream supply", requiredQuantity: 3, sourceIdentityKey: identityKey }] })).body.project;
    const retailProject = (await call("POST", "/api/versions/retail/erp/projects", { title: "Other version", needs: [{ stableId: "other", kind: "ITEM_ID", resourceKey: "159", label: "Other version need", requiredQuantity: 1 }] })).body.project;
    const classic = (await call("GET", "/api/versions/classic-era/erp/projects")).body.projects;
    const first = classic.find((project: any) => project.stableId === prerequisite.stableId);
    const second = classic.find((project: any) => project.stableId === dependent.stableId);
    const task = (project: any, needId: string, portfolioPrerequisites: unknown[] = []) => ({ projectId: project.stableId, expectedRevision: project.revision, tasks: [{ needId, reviewSnapshot: buildErpNeedReviewSnapshot(project, needId), kind: "INVESTIGATE", title: `Review ${needId}`, instructions: "Review the prerequisite evidence and decide manually.", portfolioPrerequisites }] });
    const wrongVersion = await call("POST", "/api/versions/classic-era/erp/work-order-batches", { updates: [task(second, "shared-local-need-id", [{ projectId: retailProject.stableId, needId: "other" }])] });
    assert.equal(wrongVersion.status, 409);
    assert.equal(wrongVersion.body.code, "PORTFOLIO_PREREQUISITE_STALE", "a project from another version is not resolved through a co-located ID");
    const missingNeed = await call("POST", "/api/versions/classic-era/erp/work-order-batches", { updates: [task(second, "shared-local-need-id", [{ projectId: first.stableId, needId: "absent" }])] });
    assert.equal(missingNeed.status, 409);
    assert.equal(missingNeed.body.code, "PORTFOLIO_PREREQUISITE_STALE");
    const accepted = await call("POST", "/api/versions/classic-era/erp/work-order-batches", { updates: [task(second, "shared-local-need-id", [{ projectId: first.stableId, needId: "shared-local-need-id" }])] });
    assert.equal(accepted.status, 200);
    const saved = accepted.body.projects.find((project: any) => project.stableId === second.stableId);
    assert.deepEqual(saved.workOrders[0].portfolioPrerequisites, [{ projectId: first.stableId, needId: "shared-local-need-id" }]);
    assert.equal(saved.workOrderReadiness[0].state, "WAITING_FOR_PORTFOLIO_PREREQUISITE");
    assert.equal(saved.workOrderReadiness[0].portfolioPrerequisites[0].state, "OBSERVED_SHORTFALL");
    assert.deepEqual(saved.workOrderReadiness[0].unresolvedNeedIds, [], "a foreign prerequisite's project-local ID is not misreported as a need on the dependent project");
    const linkedPortfolio = (await call("GET", "/api/versions/classic-era/erp/projects")).body.portfolioFulfillment;
    assert.equal(linkedPortfolio.totalPackageCount, 1, "the REST project read returns the shared portfolio package projection");
    assert.deepEqual(linkedPortfolio.packages[0].steps.map((step: any) => step.projectId), [first.stableId, second.stableId]);
    const context = await call("GET", "/api/account-context");
    assert.deepEqual(context.body.planning.projects.find((project: any) => project.stableId === second.stableId).workOrderReadinessStates, { WAITING_FOR_PORTFOLIO_PREREQUISITE: 1 });
    store.importSnapshot(buildWowSyncExport({ generatedAt: at + 1, character: { name: "Mira", realm: "PvP 2", clientVersion: "1.15.7", clientBuild: "60927" }, bags: { containers: [{ id: 0, capacity: 16, items: [{ itemRef: "item:159:0:0", name: "Rough Stone", qty: 5 }] }] }, bank: { containers: [] } }));
    const afterEvidence = (await call("GET", "/api/versions/classic-era/erp/projects")).body.projects.find((project: any) => project.stableId === second.stableId);
    assert.equal(afterEvidence.workOrderReadiness[0].portfolioPrerequisites[0].state, "OBSERVED_MET", "a later same-version complete observation satisfies the evidence gate without completing either project");
    assert.equal(afterEvidence.workOrderReadiness[0].state, "OBSERVATION_CHANGED_REQUIRES_REVIEW", "new evidence satisfies the gate, then the existing non-causal changed-observation guard asks the player to review the change");
    assert.equal(afterEvidence.status, "ACTIVE", "portfolio evidence changes readiness but do not change saved project status");

    const cycleA = (await call("POST", "/api/versions/classic-era/erp/projects", { title: "Cycle A", needs: [{ stableId: "a", kind: "ITEM_REF", resourceKey: "item:159:0:0", label: "A", requiredQuantity: 1, sourceIdentityKey: identityKey }] })).body.project;
    const cycleB = (await call("POST", "/api/versions/classic-era/erp/projects", { title: "Cycle B", needs: [{ stableId: "b", kind: "ITEM_REF", resourceKey: "item:159:0:0", label: "B", requiredQuantity: 1, sourceIdentityKey: identityKey }] })).body.project;
    const before = (await call("GET", "/api/versions/classic-era/erp/projects")).body.projects;
    const cycle = await call("POST", "/api/versions/classic-era/erp/work-order-batches", { updates: [
      task(before.find((project: any) => project.stableId === cycleA.stableId), "a", [{ projectId: cycleB.stableId, needId: "b" }]),
      task(before.find((project: any) => project.stableId === cycleB.stableId), "b", [{ projectId: cycleA.stableId, needId: "a" }]),
    ] });
    assert.equal(cycle.status, 400);
    assert.equal(cycle.body.code, "PORTFOLIO_DEPENDENCY_CYCLE");
    const after = (await call("GET", "/api/versions/classic-era/erp/projects")).body.projects.filter((project: any) => [cycleA.stableId, cycleB.stableId].includes(project.stableId));
    assert.deepEqual(after.map((project: any) => [project.revision, project.workOrders.length]), [[1, 0], [1, 0]], "a cyclic package is rejected without partial writes");
    const addDependency = (project: any, workOrderId: string, prerequisiteProjectId: string, prerequisiteNeedId: string) => call("PUT", `/api/versions/classic-era/erp/projects/${project.stableId}`, { expectedRevision: project.revision, project: { title: project.title, status: project.status, priority: project.priority, needs: project.needs, reservations: project.reservations, workOrders: [...project.workOrders, { stableId: workOrderId, kind: "INVESTIGATE", status: "PLANNED", title: `Review ${workOrderId}`, instructions: "Review evidence manually.", resourceNeedIds: [project.needs[0].stableId], dependsOn: [], portfolioPrerequisites: [{ projectId: prerequisiteProjectId, needId: prerequisiteNeedId }] }] } });
    const savedA = await addDependency(after.find((project: any) => project.stableId === cycleA.stableId), "cycle_a_task", cycleB.stableId, "b");
    assert.equal(savedA.status, 200, "an existing same-version prerequisite can be linked to a manual project work order");
    const latestB = (await call("GET", "/api/versions/classic-era/erp/projects")).body.projects.find((project: any) => project.stableId === cycleB.stableId);
    const reverse = await addDependency(latestB, "cycle_b_task", cycleA.stableId, "a");
    assert.equal(reverse.status, 409, "ordinary project edits cannot bypass the portfolio cycle guard");
    assert.equal(reverse.body.code, "PORTFOLIO_DEPENDENCY_CYCLE");
  });
});

test("cross-project reservation requests are capacity checked together and saved atomically with work", async () => {
  await withServer(async (call, store) => {
    const at = Math.floor(Date.now() / 1000);
    store.importSnapshot(buildWowSyncExport({ generatedAt: at, character: { name: "Mira", realm: "PvP 2", clientVersion: "1.15.7", clientBuild: "60927", moneyCopper: 10000 }, bags: { containers: [{ id: 0, capacity: 16, items: [{ itemRef: "item:159:0:0", name: "Rough Stone", qty: 5 }] }] }, bank: { containers: [] } }));
    const identityKey = store.listCharacters("classic-era")[0]!.identityKey;
    const create = async (title: string, needId: string) => (await call("POST", "/api/versions/classic-era/erp/projects", { title, needs: [{ stableId: needId, kind: "ITEM_REF", resourceKey: "item:159:0:0", label: title, requiredQuantity: 5, sourceIdentityKey: identityKey }] })).body.project;
    const first = await create("Reserve stone for craft A", "need_a");
    const second = await create("Reserve stone for craft B", "need_b");
    const current = (await call("GET", "/api/versions/classic-era/erp/projects")).body.projects;
    const group = (project: any, needId: string, quantity: number) => ({ projectId: project.stableId, expectedRevision: project.revision, tasks: [{ needId, reviewSnapshot: buildErpNeedReviewSnapshot(project, needId), kind: "CRAFT", title: `Plan ${needId}`, instructions: "Confirm prerequisites and craft manually.", reservationQuantity: quantity }] });
    const firstView = current.find((project: any) => project.stableId === first.stableId);
    const secondView = current.find((project: any) => project.stableId === second.stableId);
    const over = await call("POST", "/api/versions/classic-era/erp/work-order-batches", { updates: [group(firstView, "need_a", 3), group(secondView, "need_b", 3)] });
    assert.equal(over.status, 409);
    assert.equal(over.body.code, "RESERVATION_CAPACITY_EXCEEDED");
    let listed = (await call("GET", "/api/versions/classic-era/erp/projects")).body.projects.filter((project: any) => [first.stableId, second.stableId].includes(project.stableId));
    assert.deepEqual(listed.map((project: any) => [project.revision, project.workOrders.length, project.reservations.length]), [[1, 0, 0], [1, 0, 0]], "capacity rejection rolls back every order and reservation");

    const accepted = await call("POST", "/api/versions/classic-era/erp/work-order-batches", { updates: [group(firstView, "need_a", 3), group(secondView, "need_b", 2)] });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.createdCount, 2);
    assert.equal(accepted.body.projects.reduce((sum: number, project: any) => sum + project.reservations.reduce((inside: number, reservation: any) => inside + (reservation.status === "ACTIVE" ? reservation.quantity : 0), 0), 0), 5);
    assert.equal(accepted.body.projects.reduce((sum: number, project: any) => sum + project.workOrders.length, 0), 2);
    assert.equal(accepted.body.projects.every((project: any) => project.revision === 2), true);
    assert.equal(accepted.body.projects[0].needEvidence[0].observedQuantity, 5, "reservation intent does not mutate observed stock");
    const context = await call("GET", "/api/account-context");
    assert.equal(context.body.planning.projects.filter((project: any) => [first.stableId, second.stableId].includes(project.stableId)).every((project: any) => project.reservationReviewStates.WITHIN_OBSERVED_SUPPLY === 1), true);
    assert.deepEqual((await call("GET", "/api/versions/retail/erp/projects")).body.projects, []);

    store.importSnapshot(buildWowSyncExport({ generatedAt: at + 1, character: { name: "Mira", realm: "PvP 2", clientVersion: "1.15.7", clientBuild: "60927", moneyCopper: 10000 }, bags: { containers: [{ id: 0, capacity: 16, items: [{ itemRef: "item:159:0:0", name: "Rough Stone", qty: 5 }] }] }, bank: { unknown: true } }));
    const third = await create("Unknown bank source", "need_c");
    const latest = (await call("GET", "/api/versions/classic-era/erp/projects")).body.projects.find((project: any) => project.stableId === third.stableId);
    const unknown = await call("POST", "/api/versions/classic-era/erp/work-order-batches", { updates: [group(latest, "need_c", 1)] });
    assert.equal(unknown.status, 409, "unknown bank evidence remains an explicit block to a new reservation");
    assert.equal(unknown.body.code, "RESERVATION_EVIDENCE_UNAVAILABLE");
    listed = (await call("GET", "/api/versions/classic-era/erp/projects")).body.projects.filter((project: any) => project.stableId === third.stableId);
    assert.deepEqual([listed[0].revision, listed[0].workOrders.length, listed[0].reservations.length], [1, 0, 0]);
  });
});

test("a base-item reservation cannot bypass a conflicting exact-variant requirement", async () => {
  await withServer(async (call, store) => {
    const at = Math.floor(Date.now() / 1000);
    store.importSnapshot(buildWowSyncExport({ generatedAt: at, character: { name: "Mira", realm: "PvP 2", clientVersion: "1.15.7", clientBuild: "60927" }, bags: { containers: [{ id: 0, capacity: 16, items: [{ itemRef: "item:159:0:0", name: "Rough Stone", qty: 4 }] }] }, bank: { containers: [] } }));
    const identityKey = store.listCharacters("classic-era")[0]!.identityKey;
    const broad = (await call("POST", "/api/versions/classic-era/erp/projects", { title: "Any Rough Stone", needs: [{ stableId: "materials", kind: "ITEM_ID", resourceKey: "159", label: "Rough Stone", requiredQuantity: 2, sourceIdentityKey: identityKey }] })).body.project;
    const exact = (await call("POST", "/api/versions/classic-era/erp/projects", { title: "Exact variant", needs: [{ stableId: "materials", kind: "ITEM_REF", resourceKey: "item:159:0:0", label: "Exact Rough Stone variant", requiredQuantity: 2, sourceIdentityKey: identityKey }] })).body.project;
    const request = (project: any, needId: string) => ({ projectId: project.stableId, expectedRevision: project.revision, tasks: [{ needId, reviewSnapshot: buildErpNeedReviewSnapshot(project, needId), kind: "GATHER", title: "Review this requirement", instructions: "Confirm the exact stock scope.", reservationQuantity: 1 }] });
    const result = await call("POST", "/api/versions/classic-era/erp/work-order-batches", { updates: [request(broad, "materials")] });
    assert.equal(result.status, 409);
    assert.equal(result.body.code, "RESERVATION_SCOPE_OVERLAP");
    const projects = (await call("GET", "/api/versions/classic-era/erp/projects")).body.projects.filter((project: any) => [broad.stableId, exact.stableId].includes(project.stableId));
    assert.deepEqual(projects.map((project: any) => [project.revision, project.workOrders.length, project.reservations.length]), [[1, 0, 0], [1, 0, 0]]);
  });
});

test("a grouped manual plan rejects changed evidence before appending any work", async () => {
  await withServer(async (call, store) => {
    const at = Math.floor(Date.now() / 1000);
    const capture = (generatedAt: number, quantity: number) => buildWowSyncExport({ generatedAt, character: { name: "Mira", realm: "PvP 2", clientVersion: "1.15.7", clientBuild: "60927" }, bags: { containers: [{ id: 0, capacity: 16, items: [{ itemRef: "item:159", name: "Rough Stone", qty: quantity }] }] }, bank: { unknown: true } });
    store.importSnapshot(capture(at, 3));
    const identityKey = store.listCharacters("classic-era")[0]!.identityKey;
    const first = (await call("POST", "/api/versions/classic-era/erp/projects", { title: "First fulfillment", needs: [{ stableId: "first_need", kind: "ITEM_REF", resourceKey: "item:159", label: "Rough Stone", requiredQuantity: 5, sourceIdentityKey: identityKey }] })).body.project;
    const second = (await call("POST", "/api/versions/classic-era/erp/projects", { title: "Second fulfillment", needs: [{ stableId: "second_need", kind: "ITEM_REF", resourceKey: "item:159", label: "Rough Stone", requiredQuantity: 4, sourceIdentityKey: identityKey }] })).body.project;
    const views = (await call("GET", "/api/versions/classic-era/erp/projects")).body.projects;
    const toGroup = (project: any, needId: string) => ({ projectId: project.stableId, expectedRevision: project.revision, tasks: [{ needId, reviewSnapshot: buildErpNeedReviewSnapshot(project, needId), kind: "GATHER", title: "Review evidence", instructions: "Check manually." }] });
    const staleUpdates = [toGroup(views.find((p: any) => p.stableId === first.stableId), "first_need"), toGroup(views.find((p: any) => p.stableId === second.stableId), "second_need")];
    store.importSnapshot(capture(at + 30, 2));
    const result = await call("POST", "/api/versions/classic-era/erp/work-order-batches", { updates: staleUpdates });
    assert.equal(result.status, 409);
    assert.equal(result.body.code, "NEED_REVIEW_STALE");
    const readback = await call("GET", "/api/versions/classic-era/erp/projects");
    assert.deepEqual(readback.body.projects.filter((project: any) => [first.stableId, second.stableId].includes(project.stableId)).map((project: any) => [project.workOrders.length, project.revision]), [[0, 1], [0, 1]], "no project is partially updated when one reviewed evidence row is stale");
  });
});

test("latest changed-need review agrees across REST and AccountContext without attributing action cause", async () => {
  await withServer(async (call, store) => {
    const observedAt = Math.floor(Date.now() / 1000) + 100;
    const capture = (time: number, quantity: number) => buildWowSyncExport({ generatedAt: time, character: { name: "Mira", realm: "PvP 2", clientVersion: "1.15.7", clientBuild: "60927" }, bags: { containers: [{ id: 0, capacity: 16, items: [{ itemRef: "item:159:0:0", name: "Rough Stone", qty: quantity }] }] }, bank: { containers: [] } });
    const earlier = store.importSnapshot(capture(observedAt - 100, 1));
    store.importSnapshot(capture(observedAt, 3));
    const created = await call("POST", "/api/versions/classic-era/erp/projects", { title: "Observe resource changes", needs: [{ stableId: "rough_stone", kind: "ITEM_REF", resourceKey: "item:159:0:0", label: "Exact Rough Stone variant", requiredQuantity: 5, sourceIdentityKey: earlier.character.identityKey }] });
    assert.equal(created.status, 201);
    const listed = await call("GET", "/api/versions/classic-era/erp/projects");
    const review = listed.body.observationChanges;
    assert.equal(review.totalCount, 1);
    assert.equal(review.affectedProjectCount, 1);
    assert.equal(review.items[0].resourceKey, "item:159:0:0");
    assert.equal(review.items[0].evidenceState, "SHORTFALL_OBSERVED");
    assert.equal(review.items[0].freshness, "recent");
    assert.deepEqual(review.items[0].comparisons.map((entry: any) => [entry.previousQuantity, entry.currentQuantity, entry.delta]), [[1, 3, 2]]);
    assert.match(review.items[0].reason, /does not establish whether a project action caused/);
    assert.equal(listed.body.fulfillmentTriage.version, "classic-era");
    assert.deepEqual(listed.body.fulfillmentTriage.items[0].signals, ["CHANGED_OBSERVATION", "UNWORKED_REQUIREMENT"]);
    assert.equal(listed.body.fulfillmentTriage.items[0].need.resourceKey, "item:159:0:0");
    const context = await call("GET", "/api/account-context");
    assert.deepEqual(context.body.planning.needObservationChangeReviews["classic-era"], { changedNeedCount: 1, affectedProjectCount: 1, truncated: false });
    assert.deepEqual(context.body.planning.needObservationChangeReviews.retail, { changedNeedCount: 0, affectedProjectCount: 0, truncated: false });
    assert.deepEqual(context.body.planning.fulfillmentTriage["classic-era"].counts, { CHANGED_OBSERVATION: 1, UNWORKED_REQUIREMENT: 1, RESERVATION_REVIEW: 0, OPEN_WORK_ORDER: 0 });
    assert.deepEqual(context.body.planning.fulfillmentTriage.retail.counts, { CHANGED_OBSERVATION: 0, UNWORKED_REQUIREMENT: 0, RESERVATION_REVIEW: 0, OPEN_WORK_ORDER: 0 });
  });
});

test("stale reservation coverage agrees across REST and AccountContext summaries", async () => {
  await withServer(async (call, store) => {
    const observedAt = Math.floor(Date.now() / 1000) - 5 * 86400;
    store.importSnapshot(buildWowSyncExport({ generatedAt: observedAt, character: { name: "Mira", realm: "PvP 2", clientVersion: "1.15.7", clientBuild: "60927" }, bags: { containers: [{ id: 0, capacity: 16, items: [{ itemRef: "item:159", name: "Rough Stone", qty: 3 }] }] }, bank: { unknown: true } }));
    const character = store.listCharacters("classic-era")[0]!;
    const created = await call("POST", "/api/versions/classic-era/erp/projects", { title: "Review stale reserved supply", needs: [{ stableId: "stale_stone", kind: "ITEM_REF", resourceKey: "item:159", label: "Rough Stone", requiredQuantity: 2, sourceIdentityKey: character.identityKey }], reservations: [{ stableId: "stale_stone_hold", needId: "stale_stone", sourceIdentityKey: character.identityKey, quantity: 2, status: "ACTIVE", createdAt: observedAt, updatedAt: observedAt }] });
    assert.equal(created.status, 201);
    const evidence = created.body.project.needEvidence[0];
    assert.equal(evidence.observedQuantity, 3);
    assert.equal(evidence.freshness, "stale");
    assert.equal(evidence.reservationAssessment.state, "UNKNOWN");
    assert.equal(evidence.reservationAssessment.activeQuantity, 2);
    assert.equal(evidence.reservationAssessment.availableObservedLowerBound, undefined);
    assert.equal(created.body.project.reservationReview[0].state, "SUPPLY_UNKNOWN");
    assert.equal(created.body.project.fulfillment.state, "RESERVATIONS_NEED_REVIEW");
    assert.equal(created.body.project.fulfillment.historicalOrStaleEvidenceCount, 1);
    assert.equal(created.body.project.fulfillment.changedObservationCauseUnknownCount, 0);

    const context = await call("GET", "/api/account-context");
    assert.equal(context.body.schemaVersion, "34");
    const summary = context.body.planning.projects.find((entry: any) => entry.stableId === created.body.project.stableId);
    assert.deepEqual(summary.reservationReviewStates, { SUPPLY_UNKNOWN: 1 }, "AccountContext exposes the same compact reservation result as the detailed REST projection");
    assert.deepEqual(summary.fulfillment, created.body.project.fulfillment, "AccountContext carries the same project fulfillment snapshot as REST");
    const listed = await call("GET", "/api/versions/classic-era/erp/projects");
    const listedProject = listed.body.projects.find((entry: any) => entry.stableId === created.body.project.stableId);
    assert.deepEqual(listedProject.reservationReview.map((entry: any) => entry.state), ["SUPPLY_UNKNOWN"]);
  });
});

test("planned craft outputs are returned through REST as intent plus character-scoped evidence", async () => {
  await withServer(async (call, store) => {
    const character = store.listCharacters("classic-era")[0]!;
    const alternate = buildWowSyncExport({ character: { name: "Output Recipient", realm: "PvP 2", clientVersion: "1.15.7", clientBuild: "60927" }, bags: { containers: [] }, bank: { unknown: true } });
    store.importSnapshot(alternate);
    const recipient = store.listCharacters("classic-era").find((entry) => entry.identityKey !== character.identityKey)!;
    const created = await call("POST", "/api/versions/classic-era/erp/projects", {
      title: "Record planned craft result",
      workOrders: [{ stableId: "craft_result", kind: "CRAFT", status: "PLANNED", title: "Craft manually", assignedIdentityKey: character.identityKey, destinationIdentityKey: recipient.identityKey, outputObservationIdentityKey: character.identityKey, resourceNeedIds: [], dependsOn: [], plannedOutput: { kind: "ITEM_REF", resourceKey: "item:159", label: "Rough Stone", quantity: 2 } }],
    });
    assert.equal(created.status, 201);
    const view = created.body.project;
    assert.deepEqual(view.workOrders[0].plannedOutput, { kind: "ITEM_REF", resourceKey: "item:159", label: "Rough Stone", quantity: 2 });
    const assessment = view.workOrderProgress[0].plannedOutputAssessment;
    assert.equal(assessment.recipientIdentityKey, recipient.identityKey);
    assert.equal(assessment.intendedRecipientIdentityKey, recipient.identityKey);
    assert.equal(assessment.observedOnIdentityKey, character.identityKey);
    assert.equal(assessment.state, "COVERED_BY_OBSERVED");
    assert.equal(assessment.observedQuantity, 3);
    assert.match(assessment.reason, /does not prove that crafting occurred/);
    assert.equal(view.workOrderProgress[0].recordedStatus, "PLANNED");
    const context = await call("GET", "/api/account-context");
    const summary = context.body.planning.projects.find((entry: any) => entry.stableId === view.stableId);
    assert.deepEqual(summary.workOrderProgressStates, { NO_LINKED_NEEDS: 1 }, "AccountContext summarizes the same progress projection without treating output as an input requirement");
    assert.deepEqual(summary.plannedCraftOutputStates, { COVERED_BY_OBSERVED: 1 }, "AccountContext exposes a compact count of the same output evidence");
    const listed = (await call("GET", "/api/versions/classic-era/erp/projects")).body.projects[0];
    assert.deepEqual(listed.workOrderProgress[0].plannedOutputAssessment, assessment, "REST read-after-write returns the same core projection");
  });
});

test("REST and AccountContext expose paired craft input observations from the assigned character only", async () => {
  await withServer(async (call, store) => {
    const generatedAt = Math.floor(Date.now() / 1000) + 1;
    const makeCapture = (at: number, quantity: number, outputQuantity: number) => buildWowSyncExport({ generatedAt: at, character: { name: "Craft Pair", realm: "PvP 2", clientVersion: "1.15.7", clientBuild: "60927" }, bags: { containers: [{ id: 0, capacity: 16, items: [{ itemRef: "item:159", name: "Rough Stone", qty: quantity }, ...(outputQuantity ? [{ itemRef: "item:999", name: "Planned Result", qty: outputQuantity }] : [])] }] }, bank: { containers: [] } });
    const first = store.importSnapshot(makeCapture(generatedAt, 4, 0));
    store.importSnapshot(makeCapture(generatedAt + 1, 2, 1));
    const created = await call("POST", "/api/versions/classic-era/erp/projects", { title: "Review paired craft evidence", needs: [{ stableId: "stone_input", kind: "ITEM_REF", resourceKey: "item:159", label: "Rough Stone", requiredQuantity: 4, sourceIdentityKey: first.character.identityKey }], workOrders: [{ stableId: "craft_pair", kind: "CRAFT", status: "PLANNED", title: "Review manual craft", assignedIdentityKey: first.character.identityKey, resourceNeedIds: ["stone_input"], dependsOn: [], plannedOutput: { kind: "ITEM_REF", resourceKey: "item:999", label: "Planned Result", quantity: 1 } }] });
    assert.equal(created.status, 201);
    const progress = created.body.project.workOrderProgress[0];
    assert.deepEqual(progress.craftInputObservationReviews.map((input: any) => [input.needId, input.crafterIdentityKey, input.state, input.comparisons[0].delta]), [["stone_input", first.character.identityKey, "CHANGED", -2]]);
    assert.equal(progress.plannedOutputAssessment.observationChange, "CHANGED");
    assert.equal(progress.completionRecorded, false);
    const listed = (await call("GET", "/api/versions/classic-era/erp/projects")).body.projects[0];
    assert.deepEqual(listed.workOrderProgress[0].craftInputObservationReviews, progress.craftInputObservationReviews, "REST read-after-write retains the core projection");
    const context = (await call("GET", "/api/account-context")).body.planning.projects.find((entry: any) => entry.stableId === created.body.project.stableId);
    assert.deepEqual(context.craftInputObservationStates, { CHANGED: 1 }, "AccountContext summarizes the same input comparison without claiming crafting");
  });
});

test("REST and AccountContext expose an explicit procurement review without asserting price or affordability", async () => {
  await withServer(async (call, store) => {
    const character = store.listCharacters("classic-era")[0]!;
    const generatedAt = Math.floor(Date.now() / 1000) + 1;
    store.importSnapshot(buildWowSyncExport({ generatedAt, character: { name: "Mira", realm: "PvP 2", clientVersion: "1.15.7", clientBuild: "60927", moneyCopper: 900 }, bags: { containers: [{ id: 0, capacity: 16, items: [{ itemRef: "item:159", name: "Rough Stone", qty: 3 }] }] }, bank: { containers: [] } }));
    const created = await call("POST", "/api/versions/classic-era/erp/projects", { title: "Review a manual purchase", needs: [{ stableId: "stone_target", kind: "ITEM_REF", resourceKey: "item:159", label: "Rough Stone", requiredQuantity: 5, sourceIdentityKey: character.identityKey, destinationIdentityKey: character.identityKey }, { stableId: "purchase_budget", kind: "GOLD_COPPER", resourceKey: "copper", label: "Player planned purchase budget", requiredQuantity: 600, sourceIdentityKey: character.identityKey, destinationIdentityKey: character.identityKey }], workOrders: [{ stableId: "purchase", kind: "PURCHASE", status: "PLANNED", title: "Check quote manually", assignedIdentityKey: character.identityKey, resourceNeedIds: ["stone_target", "purchase_budget"], dependsOn: [], procurementPlan: { targetNeedId: "stone_target", budgetNeedId: "purchase_budget", spendingCeilingCopper: 500, playerQuote: { amountCopper: 100, quantity: 5, recordedAt: generatedAt - 1, sourceNote: "Player checked at vendor" } } }] });
    assert.equal(created.status, 201);
    const readiness = created.body.project.workOrderReadiness[0];
    const assessment = readiness.procurementAssessment;
    const procurementProgress = created.body.project.workOrderProgress[0];
    assert.deepEqual([procurementProgress.procurementObservationReview.state, procurementProgress.procurementObservationReview.comparison.delta], ["GOLD_DECREASED", -9100]);
    assert.equal(procurementProgress.procurementObservationReview.interpretation, "CAUSE_UNKNOWN");
    assert.deepEqual([procurementProgress.procurementObservationReview.targetItem.needId, procurementProgress.procurementObservationReview.targetItem.state], ["stone_target", "ITEM_UNCHANGED"], "comparable buyer item observations remain independently visible beside the gold delta");
    assert.equal(readiness.state, "MANUAL_SUPPLY_STEP_RECOMMENDED");
    assert.deepEqual([assessment.reviewState, assessment.budgetState], ["OBSERVED_ITEM_GAP", "GROSS_OBSERVED_GOLD_AT_OR_ABOVE_CEILING"]);
    assert.deepEqual([assessment.quoteState, assessment.playerQuote.amountCopper, assessment.playerQuote.provenance], ["PLAYER_REPORTED_WITHIN_CEILING", 100, "PLAYER_REPORTED"]);
    assert.equal(assessment.budgetNeedAssessment.ceilingCoverage, "PLANNED_NEED_COVERS_CEILING");
    assert.equal(assessment.quoteVsPlannedBudgetState, "PLAYER_QUOTE_AT_OR_BELOW_PLANNED_BUDGET");
    assert.equal(assessment.quoteVsPlannedBudgetCopper, 600);
    assert.deepEqual([assessment.budgetNeedAssessment.need.needId, assessment.budgetNeedAssessment.need.requiredQuantity], ["purchase_budget", 600]);
    assert.equal(assessment.playerQuote.quantity, 5);
    assert.deepEqual([assessment.recordedGoldReservationsCopper, assessment.recordedGoldReservationState], [0, "NO_RECORDED_RESERVATIONS"]);
    assert.deepEqual([assessment.marketAvailability, assessment.quotedPrice, assessment.affordability], ["UNKNOWN", "PLAYER_REPORTED", "UNKNOWN"]);
    assert.match(assessment.reason, /not a purchase recommendation or action/);
    const account = await call("GET", "/api/account-context");
    assert.equal(account.body.schemaVersion, "34");
    const summary = account.body.planning.projects.find((entry: any) => entry.stableId === created.body.project.stableId);
    assert.deepEqual(summary.procurementBudgetNeedStates, { PLANNED_NEED_COVERS_CEILING: 1 });
    assert.deepEqual(summary.procurementReviewStates, { OBSERVED_ITEM_GAP: 1 });
    assert.deepEqual(summary.procurementQuoteStates, { PLAYER_REPORTED_WITHIN_CEILING: 1 });
    assert.deepEqual(summary.procurementQuoteFreshnessStates, { recent: 1 });
    assert.deepEqual(summary.procurementGoldReservationStates, { NO_RECORDED_RESERVATIONS: 1 });
    assert.deepEqual(summary.procurementQuoteGoldComparisonStates, { PLAYER_QUOTE_AT_OR_BELOW_RECORDED_GOLD_REMAINDER: 1 });
    assert.deepEqual(summary.procurementQuotePlannedBudgetStates, { PLAYER_QUOTE_AT_OR_BELOW_PLANNED_BUDGET: 1 });
    assert.deepEqual([assessment.quoteVsRecordedGoldState, assessment.quoteVsRecordedGoldRemainderCopper], ["PLAYER_QUOTE_AT_OR_BELOW_RECORDED_GOLD_REMAINDER", 900]);
    const listed = (await call("GET", "/api/versions/classic-era/erp/projects")).body.projects[0];
    assert.deepEqual(listed.workOrderReadiness[0].procurementAssessment, assessment);
    assert.deepEqual(listed.workOrderProgress[0].procurementObservationReview, procurementProgress.procurementObservationReview, "REST returns the same paired gold review after read-back");
  });
});

test("manual sale reconciliation pairs explicit seller item and gold evidence without confirming a sale", async () => {
  await withServer(async (call, store) => {
    const generatedAt = Math.floor(Date.now() / 1000) + 1;
    const capture = (at: number, quantity: number, copper: number) => buildWowSyncExport({ generatedAt: at, character: { name: "Sale Pair", realm: "PvP 2", clientVersion: "1.15.7", clientBuild: "60927", moneyCopper: copper }, bags: { containers: [{ id: 0, capacity: 16, items: quantity ? [{ itemRef: "item:159", name: "Rough Stone", qty: quantity }] : [] }] }, bank: { containers: [] } });
    const seller = store.importSnapshot(capture(generatedAt, 4, 500));
    store.importSnapshot(capture(generatedAt + 1, 2, 700));
    const created = await call("POST", "/api/versions/classic-era/erp/projects", { title: "Review a manual sale", needs: [{ stableId: "sale_target", kind: "ITEM_REF", resourceKey: "item:159", label: "Rough Stone", requiredQuantity: 1, sourceIdentityKey: seller.character.identityKey, destinationIdentityKey: seller.character.identityKey }], workOrders: [{ stableId: "sale_order", kind: "SELL_MANUALLY", status: "IN_PROGRESS", title: "Sell manually if appropriate", assignedIdentityKey: seller.character.identityKey, resourceNeedIds: ["sale_target"], dependsOn: [] }] });
    assert.equal(created.status, 201);
    const progress = created.body.project.workOrderProgress[0];
    const review = progress.sellObservationReviews[0];
    assert.deepEqual([review.sellerIdentityKey, review.state, review.itemState, review.interpretation], [seller.character.identityKey, "GOLD_INCREASED", "ITEM_CHANGED", "CAUSE_UNKNOWN"]);
    assert.deepEqual([review.goldComparison.previousQuantity, review.goldComparison.currentQuantity], [500, 700]);
    assert.equal(progress.completionRecorded, false);
    const listed = (await call("GET", "/api/versions/classic-era/erp/projects")).body.projects[0];
    assert.deepEqual(listed.workOrderProgress[0].sellObservationReviews, [review], "REST read-after-write preserves the core sale review");
    const context = (await call("GET", "/api/account-context")).body.planning.projects.find((entry: any) => entry.stableId === created.body.project.stableId);
    assert.deepEqual(context.sellObservationStates, { GOLD_INCREASED: 1 }, "AccountContext summarizes the same read-only sale state");
  });
});

test("project REST preserves RETRIEVE as a distinct manual action and keeps storage access unknown", async () => {
  await withServer(async (call, store) => {
    const character = store.listCharacters("classic-era")[0]!;
    const now = Math.floor(Date.now() / 1000);
    store.importSnapshot(buildWowSyncExport({ generatedAt: now, character: { name: "Mira", realm: "PvP 2", clientVersion: "1.15.7", clientBuild: "60927" }, bags: { containers: [{ id: 0, capacity: 16, items: [{ itemRef: "item:159", name: "Rough Stone", qty: 3 }] }] }, bank: { containers: [] } }));
    const created = await call("POST", "/api/versions/classic-era/erp/projects", {
      title: "Retrieve observed stock manually",
      needs: [{ stableId: "stone", kind: "ITEM_REF", resourceKey: "item:159", label: "Rough Stone", requiredQuantity: 1, sourceIdentityKey: character.identityKey }],
      workOrders: [{ stableId: "retrieve", kind: "RETRIEVE", status: "PLANNED", title: "Review storage access", resourceNeedIds: ["stone"], dependsOn: [] }],
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.project.workOrders[0].kind, "RETRIEVE");
    assert.match(created.body.project.workOrderReadiness[0].reason, /does not establish current access or retrieval eligibility/);
    const context = await call("GET", "/api/account-context");
    assert.equal(context.body.planning.projects[0].workOrderCounts.PLANNED, 1);
  });
});

test("REST and AccountContext expose paired RETRIEVE bag and bank observations without completing the manual order", async () => {
  await withServer(async (call, store) => {
    const now = Math.floor(Date.now() / 1000);
    const capture = (bags: number, bank: number | undefined, generatedAt: number) => buildWowSyncExport({ generatedAt, character: { name: "Mira", realm: "PvP 2", clientVersion: "1.15.7", clientBuild: "60927" }, bags: { containers: [{ id: 0, capacity: 16, items: bags ? [{ itemRef: "item:159", name: "Rough Stone", qty: bags }] : [] }] }, bank: bank === undefined ? { unknown: true } : { containers: [{ id: 0, capacity: 28, items: bank ? [{ itemRef: "item:159", name: "Rough Stone", qty: bank }] : [] }] } });
    const identityKey = store.listCharacters("classic-era")[0]!.identityKey;
    store.importSnapshot(capture(0, 3, now - 20));
    store.importSnapshot(capture(1, 2, now));
    const created = await call("POST", "/api/versions/classic-era/erp/projects", { title: "Review personal bank retrieval", needs: [{ stableId: "retrieve_stone", kind: "ITEM_REF", resourceKey: "item:159", label: "Rough Stone", requiredQuantity: 1, sourceIdentityKey: identityKey, destinationIdentityKey: identityKey }], workOrders: [{ stableId: "retrieve", kind: "RETRIEVE", status: "PLANNED", title: "Check personal bank and bags", assignedIdentityKey: identityKey, sourceIdentityKey: identityKey, destinationIdentityKey: identityKey, resourceNeedIds: ["retrieve_stone"], dependsOn: [] }] });
    assert.equal(created.status, 201);
    const progress = created.body.project.workOrderProgress[0];
    const review = progress.retrievalObservationReviews[0];
    assert.equal(review.state, "BAGS_AND_BANK_CHANGED");
    assert.equal(review.interpretation, "CAUSE_UNKNOWN");
    assert.equal(progress.recordedStatus, "PLANNED");
    const readback = (await call("GET", "/api/versions/classic-era/erp/projects")).body.projects[0];
    assert.deepEqual(readback.workOrderProgress[0].retrievalObservationReviews, progress.retrievalObservationReviews);
    const context = (await call("GET", "/api/account-context")).body.planning.projects[0];
    assert.deepEqual(context.workOrderProgressStates, { OBSERVATION_CHANGED_CAUSE_UNKNOWN: 1 });
  });
});

test("REST exposes owner-scoped shared-storage retrieval history without inferring recipient access", async () => {
  await withServer(async (call, store) => {
    const now = Math.floor(Date.now() / 1000);
    const sharedItem = itemRow("Rough Stone", 1).itemRef;
    const capture = (carrier: string, at: number, quantity: number) => renderExport({ name: carrier, realm: "Retail Realm", generated: at, warband: warband({ observedAt: at, items: [["Rough Stone", quantity]] }) });
    const recipientCapture = (at: number, quantity: number) => buildWowSyncExport({ generatedAt: at, character: { name: "Recipient", realm: "Retail Realm", clientFamily: "Retail", clientVersion: "12.1.0" }, bags: { containers: [{ id: 0, capacity: 16, items: quantity ? [{ itemRef: sharedItem, name: "Rough Stone", qty: quantity }] : [] }] }, bank: { unknown: true } });
    store.importSnapshot(recipientCapture(now - 20, 0));
    store.importSnapshot(recipientCapture(now - 5, 2));
    store.importSnapshot(capture("Carrier One", now - 20, 4));
    store.importSnapshot(capture("Carrier Two", now - 10, 2));
    const recipient = store.listCharacters("retail").find((character) => character.name === "Recipient")!;
    const created = await call("POST", "/api/versions/retail/erp/projects", { title: "Review shared-storage retrieval", needs: [{ stableId: "shared_need", kind: "ITEM_REF", resourceKey: sharedItem, label: "Rough Stone", requiredQuantity: 1, sourceOwnerKey: "retail::warband::local", destinationIdentityKey: recipient.identityKey }], workOrders: [{ stableId: "retrieve", kind: "RETRIEVE", status: "PLANNED", title: "Review Warband evidence", resourceNeedIds: ["shared_need"], dependsOn: [], assignedIdentityKey: recipient.identityKey, destinationIdentityKey: recipient.identityKey }] });
    assert.equal(created.status, 201);
    const progress = created.body.project.workOrderProgress[0];
    const review = progress.retrievalObservationReviews[0];
    assert.equal(review.state, "SHARED_OWNER_CONTENT_CHANGED");
    assert.equal(review.sourceOwnerKey, "retail::warband::local");
    assert.equal(review.ownerScope, "warband-installation-local");
    assert.deepEqual(review.comparisons.map((entry: any) => [entry.section, entry.previousQuantity, entry.currentQuantity, entry.delta]), [["shared storage", 4, 2, -2]]);
    assert.equal(review.recipientBagObservation.identityKey, recipient.identityKey);
    assert.equal(review.recipientBagObservation.state, "COMPARABLE_CHANGED");
    assert.deepEqual(review.recipientBagObservation.comparisons.map((entry: any) => [entry.section, entry.previousQuantity, entry.currentQuantity, entry.delta]), [["bags", 0, 2, 2]]);
    assert.match(review.reason, /do not establish ownership, access, recipient, or cause/);
    const readback = (await call("GET", "/api/versions/retail/erp/projects")).body.projects[0];
    assert.deepEqual(readback.workOrderProgress[0].retrievalObservationReviews, progress.retrievalObservationReviews);
    assert.equal(readback.workOrderProgress[0].recordedStatus, "PLANNED");
    const context = (await call("GET", "/api/account-context")).body.planning.projects.find((entry: any) => entry.stableId === created.body.project.stableId);
    assert.equal(context.workOrderProgressStates.CURRENT_LINKED_NEEDS_MET, 1, "AccountContext summarizes the shared source's same core current-state projection without claiming recipient access");
    assert.deepEqual(context.retrievalObservationStates, { SHARED_OWNER_CONTENT_CHANGED: 1 });
    assert.deepEqual(context.retrievalRecipientBagObservationStates, { COMPARABLE_CHANGED: 1 });
  });
});

test("REST and AccountContext expose paired transfer observations while preserving unknown causality", async () => {
  await withServer(async (call, store) => {
    const currentAt = Math.floor(Date.now() / 1000);
    const capture = (name: string, quantity: number, generatedAt: number) => buildWowSyncExport({ generatedAt, character: { name, realm: "PvP 2", clientVersion: "1.15.7", clientBuild: "60927" }, bags: { containers: [{ id: 0, capacity: 16, items: quantity ? [{ itemRef: "item:159", name: "Rough Stone", qty: quantity }] : [] }] }, bank: { containers: [] } });
    store.importSnapshot(capture("Sender", 2, currentAt - 10));
    store.importSnapshot(capture("Receiver", 0, currentAt - 10));
    store.importSnapshot(capture("Sender", 1, currentAt));
    store.importSnapshot(capture("Receiver", 1, currentAt));
    const source = store.listCharacters("classic-era").find((character) => character.name === "Sender")!;
    const destination = store.listCharacters("classic-era").find((character) => character.name === "Receiver")!;
    const created = await call("POST", "/api/versions/classic-era/erp/projects", { title: "Review paired item observations", needs: [{ stableId: "stone", kind: "ITEM_REF", resourceKey: "item:159", label: "Rough Stone", requiredQuantity: 1, sourceIdentityKey: source.identityKey, destinationIdentityKey: destination.identityKey }], workOrders: [{ stableId: "move", kind: "TRANSFER", status: "WAITING_FOR_EVIDENCE", title: "Review item movement", sourceIdentityKey: source.identityKey, destinationIdentityKey: destination.identityKey, resourceNeedIds: ["stone"], dependsOn: [] }] });
    assert.equal(created.status, 201);
    const review = created.body.project.workOrderProgress[0].transferObservationReviews[0];
    assert.equal(review.state, "BOTH_SIDES_CHANGED");
    assert.equal(review.interpretation, "CAUSE_UNKNOWN");
    assert.deepEqual(created.body.project.workOrderReadiness[0].linkedNeeds.map((need: any) => [need.needId, need.kind, need.requiredQuantity, need.sourceIdentityKey, need.observedQuantity, need.freshness]), [["stone", "ITEM_REF", 1, source.identityKey, 1, "recent"]]);
    assert.ok(created.body.project.workOrderReadiness[0].linkedNeeds[0].sourceSections.some((section: any) => section.section === "bags" && section.state === "OBSERVED" && section.observedAt === currentAt), "REST keeps section-level source provenance on the work-order input");
    const sourceBagChange = review.source.comparisons.find((comparison: any) => comparison.section === "bags" && comparison.delta !== 0);
    assert.deepEqual(sourceBagChange && [sourceBagChange.previousQuantity, sourceBagChange.currentQuantity, sourceBagChange.delta], [2, 1, -1]);
    assert.match(review.reason, /do not establish that the changes are related or that the planned transfer occurred/);
    const listed = await call("GET", "/api/versions/classic-era/erp/projects");
    assert.deepEqual(listed.body.projects[0].workOrderProgress[0].transferObservationReviews, created.body.project.workOrderProgress[0].transferObservationReviews);
    const context = await call("GET", "/api/account-context");
    assert.deepEqual(context.body.planning.projects[0].workOrderProgressStates, { OBSERVATION_CHANGED_CAUSE_UNKNOWN: 1 });
    const provisioned = await call("POST", "/api/versions/classic-era/erp/projects", { title: "Review paired provisioning observations", needs: [{ stableId: "provision_stone", kind: "ITEM_REF", resourceKey: "item:159", label: "Rough Stone", requiredQuantity: 1, sourceIdentityKey: source.identityKey, destinationIdentityKey: destination.identityKey }], workOrders: [{ stableId: "provision", kind: "PROVISION", status: "PLANNED", title: "Review provisioning", sourceIdentityKey: source.identityKey, destinationIdentityKey: destination.identityKey, resourceNeedIds: ["provision_stone"], dependsOn: [] }] });
    assert.equal(provisioned.status, 201);
    const provisioningReview = provisioned.body.project.workOrderProgress[0].provisioningObservationReviews[0];
    assert.deepEqual([provisioningReview.state, provisioningReview.interpretation], ["BOTH_SIDES_CHANGED", "CAUSE_UNKNOWN"]);
    assert.deepEqual([provisioningReview.source.identityKey, provisioningReview.destination.identityKey], [source.identityKey, destination.identityKey]);
    assert.equal(provisioned.body.project.workOrderProgress[0].recordedStatus, "PLANNED", "paired changes do not mark provisioning complete");
    const provisionedRead = (await call("GET", "/api/versions/classic-era/erp/projects")).body.projects.find((entry: any) => entry.title === "Review paired provisioning observations");
    assert.deepEqual(provisionedRead.workOrderProgress[0].provisioningObservationReviews, provisioned.body.project.workOrderProgress[0].provisioningObservationReviews, "REST read-after-write returns the same provisioning comparison");
    const provisionContext = (await call("GET", "/api/account-context")).body.planning.projects.find((entry: any) => entry.title === "Review paired provisioning observations");
    assert.deepEqual(provisionContext.workOrderProgressStates, { OBSERVATION_CHANGED_CAUSE_UNKNOWN: 1 }, "AccountContext uses the same non-causal progress reconciliation summary");
  });
});

test("CRAFT readiness checks only the assigned character and preserves missing profession evidence through REST and AccountContext", async () => {
  await withServer(async (call, store) => {
    const character = store.listCharacters("classic-era")[0]!;
    const created = await call("POST", "/api/versions/classic-era/erp/projects", { title: "Check an assigned crafter", needs: [{ stableId: "blacksmithing", kind: "PROFESSION", resourceKey: "Blacksmithing", label: "Blacksmithing skill 1", requiredQuantity: 1 }], workOrders: [{ stableId: "craft", kind: "CRAFT", status: "PLANNED", title: "Review crafter evidence", assignedIdentityKey: character.identityKey, resourceNeedIds: ["blacksmithing"], dependsOn: [] }] });
    assert.equal(created.status, 201);
    const readiness = created.body.project.workOrderReadiness[0];
    assert.equal(readiness.state, "WAITING_FOR_EVIDENCE");
    assert.deepEqual(readiness.capabilityChecks.map((check: any) => [check.state, check.assignedIdentityKey, check.evidenceSourceIdentityKey, check.freshness]), [["EVIDENCE_UNKNOWN", character.identityKey, character.identityKey, "stale"]]);
    assert.equal(readiness.linkedNeeds[0].sourceIdentityKey, character.identityKey, "the order's capability view uses only its assigned character's observation");
    const unspecified = await call("POST", "/api/versions/classic-era/erp/projects", { title: "Unspecified craft plan", workOrders: [{ stableId: "craft-unspecified", kind: "CRAFT", status: "PLANNED", title: "Craft without recorded prerequisites", assignedIdentityKey: character.identityKey, resourceNeedIds: [], dependsOn: [] }] });
    assert.equal(unspecified.status, 201);
    assert.equal(unspecified.body.project.workOrderReadiness[0].state, "WAITING_FOR_EVIDENCE");
    assert.match(unspecified.body.project.workOrderReadiness[0].reason, /No exact profession or recipe requirement is linked/);
    const context = await call("GET", "/api/account-context");
    assert.equal(context.body.planning.projects.filter((entry: any) => entry.workOrderReadinessStates.WAITING_FOR_EVIDENCE === 1).length, 2);
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
    assert.equal(context.body.schemaVersion, "34");
    assert.deepEqual(context.body.planning.projects[0].workOrderReadinessStates, { MANUAL_SUPPLY_STEP_RECOMMENDED: 1 }, "AccountContext carries the count for the exact core/REST readiness state");
    assert.deepEqual(context.body.planning.resourceCommitments["classic-era"], { lineCount: 1, linesWithReservations: 0, unknownSourceLines: 0, overlappingScopeLines: 0, truncated: false });
  });
});

test("assigned gatherer bag deltas agree across REST and AccountContext without attributing a cause", async () => {
  await withServer(async (call, store) => {
    const earlier = Math.floor(Date.now() / 1000) - 2;
    store.importSnapshot(buildWowSyncExport({ generatedAt: earlier, character: { name: "Mira", realm: "PvP 2", clientVersion: "1.15.7", clientBuild: "60927" }, bags: { containers: [{ id: 0, capacity: 16, items: [{ itemRef: "item:159", name: "Rough Stone", qty: 1 }] }] }, bank: { containers: [] } }));
    store.importSnapshot(buildWowSyncExport({ generatedAt: earlier + 1, character: { name: "Mira", realm: "PvP 2", clientVersion: "1.15.7", clientBuild: "60927" }, bags: { containers: [{ id: 0, capacity: 16, items: [{ itemRef: "item:159", name: "Rough Stone", qty: 4 }] }] }, bank: { containers: [] } }));
    const character = store.listCharacters("classic-era")[0]!;
    const created = await call("POST", "/api/versions/classic-era/erp/projects", { title: "Gather rough stone", needs: [{ stableId: "stone", kind: "ITEM_REF", resourceKey: "item:159", label: "Rough Stone", requiredQuantity: 5, sourceIdentityKey: character.identityKey, destinationIdentityKey: character.identityKey }], workOrders: [{ stableId: "gather", kind: "GATHER", status: "IN_PROGRESS", title: "Gather the remaining stone", assignedIdentityKey: character.identityKey, resourceNeedIds: ["stone"], dependsOn: [] }] });
    assert.equal(created.status, 201);
    const review = created.body.project.workOrderProgress[0].gatherObservationReviews[0];
    assert.equal(review.state, "RESOURCE_INCREASED");
    assert.equal(review.interpretation, "CAUSE_UNKNOWN");
    assert.deepEqual(review.comparisons.map((entry: any) => [entry.section, entry.delta]), [["bags", 3]]);
    const context = await call("GET", "/api/account-context");
    assert.equal(context.body.schemaVersion, "34");
    assert.deepEqual(context.body.planning.projects[0].gatherObservationStates, { RESOURCE_INCREASED: 1 });
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

test("same-version source screens stay conditional and agree across REST and AccountContext", async () => {
  await withServer(async (call, store) => {
    const destination = store.listCharacters("classic-era")[0]!;
    const source = store.importSnapshot(buildWowSyncExport({ generatedAt: 1_700_000_100, character: { name: "Potential Holder", realm: "Other Realm", clientVersion: "1.15.7", clientBuild: "60927" }, bags: { containers: [{ id: 0, capacity: 16, items: [{ itemRef: "item:159", name: "Rough Stone", qty: 2 }] }] }, bank: { containers: [] } })).character;
    const created = await call("POST", "/api/versions/classic-era/erp/projects", { title: "Find manual source", needs: [{ stableId: "stone_need", kind: "ITEM_REF", resourceKey: "item:159", label: "Rough Stone", requiredQuantity: 1, destinationIdentityKey: destination.identityKey }] });
    assert.equal(created.status, 201);
    const rest = await call("GET", "/api/versions/classic-era/erp/projects");
    const view = rest.body.projects.find((entry: any) => entry.stableId === created.body.project.stableId);
    const screen = view.resourceSourceScreens[0];
    assert.deepEqual([screen.destinationIdentityKey, screen.scannedCharacterCount], [destination.identityKey, 1]);
    assert.equal(screen.candidates[0].sourceIdentityKey, source.identityKey);
    assert.equal(screen.candidates[0].observedQuantity, 2);
    assert.equal(screen.candidates[0].locations[0].section, "bags");
    assert.equal(screen.candidates[0].transferability, "UNKNOWN");
    assert.equal(screen.candidates[0].accountMembership, "UNKNOWN");
    assert.equal(screen.candidates[0].access, "UNKNOWN");
    const context = await call("GET", "/api/account-context");
    const summary = context.body.planning.projects.find((entry: any) => entry.stableId === created.body.project.stableId);
    assert.deepEqual(summary.resourceSourceScreenCounts, { needsScreened: 1, possibleSources: 1, unresolvedCharacters: 1 }, "the candidate exists but an incomplete source section remains unresolved");
    assert.equal(view.resourceSourceScreens[0].candidates[0].sourceIdentityKey, source.identityKey, "REST keeps the concrete source that the compact context counts");
  });
});
