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
      generated: now - 100,
      bags: observedSection([row(ITEM_ID, 39, { name: "Mycobloom" })], now - 100),
      bank: observedSection([], now - 100),
      warband: warbandSection("OBSERVED", [], now - 100),
      guild: guildSection("gclub-project-fixture", [], now - 100),
    }));
    store.importSnapshot(renderExport({
      name: "Project Fixture",
      realm: "Cairne",
      generated: now,
      bags: observedSection([row(ITEM_ID, 40, { name: "Mycobloom" })], now),
      bank: observedSection([], now),
      warband: warbandSection("OBSERVED", [], now),
      guild: guildSection("gclub-project-fixture", [], now),
    }));
    store.importSnapshot(renderExport({
      name: "Other Potential Holder",
      realm: "Thrall",
      generated: now - 100,
      bags: observedSection([row(ITEM_ID, 3, { name: "Mycobloom" })], now - 100),
      bank: observedSection([], now - 100),
      warband: warbandSection("OBSERVED", [], now - 100),
      guild: guildSection("gclub-other-holder", [], now - 100),
    }));
    store.importSnapshot(renderExport({
      name: "Other Potential Holder",
      realm: "Thrall",
      generated: now,
      bags: observedSection([row(ITEM_ID, 2, { name: "Mycobloom" })], now),
      bank: observedSection([], now),
      warband: warbandSection("OBSERVED", [], now),
      guild: guildSection("gclub-other-holder", [], now),
    }));
    store.importSnapshot(renderExport({
      name: "Another Potential Holder",
      realm: "Aerie Peak",
      generated: now,
      bags: observedSection([row(ITEM_ID, 3, { name: "Mycobloom" })], now),
      bank: observedSection([], now),
      warband: warbandSection("OBSERVED", [], now),
      guild: guildSection("gclub-another-holder", [], now),
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
    await needForm.getByLabel("Source character or shared owner").selectOption({ label: "None — supply UNKNOWN" });
    await needForm.getByLabel("Intended recipient").selectOption({ label: "Project Fixture — Cairne" });
    await needForm.getByRole("button", { name: "Add requirement" }).click();
    const needEvidence = projectCard.locator(".erp-need-list li").first();
    await needEvidence.waitFor();
    let needEvidenceText = await needEvidence.innerText();
    assert.match(needEvidenceText, /Supply unknown/, needEvidenceText);
    assert.match(needEvidenceText, /Possible observed sources for this intended recipient/);
    assert.match(needEvidenceText, /Other Potential Holder — Thrall/);
    assert.match(needEvidenceText, /item:940101/);
    assert.match(needEvidenceText, /Base-item search groups these exact variants/);
    assert.match(needEvidenceText, /Account membership, access, and transferability: UNKNOWN/);
    const possibleSource = needEvidence.locator("li").filter({ hasText: "Thrall" });
    await possibleSource.getByRole("button", { name: "Create source verification task" }).first().click();
    const verifySourceOrder = projectCard.locator(".erp-work-order-list li").filter({ hasText: "Verify possible source for Mycobloom" });
    await verifySourceOrder.waitFor();
    const verificationText = await verifySourceOrder.innerText();
    assert.match(verificationText, /item:940101\S* \(OBSERVED in bags, seen /);
    assert.match(verificationText, /Account membership, source access, recipient access, and a valid transfer route are UNKNOWN/);
    assert.match(verificationText, /does not authorize or perform a transfer/);
    await possibleSource.getByText("Source verification work order already exists for this need.").waitFor();
    await possibleSource.getByRole("button", { name: "Set planned source" }).first().click();
    await needEvidence.getByText(/Recorded as the planned source/).waitFor();
    needEvidenceText = await needEvidence.innerText();
    assert.match(needEvidenceText, /Observed shortfall/, needEvidenceText);
    assert.match(needEvidenceText, /Source: (Other Potential Holder — Thrall|Another Potential Holder — Aerie Peak)/);
    assert.match(needEvidenceText, /Recorded as the planned source \(intent only\)/);
    page.once("dialog", (dialog) => dialog.accept("1"));
    await needEvidence.getByRole("button", { name: "Reserve" }).click();
    await needEvidence.locator(".erp-status").filter({ hasText: /1 reserved across overlapping plans/ }).waitFor();
    const sourceChange = needEvidence.getByRole("button", { name: "Set planned source" });
    assert.equal(await sourceChange.count(), 1, "the selected source is labelled as planned; the other candidate offers a change action");
    assert.equal(await sourceChange.evaluateAll((buttons) => buttons.every((button) => button.disabled)), true, "changing source while a reservation is active is blocked rather than causing a rejected project update");
    await needEvidence.getByText(/Release this need’s active reservation before changing its planned source/).waitFor();
    const commitmentPanel = page.getByRole("region", { name: "Resource commitments" });
    await commitmentPanel.waitFor();
    const commitmentText = await commitmentPanel.innerText();
    assert.match(commitmentText, /Mycobloom/);
    assert.match(commitmentText, /20 requested/, "planning intent is visible as its own quantity");
    assert.match(commitmentText, /2/, "observed source stock is shown independently from planned demand");
    assert.match(commitmentText, /Freshness:/);

    await needForm.getByRole("button", { name: "Close" }).click();
    await projectCard.getByRole("button", { name: "Add requirement / work order" }).click();
    const transferForm = projectCard.locator("form.erp-inline-form");
    await transferForm.getByLabel("Action type").selectOption("TRANSFER");
    await transferForm.getByLabel("Action", { exact: true }).fill("Review paired source and recipient observations");
    await transferForm.getByLabel("Planned source character").selectOption({ label: "Other Potential Holder — Thrall" });
    await transferForm.getByLabel("Intended destination character").selectOption({ label: "Project Fixture — Cairne" });
    await transferForm.getByLabel("Linked resource needs").selectOption({ label: "Mycobloom" });
    await transferForm.getByRole("button", { name: "Add work order" }).click();
    const savedPlan = await page.evaluate(async () => (await (await fetch("/api/versions/retail/erp/projects")).json()).projects.find((entry) => entry.title === "Provision the crafter"));
    const savedNeed = savedPlan.needs.find((entry) => entry.label === "Mycobloom");
    const savedTransferOrder = savedPlan.workOrders.find((entry) => entry.title === "Review paired source and recipient observations");
    assert.deepEqual(savedTransferOrder.resourceNeedIds, [savedNeed.stableId]);
    assert.equal(savedPlan.workOrderReadiness.find((entry) => entry.workOrderId === savedTransferOrder.stableId).linkedNeeds.length, 1);
    assert.equal(savedTransferOrder.sourceIdentityKey, savedNeed.sourceIdentityKey, "transfer source intent matches the linked need source");
    assert.equal(savedTransferOrder.destinationIdentityKey, savedNeed.destinationIdentityKey, "transfer destination intent matches the linked need recipient");
    const transferOrder = projectCard.locator(".erp-work-order-list li").filter({ hasText: "Review paired source and recipient observations" });
    await transferOrder.waitFor();
    assert.match(await transferOrder.innerText(), /Linked inputs and evidence/, await transferOrder.innerText());
    await transferOrder.locator(".erp-work-order-inputs summary").click();
    const transferInputs = await transferOrder.innerText();
    assert.match(transferInputs, /Mycobloom/);
    assert.match(transferInputs, /observed 2/);
    assert.match(transferInputs, /Source: Other Potential Holder — Thrall/);
    await transferOrder.getByText("Compare planned source and destination observations (relationship unknown)").click();
    const transferReview = await transferOrder.innerText();
    assert.match(transferReview, /BOTH SIDES CHANGED/);
    assert.match(transferReview, /Source — Other Potential Holder — Thrall: recent comparable quantity change/);
    assert.match(transferReview, /bags: 3 → 2 \(-1\)/);
    assert.match(transferReview, /Destination — Project Fixture — Cairne: recent comparable quantity change/);
    assert.match(transferReview, /bags: 39 → 40 \(\+1\)/);
    assert.match(transferReview, /do not establish that the changes are related or that a transfer occurred/);
    assert.match(transferReview, /does not establish account membership, ownership, access, transferability/);

    await transferForm.getByRole("button", { name: "Close" }).click();
    await projectCard.getByRole("button", { name: "Add requirement / work order" }).click();
    const orderForm = projectCard.locator("form.erp-inline-form");
    await orderForm.getByLabel("Action", { exact: true }).fill("Manually review possible retrieval of observed supply");
    await orderForm.getByLabel("Action type").selectOption("RETRIEVE");
    assert.match(await projectCard.locator("form.erp-inline-form").last().innerText(), /Retrieval from bank or shared storage remains player-controlled and requires the player to confirm current access/);
    await orderForm.getByLabel("Linked resource needs").selectOption({ label: "Mycobloom" });
    await orderForm.getByRole("button", { name: "Add work order" }).click();
    const order = projectCard.locator(".erp-work-order-list li").filter({ hasText: "Manually review possible retrieval of observed supply" });
    await order.waitFor();
    const progressText = await order.innerText();
    assert.match(progressText, /Current linked resource shortfall/, progressText);
    assert.match(progressText, /RETRIEVE · PLANNED/, "observed stock shortfall does not auto-complete the manual work order");
    assert.doesNotMatch(progressText, /COMPLETED/);

    await orderForm.getByRole("button", { name: "Close" }).click();
    await projectCard.getByRole("button", { name: "Add requirement / work order" }).click();
    const professionForm = projectCard.locator("form.erp-inline-form");
    await professionForm.getByLabel("Kind").selectOption("PROFESSION");
    await professionForm.getByLabel("Resource key").fill("Leatherworking");
    await professionForm.getByLabel("Label").fill("Leatherworking skill 1");
    await professionForm.getByLabel("Required skill").fill("1");
    await professionForm.getByLabel("Source character or shared owner").selectOption({ label: "None — supply UNKNOWN" });
    await professionForm.getByRole("button", { name: "Add requirement" }).click();
    const craftForm = projectCard.locator("form.erp-inline-form");
    await craftForm.getByLabel("Action type").selectOption("CRAFT");
    await craftForm.getByLabel("Action", { exact: true }).fill("Check the assigned character's profession evidence");
    await craftForm.getByLabel("Assigned character").selectOption({ label: "Other Potential Holder — Thrall" });
    await craftForm.getByLabel("Linked resource needs").selectOption({ label: "Leatherworking skill 1" });
    await craftForm.getByRole("button", { name: "Add work order" }).click();
    const craftOrder = projectCard.locator(".erp-work-order-list li").filter({ hasText: "Check the assigned character's profession evidence" });
    await craftOrder.waitFor();
    const craftText = await craftOrder.innerText();
    assert.match(craftText, /Checked on assigned character: Other Potential Holder — Thrall/);
    assert.match(craftText, /unknown freshness/);
    assert.match(craftText, /does not meet Exact profession Leatherworking at skill 1|assigned crafter is unknown/);
    assert.deepEqual(pageErrors, [], "project workflow reports no uncaught browser errors");
  } finally {
    if (browser) await browser.close();
    if (server) await new Promise((resolve) => server.close(() => resolve()));
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
