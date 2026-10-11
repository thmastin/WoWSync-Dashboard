import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { DashboardReadModel, SqliteSnapshotStore } from "@wowsync-dashboard/core";
import { buildWowSyncExport } from "../../core/test/fixtureBuilder.ts";
import { createApp } from "../../server/src/app.ts";
import { LOOPBACK_HOSTNAMES } from "../../server/src/net.ts";
import { test } from "node:test";

const root = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const entrypoint = path.join(root, "packages", "mcp", "src", "index.ts");
const uuid = () => globalThis.crypto.randomUUID();
function structured<T>(result: { structuredContent?: unknown }): T { return result.structuredContent as T; }

test("MCP writes require exact separate Dashboard approval and commit idempotently", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "wowsync-mcp-approved-write-"));
  const databasePath = path.join(directory, "fixture.sqlite");
  const seed = new SqliteSnapshotStore(databasePath);
  const now = Math.floor(Date.now() / 1000);
  const character = seed.importSnapshot(buildWowSyncExport({ generatedAt: now, character: { name: "Plan Author", realm: "Cairne", clientVersion: "1.15.7", clientBuild: "60927" }, bank: { unknown: true } })).character;
  const first = seed.createErpProject({ version: "classic-era", title: "First project", rationale: "Seed", workOrders: [] });
  seed.close();

  const reservation = http.createServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = (reservation.address() as AddressInfo).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const apiStore = new SqliteSnapshotStore(databasePath);
  const api = http.createServer(createApp(apiStore, port, undefined, { selfOrigin: `http://127.0.0.1:${port}`, allowedHosts: LOOPBACK_HOSTNAMES }));
  await new Promise<void>((resolve) => api.listen(port, "127.0.0.1", resolve));

  const connect = async (planning = true) => {
    const client = new Client({ name: "wowsync-mcp-approval-test", version: "0.1.0" });
    const transport = new StdioClientTransport({
      command: process.execPath, args: [entrypoint], cwd: root,
      env: { ...process.env, WOWSYNC_MCP_DB_PATH: databasePath, ...(planning ? { WOWSYNC_MCP_PLANNING_API_URL: `http://127.0.0.1:${port}` } : { WOWSYNC_MCP_PLANNING_API_URL: "" }) },
      stderr: "pipe",
    });
    await client.connect(transport);
    return client;
  };
  const dashboard = (route: string, body: unknown) => fetch(`http://127.0.0.1:${port}${route}`, { method: "POST", headers: { "content-type": "application/json", origin: `http://127.0.0.1:${port}` }, body: JSON.stringify(body) });
  let client: Client | undefined;
  let reader: Client | undefined;
  try {
    const readonly = await connect(false);
    try {
      const names = (await readonly.listTools()).tools.map((entry) => entry.name);
      assert.equal(names.includes("create_erp_project"), false);
      assert.equal(names.includes("commit_approved_erp_change"), false);
      assert.equal(names.includes("approve_erp_change"), false);
      assert.ok(names.includes("get_erp_change_proposals"), "fresh read-only Operations sessions can recover outstanding proposals");
      assert.ok(names.includes("get_erp_change_proposal"));
    } finally { await readonly.close(); }

    client = await connect();
    const tools = (await client.listTools()).tools;
    assert.ok(tools.some((tool) => tool.name === "commit_approved_erp_change"));
    assert.equal(tools.some((tool) => tool.name === "approve_erp_change" || tool.name === "approve_erp_change_proposal"), false, "no MCP operation can approve a proposal");
    for (const tool of tools.filter((entry) => ["create_erp_project", "update_erp_project_plan", "set_erp_project_status", "plan_erp_work_order_batch", "replan_erp_reservations", "commit_approved_erp_change"].includes(entry.name))) {
      assert.equal(tool.annotations?.destructiveHint, true);
      assert.equal(tool.annotations?.readOnlyHint, false);
    }

    const proposalId = uuid();
    const input = { version: "classic-era", proposalId, idempotencyKey: "approved-write-project", rationale: "Player explicitly asked to create this planning record.", title: "Approved project", objective: "A manual test.", priority: 3 };
    const staged = await client.callTool({ name: "create_erp_project", arguments: input });
    assert.equal(staged.isError, undefined, JSON.stringify(staged.structuredContent));
    const proposal = structured<{ proposal: { proposalId: string; digest: string; status: string } }>(staged).proposal;
    assert.equal(proposal.status, "PENDING");
    assert.ok(proposal.proposalId.startsWith("proposal_"));
    const retry = structured<{ proposal: { proposalId: string; digest: string } }>(await client.callTool({ name: "create_erp_project", arguments: input })).proposal;
    assert.deepEqual([retry.proposalId, retry.digest], [proposal.proposalId, proposal.digest], "the proposal ID is idempotent for the exact same operation");
    assert.equal(apiStore.listErpProjects("classic-era").some((project) => project.title === "Approved project"), false, "staging does not mutate the project database");

    const denied = await client.callTool({ name: "commit_approved_erp_change", arguments: { version: "classic-era", proposalId: proposal.proposalId, digest: proposal.digest } });
    assert.equal(denied.isError, true, "an unapproved proposal is rejected server-side");
    assert.equal(apiStore.listErpProjects("classic-era").some((project) => project.title === "Approved project"), false);
    const altered = await dashboard(`/api/versions/classic-era/erp/change-proposals/${proposal.proposalId}/approve`, { digest: "0".repeat(64) });
    assert.equal(altered.status, 409, "a different digest cannot approve the proposal");
    const approved = await dashboard(`/api/versions/classic-era/erp/change-proposals/${proposal.proposalId}/approve`, { digest: proposal.digest });
    assert.equal(approved.status, 200, "approval uses the separate Dashboard HTTP surface");

    reader = await connect(false);
    const recoveredList = structured<{ proposals: Array<{ proposalId: string; status: string }> }>(await reader.callTool({ name: "get_erp_change_proposals", arguments: { version: "classic-era", limit: 10 } }));
    assert.ok(recoveredList.proposals.some((entry) => entry.proposalId === proposal.proposalId && entry.status === "APPROVED"), "approval and exact identity are recoverable after a new client session");
    const recoveredProposal = structured<{ proposal: { digest: string; status: string } }>(await reader.callTool({ name: "get_erp_change_proposal", arguments: { version: "classic-era", proposalId: proposal.proposalId } }));
    assert.deepEqual([recoveredProposal.proposal.digest, recoveredProposal.proposal.status], [proposal.digest, "APPROVED"]);
    await reader.close(); reader = undefined;

    const changedDigest = await client.callTool({ name: "commit_approved_erp_change", arguments: { version: "classic-era", proposalId: proposal.proposalId, digest: "f".repeat(64) } });
    assert.equal(changedDigest.isError, true, "approval cannot authorize an altered mutation");
    const committed = await client.callTool({ name: "commit_approved_erp_change", arguments: { version: "classic-era", proposalId: proposal.proposalId, digest: proposal.digest } });
    assert.equal(committed.isError, undefined, JSON.stringify(committed.structuredContent));
    const committedBody = structured<{ proposal: { status: string }; result: { project: { stableId: string; revision: number } }; replay: boolean }>(committed);
    assert.equal(committedBody.proposal.status, "COMMITTED");
    assert.equal(committedBody.result.project.revision, 1);
    assert.equal(committedBody.replay, false);
    const retried = await client.callTool({ name: "commit_approved_erp_change", arguments: { version: "classic-era", proposalId: proposal.proposalId, digest: proposal.digest } });
    assert.equal(structured<{ replay: boolean }>(retried).replay, true);
    assert.equal(apiStore.listErpProjects("classic-era").filter((project) => project.stableId === committedBody.result.project.stableId).length, 1, "commit retries do not duplicate projects");

    const crossVersion = await client.callTool({ name: "commit_approved_erp_change", arguments: { version: "forever", proposalId: proposal.proposalId, digest: proposal.digest } });
    assert.equal(crossVersion.isError, true, "a proposal cannot cross version buckets");

    const staleInput = { ...input, proposalId: uuid(), idempotencyKey: "stale-proposal", title: "Must stay unchanged" };
    const staleStage = structured<{ proposal: { proposalId: string; digest: string } }>(await client.callTool({ name: "create_erp_project", arguments: staleInput })).proposal;
    await dashboard(`/api/versions/classic-era/erp/change-proposals/${staleStage.proposalId}/reject`, { digest: staleStage.digest });
    const project = new DashboardReadModel(apiStore).getErpProjects({ version: "classic-era" }).find((entry) => entry.stableId === first.stableId)!;
    const staleUpdateId = uuid();
    const pendingUpdate = structured<{ proposal: { proposalId: string; digest: string; expectedRevisions: Record<string, number> } }>(await client.callTool({ name: "set_erp_project_status", arguments: { version: "classic-era", proposalId: staleUpdateId, projectId: first.stableId, expectedRevision: project.revision, status: "PAUSED", rationale: "Pause after review." } })).proposal;
    assert.equal(pendingUpdate.expectedRevisions[first.stableId], project.revision);
    const concurrent = await fetch(`http://127.0.0.1:${port}/api/versions/classic-era/erp/projects/${first.stableId}/status`, { method: "PATCH", headers: { "content-type": "application/json", origin: `http://127.0.0.1:${port}` }, body: JSON.stringify({ expectedRevision: project.revision, status: "PAUSED", rationale: "A separate dashboard change." }) });
    assert.equal(concurrent.status, 200);
    const staleApproval = await dashboard(`/api/versions/classic-era/erp/change-proposals/${pendingUpdate.proposalId}/approve`, { digest: pendingUpdate.digest });
    assert.equal(staleApproval.status, 409, "approval refuses a stale project revision");
    assert.equal(apiStore.getErpProject(first.stableId)?.status, "PAUSED");

    const readBack = await client.callTool({ name: "get_erp_project", arguments: { version: "classic-era", projectId: committedBody.result.project.stableId } });
    const readProject = structured<{ project: { revision: number; title: string } }>(readBack).project;
    assert.deepEqual([readProject.revision, readProject.title], [1, "Approved project"]);
    const ctx = await fetch(`http://127.0.0.1:${port}/api/account-context`).then((response) => response.json()) as { planning: { projects: Array<{ stableId: string; revision: number }> } };
    assert.equal(ctx.planning.projects.find((entry) => entry.stableId === committedBody.result.project.stableId)?.revision, 1);
    reader = await connect(false);
    const readTools = (await reader.listTools()).tools.map((tool) => tool.name);
    assert.ok(readTools.includes("get_erp_project"));
    const rest = await fetch(`http://127.0.0.1:${port}/api/versions/classic-era/erp/projects`).then((response) => response.json()) as { projects: Array<{ stableId: string; revision: number }> };
    assert.equal(rest.projects.find((entry) => entry.stableId === committedBody.result.project.stableId)?.revision, 1);
    assert.equal(apiStore.listErpChangeProposals("classic-era", true).find((entry) => entry.proposalId === proposal.proposalId)?.status, "COMMITTED");
    assert.equal(apiStore.listErpProjects("forever").some((entry) => entry.stableId === committedBody.result.project.stableId), false);
    assert.equal(character.version, "classic-era");
  } finally {
    await client?.close();
    await reader?.close();
    await new Promise<void>((resolve) => api.close(() => resolve()));
    apiStore.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("MCP planning writes reject non-loopback and path-bearing API configuration before opening a database", async () => {
  const { createWoWSyncMcpServer } = await import("../src/server.ts");
  for (const planningApiBaseUrl of ["https://127.0.0.1:4173", "http://example.test", "http://localhost:4173", "http://127.0.0.1:4173/proxy", "http://user@127.0.0.1:4173"]) {
    assert.throws(() => createWoWSyncMcpServer({ databasePath: path.join(os.tmpdir(), "must-not-be-opened.sqlite"), planningApiBaseUrl }), /loopback.*origin/);
  }
});
