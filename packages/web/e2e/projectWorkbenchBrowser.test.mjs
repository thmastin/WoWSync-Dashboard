import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { SqliteSnapshotStore } from "@wowsync-dashboard/core";
import { buildWowSyncExport } from "../../core/test/fixtureBuilder.ts";
import { createApp } from "../../server/src/app.ts";
import { LOOPBACK_HOSTNAMES, listenOnce } from "../../server/src/net.ts";

const webDist = fileURLToPath(new URL("../dist/", import.meta.url));

test("[SYNTHETIC BROWSER ACCEPTANCE] project workbench leads with the next player action and remembers project context", async () => {
  assert.ok(existsSync(path.join(webDist, "index.html")), "build the web UI before browser acceptance");
  const directory = mkdtempSync(path.join(os.tmpdir(), "wowsync-project-workbench-"));
  const databasePath = path.join(directory, "browser.sqlite");
  let store; let server; let browser;
  try {
    store = new SqliteSnapshotStore(databasePath);
    const now = Math.floor(Date.now() / 1000);
    const imported = store.importSnapshot(buildWowSyncExport({ generatedAt: now, character: { name: "Rordin", surname: "Longbraid", realm: "Classic Beta PvP 2", clientFamily: "Forever", clientVersion: "1.60.1", clientBuild: "70338", interface: "16001", class: "WARRIOR", level: 6 }, professions: { skills: [] }, bank: { unknown: true } }));
    const rordin = store.createErpProject({
      version: "forever", title: "Rordin: learn Mining and Blacksmithing", objective: "Player goal: Create a project for Rordin Longbraid on Forever to learn Mining and Blacksmithing and craft his first useful equipment upgrade.\nTarget identity: forever::classic beta pvp 2::rordin; machine-generated evidence details stay out of the player summary.", priority: 5,
      needs: [{ stableId: "mining", kind: "PROFESSION", resourceKey: "Mining", label: "Mining", requiredQuantity: 1, destinationIdentityKey: imported.character.identityKey }, { stableId: "blacksmithing", kind: "PROFESSION", resourceKey: "Blacksmithing", label: "Blacksmithing", requiredQuantity: 1, destinationIdentityKey: imported.character.identityKey }],
      workOrders: [
        { stableId: "verify_professions", kind: "INVESTIGATE", status: "PLANNED", title: "Verify Rordin's current profession evidence", instructions: "Profession state is UNKNOWN. Refresh a Forever export and verify whether Mining and Blacksmithing are already observed.", assignedIdentityKey: imported.character.identityKey, resourceNeedIds: [], dependsOn: [] },
        { stableId: "review_materials", kind: "INVESTIGATE", status: "PLANNED", title: "Review observed materials and project requirements", assignedIdentityKey: imported.character.identityKey, resourceNeedIds: [], dependsOn: ["verify_professions"] },
        { stableId: "plan_craft", kind: "CRAFT", status: "PLANNED", title: "Review a verified equipment craft", assignedIdentityKey: imported.character.identityKey, resourceNeedIds: [], dependsOn: ["review_materials"] },
        { stableId: "trainer_evidence", kind: "INVESTIGATE", status: "WAITING_FOR_EVIDENCE", title: "Check trainer evidence when available", assignedIdentityKey: imported.character.identityKey, resourceNeedIds: [], dependsOn: [] },
        { stableId: "prior_note", kind: "INVESTIGATE", status: "COMPLETED", title: "Record the project goal", completionNote: "Player recorded the goal.", assignedIdentityKey: imported.character.identityKey, resourceNeedIds: [], dependsOn: [] },
        { stableId: "retired_step", kind: "GATHER", status: "CANCELLED", title: "Old gathering idea", assignedIdentityKey: imported.character.identityKey, resourceNeedIds: [], dependsOn: [] },
      ],
    });
    store.createErpProject({ version: "forever", title: "Paused gather project", status: "PAUSED", priority: 2, workOrders: [{ stableId: "paused-prerequisite", kind: "INVESTIGATE", status: "PLANNED", title: "Review paused-project evidence", resourceNeedIds: [], dependsOn: [] }, { stableId: "blocked", kind: "GATHER", status: "PLANNED", title: "Gather project materials", resourceNeedIds: [], dependsOn: ["paused-prerequisite"] }] });
    server = await listenOnce(createApp(store, 0, webDist, { allowedHosts: LOOPBACK_HOSTNAMES }), "127.0.0.1", 0);
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const executablePath = process.env.WOWSYNC_CHROMIUM_PATH ?? (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);
    browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
    const context = await browser.newContext();
    const page = await context.newPage(); page.setDefaultTimeout(8_000);
    const pageErrors = []; page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(`http://127.0.0.1:${address.port}/#/forever/overview`);
    await page.getByRole("button", { name: "Projects & Work Orders" }).click();

    const detail = page.getByTestId("erp-player-project-detail");
    await detail.getByRole("heading", { name: rordin.title }).waitFor();
    assert.match(await detail.innerText(), /Create a project for Rordin Longbraid on Forever/);
    assert.doesNotMatch(await detail.innerText(), /Target identity:|forever::/);
    assert.match(await detail.innerText(), /Verify Rordin's current profession evidence/);
    assert.match(await detail.innerText(), /Refresh Rordin Longbraid's Forever export[\s\S]*current profession state needs verification/);
    assert.match(await detail.innerText(), /Task assigned to: Rordin Longbraid/);
    assert.match(await detail.innerText(), /Review observed materials and project requirements/);
    assert.match(await detail.innerText(), /Review a verified equipment craft/);
    assert.match(await detail.innerText(), /Needs evidence/);
    assert.match(await detail.innerText(), /Completed/);
    assert.match(await detail.innerText(), /Closed/);
    assert.equal(await detail.locator(".erp-next-action").count(), 1, "one next action is prominent even when later work is dependency-blocked");
    assert.equal(await page.getByText("Advanced planning, resources, and evidence").count(), 1);
    assert.equal(await page.getByText("Work order review queue").isVisible().catch(() => false), false, "portfolio diagnostics are collapsed on entry");
    assert.equal(await page.locator(".erp-player-project-nav button").count(), 2, "the project list remains compact and supports multiple projects");

    await detail.getByRole("button", { name: "Mark in progress" }).click();
    await page.getByRole("status").waitFor();
    const rest = await page.evaluate(async () => await (await fetch("/api/versions/forever/erp/projects")).json());
    const stored = rest.projects.find((project) => project.stableId === rordin.stableId);
    assert.equal(stored.workOrders[0].status, "IN_PROGRESS", "manual progress updates persistent plan state");
    assert.equal(stored.workOrders[0].completionNote, undefined, "marking work in progress records no game outcome");

    await page.locator(".erp-player-project-nav").getByRole("button", { name: /Paused gather project/ }).click();
    assert.match(await page.getByTestId("erp-player-project-detail").innerText(), /Gather project materials/);
    await page.locator(".erp-player-project-nav").getByRole("button", { name: /Rordin: learn Mining and Blacksmithing/ }).click();
    await page.getByTestId("erp-player-project-detail").locator(".erp-player-evidence summary").click();
    assert.match(await page.getByTestId("erp-player-project-detail").innerText(), /Planned source: Not specified; source evidence remains unknown/);

    await page.reload();
    await page.getByRole("button", { name: "Projects & Work Orders" }).click();
    const restored = page.getByTestId("erp-player-project-detail");
    await restored.getByRole("heading", { name: rordin.title }).waitFor();
    assert.match(await restored.innerText(), /IN_PROGRESS|Verify Rordin's current profession evidence/);
    await page.getByText("Advanced planning, resources, and evidence").click();
    await page.getByRole("heading", { name: "Work order review queue" }).waitFor();
    assert.deepEqual(pageErrors, []);
  } finally {
    if (browser) await browser.close();
    if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    store?.close(); rmSync(directory, { recursive: true, force: true });
  }
});
