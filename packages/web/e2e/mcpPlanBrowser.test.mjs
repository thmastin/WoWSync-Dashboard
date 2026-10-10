import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { buildErpNeedReviewSnapshot, DashboardReadModel, SqliteSnapshotStore } from "@wowsync-dashboard/core";
import { buildWowSyncExport } from "../../core/test/fixtureBuilder.ts";
import { createApp } from "../../server/src/app.ts";
import { LOOPBACK_HOSTNAMES, listenOnce } from "../../server/src/net.ts";

const root = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const webDist = fileURLToPath(new URL("../dist/", import.meta.url));
const mcpEntrypoint = path.join(root, "packages", "mcp", "src", "index.ts");

test("[SYNTHETIC BROWSER ACCEPTANCE] MCP-authored project intent appears consistently in REST, AccountContext, MCP, and the Dashboard", async () => {
  assert.ok(existsSync(path.join(webDist, "index.html")), "build the web UI before browser acceptance");
  const directory = mkdtempSync(path.join(os.tmpdir(), "wowsync-mcp-plan-browser-"));
  const databasePath = path.join(directory, "browser.sqlite");
  let store; let server; let browser; let mcpClient;
  try {
    store = new SqliteSnapshotStore(databasePath);
    const now = Math.floor(Date.now() / 1000);
    const imported = store.importSnapshot(buildWowSyncExport({ generatedAt: now, character: { name: "MCP Plan Character", realm: "Cairne", clientFamily: "Retail", clientVersion: "12.1.0" }, bags: { containers: [{ id: 0, capacity: 16, items: [{ itemRef: "item:159:0:0", name: "Rough Stone", qty: 3 }, { itemRef: "item:2589:0:0", name: "Linen Cloth", qty: 2 }] }] }, bank: { containers: [] } }));
    server = await listenOnce(createApp(store, 0, webDist, { allowedHosts: LOOPBACK_HOSTNAMES }), "127.0.0.1", 0);
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const executablePath = process.env.WOWSYNC_CHROMIUM_PATH ?? (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);
    browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
    const page = await browser.newPage(); page.setDefaultTimeout(8_000);
    const pageErrors = []; page.on("pageerror", (error) => pageErrors.push(error.message));

    mcpClient = new Client({ name: "mcp-plan-browser-acceptance", version: "0.1.0" });
    await mcpClient.connect(new StdioClientTransport({ command: process.execPath, args: [mcpEntrypoint], cwd: root, env: { ...process.env, WOWSYNC_MCP_DB_PATH: databasePath, WOWSYNC_MCP_PLANNING_API_URL: baseUrl }, stderr: "pipe" }));
    const tools = (await mcpClient.listTools()).tools;
    const updateTool = tools.find((tool) => tool.name === "update_erp_project_plan");
    assert.equal(updateTool?.annotations?.readOnlyHint, false);
    assert.equal(updateTool?.annotations?.destructiveHint, true, "host clients receive a confirmation hint for full-plan replacement");

    await page.goto(`${baseUrl}/#/retail/overview`);
    await page.getByRole("button", { name: "Projects & Work Orders" }).click();
    await page.getByRole("heading", { name: "Projects & Work Orders" }).waitFor();

    const createdResult = await mcpClient.callTool({ name: "create_erp_project", arguments: {
      version: "retail",
      title: "MCP-authored provisioning plan",
      objective: "Record an observed-material requirement for player review.",
      priority: 4,
      needs: [
        { stableId: "rough-stone", kind: "ITEM_REF", resourceKey: "item:159:0:0", label: "Rough Stone", requiredQuantity: 5, sourceIdentityKey: imported.character.identityKey },
        { stableId: "linen-cloth", kind: "ITEM_REF", resourceKey: "item:2589:0:0", label: "Linen Cloth", requiredQuantity: 4, sourceIdentityKey: imported.character.identityKey },
      ],
    } });
    assert.equal(createdResult.isError, undefined, JSON.stringify(createdResult.structuredContent));
    const createdProject = createdResult.structuredContent.project;

    let rest = await fetch(`${baseUrl}/api/versions/retail/erp/projects`).then((response) => response.json());
    let project = rest.projects.find((entry) => entry.stableId === createdProject.stableId);
    assert.deepEqual(project?.needs.map((need) => need.stableId), ["rough-stone", "linen-cloth"]);
    assert.equal(project?.needs[0]?.resourceKey, "item:159:0:0");
    assert.equal(project?.needs[0]?.sourceIdentityKey, imported.character.identityKey);
    let context = await fetch(`${baseUrl}/api/account-context`).then((response) => response.json());
    assert.equal(context.planning.projects.find((entry) => entry.stableId === project.stableId)?.status, "ACTIVE");
    let mcpRead = await mcpClient.callTool({ name: "get_erp_projects", arguments: { version: "retail", limit: 20 } });
    assert.deepEqual(mcpRead.structuredContent.projects.find((entry) => entry.stableId === project.stableId), project);

    const reviewProject = new DashboardReadModel(store).getErpProjects({ version: "retail" }).find((entry) => entry.stableId === project.stableId);
    assert.ok(reviewProject);
    const planned = await mcpClient.callTool({ name: "plan_erp_work_order_batch", arguments: { version: "retail", updates: [{
      projectId: project.stableId,
      expectedRevision: project.revision,
      tasks: reviewProject.needs.map((need) => ({ needId: need.stableId, kind: "INVESTIGATE", title: `Review ${need.label}`, instructions: "Player checks the observed source and decides the next manual step; no action is executed by MCP.", reviewSnapshot: buildErpNeedReviewSnapshot(reviewProject, need.stableId) })),
    }] } });
    assert.equal(planned.isError, undefined, JSON.stringify(planned.structuredContent));
    rest = await fetch(`${baseUrl}/api/versions/retail/erp/projects`).then((response) => response.json());
    project = rest.projects.find((entry) => entry.stableId === project.stableId);
    assert.equal(project.workOrders.length, 2, "the review-checked MCP batch saves both multi-need manual steps atomically");
    assert.deepEqual(project.workOrders.map((order) => order.status), ["PLANNED", "PLANNED"]);

    const updatedResult = await mcpClient.callTool({ name: "update_erp_project_plan", arguments: { version: "retail", projectId: project.stableId, expectedRevision: project.revision, project: { ...project, status: "PAUSED" } } });
    assert.equal(updatedResult.isError, undefined, JSON.stringify(updatedResult.structuredContent));
    const staleResult = await mcpClient.callTool({ name: "update_erp_project_plan", arguments: { version: "retail", projectId: project.stableId, expectedRevision: project.revision, project: { ...project, status: "COMPLETED" } } });
    assert.equal(staleResult.isError, true, "stale replacement is refused rather than overwriting the newer plan");

    rest = await fetch(`${baseUrl}/api/versions/retail/erp/projects`).then((response) => response.json());
    project = rest.projects.find((entry) => entry.stableId === project.stableId);
    assert.equal(project.status, "PAUSED");
    assert.equal(project.revision, createdProject.revision + 2);
    context = await fetch(`${baseUrl}/api/account-context`).then((response) => response.json());
    assert.equal(context.planning.projects.find((entry) => entry.stableId === project.stableId)?.status, "PAUSED");
    mcpRead = await mcpClient.callTool({ name: "get_erp_projects", arguments: { version: "retail", limit: 20 } });
    assert.deepEqual(mcpRead.structuredContent.projects.find((entry) => entry.stableId === project.stableId), project);
    const forever = await fetch(`${baseUrl}/api/versions/forever/erp/projects`).then((response) => response.json());
    assert.equal(forever.projects.some((entry) => entry.stableId === project.stableId), false, "the plan remains isolated in its explicitly selected version");

    await page.reload();
    await page.getByRole("button", { name: "Projects & Work Orders" }).click();
    await page.getByRole("heading", { name: "MCP-authored provisioning plan", exact: true }).waitFor();
    const card = page.locator(".erp-project-card").filter({ hasText: "MCP-authored provisioning plan" });
    assert.match(await card.innerText(), /PAUSED/);
    assert.match(await card.innerText(), /Rough Stone/);
    assert.match(await card.innerText(), /Revision 3/);
    assert.match(await card.innerText(), /Review Rough Stone/);
    assert.match(await card.innerText(), /Review Linen Cloth/);
    assert.deepEqual(pageErrors, []);
  } finally {
    if (mcpClient) await mcpClient.close();
    if (browser) await browser.close();
    if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    store?.close(); rmSync(directory, { recursive: true, force: true });
  }
});
