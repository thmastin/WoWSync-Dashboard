import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { DashboardReadModel, SqliteSnapshotReadStore, SqliteSnapshotStore } from "@wowsync-dashboard/core";
import { buildWowSyncExport } from "../../core/test/fixtureBuilder.ts";
import { createApp } from "../../server/src/app.ts";
import { LOOPBACK_HOSTNAMES } from "../../server/src/net.ts";
import { createWoWSyncMcpServer } from "../src/server.ts";
import { buildRordinForeverGoalProject, RORDIN_PROFESSION_GOAL } from "../src/foreverGoalProject.ts";
import { test } from "node:test";

const root = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const entrypoint = path.join(root, "packages", "mcp", "src", "index.ts");

test("exact Forever natural-language goal discovers scoped evidence and creates one idempotent, evidence-bounded project through MCP", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "wowsync-forever-goal-"));
  const databasePath = path.join(directory, "fixture.sqlite");
  const now = Math.floor(Date.now() / 1000);
  const seed = new SqliteSnapshotStore(databasePath);
  // Synthetic fixture values mirror the currently read-only DEV observations; they remain test data, not a live import.
  const rordin = seed.importSnapshot(buildWowSyncExport({ generatedAt: now, character: { name: "Rordin", surname: "Longbraid", realm: "Classic Beta PvP 2", class: "Warrior", level: 6, clientFamily: "Forever", clientVersion: "1.60.1", clientBuild: "70338", interface: "16001" }, professions: { entries: [{ name: "Mining", skill: 3, maxSkill: 75 }, { name: "Blacksmithing", skill: 1, maxSkill: 75 }] }, bags: { containers: [{ id: 0, capacity: 16, items: [{ itemRef: "item:117::::::::6:1491:::::::::", name: "Tough Jerky", qty: 13 }, { itemRef: "item:2589::::::::6:1491:::::::::", name: "Linen Cloth", qty: 17 }, { itemRef: "item:6948::::::::6:1491::75:::::::", name: "Hearthstone", qty: 1 }, { itemRef: "item:247840::::::::6:1491::11:::::::", name: "Mining for Dummies", qty: 1 }, { itemRef: "item:286355::::::::6:1491:::::::::", name: "Crate of Candles", qty: 1 }] }] }, bank: { unknown: true } })).character;
  const fizzwick = seed.importSnapshot(buildWowSyncExport({ generatedAt: now, character: { name: "Fizzwick", realm: "Classic Beta PvP 2", class: "Mage", level: 4, clientFamily: "Forever", clientVersion: "1.60.1", clientBuild: "70291", interface: "16001" }, bags: { containers: [{ id: 0, capacity: 16, items: [{ itemRef: "item:6173::::::::4:1482::11:::::::", name: "Snow Boots", qty: 1 }, { itemRef: "item:7005::::::::4:1482::14:::::::", name: "Skinning Knife", qty: 1 }] }] }, bank: { unknown: true } })).character;
  const hallo = seed.importSnapshot(buildWowSyncExport({ generatedAt: now, character: { name: "Hallo", realm: "Classic Beta PvP 2", class: "Hunter", level: 9, clientFamily: "Forever", clientVersion: "1.60.1", clientBuild: "70291", interface: "16001" }, bags: { containers: [{ id: 0, capacity: 16, items: [{ itemRef: "item:2770::::::::9:1485::::::::", name: "Copper Ore", qty: 37 }, { itemRef: "item:2835::::::::9:1485::::::::", name: "Rough Stone", qty: 27 }, { itemRef: "item:2901::::::::9:1485::14:::::::", name: "Mining Pick", qty: 1 }] }] }, bank: { unknown: true } })).character;
  const otherRealm = seed.importSnapshot(buildWowSyncExport({ generatedAt: now, character: { name: "OtherRealm", realm: "Different Realm", class: "Warrior", level: 9, clientFamily: "Forever", clientVersion: "1.60.1", clientBuild: "70338", interface: "16001" }, bags: { containers: [{ id: 0, capacity: 16, items: [{ itemRef: "item:2770:0:0:0:0:0:0:0", name: "Copper Ore", qty: 20 }] }] }, bank: { unknown: true } })).character;
  const retail = seed.importSnapshot(buildWowSyncExport({ generatedAt: now, character: { name: "RetailOre", realm: "Classic Beta PvP 2", class: "Warrior", level: 70, clientVersion: "12.0.0", clientBuild: "99999", clientFamily: "Retail" }, bags: { containers: [{ id: 0, capacity: 16, items: [{ itemRef: "item:2770:0:0:0:0:0:0:0", name: "Copper Ore", qty: 200 }] }] }, bank: { unknown: true } })).character;
  seed.close();

  const apiStore = new SqliteSnapshotStore(databasePath);
  const portReservation = http.createServer();
  await new Promise<void>((resolve) => portReservation.listen(0, "127.0.0.1", resolve));
  const port = (portReservation.address() as AddressInfo).port;
  await new Promise<void>((resolve) => portReservation.close(() => resolve()));
  const api = http.createServer(createApp(apiStore, port, undefined, { selfOrigin: `http://127.0.0.1:${port}`, allowedHosts: LOOPBACK_HOSTNAMES }));
  await new Promise<void>((resolve) => api.listen(port, "127.0.0.1", resolve));
  const client = new Client({ name: "wowsync-forever-goal-acceptance", version: "0.1.0" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [entrypoint], cwd: root,
    env: { ...process.env, WOWSYNC_MCP_DB_PATH: databasePath, WOWSYNC_MCP_PLANNING_API_URL: `http://127.0.0.1:${port}` }, stderr: "pipe" });
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools;
    const createTool = tools.find((tool) => tool.name === "create_erp_project_from_goal");
    assert.ok(createTool, "the goal workflow is exposed only in explicitly enabled planning-write mode");
    assert.equal(createTool.annotations?.readOnlyHint, false);
    assert.equal(createTool.annotations?.destructiveHint, true, "persistent goal creation is presented to the MCP host as a user-confirmed write");
    assert.equal(tools.some((tool) => tool.name === "create_erp_project_from_goal"), true);

    const first = await client.callTool({ name: "create_erp_project_from_goal", arguments: { goal: RORDIN_PROFESSION_GOAL } });
    assert.equal(first.isError, undefined, JSON.stringify(first.structuredContent));
    const response = first.structuredContent as { target: { identityKey: string; name: string; surname?: string }; proposal: { proposal: { proposalId: string; digest: string; status: string } }; resourceDiscovery: { accountMembership: string; sameRealmCharacterCount: number; otherRealmCharacterCount: number; leads: Array<{ character: { identityKey: string }; itemRef?: string; quantity?: number }>; characters: Array<{ identityKey: string; class?: string; professionState: string; professions: Array<{ name: string; skill?: number }> }> }; recipeEvidence: { state: string } };
    assert.equal(response.target.identityKey, rordin.identityKey);
    assert.equal(response.target.name, "Rordin");
    assert.equal(response.target.surname, "Longbraid");
    assert.equal(response.proposal.proposal.status, "PENDING");
    assert.equal(apiStore.listErpProjects("forever").length, 0, "goal interpretation stages a proposal without mutating persistent project state");
    assert.equal(response.recipeEvidence.state, "UNKNOWN");
    assert.equal(response.resourceDiscovery.accountMembership, "UNKNOWN");
    assert.equal(response.resourceDiscovery.sameRealmCharacterCount, 3);
    assert.equal(response.resourceDiscovery.otherRealmCharacterCount, 1);
    assert.ok(response.resourceDiscovery.characters.some((character) => character.identityKey === rordin.identityKey && character.professionState === "OBSERVED" && character.professions.some((entry) => entry.name === "Mining" && entry.skill === 3) && character.professions.some((entry) => entry.name === "Blacksmithing" && entry.skill === 1)), "real-shaped observed profession skill evidence is visible to goal planning");
    assert.ok(response.resourceDiscovery.characters.some((character) => character.identityKey === fizzwick.identityKey && character.class === "Mage"));
    assert.ok(response.resourceDiscovery.leads.some((lead) => lead.character.identityKey === hallo.identityKey && lead.itemRef === "item:2770::::::::9:1485::::::::" && lead.quantity === 37));
    assert.ok(response.resourceDiscovery.leads.some((lead) => lead.character.identityKey === hallo.identityKey && lead.itemRef === "item:2835::::::::9:1485::::::::" && lead.quantity === 27));
    assert.ok(!response.resourceDiscovery.leads.some((lead) => lead.character.identityKey === otherRealm.identityKey || lead.character.identityKey === retail.identityKey), "different-realm and Retail materials are not treated as source leads");

    const quotedGoal = await client.callTool({ name: "create_erp_project_from_goal", arguments: { goal: `Do not create this yet; the request is “${RORDIN_PROFESSION_GOAL}”` } });
    assert.equal(quotedGoal.isError, true, "quoted goal text inside a negation must not create persistent intent");

    const approved = await fetch(`http://127.0.0.1:${port}/api/versions/forever/erp/change-proposals/${response.proposal.proposal.proposalId}/approve`, { method: "POST", headers: { "content-type": "application/json", origin: `http://127.0.0.1:${port}` }, body: JSON.stringify({ digest: response.proposal.proposal.digest }) });
    assert.equal(approved.status, 200, "the separate Dashboard approval applies only to this exact goal proposal");
    const committed = await client.callTool({ name: "commit_approved_erp_change", arguments: { version: "forever", proposalId: response.proposal.proposal.proposalId, digest: response.proposal.proposal.digest } });
    assert.equal(committed.isError, undefined, JSON.stringify(committed.structuredContent));
    const committedProject = (committed.structuredContent as { result: { project: { stableId: string; version: string; needs: Array<{ kind: string; resourceKey: string; sourceIdentityKey?: string; destinationIdentityKey?: string }>; reservations: unknown[]; workOrders: Array<{ stableId: string; kind: string; status: string; title: string; assignedIdentityKey?: string; dependsOn: string[] }> } } }).result.project;
    const project = committedProject;
    assert.equal(project.version, "forever");
    assert.deepEqual(project.needs.map((need) => [need.kind, need.resourceKey, need.sourceIdentityKey, need.destinationIdentityKey]), [
      ["PROFESSION", "Mining", rordin.identityKey, rordin.identityKey], ["PROFESSION", "Blacksmithing", rordin.identityKey, rordin.identityKey],
    ]);
    assert.deepEqual(project.reservations, [], "unverified quantities and other-character leads are not reserved");
    assert.equal(project.workOrders.length, 7);
    assert.deepEqual(project.workOrders.find((order) => order.title.startsWith("Verify an exact Forever"))?.dependsOn, [], "recipe evidence investigation is not blocked by unrelated profession-learning work orders");
    assert.ok(project.workOrders.every((order) => order.assignedIdentityKey === rordin.identityKey));
    assert.ok(project.workOrders.find((order) => order.kind === "CRAFT")?.status === "WAITING_FOR_EVIDENCE");
    const second = await client.callTool({ name: "create_erp_project_from_goal", arguments: { goal: `  ${RORDIN_PROFESSION_GOAL.replace(/\s+/g, " ")}  ` } });
    assert.equal(second.isError, undefined, "the exact retry recovers the idempotent proposal");
    const secondResponse = second.structuredContent as typeof response;
    assert.equal(secondResponse.proposal.proposal.proposalId, response.proposal.proposal.proposalId);
    const conflictingRetry = await fetch(`http://127.0.0.1:${port}/api/versions/forever/erp/projects`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
      idempotencyKey: `forever:rordin-longbraid:learn-mining:blacksmithing:first-useful-equipment-upgrade:v1:${rordin.identityKey}`,
      title: "Different plan must conflict", needs: [], workOrders: [],
    }) });
    assert.equal(conflictingRetry.status, 409, "reusing a goal key for a different plan is rejected");
    const projects = new SqliteSnapshotReadStore(databasePath);
    try {
      const saved = new DashboardReadModel(projects).getErpProjects({ version: "forever" });
      assert.equal(saved.length, 1);
      assert.equal(saved[0]?.stableId, project.stableId);
      assert.ok(saved[0]?.needs.every((need) => need.kind === "PROFESSION"));
    } finally { projects.close(); }

    const rest = await fetch(`http://127.0.0.1:${port}/api/versions/forever/erp/projects`).then((r) => r.json()) as { projects: Array<{ stableId: string; needs: Array<{ stableId: string }> }> };
    assert.equal(rest.projects.length, 1);
    const context = await fetch(`http://127.0.0.1:${port}/api/account-context`).then((r) => r.json()) as { planning: { projects: Array<{ stableId: string; needCount?: number }> } };
    assert.ok(context.planning.projects.some((entry) => entry.stableId === project.stableId), "AccountContext reports the created plan");
    const readback = await client.callTool({ name: "get_erp_projects", arguments: { version: "forever" } });
    const mcpProjects = (readback.structuredContent as { projects: Array<{ stableId: string; needs: Array<{ stableId: string }> }> }).projects;
    assert.equal(mcpProjects.length, 1);
    assert.equal(mcpProjects[0]?.stableId, project.stableId);
    assert.deepEqual(mcpProjects[0]?.needs.map((need) => need.stableId), rest.projects[0]?.needs.map((need) => need.stableId));
    const currentProjects = mcpProjects[0] as typeof mcpProjects[number] & { workOrders: Array<{ stableId: string; status: string }>; workOrderProgress: Array<{ workOrderId: string; professionGoalStateReview?: { state: string; proposalReadiness: string; suggestedStatus?: string; requiresDashboardApproval: boolean } }> };
    for (const taskId of ["forever_rordin-longbraid_learn-mining_blacksmithing_first-useful-equipment-upgrade_v1_mining", "forever_rordin-longbraid_learn-mining_blacksmithing_first-useful-equipment-upgrade_v1_blacksmithing"]) {
      const task = currentProjects.workOrders.find((order) => order.stableId === taskId)!;
      const progress = currentProjects.workOrderProgress.find((entry) => entry.workOrderId === taskId)?.professionGoalStateReview;
      assert.equal(task.status, "PLANNED", "observations never mutate saved task status");
      assert.equal(progress?.state, "CURRENTLY_MET");
      assert.equal(progress?.proposalReadiness, "REVIEW_DEPENDENCIES_FIRST");
      assert.equal(progress?.suggestedStatus, undefined);
      assert.equal(progress?.requiresDashboardApproval, true);
    }
    const otherVersion = await client.callTool({ name: "get_erp_projects", arguments: { version: "retail" } });
    assert.equal((otherVersion.structuredContent as { projects: unknown[] }).projects.length, 0);
    const professionRead = await client.callTool({ name: "get_character_professions", arguments: { version: "forever", name: "Rordin", realm: "Classic Beta PvP 2" } });
    const professionData = professionRead.structuredContent as { value?: { data?: { recipeKnowledge?: { status: { state: string; reason?: string } } } } };
    assert.equal(professionData.value?.data?.recipeKnowledge?.status.state, "UNKNOWN");
    assert.match(professionData.value?.data?.recipeKnowledge?.status.reason ?? "", /profession panel must be opened before capture/i);
  } finally {
    await client.close();
    await new Promise<void>((resolve) => api.close(() => resolve()));
    apiStore.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the Rordin goal parser rejects incomplete or cross-version requests without creating a project", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "wowsync-forever-goal-reject-"));
  const databasePath = path.join(directory, "empty.sqlite");
  new SqliteSnapshotStore(databasePath).close();
  const store = new SqliteSnapshotReadStore(databasePath);
  try {
    assert.match((buildRordinForeverGoalProject("Create a project for Rordin on Forever", store) as { error: string }).error, /supports the explicit Forever request/);
    assert.match((buildRordinForeverGoalProject(RORDIN_PROFESSION_GOAL.replace("Forever", "Retail"), store) as { error: string }).error, /supports the explicit Forever request/);
    assert.match((buildRordinForeverGoalProject(`Do not create this yet; the request is “${RORDIN_PROFESSION_GOAL}”`, store) as { error: string }).error, /supports the explicit Forever request/);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("UNKNOWN latest character profile does not inherit stale summary class or level as current goal evidence", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "wowsync-forever-goal-stale-profile-"));
  const databasePath = path.join(directory, "fixture.sqlite");
  const store = new SqliteSnapshotStore(databasePath);
  const imported = store.importSnapshot(buildWowSyncExport({ generatedAt: 1_791_683_000, character: { name: "Rordin", surname: "Longbraid", realm: "Classic Beta PvP 2", class: "Warrior", level: 3, clientFamily: "Forever", clientVersion: "1.60.1", clientBuild: "70338", interface: "16001" }, bags: { containers: [{ id: 0, capacity: 16, items: [] }] }, bank: { unknown: true } }));
  const current = store.listSnapshots(imported.character.identityKey)[0]!;
  const unknownProfile = { ...current, parsed: { ...current.parsed, character: { ...current.parsed.character, class: undefined, level: undefined, status: { state: "UNKNOWN" as const, reason: "fixture unknown" } } } };
  const source = { ...imported.character, class: "Warrior", latestLevel: 3 };
  const fakeReadStore = { listCharacters: () => [source], listSnapshots: (identityKey: string) => identityKey === source.identityKey ? [unknownProfile] : [] } as never;
  try {
    const plan = buildRordinForeverGoalProject(RORDIN_PROFESSION_GOAL, fakeReadStore, 1_791_683_200);
    assert.ok(!("error" in plan));
    assert.equal(plan.target.profileState, "UNKNOWN");
    assert.equal(plan.target.freshness, "unknown");
    assert.equal(plan.target.class, undefined);
    assert.equal(plan.target.level, undefined);
    assert.equal(plan.resourceDiscovery.characters[0]?.profileState, "UNKNOWN");
    assert.equal(plan.resourceDiscovery.characters[0]?.profileFreshness, "unknown");
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("LAST_SEEN sections without their own timestamp remain historical with UNKNOWN freshness", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "wowsync-forever-goal-last-seen-time-"));
  const databasePath = path.join(directory, "fixture.sqlite");
  const store = new SqliteSnapshotStore(databasePath);
  const imported = store.importSnapshot(buildWowSyncExport({ generatedAt: 1_791_683_000, character: { name: "Rordin", surname: "Longbraid", realm: "Classic Beta PvP 2", class: "Warrior", level: 3, clientFamily: "Forever", clientVersion: "1.60.1", clientBuild: "70338", interface: "16001" }, professions: { entries: [{ name: "Mining", skill: 1, maxSkill: 75 }] }, bags: { containers: [{ id: 0, capacity: 16, items: [{ itemRef: "item:2770:0:0:0:0:0:0:0", name: "Copper Ore", qty: 4 }] }] }, bank: { unknown: true } }));
  const snapshot = store.listSnapshots(imported.character.identityKey)[0]!;
  const carried = { ...snapshot, parsed: { ...snapshot.parsed,
    character: { ...snapshot.parsed.character, status: { state: "LAST_SEEN" as const, reason: "carried forward without section time" } },
    professions: { ...snapshot.parsed.professions, status: { state: "LAST_SEEN" as const, reason: "carried forward without section time" } },
    bags: { ...snapshot.parsed.bags, status: { state: "LAST_SEEN" as const, reason: "carried forward without section time" } },
  } };
  const fakeReadStore = { listCharacters: () => [imported.character], listSnapshots: (identityKey: string) => identityKey === imported.character.identityKey ? [carried] : [] } as never;
  try {
    const plan = buildRordinForeverGoalProject(RORDIN_PROFESSION_GOAL, fakeReadStore, 1_791_683_200);
    assert.ok(!("error" in plan));
    assert.equal(plan.target.profileState, "LAST_SEEN");
    assert.equal(plan.target.freshness, "unknown");
    assert.equal(plan.resourceDiscovery.characters[0]?.professionState, "LAST_SEEN");
    assert.equal(plan.resourceDiscovery.characters[0]?.professionFreshness, "unknown");
    assert.equal(plan.resourceDiscovery.matchingObservedLocationCount, 0);
    assert.equal(plan.resourceDiscovery.matchingLastSeenLocationCount, 1);
    assert.equal(plan.resourceDiscovery.leads[0]?.provenance, "LAST_SEEN");
    assert.equal(plan.resourceDiscovery.leads[0]?.freshness, "unknown");
    assert.equal(plan.resourceDiscovery.leads[0]?.observedAt, undefined);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
