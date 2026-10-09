// Browser acceptance for the implemented Retail Allocation workflow. The resource rows are explicitly
// synthetic and run against a disposable SQLite DB plus the actual Dashboard HTTP server and web build.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { SqliteSnapshotStore } from "@wowsync-dashboard/core";
import { T, guildSection, observedSection, row, warbandSection } from "../../core/test/allocationFixtures.ts";
import { renderExport } from "../../core/test/sharedStorageExports.ts";
import { createApp } from "../../server/src/app.ts";
import { LOOPBACK_HOSTNAMES, listenOnce } from "../../server/src/net.ts";

const webDist = fileURLToPath(new URL("../dist/", import.meta.url));
const ITEM_ID = 940101;

test("[SYNTHETIC BROWSER ACCEPTANCE] set, edit, and remove a stock target, then verify removed history and version isolation", async () => {
  assert.ok(existsSync(path.join(webDist, "index.html")), "build the web UI before browser acceptance");
  const directory = mkdtempSync(path.join(os.tmpdir(), "wowsync-erp-browser-"));
  let store;
  let server;
  let browser;
  try {
    store = new SqliteSnapshotStore(path.join(directory, "browser.sqlite"));
    store.importSnapshot(renderExport({
      name: "Browser ERP Fixture",
      realm: "Cairne",
      generated: T,
      bags: observedSection([row(ITEM_ID, 40, { name: "Mycobloom" })]),
      bank: observedSection([]),
      warband: warbandSection("OBSERVED", []),
      guild: guildSection("gclub-browser-fixture", [row(ITEM_ID, 900, { name: "Guild Mycobloom" })]),
    }));
    server = await listenOnce(createApp(store, 0, webDist, { allowedHosts: LOOPBACK_HOSTNAMES }), "127.0.0.1", 0);
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const executablePath = process.env.WOWSYNC_CHROMIUM_PATH ?? (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);
    browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
    const page = await browser.newPage();
    page.setDefaultTimeout(5_000);
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(`http://127.0.0.1:${address.port}/#/retail/allocation`);
    await page.getByRole("heading", { name: "Your targets" }).waitFor();
    const held = page.locator(".allocation-held-row").filter({ hasText: "Mycobloom" });
    await held.getByRole("button", { name: "Set target" }).click();
    const createForm = page.getByRole("form", { name: "Set target" });
    await createForm.getByLabel("Keep").fill("30");
    await createForm.getByLabel("Why / purpose (optional)").fill("Synthetic browser acceptance");
    await createForm.getByRole("button", { name: "Set target" }).click();

    const target = page.locator(`#allocation-target-${ITEM_ID}`);
    await target.waitFor();
    await page.locator(".allocation-flash").getByText("Target set: keep 30 of item 940101.").waitFor();
    await target.getByText("Synthetic browser acceptance").waitFor();
    await target.getByRole("button", { name: "Edit" }).click();
    const editForm = page.getByRole("form", { name: "Edit target" });
    await editForm.getByLabel("Keep").fill("50");
    await editForm.getByRole("button", { name: "Save target" }).click();
    await target.getByText("Keep 50").waitFor();
    await target.getByRole("button", { name: "Remove target" }).click();
    await target.getByText(/Removing the target|no longer has modeled intent/i).waitFor();
    await target.getByRole("button", { name: "Remove target" }).last().click();
    await page.getByRole("status").filter({ hasText: "Target removed." }).waitFor();
    await page.locator(".allocation-held-row").filter({ hasText: "Mycobloom" }).waitFor();

    const removed = page.locator("details.allocation-removed");
    await removed.locator("summary").click();
    await removed.getByText(/was Keep 50/).waitFor();
    assert.equal(await page.evaluate(() => document.querySelectorAll(".allocation-row").length), 0, "deactivated intent leaves active allocation rows");

    await page.goto(`http://127.0.0.1:${address.port}/#/forever/allocation`);
    await page.getByRole("heading", { name: "Allocation" }).waitFor();
    await page.getByText("Stock targets and allocation are Retail-only.").waitFor();
    assert.equal(await page.getByText("Mycobloom").count(), 0, "Retail inventory does not leak into Forever UI");
    assert.deepEqual(pageErrors, [], "browser application reported no uncaught errors");
  } finally {
    if (browser) await browser.close();
    if (server) await new Promise((resolve) => server.close(() => resolve()));
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("[SYNTHETIC BROWSER ACCEPTANCE] create a project resource need and manual work order, then show resource evidence without claiming completion", async () => {
  assert.ok(existsSync(path.join(webDist, "index.html")), "build the web UI before browser acceptance");
  const directory = mkdtempSync(path.join(os.tmpdir(), "wowsync-erp-project-browser-"));
  let store;
  let server;
  let browser;
  try {
    store = new SqliteSnapshotStore(path.join(directory, "browser.sqlite"));
    const now = Math.floor(Date.now() / 1000);
    store.importSnapshot(renderExport({
      name: "Project Fixture",
      realm: "Cairne",
      generated: now,
      bags: observedSection([row(ITEM_ID, 40, { name: "Mycobloom" })], now),
      bank: observedSection([], now),
      warband: warbandSection("OBSERVED", [], now),
      guild: guildSection("gclub-project-fixture", [], now),
    }));
    server = await listenOnce(createApp(store, 0, webDist, { allowedHosts: LOOPBACK_HOSTNAMES }), "127.0.0.1", 0);
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const executablePath = process.env.WOWSYNC_CHROMIUM_PATH ?? (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);
    browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
    const page = await browser.newPage();
    page.setDefaultTimeout(5_000);
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(`http://127.0.0.1:${address.port}/#/retail/overview`);
    await page.getByRole("button", { name: "Projects & Work Orders" }).click();
    await page.getByRole("heading", { name: "Projects & Work Orders" }).waitFor();
    const createForm = page.locator("form.erp-create-form");
    await createForm.getByLabel("Project title").fill("Provision the crafter");
    await createForm.getByLabel("Objective").fill("Record a resource-backed manual step.");
    await createForm.getByRole("button", { name: "Create project" }).click();
    const projectCard = page.locator(".erp-project-card").filter({ hasText: "Provision the crafter" });
    await projectCard.waitFor();

    await projectCard.getByRole("button", { name: "Add requirement / work order" }).click();
    const needForm = projectCard.locator("form.erp-inline-form");
    await needForm.getByLabel("Kind").selectOption("ITEM_ID");
    await needForm.getByLabel("Resource key").fill(String(ITEM_ID));
    await needForm.getByLabel("Label").fill("Mycobloom");
    await needForm.getByLabel("Quantity").fill("20");
    await needForm.getByLabel("Source character or shared owner").selectOption({ label: "Project Fixture — Cairne" });
    await needForm.getByRole("button", { name: "Add requirement" }).click();
    const needEvidence = projectCard.locator(".erp-need-list li").first();
    await needEvidence.waitFor();
    const needEvidenceText = await needEvidence.innerText();
    assert.match(needEvidenceText, /Covered by observed supply/, needEvidenceText);
    const commitmentPanel = page.getByRole("region", { name: "Resource commitments" });
    await commitmentPanel.waitFor();
    const commitmentText = await commitmentPanel.innerText();
    assert.match(commitmentText, /Mycobloom/);
    assert.match(commitmentText, /20 requested/, "planning intent is visible as its own quantity");
    assert.match(commitmentText, /40/, "observed stock is shown independently from planned demand");
    assert.match(commitmentText, /Freshness:/);

    await needForm.getByRole("button", { name: "Close" }).click();
    await projectCard.getByRole("button", { name: "Add requirement / work order" }).click();
    const orderForm = projectCard.locator("form.erp-inline-form");
    await orderForm.getByLabel("Action", { exact: true }).fill("Manually inspect the stored supply");
    await orderForm.getByLabel("Action type").selectOption("INVESTIGATE");
    await orderForm.getByLabel("Linked resource needs").selectOption({ label: "Mycobloom" });
    await orderForm.getByRole("button", { name: "Add work order" }).click();
    const order = projectCard.locator(".erp-work-order-list li").filter({ hasText: "Manually inspect the stored supply" });
    await order.waitFor();
    const progressText = await order.innerText();
    assert.match(progressText, /Linked resource needs currently covered/, progressText);
    assert.match(progressText, /not completion or the action that produced it/, progressText);
    assert.deepEqual(pageErrors, [], "project workflow reports no uncaught browser errors");
  } finally {
    if (browser) await browser.close();
    if (server) await new Promise((resolve) => server.close(() => resolve()));
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
