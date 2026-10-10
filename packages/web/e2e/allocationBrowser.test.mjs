// Browser acceptance for the implemented Retail Allocation workflow. The resource rows are explicitly
// synthetic and run against a disposable SQLite DB plus the actual Dashboard HTTP server and web build.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { SqliteSnapshotStore } from "@wowsync-dashboard/core";
import { T, fullRef, guildSection, observedSection, row, warbandSection } from "../../core/test/allocationFixtures.ts";
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
      guild: guildSection("gclub-project-fixture", [row(ITEM_ID, 10, { name: "Guild Mycobloom" })], now - 100),
    }));
    store.importSnapshot(renderExport({
      name: "Project Fixture",
      realm: "Cairne",
      generated: now,
      bags: observedSection([row(ITEM_ID, 40, { name: "Mycobloom" })], now),
      bank: observedSection([], now),
      warband: warbandSection("OBSERVED", [], now),
      guild: guildSection("gclub-project-fixture", [row(ITEM_ID, 10, { name: "Guild Mycobloom" })], now),
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
    const fulfillmentSnapshot = projectCard.getByTestId("erp-fulfillment-snapshot");
    await fulfillmentSnapshot.getByText(/NO REQUIREMENTS/).waitFor();
    assert.match(await fulfillmentSnapshot.innerText(), /player project status active/i);
    assert.match(await fulfillmentSnapshot.innerText(), /does not mean resources are unreserved or accessible/);

    await projectCard.getByRole("button", { name: "Add requirement / work order" }).click();
    const needForm = projectCard.locator("form.erp-inline-form");
    await needForm.getByLabel("Kind").selectOption("ITEM_ID");
    await needForm.getByLabel("Resource key").fill(String(ITEM_ID));
    await needForm.getByLabel("Label").fill("Mycobloom");
    await needForm.getByLabel("Quantity").fill("20");
    await needForm.getByLabel("Source character or shared owner").selectOption({ label: "None — supply UNKNOWN" });
    await needForm.getByLabel("Intended recipient").selectOption({ label: "Project Fixture — Cairne" });
    await needForm.getByRole("button", { name: "Add requirement" }).click();
    await fulfillmentSnapshot.getByText(/EVIDENCE REVIEW REQUIRED/).waitFor();
    assert.match(await fulfillmentSnapshot.innerText(), /1 unresolved/);
    const unworkedNeeds = page.getByRole("region", { name: "Resource needs without an open work order" });
    await unworkedNeeds.getByText("Mycobloom").waitFor();
    assert.match(await unworkedNeeds.innerText(), /UNKNOWN/);
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
    assert.match(await fulfillmentSnapshot.innerText(), /1 open manual work orders/);
    await unworkedNeeds.getByText("No uncovered resource needs are missing an open manual work order.").waitFor();
    const verificationText = await verifySourceOrder.innerText();
    assert.match(verificationText, /item:940101\S* \(OBSERVED in bags, seen /);
    assert.match(verificationText, /Account membership, source access, recipient access, and a valid transfer route are UNKNOWN/);
    assert.match(verificationText, /does not authorize or perform a transfer/);
    const workQueue = page.getByRole("region", { name: "Work order review queue" });
    await workQueue.getByText("Verify possible source for Mycobloom").waitFor();
    assert.match(await workQueue.innerText(), /review needed/);
    assert.match(await workQueue.innerText(), /Provision the crafter/);
    await workQueue.getByLabel("Search work orders").fill("not present");
    await workQueue.getByText("No work orders match this search.").waitFor();
    await workQueue.getByLabel("Search work orders").fill("");
    await workQueue.getByRole("button", { name: "Open project" }).click();
    assert.ok(await projectCard.getAttribute("id"), "queue navigation points to the existing project card");
    assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), "Provision the crafter", "keyboard and screen-reader focus moves to the project heading");
    await possibleSource.getByText("Source verification work order already exists for this need.").waitFor();
    await possibleSource.getByRole("button", { name: "Set planned source" }).first().click();
    await needEvidence.getByText(/Recorded as the planned source/).waitFor();
    needEvidenceText = await needEvidence.innerText();
    assert.match(needEvidenceText, /Observed shortfall/, needEvidenceText);
    assert.match(needEvidenceText, /Source: (Other Potential Holder — Thrall|Another Potential Holder — Aerie Peak)/);
    assert.match(needEvidenceText, /Recorded as the planned source \(intent only\)/);
    await possibleSource.getByRole("button", { name: "Plan manual provisioning review" }).click();
    const provisioningOrder = projectCard.locator(".erp-work-order-list li").filter({ hasText: "Review provisioning Mycobloom to Project Fixture" });
    await provisioningOrder.waitFor();
    const { provisioningRecord, plannedSourceIdentityKey, intendedRecipientIdentityKey } = await page.evaluate(async () => { const project = (await (await fetch("/api/versions/retail/erp/projects")).json()).projects.find((entry) => entry.title === "Provision the crafter"); const need = project.needs.find((entry) => entry.label === "Mycobloom"); const candidate = project.resourceSourceScreens.find((entry) => entry.needId === need.stableId).candidates.find((entry) => entry.sourceRealm === "Thrall"); return { provisioningRecord: project.workOrders.find((entry) => entry.kind === "PROVISION"), plannedSourceIdentityKey: candidate.sourceIdentityKey, intendedRecipientIdentityKey: need.destinationIdentityKey }; });
    assert.equal(provisioningRecord.sourceIdentityKey, plannedSourceIdentityKey);
    assert.equal(provisioningRecord.destinationIdentityKey, intendedRecipientIdentityKey);
    assert.notEqual(provisioningRecord.sourceIdentityKey, provisioningRecord.destinationIdentityKey);
    assert.equal(provisioningRecord.status, "PLANNED");
    assert.match(provisioningRecord.instructions, /account membership, character access, binding, or a valid transfer route/);
    assert.match(await provisioningOrder.innerText(), /No transfer is executed/);
    await possibleSource.getByText("Provisioning review already exists for this source and recipient.").waitFor();
    page.once("dialog", (dialog) => dialog.accept("1"));
    await needEvidence.getByRole("button", { name: "Reserve" }).click();
    await needEvidence.locator(".erp-status").filter({ hasText: /1 reserved across overlapping plans/ }).waitFor();
    assert.equal(await possibleSource.getByRole("button", { name: "Plan manual provisioning review" }).count(), 0, "a source with an active reservation cannot generate another provisioning plan");
    page.once("dialog", (dialog) => dialog.accept("3"));
    await needEvidence.getByRole("button", { name: "Adjust 1" }).click();
    await page.getByRole("alert").filter({ hasText: "Enter a whole quantity from 1 to 2" }).waitFor();
    page.once("dialog", (dialog) => dialog.accept("2"));
    await needEvidence.getByRole("button", { name: "Adjust 1" }).click();
    await needEvidence.locator(".erp-status").filter({ hasText: /2 reserved across overlapping plans/ }).waitFor();
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
    const selectedSourceCommitment = commitmentPanel.locator(".erp-commitment-card").filter({ hasText: "Other Potential Holder" });
    const sectionEvidence = selectedSourceCommitment.locator(".erp-commitment-sections");
    await sectionEvidence.locator("summary").click();
    assert.match(await sectionEvidence.innerText(), /Bags: OBSERVED · 2 matching units/,
      "the account-wide view preserves per-location evidence instead of presenting only a collapsed total");
    assert.match(await sectionEvidence.innerText(), /Character bank: OBSERVED · 0 matching units/,
      "a fully observed empty personal-bank section is distinguishable from missing bank evidence");
    await commitmentPanel.getByLabel("Commitment filter").selectOption("REVIEW");
    assert.match(await commitmentPanel.getByText(/need review/).innerText(), /Showing \d+ of \d+ resource scopes/);
    await commitmentPanel.getByLabel("Commitment filter").selectOption("RESERVED");
    await commitmentPanel.locator(".erp-commitment-card").first().waitFor();
    const reservedCommitments = await commitmentPanel.locator(".erp-commitment-card").allInnerTexts();
    assert.ok(reservedCommitments.some((text) => /Reservations on these exact needs[\s\S]*2/.test(text)), "the adjusted reservation remains visible in the cross-project filter");
    await commitmentPanel.getByLabel("Search commitments").fill("no matching resource name");
    await commitmentPanel.getByText("No commitments match this filter.").waitFor();
    await commitmentPanel.getByLabel("Search commitments").fill("");
    await commitmentPanel.getByLabel("Commitment filter").selectOption("ALL");

    await needForm.getByLabel("Kind").selectOption("RECIPE");
    await needForm.getByLabel("Resource key").fill("3001");
    await needForm.getByLabel("Label").fill("Recipe 3001");
    const fixtureSourceKeys = await needForm.getByLabel("Source character or shared owner").locator("option").evaluateAll((options) => options.filter((option) => option.textContent.includes("Project Fixture")).map((option) => option.value));
    assert.equal(fixtureSourceKeys.length, 1);
    await needForm.getByLabel("Source character or shared owner").selectOption(fixtureSourceKeys[0]);
    await needForm.getByRole("button", { name: "Add requirement" }).click();
    const recipeNeed = projectCard.locator(".erp-need-list li").filter({ hasText: "Recipe 3001" });
    await recipeNeed.getByRole("button", { name: "Plan manual craft review" }).click();
    const prefilledCraftForm = projectCard.locator("form.erp-inline-form").last();
    assert.equal(await prefilledCraftForm.getByLabel("Action type").inputValue(), "CRAFT");
    assert.equal(await prefilledCraftForm.getByLabel("Assigned character").inputValue(), fixtureSourceKeys[0]);
    const recipeNeedId = await page.evaluate(async () => (await (await fetch("/api/versions/retail/erp/projects")).json()).projects.find((entry) => entry.title === "Provision the crafter").needs.find((entry) => entry.label === "Recipe 3001").stableId);
    assert.deepEqual(await prefilledCraftForm.getByLabel("Linked resource needs").evaluate((element) => Array.from(element.selectedOptions, (option) => option.value)), [recipeNeedId]);
    assert.match(await prefilledCraftForm.getByLabel("Manual instructions").inputValue(), /does not establish profession skill, unlocks, reagents, craftability, output, or completion/);
    const craftFormGuidance = await prefilledCraftForm.innerText();
    assert.ok(craftFormGuidance.includes("Declare each material as its own resource need"));
    assert.ok(craftFormGuidance.includes("no inputs are generated or assumed"));
    const materialNeedForm = projectCard.locator("form.erp-inline-form").filter({ hasText: "Add a resource requirement" });
    assert.equal(await materialNeedForm.getByLabel("Kind").inputValue(), "ITEM_REF", "craft review prepares an exact-variant material requirement form");
    assert.equal(await materialNeedForm.getByLabel("Source character or shared owner").inputValue(), fixtureSourceKeys[0], "material source is explicitly preselected to the crafter");
    await materialNeedForm.getByLabel("Resource key").fill(`item:${ITEM_ID}::::::::80`);
    await materialNeedForm.getByLabel("Label").fill("Player-declared craft material");
    await materialNeedForm.getByLabel("Quantity").fill("45");
    await materialNeedForm.getByRole("button", { name: "Add requirement" }).click();
    const { materialNeedId, materialNeedRecord } = await page.evaluate(async () => { const project = (await (await fetch("/api/versions/retail/erp/projects")).json()).projects.find((entry) => entry.title === "Provision the crafter"); const need = project.needs.find((entry) => entry.label === "Player-declared craft material"); return { materialNeedId: need.stableId, materialNeedRecord: need }; });
    assert.equal(materialNeedRecord.destinationIdentityKey, fixtureSourceKeys[0], "craft material is intended for its assigned crafter");
    await prefilledCraftForm.getByLabel("Linked resource needs").selectOption([recipeNeedId, materialNeedId]);
    await prefilledCraftForm.getByRole("button", { name: "Add work order" }).click();
    await recipeNeed.getByText("An active CRAFT review is already linked to this recipe need.").waitFor();
    const craftAssessment = await page.evaluate(async () => (await (await fetch("/api/versions/retail/erp/projects")).json()).projects.find((entry) => entry.title === "Provision the crafter"));
    const craftOrder = craftAssessment.workOrders.find((entry) => entry.kind === "CRAFT" && entry.resourceNeedIds.includes(recipeNeedId));
    assert.deepEqual(craftOrder.resourceNeedIds, [recipeNeedId, materialNeedId]);
    let linkedMaterial = craftAssessment.workOrderReadiness.find((entry) => entry.workOrderId === craftOrder.stableId).linkedNeeds.find((entry) => entry.needId === materialNeedId);
    assert.equal(linkedMaterial.state, "SHORTFALL_OBSERVED", "the declared quantity exceeds the selected crafter's complete synthetic inventory observation");
    assert.equal(linkedMaterial.reservationState, "UNRESERVED");
    const materialNeed = projectCard.locator(".erp-need-list li").filter({ hasText: "Player-declared craft material" });
    page.once("dialog", (dialog) => dialog.accept("2"));
    await materialNeed.getByRole("button", { name: "Reserve" }).click();
    await materialNeed.locator(".erp-status").filter({ hasText: /2 reserved across overlapping plans/ }).waitFor();
    const reservedCraftAssessment = await page.evaluate(async () => (await (await fetch("/api/versions/retail/erp/projects")).json()).projects.find((entry) => entry.title === "Provision the crafter"));
    linkedMaterial = reservedCraftAssessment.workOrderReadiness.find((entry) => entry.workOrderId === craftOrder.stableId).linkedNeeds.find((entry) => entry.needId === materialNeedId);
    assert.equal(linkedMaterial.reservationState, "WITHIN_OBSERVED_SUPPLY");
    assert.equal(linkedMaterial.activeReservationQuantity, 2);
    assert.equal(linkedMaterial.state, "SHORTFALL_OBSERVED", "reserving available material does not erase the observed project shortfall");
    await materialNeed.getByRole("button", { name: "Plan manual purchase step" }).click();
    const purchasePrefill = projectCard.locator("form.erp-inline-form").last();
    assert.equal(await purchasePrefill.getByLabel("Action type").inputValue(), "PURCHASE");
    assert.equal(await purchasePrefill.getByLabel("Assigned character").inputValue(), fixtureSourceKeys[0]);
    assert.equal(await purchasePrefill.getByLabel("Item target need").inputValue(), materialNeedId);
    await purchasePrefill.getByLabel("Spending ceiling (copper)").fill("2500");
    await purchasePrefill.getByRole("button", { name: "Add work order" }).click();
    const procurementAssessment = await page.evaluate(async () => (await (await fetch("/api/versions/retail/erp/projects")).json()).projects.find((entry) => entry.title === "Provision the crafter"));
    const materialProcurementOrder = procurementAssessment.workOrders.find((entry) => entry.kind === "PURCHASE" && entry.resourceNeedIds.includes(materialNeedId));
    assert.equal(materialProcurementOrder.assignedIdentityKey, fixtureSourceKeys[0]);
    assert.equal(materialProcurementOrder.procurementPlan.targetNeedId, materialNeedId);
    assert.equal(materialProcurementOrder.procurementPlan.spendingCeilingCopper, 2500);
    assert.equal(materialProcurementOrder.status, "PLANNED", "procurement remains a manual plan with no purchase execution");

    await materialNeedForm.getByRole("button", { name: "Close" }).click();
    await projectCard.getByRole("button", { name: "Add requirement / work order" }).click();
    const sharedNeedForm = projectCard.locator("form.erp-inline-form").first();
    await sharedNeedForm.getByLabel("Kind").selectOption("ITEM_REF");
    await sharedNeedForm.getByLabel("Resource key").fill(`item:${ITEM_ID}::::::::80`);
    await sharedNeedForm.getByLabel("Label").fill("Guild-held Mycobloom");
    await sharedNeedForm.getByLabel("Quantity").fill("1");
    await sharedNeedForm.getByLabel("Source character or shared owner").locator("option[value='owner::retail::guild::gclub-project-fixture']").waitFor({ state: "attached" });
    await sharedNeedForm.getByLabel("Source character or shared owner").selectOption("owner::retail::guild::gclub-project-fixture");
    await sharedNeedForm.getByLabel("Intended recipient").selectOption(fixtureSourceKeys[0]);
    await sharedNeedForm.getByRole("button", { name: "Add requirement" }).click();
    const guildNeed = projectCard.locator(".erp-need-list li").filter({ hasText: "Guild-held Mycobloom" });
    await guildNeed.getByText("Covered by observed supply").waitFor();
    await guildNeed.getByRole("button", { name: "Plan manual shared-storage retrieval review" }).click();
    const retrievalPrefill = projectCard.locator("form.erp-inline-form").last();
    assert.equal(await retrievalPrefill.getByLabel("Action type").inputValue(), "RETRIEVE");
    assert.equal(await retrievalPrefill.getByLabel("Assigned character").inputValue(), fixtureSourceKeys[0]);
    assert.equal(await retrievalPrefill.getByLabel("Intended destination character").inputValue(), fixtureSourceKeys[0]);
    assert.match(await retrievalPrefill.getByLabel("Manual instructions").inputValue(), /Guild items remain guild-owned/);
    assert.match(await retrievalPrefill.getByLabel("Manual instructions").inputValue(), /at least 10 matching units/);
    assert.match(await retrievalPrefill.getByLabel("Manual instructions").inputValue(), /may not cover inaccessible or unscanned storage/);
    assert.match(await retrievalPrefill.getByLabel("Manual instructions").inputValue(), /No retrieval is executed/);
    await retrievalPrefill.getByRole("button", { name: "Add work order" }).click();
    const retrievalOrder = projectCard.locator(".erp-work-order-list li").filter({ hasText: "Review retrieval of Guild-held Mycobloom" });
    await retrievalOrder.waitFor();
    assert.match(await retrievalOrder.innerText(), /Guild remains guild-owned|guild-owned/);
    assert.match(await retrievalOrder.innerText(), /does not establish|permission|access/i);
    await guildNeed.getByText("An active RETRIEVE review is already linked to this need.").waitFor();
    await projectCard.getByRole("button", { name: "Hide forms" }).click();
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
    assert.match(transferReview, /do not establish that the changes are related or that the planned transfer occurred/);
    assert.match(transferReview, /does not establish account membership, ownership, access, transferability/);

    await transferForm.getByRole("button", { name: "Close" }).click();
    await projectCard.getByRole("button", { name: "Add requirement / work order" }).click();
    const provisionForm = projectCard.locator("form.erp-inline-form");
    await provisionForm.getByLabel("Action type").selectOption("PROVISION");
    await provisionForm.getByLabel("Action", { exact: true }).fill("Review manual character provisioning");
    await provisionForm.getByLabel("Planned source character").selectOption(savedNeed.sourceIdentityKey);
    await provisionForm.getByLabel("Intended destination character").selectOption(savedNeed.destinationIdentityKey);
    await provisionForm.getByLabel("Linked resource needs").selectOption({ label: "Mycobloom" });
    await provisionForm.getByRole("button", { name: "Add work order" }).click();
    const provisionOrder = projectCard.locator(".erp-work-order-list li").filter({ hasText: "Review manual character provisioning" });
    await provisionOrder.waitFor();
    await provisionOrder.getByText("Compare planned provisioning source and recipient observations (relationship unknown)").click();
    const provisionReview = await provisionOrder.innerText();
    assert.match(provisionReview, /BOTH SIDES CHANGED/);
    assert.match(provisionReview, /Source: Other Potential Holder.*recent comparable quantity change/);
    assert.match(provisionReview, /Recipient: Project Fixture.*recent comparable quantity change/);
    assert.match(provisionReview, /does not establish that the resources moved/);
    assert.match(provisionReview, /PROVISION.*PLANNED/);
    assert.doesNotMatch(provisionReview, /PROVISION.*COMPLETED/);

    await provisionForm.getByRole("button", { name: "Close" }).click();
    await projectCard.getByRole("button", { name: "Add requirement / work order" }).click();
    const orderForm = projectCard.locator("form.erp-inline-form").last();
    await orderForm.getByLabel("Action", { exact: true }).fill("Manually review possible retrieval of observed supply");
    await orderForm.getByLabel("Action type").selectOption("RETRIEVE");
    assert.match(await orderForm.innerText(), /Retrieval from bank or shared storage remains player-controlled and requires the player to confirm current access/);
    await orderForm.getByLabel("Linked resource needs").selectOption({ label: "Mycobloom" });
    await orderForm.getByRole("button", { name: "Add work order" }).click();
    const order = projectCard.locator(".erp-work-order-list li").filter({ hasText: "Manually review possible retrieval of observed supply" });
    await order.waitFor();
    const progressText = await order.innerText();
    assert.match(progressText, /Current linked resource shortfall/, progressText);
    assert.match(progressText, /RETRIEVE .*PLANNED/);
    assert.doesNotMatch(progressText, /COMPLETED/);
    await projectCard.getByRole("button", { name: "Hide forms" }).click();
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
    await craftForm.getByLabel("Item identity").selectOption("ITEM_ID");
    await craftForm.getByRole("textbox", { name: "Base item ID" }).fill(String(ITEM_ID));
    await craftForm.getByLabel("Output label").fill("Planned Mycobloom output");
    await craftForm.getByLabel("Planned quantity").fill("2");
    const outputRecipient = craftForm.getByLabel("Intended destination character");
    const outputRecipientKey = await outputRecipient.locator("option").evaluateAll((options) => options.find((option) => option.textContent?.startsWith("Project Fixture"))?.value);
    assert.ok(outputRecipientKey);
    await outputRecipient.selectOption(outputRecipientKey);
    const outputObserver = craftForm.getByLabel("Character inventory to check for planned craft output");
    const outputObserverKey = await outputObserver.locator("option").evaluateAll((options) => options.find((option) => option.textContent?.startsWith("Other Potential Holder"))?.value);
    assert.ok(outputObserverKey);
    await outputObserver.selectOption(outputObserverKey);
    await craftForm.getByLabel("Assigned character").selectOption({ label: "Other Potential Holder — Thrall" });
    await craftForm.getByLabel("Linked resource needs").selectOption([{ label: "Leatherworking skill 1" }, { label: "Mycobloom" }]);
    await craftForm.getByRole("button", { name: "Add work order" }).click();
    const craftOrderElement = projectCard.locator(".erp-work-order-list li").filter({ hasText: "Check the assigned character's profession evidence" });
    await craftOrderElement.waitFor();
    await craftOrderElement.getByText("Compare planned crafter input observations (crafting cause unknown)").click();
    const craftText = await craftOrderElement.innerText();
    assert.match(craftText, /Checked on assigned character: Other Potential Holder — Thrall/);
    assert.match(craftText, /unknown freshness/);
    assert.match(craftText, /does not meet Exact profession Leatherworking at skill 1|assigned crafter is unknown/);
    assert.match(craftText, /Planned craft output \(intent only\)/);
    assert.match(craftText, /Intended recipient: Project Fixture.*Inventory checked: Other Potential Holder/);
    assert.match(craftText, /Quantity in recorded evidence: 2/);
    assert.match(craftText, /do not verify this craft or complete the work order/);
    assert.match(craftText, /Compare planned crafter input observations \(crafting cause unknown\)/);
    assert.match(craftText, /Input changes do not establish consumption or link them causally to the planned output/);
    const persistedCraft = await page.evaluate(async () => (await (await fetch("/api/versions/retail/erp/projects")).json()).projects.find((entry) => entry.title === "Provision the crafter").workOrders.find((entry) => entry.title === "Check the assigned character's profession evidence"));
    assert.deepEqual(persistedCraft.plannedOutput, { kind: "ITEM_ID", resourceKey: String(ITEM_ID), label: "Planned Mycobloom output", quantity: 2 });
    assert.equal(persistedCraft.destinationIdentityKey, outputRecipientKey);
    assert.equal(persistedCraft.outputObservationIdentityKey, outputObserverKey);

    await craftOrderElement.getByRole("button", { name: "Edit plan" }).click();
    const editCraftForm = projectCard.locator("form.erp-inline-form").last();
    await editCraftForm.getByRole("heading", { name: "Edit manual work order" }).waitFor();
    await editCraftForm.getByLabel("Action", { exact: true }).fill("Review and revise the craft plan");
    await editCraftForm.getByRole("button", { name: "Save work-order plan" }).click();
    const revisedCraft = projectCard.locator(".erp-work-order-list li").filter({ hasText: "Review and revise the craft plan" });
    await revisedCraft.waitFor();
    const persistedRevisedCraft = await page.evaluate(async () => (await (await fetch("/api/versions/retail/erp/projects")).json()).projects.find((entry) => entry.title === "Provision the crafter").workOrders.find((entry) => entry.title === "Review and revise the craft plan"));
    assert.equal(persistedRevisedCraft.stableId, persistedCraft.stableId, "editing preserves the persistent work-order identity");
    assert.equal(persistedRevisedCraft.status, persistedCraft.status, "editing plan fields does not change manual task status");
    assert.deepEqual(persistedRevisedCraft.resourceNeedIds, persistedCraft.resourceNeedIds);
    assert.equal(persistedRevisedCraft.outputObservationIdentityKey, outputObserverKey);
    assert.equal(persistedRevisedCraft.destinationIdentityKey, outputRecipientKey);

    await craftForm.getByRole("button", { name: "Close" }).click();
    await projectCard.getByRole("button", { name: "Add requirement / work order" }).click();
    const procurementNeedForm = projectCard.locator("form.erp-inline-form").first();
    await procurementNeedForm.getByLabel("Kind").selectOption("ITEM_ID");
    await procurementNeedForm.getByLabel("Resource key").fill(String(ITEM_ID));
    await procurementNeedForm.getByLabel("Label").fill("Purchase gap target");
    await procurementNeedForm.getByLabel("Quantity").fill("45");
    await procurementNeedForm.getByLabel("Source character or shared owner").selectOption({ label: "Project Fixture — Cairne" });
    await procurementNeedForm.getByLabel("Intended recipient").selectOption({ label: "Project Fixture — Cairne" });
    await procurementNeedForm.getByRole("button", { name: "Add requirement" }).click();
    const plannedBudgetForm = procurementNeedForm;
    await plannedBudgetForm.getByLabel("Kind").selectOption("GOLD_COPPER");
    await plannedBudgetForm.getByLabel("Label").fill("Planned purchase budget");
    await plannedBudgetForm.getByRole("spinbutton", { name: "Copper" }).fill("90");
    const buyerOption = plannedBudgetForm.getByLabel("Source character or shared owner").locator("option").filter({ hasText: "Project Fixture" }).last();
    const buyerIdentityKey = await buyerOption.getAttribute("value");
    await plannedBudgetForm.getByLabel("Source character or shared owner").selectOption(buyerIdentityKey);
    await plannedBudgetForm.getByLabel("Intended recipient").selectOption(buyerIdentityKey);
    await plannedBudgetForm.getByRole("button", { name: "Add requirement" }).click();
    await procurementNeedForm.getByLabel("Kind").selectOption("ITEM_ID");
    await procurementNeedForm.getByLabel("Resource key").fill(String(ITEM_ID + 1));
    await procurementNeedForm.getByLabel("Label").fill("Alternate purchase target");
    await procurementNeedForm.getByLabel("Quantity").fill("1");
    await procurementNeedForm.getByLabel("Source character or shared owner").selectOption(buyerIdentityKey);
    await procurementNeedForm.getByLabel("Intended recipient").selectOption(buyerIdentityKey);
    await procurementNeedForm.getByRole("button", { name: "Add requirement" }).click();
    const procurementForm = projectCard.locator("form.erp-inline-form").filter({ has: page.getByLabel("Action type") });
    await procurementForm.getByLabel("Action type").selectOption("PURCHASE");
    await procurementForm.getByLabel("Action", { exact: true }).fill("Review the observed item gap without purchasing");
    await procurementForm.locator("select").nth(1).selectOption({ label: "Project Fixture — Cairne" });
    const targetOptions = await procurementForm.getByLabel("Item target need").locator("option").allTextContents();
    assert.ok(targetOptions.some((label) => label.includes("Purchase gap target")));
    assert.ok(!targetOptions.some((label) => label.includes("Mycobloom")), "item needs scoped to another or unknown buyer are not offered");
    await procurementForm.getByLabel("Item target need").selectOption({ label: targetOptions.find((label) => label.includes("Purchase gap target")) });
    const budgetOptions = await procurementForm.getByLabel("Explicit gold budget need (optional)").locator("option").allTextContents();
    assert.ok(budgetOptions.some((label) => label.includes("Planned purchase budget")));
    await procurementForm.getByLabel("Explicit gold budget need (optional)").selectOption({ label: budgetOptions.find((label) => label.includes("Planned purchase budget")) });
    await procurementForm.getByLabel("Spending ceiling (copper)").fill("100");
    await procurementForm.getByRole("button", { name: "Add work order" }).click();
    const purchaseOrder = projectCard.locator(".erp-work-order-list li").filter({ hasText: "Review the observed item gap without purchasing" });
    await purchaseOrder.waitFor();
    const queuedPurchaseOrder = page.getByRole("region", { name: "Work order review queue" }).locator("li").filter({ hasText: "Review the observed item gap without purchasing" });
    await queuedPurchaseOrder.waitFor();
    const goldCommitment = commitmentPanel.locator(".erp-commitment-card").filter({ hasText: "Planned purchase budget" });
    const goldSectionEvidence = goldCommitment.locator(".erp-commitment-sections");
    await goldSectionEvidence.locator("summary").click();
    assert.match(await goldSectionEvidence.innerText(), /resource-specific value is summarized above; section quantity detail unavailable/,
      "a non-item source section is not mislabeled as an unknown item count");
    const quoteAnswers = [" "];
    page.on("dialog", async (dialog) => dialog.accept(quoteAnswers.shift() ?? ""));
    await queuedPurchaseOrder.getByRole("button", { name: "Record quote..." }).click();
    await page.locator(".erp-form-error").filter({ hasText: "Enter a non-negative whole-copper amount" }).waitFor();
    let persistedProject = await page.evaluate(async () => (await (await fetch("/api/versions/retail/erp/projects")).json()).projects.find((entry) => entry.title === "Provision the crafter"));
    let persistedPurchase = persistedProject.workOrders.find((entry) => entry.title === "Review the observed item gap without purchasing");
    assert.equal(persistedPurchase.procurementPlan.playerQuote, undefined, "blank price input cannot create a zero-copper player quote");
    quoteAnswers.push("80", "5", "Town vendor checked by player");
    await queuedPurchaseOrder.getByRole("button", { name: "Record quote..." }).click();
    await purchaseOrder.locator(".erp-procurement-review").filter({ hasText: "Town vendor checked by player" }).waitFor();
    const purchaseText = await purchaseOrder.innerText();
    assert.match(purchaseText, /Purchase review \(not a recommendation\)/);
    assert.match(purchaseText, /OBSERVED ITEM GAP/);
    assert.match(purchaseText, /observed gold UNKNOWN/);
    assert.match(purchaseText, /No active same-version WoWSync gold reservation is recorded/);
    assert.match(purchaseText, /Current stock availability, purchase route.*UNKNOWN/);
    assert.match(purchaseText, /affordability are UNKNOWN/);
    assert.match(purchaseText, /not a purchase recommendation or action/);
    assert.match(purchaseText, /Player-reported total quote: 80 copper for 5 unit\(s\)/);
    assert.match(purchaseText, /not verified market data/);
    assert.match(purchaseText, /Procurement change review \(cause unknown\)/);
    assert.match(purchaseText, /Buyer: Project Fixture.*UNKNOWN.*recent latest evidence/);
    assert.match(purchaseText, /Linked item target ITEM CHANGED · recent latest evidence/);
    assert.match(purchaseText, /bags: 39 → 40 \(\+1\)/);
    assert.match(purchaseText, /Quote compared with recorded-gold snapshot: EVIDENCE NOT COMPARABLE/i);
    assert.match(purchaseText, /Quote compared with planned budget: PLAYER QUOTE AT OR BELOW PLANNED BUDGET \(90 copper planned\)/i);
    persistedProject = await page.evaluate(async () => (await (await fetch("/api/versions/retail/erp/projects")).json()).projects.find((entry) => entry.title === "Provision the crafter"));
    persistedPurchase = persistedProject.workOrders.find((entry) => entry.title === "Review the observed item gap without purchasing");
    assert.ok(persistedPurchase.resourceNeedIds.includes(persistedPurchase.procurementPlan.targetNeedId));
    assert.deepEqual(persistedPurchase.resourceNeedIds, [persistedPurchase.procurementPlan.targetNeedId, persistedPurchase.procurementPlan.budgetNeedId], "only the separately selected gold need is linked; the spending ceiling is not persisted as demand");
    assert.equal(persistedPurchase.procurementPlan.spendingCeilingCopper, 100);
    assert.deepEqual(persistedPurchase.procurementPlan.playerQuote, { amountCopper: 80, quantity: 5, recordedAt: persistedPurchase.procurementPlan.playerQuote.recordedAt, sourceNote: "Town vendor checked by player" });
    assert.equal(persistedProject.needs.find((entry) => entry.stableId === persistedPurchase.procurementPlan.targetNeedId).destinationIdentityKey, persistedPurchase.assignedIdentityKey);
    await purchaseOrder.getByRole("button", { name: "Edit plan" }).click();
    const editPurchaseForm = projectCard.locator("form.erp-inline-form").last();
    const alternateTargetOptions = await editPurchaseForm.getByLabel("Item target need").locator("option").allTextContents();
    await editPurchaseForm.getByLabel("Item target need").selectOption({ label: alternateTargetOptions.find((label) => label.includes("Alternate purchase target")) });
    await editPurchaseForm.getByRole("button", { name: "Save work-order plan" }).click();
    persistedProject = await page.evaluate(async () => (await (await fetch("/api/versions/retail/erp/projects")).json()).projects.find((entry) => entry.title === "Provision the crafter"));
    persistedPurchase = persistedProject.workOrders.find((entry) => entry.title === "Review the observed item gap without purchasing");
    assert.equal(persistedPurchase.procurementPlan.targetNeedId, persistedProject.needs.find((entry) => entry.label === "Alternate purchase target").stableId);
    assert.deepEqual(persistedPurchase.resourceNeedIds, [persistedPurchase.procurementPlan.targetNeedId, persistedPurchase.procurementPlan.budgetNeedId], "editing replaces procurement auto-links instead of retaining the old item target");
    assert.equal(persistedPurchase.procurementPlan.playerQuote, undefined, "a quote for a prior item target must not carry over to a replacement target");
    assert.deepEqual(pageErrors, [], "project workflow reports no uncaught browser errors");
    assert.deepEqual(pageErrors, [], "project workflow reports no uncaught browser errors");
  } finally {
    if (browser) await browser.close();
    if (server) await new Promise((resolve) => server.close(() => resolve()));
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("[SYNTHETIC BROWSER ACCEPTANCE] assigned gatherer progress shows only fresh, complete bag deltas and keeps cause unknown", async () => {
  assert.ok(existsSync(path.join(webDist, "index.html")), "build the web UI before browser acceptance");
  const directory = mkdtempSync(path.join(os.tmpdir(), "wowsync-erp-gather-browser-"));
  let store;
  let server;
  let browser;
  try {
    store = new SqliteSnapshotStore(path.join(directory, "browser.sqlite"));
    const now = Math.floor(Date.now() / 1000);
    const earlier = store.importSnapshot(renderExport({ name: "Gatherer", realm: "Realm A", generated: now - 100, bags: observedSection([row(159, 1, { name: "Rough Stone" })], now - 100), bank: observedSection([], now - 100) }));
    store.importSnapshot(renderExport({ name: "Gatherer", realm: "Realm A", generated: now, bags: observedSection([row(159, 4, { name: "Rough Stone" })], now), bank: observedSection([], now) }));
    store.createErpProject({ version: "retail", title: "Gather review", needs: [{ stableId: "stone", kind: "ITEM_ID", resourceKey: "159", label: "Rough Stone", requiredQuantity: 5, sourceIdentityKey: earlier.character.identityKey, destinationIdentityKey: earlier.character.identityKey }], workOrders: [{ stableId: "gather", kind: "GATHER", status: "IN_PROGRESS", title: "Gather one more", assignedIdentityKey: earlier.character.identityKey, resourceNeedIds: ["stone"], dependsOn: [] }] });
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
    const changedNeeds = page.locator(".erp-observation-change-queue");
    const changeText = await changedNeeds.innerText();
    assert.match(changeText, /Rough Stone/);
    assert.match(changeText, /bags: 1 .* 4 \(\+3\)/);
    assert.match(changeText, /cause remains unknown/);
    await changedNeeds.getByRole("button", { name: "Review Rough Stone in Gather review" }).click();
    const focusedNeedId = await page.evaluate(() => document.activeElement?.id);
    assert.ok(focusedNeedId?.startsWith("erp-need-project_") && focusedNeedId.endsWith("-stone"), `focused exact requirement: ${focusedNeedId}`);
    const workOrder = page.locator(".erp-work-order-list li").filter({ hasText: "Gather one more" });
    await workOrder.waitFor();
    await workOrder.getByText("Compare assigned gatherer bag observations (cause unknown)").click();
    const review = await workOrder.innerText();
    assert.match(review, /RESOURCE INCREASED/);
    assert.match(review, /bags: 1 .* 4 \(\+3\)/);
    assert.match(review, /does not establish gathering as the cause/);
    assert.match(review, /does not complete the work order/);
    assert.doesNotMatch(review, /GATHER.*COMPLETED/);
    assert.deepEqual(pageErrors, []);
  } finally {
    if (browser) await browser.close();
    if (server) await new Promise((resolve) => server.close(() => resolve()));
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("[SYNTHETIC BROWSER ACCEPTANCE] confirmed same-character shortfall prefills manual gather and purchase plans", async () => {
  assert.ok(existsSync(path.join(webDist, "index.html")), "build the web UI before browser acceptance");
  const directory = mkdtempSync(path.join(os.tmpdir(), "wowsync-erp-supply-step-browser-"));
  let store;
  let server;
  let browser;
  try {
    store = new SqliteSnapshotStore(path.join(directory, "browser.sqlite"));
    const now = Math.floor(Date.now() / 1000);
    const text = renderExport({ name: "Provisioner", realm: "Realm A", generated: now, bags: observedSection([row(159, 1, { name: "Rough Stone" })], now), bank: observedSection([], now) }).replace("MoneyCopper: ?", "MoneyCopper: 10000");
    const imported = store.importSnapshot(text);
    store.createErpProject({ version: "retail", title: "Supply the repair", needs: [
      { stableId: "stone", kind: "ITEM_ID", resourceKey: "159", label: "Rough Stone", requiredQuantity: 5, sourceIdentityKey: imported.character.identityKey, destinationIdentityKey: imported.character.identityKey },
      { stableId: "budget", kind: "GOLD_COPPER", resourceKey: "copper", label: "Purchase budget", requiredQuantity: 3000, sourceIdentityKey: imported.character.identityKey, destinationIdentityKey: imported.character.identityKey },
    ], reservations: [{ stableId: "budget-reservation", needId: "budget", sourceIdentityKey: imported.character.identityKey, quantity: 1000, status: "ACTIVE", createdAt: now, updatedAt: now }], workOrders: [] });
    const other = store.importSnapshot(renderExport({ name: "Other Recipient", realm: "Realm B", generated: now, bags: observedSection([], now), bank: observedSection([], now) }));
    store.createErpProject({ version: "retail", title: "Do not shortcut ambiguous plans", needs: [
      { stableId: "reserved", kind: "ITEM_ID", resourceKey: "300", label: "Reserved Stone", requiredQuantity: 5, sourceIdentityKey: imported.character.identityKey, destinationIdentityKey: imported.character.identityKey },
      { stableId: "other-recipient", kind: "ITEM_ID", resourceKey: "159", label: "Stone for another character", requiredQuantity: 5, sourceIdentityKey: imported.character.identityKey, destinationIdentityKey: other.character.identityKey },
    ], reservations: [{ stableId: "hold", needId: "reserved", sourceIdentityKey: imported.character.identityKey, quantity: 2, status: "ACTIVE", createdAt: now, updatedAt: now }], workOrders: [] });
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
    const projectCard = page.locator(".erp-project-card").filter({ hasText: "Supply the repair" });
    await projectCard.waitFor();
    const need = projectCard.locator(".erp-need-list li").filter({ hasText: "Rough Stone" });
    await need.getByRole("button", { name: "Plan manual gather step" }).click();
    await projectCard.getByRole("button", { name: "Hide forms" }).click();
    await projectCard.getByRole("button", { name: "Add requirement / work order" }).click();
    assert.equal(await projectCard.getByRole("heading", { name: "Add a resource requirement" }).count(), 1, "reopening forms clears a stale prefilled-step mode");
    const reopenedOrderForm = projectCard.locator("form.erp-inline-form").last();
    assert.equal(await reopenedOrderForm.getByLabel("Action type").inputValue(), "INVESTIGATE");
    assert.equal(await reopenedOrderForm.getByRole("textbox", { name: "Action", exact: true }).inputValue(), "");
    assert.equal(await reopenedOrderForm.getByLabel("Assigned character").inputValue(), "");
    assert.deepEqual(await reopenedOrderForm.getByLabel("Linked resource needs").evaluate((element) => Array.from(element.selectedOptions, (option) => option.value)), []);
    await need.getByRole("button", { name: "Plan manual gather step" }).click();
    let orderForm = projectCard.locator("form.erp-inline-form");
    assert.equal(await orderForm.getByLabel("Action type").inputValue(), "GATHER");
    assert.equal(await orderForm.getByLabel("Assigned character").inputValue(), imported.character.identityKey);
    assert.deepEqual(await orderForm.getByLabel("Linked resource needs").evaluate((element) => Array.from(element.selectedOptions, (option) => option.value)), ["stone"]);
    assert.match(await orderForm.getByLabel("Manual instructions").inputValue(), /does not establish a gathering route/);
    await orderForm.getByRole("button", { name: "Add work order" }).click();
    const gatherOrder = projectCard.locator(".erp-work-order-list li").filter({ hasText: "Gather: Rough Stone" });
    await gatherOrder.waitFor();
    assert.match(await gatherOrder.innerText(), /Manual supply step can address an observed gap/);
    assert.match(await gatherOrder.innerText(), /does not establish a gathering route/);

    await need.getByRole("button", { name: "Plan manual purchase step" }).click();
    orderForm = projectCard.locator("form.erp-inline-form").last();
    assert.equal(await orderForm.getByLabel("Action type").inputValue(), "PURCHASE");
    assert.equal(await orderForm.getByLabel("Assigned character").inputValue(), imported.character.identityKey);
    assert.equal(await orderForm.getByLabel("Item target need").inputValue(), "stone");
    await orderForm.getByLabel("Explicit gold budget need (optional)").selectOption("budget");
    await orderForm.getByLabel("Spending ceiling (copper)").fill("5000");
    await orderForm.getByRole("button", { name: "Cancel prefilled step" }).click();
    await projectCard.getByRole("button", { name: "Add requirement / work order" }).click();
    const cancelledOrderForm = projectCard.locator("form.erp-inline-form").last();
    assert.equal(await cancelledOrderForm.getByLabel("Action type").inputValue(), "INVESTIGATE");
    assert.equal(await cancelledOrderForm.getByRole("textbox", { name: "Action", exact: true }).inputValue(), "");
    assert.equal(await cancelledOrderForm.getByLabel("Assigned character").inputValue(), "");
    await need.getByRole("button", { name: "Plan manual purchase step" }).click();
    orderForm = projectCard.locator("form.erp-inline-form").last();
    assert.equal(await orderForm.getByLabel("Explicit gold budget need (optional)").inputValue(), "");
    await orderForm.getByLabel("Explicit gold budget need (optional)").selectOption("budget");
    await orderForm.getByLabel("Spending ceiling (copper)").fill("5000");
    assert.match(await orderForm.innerText(), /market\/vendor availability, current price, routes, unreserved spending power, and affordability remain UNKNOWN/i);
    await orderForm.getByRole("button", { name: "Add work order" }).click();
    const purchaseOrder = projectCard.locator(".erp-work-order-list li").filter({ hasText: "Purchase: Rough Stone" });
    await purchaseOrder.waitFor();
    assert.match(await purchaseOrder.innerText(), /Manual supply step can address an observed gap/);
    assert.match(await purchaseOrder.innerText(), /Manage in review queue/);
    assert.match(await purchaseOrder.innerText(), /Explicit planned gold budget/);
    assert.match(await purchaseOrder.innerText(), /PLANNED NEED BELOW CEILING/);
    assert.match(await purchaseOrder.innerText(), /1000 copper reserved/);
    assert.match(await purchaseOrder.innerText(), /10000 copper observed/);
    assert.match(await purchaseOrder.innerText(), /not proof of reserved or spendable funds/);
    assert.doesNotMatch(await purchaseOrder.innerText(), /purchase completed/i);
    assert.match(await need.innerText(), /An active GATHER step is already linked/);
    assert.match(await need.innerText(), /An active PURCHASE step is already linked/);
    const unsafeProject = page.locator(".erp-project-card").filter({ hasText: "Do not shortcut ambiguous plans" });
    const overReservedNeed = unsafeProject.locator(".erp-need-list li").filter({ hasText: "Reserved Stone" });
    const differentRecipientNeed = unsafeProject.locator(".erp-need-list li").filter({ hasText: "Stone for another character" });
    assert.equal(await overReservedNeed.getByRole("button", { name: "Plan manual gather step" }).count(), 0, "over-reserved supply requires allocation review before creating a manual step");
    assert.equal(await overReservedNeed.getByRole("button", { name: "Plan manual purchase step" }).count(), 0);
    assert.equal(await differentRecipientNeed.getByRole("button", { name: "Plan manual gather step" }).count(), 0, "a different intended recipient is not assigned the source character as gatherer");
    assert.equal(await differentRecipientNeed.getByRole("button", { name: "Plan manual purchase step" }).count(), 0, "procurement quick-start is restricted to a same-character target");
    assert.deepEqual(pageErrors, []);
  } finally {
    if (browser) await browser.close();
    if (server) await new Promise((resolve) => server.close(() => resolve()));
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("[SYNTHETIC BROWSER ACCEPTANCE] retrieval review shows paired personal bank and bag evidence without declaring the work complete", async () => {
  assert.ok(existsSync(path.join(webDist, "index.html")), "build the web UI before browser acceptance");
  const directory = mkdtempSync(path.join(os.tmpdir(), "wowsync-erp-retrieval-browser-"));
  let store;
  let server;
  let browser;
  try {
    store = new SqliteSnapshotStore(path.join(directory, "browser.sqlite"));
    const now = Math.floor(Date.now() / 1000);
    const snapshot = (bags, bank, generated) => renderExport({ name: "Retrieval Fixture", realm: "Cairne", generated, bags: observedSection(bags ? [row(ITEM_ID, bags, { name: "Mycobloom" })] : [], generated), bank: observedSection(bank ? [row(ITEM_ID, bank, { name: "Mycobloom" })] : [], generated), guild: guildSection("gclub-retrieval-fixture", [], generated) });
    store.importSnapshot(snapshot(0, 3, now - 100));
    const character = store.listCharacters("retail").find((entry) => entry.name === "Retrieval Fixture");
    assert.ok(character);
    store.importSnapshot(snapshot(1, 2, now));
    const ownerItem = row(ITEM_ID, 1, { name: "Mycobloom" });
    const ownerCapture = (name, generated, quantity) => renderExport({ name, realm: "Cairne", generated, warband: warbandSection("OBSERVED", quantity ? [row(ITEM_ID, quantity, { name: "Mycobloom", ref: ownerItem.itemRef })] : [], generated), guild: guildSection("gclub-retrieval-fixture", [], generated) });
    store.importSnapshot(ownerCapture("Warband Carrier One", now - 2, 4));
    store.importSnapshot(ownerCapture("Warband Carrier Two", now - 1, 2));
    store.createErpProject({ version: "retail", title: "Review personal bank retrieval", needs: [{ stableId: "retrieval_item", kind: "ITEM_ID", resourceKey: String(ITEM_ID), label: "Mycobloom", requiredQuantity: 1, sourceIdentityKey: character.identityKey, destinationIdentityKey: character.identityKey }], workOrders: [{ stableId: "retrieve_step", kind: "RETRIEVE", status: "PLANNED", title: "Check personal storage observations", resourceNeedIds: ["retrieval_item"], dependsOn: [], assignedIdentityKey: character.identityKey, sourceIdentityKey: character.identityKey, destinationIdentityKey: character.identityKey }] });
    store.createErpProject({ version: "retail", title: "Review shared Warband retrieval", needs: [{ stableId: "shared_retrieval_item", kind: "ITEM_REF", resourceKey: ownerItem.itemRef, label: "Mycobloom", requiredQuantity: 1, sourceOwnerKey: "retail::warband::local", destinationIdentityKey: character.identityKey }], workOrders: [{ stableId: "shared_retrieve_step", kind: "RETRIEVE", status: "PLANNED", title: "Review shared owner observations", resourceNeedIds: ["shared_retrieval_item"], dependsOn: [], assignedIdentityKey: character.identityKey, destinationIdentityKey: character.identityKey }] });
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
    const projectCard = page.locator(".erp-project-card").filter({ hasText: "Review personal bank retrieval" });
    await projectCard.waitFor();
    const workOrder = projectCard.locator(".erp-work-order-list li").filter({ hasText: "Check personal storage observations" });
    await workOrder.getByText("Compare planned personal or shared-storage retrieval observations (cause unknown)").click();
    const review = await workOrder.innerText();
    assert.match(review, /BAGS AND BANK CHANGED/);
    assert.match(review, /bags: 0 to 1 \(\+1\)/);
    assert.match(review, /character bank: 3 to 2 \(-1\)/);
    assert.match(review, /The changes do not establish a retrieval, access, ownership, or cause/);
    assert.match(review, /RETRIEVE · PLANNED/);
    assert.doesNotMatch(review, /RETRIEVE.*COMPLETED/);
    const sharedProjectCard = page.locator(".erp-project-card").filter({ hasText: "Review shared Warband retrieval" });
    const sharedWorkOrder = sharedProjectCard.locator(".erp-work-order-list li").filter({ hasText: "Review shared owner observations" });
    await sharedWorkOrder.getByText("Compare planned personal or shared-storage retrieval observations (cause unknown)").click();
    const sharedReview = await sharedWorkOrder.innerText();
    assert.match(sharedReview, /SHARED OWNER CONTENT CHANGED/);
    assert.match(sharedReview, /warband-installation-local \(retail::warband::local\)/);
    assert.match(sharedReview, /retail::warband::local\) - Retail Warband \(installation-local\)/);
    assert.match(sharedReview, /shared storage: 4 to 2 \(-2\)/);
    assert.match(sharedReview, /do not establish ownership, access, recipient, or cause/);
    assert.deepEqual(pageErrors, []);
  } finally {
    if (browser) await browser.close();
    if (server) await new Promise((resolve) => server.close(() => resolve()));
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("[SYNTHETIC BROWSER ACCEPTANCE] plan a same-character personal-bank retrieval only from fresh complete section evidence", async () => {
  assert.ok(existsSync(path.join(webDist, "index.html")), "build the web UI before browser acceptance");
  const directory = mkdtempSync(path.join(os.tmpdir(), "wowsync-erp-personal-bank-plan-"));
  let store; let server; let browser;
  try {
    store = new SqliteSnapshotStore(path.join(directory, "browser.sqlite"));
    const now = Math.floor(Date.now() / 1000);
    const capture = (name, realm, generated, bags, bank) => renderExport({ name, realm, generated, bags: observedSection(bags ? [row(ITEM_ID, bags, { name: "Mycobloom" })] : [], generated), bank: observedSection(bank ? [row(ITEM_ID, bank, { name: "Mycobloom" })] : [], generated), guild: guildSection(`gclub-${name.toLowerCase().replaceAll(" ", "-")}`, [], generated) });
    const freshIdentity = store.importSnapshot(capture("Bank Planner", "Cairne", now, 1, 3)).character.identityKey;
    const staleIdentity = store.importSnapshot(capture("Stale Planner", "Cairne", now - 14 * 86400, 1, 3)).character.identityKey;
    const reservedIdentity = store.importSnapshot(capture("Reserved Planner", "Cairne", now, 1, 3)).character.identityKey;
    const ownIdentity = store.importSnapshot(capture("Own Reserved Planner", "Cairne", now, 1, 3)).character.identityKey;
    const unknownBankIdentity = store.importSnapshot(renderExport({ name: "Unknown Bank Planner", realm: "Cairne", generated: now, bags: observedSection([row(ITEM_ID, 1, { name: "Mycobloom" })], now), guild: guildSection("gclub-unknown-bank-planner", [], now) })).character.identityKey;
    const historicalBank = observedSection([row(ITEM_ID, 2, { name: "Mycobloom" })], now - 10 * 86400);
    historicalBank.status.state = "LAST_SEEN";
    const lastSeenIdentity = store.importSnapshot(renderExport({ name: "Historical Bank Planner", realm: "Cairne", generated: now, bags: observedSection([row(ITEM_ID, 1, { name: "Mycobloom" })], now), bank: historicalBank, guild: guildSection("gclub-historical-bank-planner", [], now) })).character.identityKey;
    store.createErpProject({ version: "retail", title: "Review fresh bank supply", needs: [{ stableId: "fresh_bank_need", kind: "ITEM_REF", resourceKey: row(ITEM_ID, 1).itemRef, label: "Mycobloom", requiredQuantity: 4, sourceIdentityKey: freshIdentity, destinationIdentityKey: freshIdentity }] });
    store.createErpProject({ version: "retail", title: "Review base-id bank supply", needs: [{ stableId: "base_id_bank_need", kind: "ITEM_ID", resourceKey: String(ITEM_ID), label: "Mycobloom base ID", requiredQuantity: 4, sourceIdentityKey: freshIdentity, destinationIdentityKey: freshIdentity }] });
    store.createErpProject({ version: "retail", title: "Review own-reserved bank supply", needs: [{ stableId: "own_reserved_bank_need", kind: "ITEM_REF", resourceKey: row(ITEM_ID, 1).itemRef, label: "Mycobloom", requiredQuantity: 4, sourceIdentityKey: ownIdentity, destinationIdentityKey: ownIdentity }], reservations: [{ stableId: "own_need_reservation", needId: "own_reserved_bank_need", sourceIdentityKey: ownIdentity, quantity: 4, status: "ACTIVE", createdAt: now, updatedAt: now }] });
    store.createErpProject({ version: "retail", title: "Review unknown bank supply", needs: [{ stableId: "unknown_bank_need", kind: "ITEM_REF", resourceKey: row(ITEM_ID, 1).itemRef, label: "Mycobloom", requiredQuantity: 4, sourceIdentityKey: unknownBankIdentity, destinationIdentityKey: unknownBankIdentity }] });
    store.createErpProject({ version: "retail", title: "Review historical bank supply", needs: [{ stableId: "historical_bank_need", kind: "ITEM_REF", resourceKey: row(ITEM_ID, 1).itemRef, label: "Mycobloom", requiredQuantity: 4, sourceIdentityKey: lastSeenIdentity, destinationIdentityKey: lastSeenIdentity }] });
    store.createErpProject({ version: "retail", title: "Review stale bank supply", needs: [{ stableId: "stale_bank_need", kind: "ITEM_REF", resourceKey: row(ITEM_ID, 1).itemRef, label: "Mycobloom", requiredQuantity: 4, sourceIdentityKey: staleIdentity, destinationIdentityKey: staleIdentity }] });
    store.createErpProject({ version: "retail", title: "Competing reservation", needs: [{ stableId: "reserved_elsewhere", kind: "ITEM_REF", resourceKey: row(ITEM_ID, 1).itemRef, label: "Mycobloom", requiredQuantity: 2, sourceIdentityKey: reservedIdentity }], reservations: [{ stableId: "hold_reserved_supply", needId: "reserved_elsewhere", sourceIdentityKey: reservedIdentity, quantity: 2, status: "ACTIVE", createdAt: now, updatedAt: now }] });
    store.createErpProject({ version: "retail", title: "Review reserved bank supply", needs: [{ stableId: "reserved_bank_need", kind: "ITEM_REF", resourceKey: row(ITEM_ID, 1).itemRef, label: "Mycobloom", requiredQuantity: 4, sourceIdentityKey: reservedIdentity, destinationIdentityKey: reservedIdentity }] });
    server = await listenOnce(createApp(store, 0, webDist, { allowedHosts: LOOPBACK_HOSTNAMES }), "127.0.0.1", 0);
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const executablePath = process.env.WOWSYNC_CHROMIUM_PATH ?? (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);
    browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
    const page = await browser.newPage(); page.setDefaultTimeout(5_000);
    const errors = []; page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${address.port}/#/retail/overview`);
    await page.getByRole("button", { name: "Projects & Work Orders" }).click();
    const fresh = page.locator(".erp-project-card").filter({ hasText: "Review fresh bank supply" }); await fresh.waitFor();
    const need = fresh.locator(".erp-need-list li").filter({ hasText: "Mycobloom" });
    const locationEvidence = await need.innerText();
    assert.match(locationEvidence, /bags: OBSERVED .*1 matching unit/);
    assert.match(locationEvidence, /character bank: OBSERVED .*3 matching units/);
    const unknownBank = page.locator(".erp-project-card").filter({ hasText: "Review unknown bank supply" }); await unknownBank.waitFor();
    const unknownBankNeed = await unknownBank.locator(".erp-need-list li").first().innerText();
    assert.match(unknownBankNeed, /character bank: UNKNOWN .*contents UNKNOWN/);
    assert.doesNotMatch(unknownBankNeed, /character bank: UNKNOWN .*0 matching units/);
    assert.equal(await unknownBank.getByRole("button", { name: "Plan manual personal-bank retrieval review" }).count(), 0);
    const historical = page.locator(".erp-project-card").filter({ hasText: "Review historical bank supply" }); await historical.waitFor();
    const historicalText = await historical.locator(".erp-need-list li").first().innerText();
    assert.match(historicalText, /character bank: LAST_SEEN .*2 matching units LAST_SEEN/);
    assert.equal(await historical.getByRole("button", { name: "Plan manual personal-bank retrieval review" }).count(), 0, "historical bank contents are displayed separately but do not create a current retrieval draft");
    await fresh.getByRole("button", { name: "Plan manual personal-bank retrieval review" }).click();
    const form = fresh.locator("form.erp-inline-form");
    await form.getByRole("textbox", { name: "Action" }).waitFor();
    await form.getByLabel("Manual instructions").waitFor();
    const instructions = await form.getByLabel("Manual instructions").inputValue();
    assert.match(instructions, /Recent complete OBSERVED sections show 1 matching unit in Bank Planner.* bags and 3 in that character's personal bank/);
    assert.match(instructions, /bag requirement is short by 3; the bank observation contains 3 exact units to consider/);
    assert.match(instructions, /planning comparison, not proof of current access, bank interaction, or retrieval/);
    assert.equal(await form.getByLabel("Assigned character").inputValue(), freshIdentity);
    assert.equal(await form.getByLabel("Planned source character").inputValue(), freshIdentity);
    assert.equal(await form.getByLabel("Intended destination character").inputValue(), freshIdentity);
    await form.getByRole("button", { name: "Add work order" }).click();
    const planned = fresh.locator(".erp-work-order-list li").filter({ hasText: "Review personal-bank retrieval: Mycobloom" });
    await planned.waitFor();
    assert.match(await planned.innerText(), /RETRIEVE · PLANNED/);
    assert.match(await planned.innerText(), /No action is executed/);
    await fresh.getByText("An active personal-bank RETRIEVE review is already linked to this character and need.").waitFor();
    const stale = page.locator(".erp-project-card").filter({ hasText: "Review stale bank supply" }); await stale.waitFor();
    assert.equal(await stale.getByRole("button", { name: "Plan manual personal-bank retrieval review" }).count(), 0, "stale snapshots do not create retrieval plans");
    const baseId = page.locator(".erp-project-card").filter({ hasText: "Review base-id bank supply" }); await baseId.waitFor();
    assert.equal(await baseId.getByRole("button", { name: "Plan manual personal-bank retrieval review" }).count(), 0, "base-ID needs do not collapse exact item variants for retrieval planning");
    const reserved = page.locator(".erp-project-card").filter({ hasText: "Review reserved bank supply" }); await reserved.waitFor();
    assert.equal(await reserved.getByRole("button", { name: "Plan manual personal-bank retrieval review" }).count(), 0, "competing reservations do not imply that the full bank quantity is available to this project");
    const ownReserved = page.locator(".erp-project-card").filter({ hasText: "Review own-reserved bank supply" }); await ownReserved.waitFor();
    assert.equal(await ownReserved.getByRole("button", { name: "Plan manual personal-bank retrieval review" }).count(), 1, "an exact reservation for this need does not block its own manual review");
    const record = await page.evaluate(async () => { const projects = (await (await fetch("/api/versions/retail/erp/projects")).json()).projects; const project = projects.find((entry) => entry.title === "Review fresh bank supply"); return project.workOrders.find((entry) => entry.kind === "RETRIEVE"); });
    assert.equal(record.status, "PLANNED");
    assert.equal(record.sourceIdentityKey, freshIdentity);
    assert.equal(record.destinationIdentityKey, freshIdentity);
    assert.equal(record.assignedIdentityKey, freshIdentity);
    assert.match(record.instructions, /not proof of current access/);
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    if (server) await new Promise((resolve) => server.close(() => resolve()));
    store?.close(); rmSync(directory, { recursive: true, force: true });
  }
});

test("[SYNTHETIC BROWSER ACCEPTANCE] stale observed stock cannot enable a new resource reservation", async () => {
  assert.ok(existsSync(path.join(webDist, "index.html")), "build the web UI before browser acceptance");
  const directory = mkdtempSync(path.join(os.tmpdir(), "wowsync-erp-stale-reservation-browser-"));
  let store;
  let server;
  let browser;
  try {
    store = new SqliteSnapshotStore(path.join(directory, "browser.sqlite"));
    const now = Math.floor(Date.now() / 1000);
    const staleAt = now - 5 * 86400;
    const item = row(ITEM_ID, 7, { name: "Stale Mycobloom" });
    const imported = store.importSnapshot(renderExport({
      name: "Stale Reservation Holder", realm: "Stale Realm", generated: staleAt,
      bags: observedSection([item], staleAt), bank: observedSection([], staleAt),
      guild: guildSection("gclub-stale-reservation-holder", [], staleAt),
    }));
    store.createErpProject({
      stableId: "stale_reservation_project", version: "retail", title: "Review stale supply", status: "ACTIVE", priority: 3,
      createdAt: staleAt, updatedAt: staleAt, revision: 1, reservations: [], workOrders: [],
      needs: [{ stableId: "stale_item_need", kind: "ITEM_REF", resourceKey: item.itemRef, label: "Stale Mycobloom", requiredQuantity: 1, sourceIdentityKey: imported.character.identityKey }],
    });
    server = await listenOnce(createApp(store, 0, webDist, { allowedHosts: LOOPBACK_HOSTNAMES }), "127.0.0.1", 0);
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const executablePath = process.env.WOWSYNC_CHROMIUM_PATH ?? (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);
    browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
    const page = await browser.newPage();
    page.setDefaultTimeout(5_000);
    await page.goto(`http://127.0.0.1:${address.port}/#/retail/overview`);
    await page.getByRole("button", { name: "Projects & Work Orders" }).click();
    const need = page.locator(".erp-need-list li").filter({ hasText: "Stale Mycobloom" });
    await need.getByText(/stale freshness/).waitFor();
    assert.equal(await need.getByRole("button", { name: "Reserve" }).isDisabled(), true,
      "observed history can remain visible without authorizing a reservation from stale supply");
  } finally {
    if (browser) await browser.close();
    if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (store) store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("[SYNTHETIC BROWSER ACCEPTANCE] group multiple assessed requirements into one linked fulfillment review", async () => {
  assert.ok(existsSync(path.join(webDist, "index.html")), "build the web UI before browser acceptance");
  const directory = mkdtempSync(path.join(os.tmpdir(), "wowsync-erp-multi-need-review-browser-"));
  let store;
  let server;
  let browser;
  try {
    store = new SqliteSnapshotStore(path.join(directory, "browser.sqlite"));
    const now = Math.floor(Date.now() / 1000);
    const imported = store.importSnapshot(renderExport({ name: "Workshop Planner", realm: "Cairne", generated: now, bags: observedSection([row(159, 1, { name: "Rough Stone" })], now), bank: observedSection([], now) }));
    const character = imported.character.identityKey;
    const created = store.createErpProject({ version: "retail", title: "Prepare a multi-input repair", needs: [
      { stableId: "stone", kind: "ITEM_ID", resourceKey: "159", label: "Rough Stone", requiredQuantity: 4, sourceIdentityKey: character, destinationIdentityKey: character },
      { stableId: "herb", kind: "ITEM_REF", resourceKey: "item:2447:0:0:0:0:0:0:0", label: "Peacebloom", requiredQuantity: 2 },
    ] });
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
    const project = page.locator(".erp-project-card").filter({ hasText: "Prepare a multi-input repair" });
    await project.getByRole("button", { name: "Create one grouped investigation" }).click();
    const planner = project.getByRole("region", { name: "Multi-need fulfillment planner for Prepare a multi-input repair" });
    const stone = planner.locator(".erp-batch-need").filter({ hasText: "Rough Stone" });
    const herb = planner.locator(".erp-batch-need").filter({ hasText: "Peacebloom" });
    assert.match(await stone.innerText(), /SHORTFALL OBSERVED.*recent freshness/);
    assert.match(await herb.innerText(), /UNKNOWN.*unknown freshness/);
    await stone.locator("input").check();
    await herb.locator("input").check();
    await planner.locator('select[aria-label="Assigned reviewer for grouped fulfillment review"]').selectOption(character);
    await planner.getByRole("button", { name: "Create review for 2 needs" }).click();
    const review = project.locator(".erp-work-order-list li").filter({ hasText: "Review fulfillment for 2 requirements" });
    await review.waitFor();
    const reviewText = await review.innerText();
    assert.match(reviewText, /Rough Stone.*SHORTFALL_OBSERVED\/recent, evidence timestamp .*; 1 observed/);
    assert.match(reviewText, /Peacebloom.*UNKNOWN\/unknown, evidence time UNKNOWN; observed quantity UNKNOWN/);
    assert.match(reviewText, /does not reserve or move resources/);
    const listed = await page.evaluate(async () => (await (await fetch("/api/versions/retail/erp/projects")).json()).projects.find((entry) => entry.title === "Prepare a multi-input repair"));
    const workOrder = listed.workOrders.find((entry) => entry.title === "Review fulfillment for 2 requirements");
    assert.equal(workOrder.kind, "INVESTIGATE");
    assert.deepEqual(workOrder.resourceNeedIds, ["stone", "herb"]);
    const readiness = listed.workOrderReadiness.find((entry) => entry.workOrderId === workOrder.stableId);
    assert.deepEqual(readiness.linkedNeeds.map((entry) => [entry.needId, entry.state]), [["stone", "SHORTFALL_OBSERVED"], ["herb", "UNKNOWN"]]);
    const context = await page.evaluate(async () => (await (await fetch("/api/account-context")).json()));
    const accountProject = context.planning.projects.find((entry) => entry.stableId === listed.stableId);
    assert.deepEqual(accountProject.workOrderCounts, { PLANNED: 1 }, "AccountContext sees the same saved manual plan");
    assert.deepEqual(accountProject.workOrderReadinessStates, { [readiness.state]: 1 }, "AccountContext reflects the exact readiness assessment returned by REST");
    assert.equal(accountProject.fulfillment.state, listed.fulfillment.state, "AccountContext and REST share the same project fulfillment state");
    assert.equal((await project.locator(".erp-fulfillment-snapshot").innerText()).match(/1 open manual work orders/) !== null, true);
    assert.deepEqual(pageErrors, []);
    assert.ok(created.stableId);
  } finally {
    if (browser) await browser.close();
    if (server) await new Promise((resolve) => server.close(() => resolve()));
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("[SYNTHETIC BROWSER ACCEPTANCE] compose different manual work types and dependencies for multiple needs in one project update", async () => {
  assert.ok(existsSync(path.join(webDist, "index.html")), "build the web UI before browser acceptance");
  const directory = mkdtempSync(path.join(os.tmpdir(), "wowsync-erp-multi-work-order-browser-"));
  let store;
  let server;
  let browser;
  try {
    store = new SqliteSnapshotStore(path.join(directory, "browser.sqlite"));
    const now = Math.floor(Date.now() / 1000);
    const imported = store.importSnapshot(renderExport({ name: "Project Planner", realm: "Cairne", generated: now, bags: observedSection([row(159, 1, { name: "Rough Stone" })], now), bank: observedSection([], now) }));
    const character = imported.character.identityKey;
    const created = store.createErpProject({ version: "retail", title: "Prepare multi-step provisioning", needs: [
      { stableId: "stone", kind: "ITEM_ID", resourceKey: "159", label: "Rough Stone", requiredQuantity: 3, sourceIdentityKey: character },
      { stableId: "herb", kind: "ITEM_REF", resourceKey: "item:2447:0:0:0:0:0:0:0", label: "Peacebloom", requiredQuantity: 2 },
    ], workOrders: [{ stableId: "inspect", kind: "INVESTIGATE", status: "IN_PROGRESS", title: "Review current project evidence", resourceNeedIds: [], dependsOn: [] }] });
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
    const project = page.locator(".erp-project-card").filter({ hasText: "Prepare multi-step provisioning" });
    await project.getByRole("button", { name: "Compose fulfillment work orders" }).click();
    const composer = project.getByRole("region", { name: "Multi-need work-order composer for Prepare multi-step provisioning" });
    await composer.locator(".erp-batch-need").filter({ hasText: "Rough Stone" }).locator("input").check();
    await composer.locator(".erp-batch-need").filter({ hasText: "Peacebloom" }).locator("input").check();
    const stoneTask = composer.locator(".erp-batch-order-draft").filter({ hasText: "Task for Rough Stone" });
    const herbTask = composer.locator(".erp-batch-order-draft").filter({ hasText: "Task for Peacebloom" });
    await stoneTask.getByLabel("Manual work type").selectOption("GATHER");
    await stoneTask.getByLabel("Assigned character (optional)").selectOption(character);
    await stoneTask.getByLabel("Manual instructions").fill("Check the player's stated gather plan and current game requirements.");
    await herbTask.getByLabel("Manual work type").selectOption("PROVISION");
    await herbTask.getByLabel("Assigned character (optional)").selectOption(character);
    await herbTask.getByLabel("Prerequisites (optional)").selectOption(["inspect", "draft:stone"]);
    await composer.getByRole("button", { name: "Save 2 planned work orders" }).click();

    const saved = await page.evaluate(async () => (await (await fetch("/api/versions/retail/erp/projects")).json()).projects.find((entry) => entry.title === "Prepare multi-step provisioning"));
    const stoneOrder = saved.workOrders.find((order) => order.kind === "GATHER");
    const herbOrder = saved.workOrders.find((order) => order.kind === "PROVISION");
    assert.deepEqual([stoneOrder.status, stoneOrder.resourceNeedIds, stoneOrder.assignedIdentityKey], ["PLANNED", ["stone"], character]);
    assert.deepEqual([herbOrder.status, herbOrder.resourceNeedIds, herbOrder.assignedIdentityKey], ["PLANNED", ["herb"], character]);
    assert.deepEqual(herbOrder.dependsOn, ["inspect", stoneOrder.stableId]);
    assert.match(stoneOrder.instructions, /planning intent only/);
    assert.match(herbOrder.instructions, /Ownership, access, binding, and a valid route remain UNKNOWN/);
    const account = await page.evaluate(async () => (await (await fetch("/api/account-context")).json()));
    const summary = account.planning.projects.find((entry) => entry.stableId === saved.stableId);
    assert.deepEqual(summary.workOrderCounts, { IN_PROGRESS: 1, PLANNED: 2 });
    assert.equal(saved.fulfillment.activeWorkOrderCount, 3);
    assert.deepEqual(pageErrors, []);
    assert.ok(created.stableId);
  } finally {
    if (browser) await browser.close();
    if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("[SYNTHETIC BROWSER ACCEPTANCE] create requirements, compose fulfillment, and read one project through UI, REST, AccountContext, and MCP", async () => {
  assert.ok(existsSync(path.join(webDist, "index.html")), "build the web UI before browser acceptance");
  const directory = mkdtempSync(path.join(os.tmpdir(), "wowsync-erp-full-fulfillment-browser-"));
  const databasePath = path.join(directory, "browser.sqlite");
  let store;
  let server;
  let browser;
  let mcpClient;
  try {
    store = new SqliteSnapshotStore(databasePath);
    const now = Math.floor(Date.now() / 1000);
    const imported = store.importSnapshot(renderExport({ name: "Fulfillment Planner", realm: "Cairne", generated: now, bags: observedSection([row(159, 2, { name: "Unrelated stone" })], now), bank: observedSection([], now) }));
    const character = imported.character.identityKey;
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
    const createForm = page.locator("form.erp-create-form");
    await createForm.getByLabel("Project title").fill("Repair kit for the workshop");
    await createForm.getByLabel("Objective").fill("Record explicit item and recipe needs and plan manual fulfillment.");
    await createForm.getByRole("button", { name: "Create project" }).click();
    const project = page.locator(".erp-project-card").filter({ hasText: "Repair kit for the workshop" });
    await project.waitFor();
    await project.getByRole("button", { name: "Define several requirements" }).click();
    const intake = project.getByRole("region", { name: "Multi-need resource composer for Repair kit for the workshop" });
    const itemNeed = intake.locator(".erp-need-bundle-row").nth(0);
    await itemNeed.getByLabel("Resource kind").selectOption("ITEM_ID");
    await itemNeed.getByLabel("Resource key").fill("987654");
    await itemNeed.getByLabel("Requirement label").fill("Copper Ore for repair");
    await itemNeed.getByLabel("Required quantity").fill("8");
    await itemNeed.getByLabel("Explicit source (optional)").selectOption(character);
    await itemNeed.getByLabel("Intended recipient (optional)").selectOption(character);
    const recipeNeed = intake.locator(".erp-need-bundle-row").nth(1);
    await recipeNeed.getByLabel("Resource kind").selectOption("RECIPE");
    await recipeNeed.getByLabel("Recipe ID").fill("123456");
    await recipeNeed.getByLabel("Requirement label").fill("Repair recipe knowledge");
    await recipeNeed.getByLabel("Intended recipient (optional)").selectOption(character);
    const saveNeeds = intake.getByRole("button", { name: "Save 2 requirements" });
    assert.equal(await saveNeeds.isDisabled(), false, await intake.innerText());
    await saveNeeds.click();
    await project.locator(".erp-need-list").getByText("Repair recipe knowledge").waitFor();

    await project.getByRole("button", { name: "Compose fulfillment work orders" }).click();
    const composer = project.getByRole("region", { name: "Multi-need work-order composer for Repair kit for the workshop" });
    await composer.locator(".erp-batch-need").filter({ hasText: "Copper Ore for repair" }).locator("input").check();
    await composer.locator(".erp-batch-need").filter({ hasText: "Repair recipe knowledge" }).locator("input").check();
    const itemTask = composer.locator(".erp-batch-order-draft").filter({ hasText: "Task for Copper Ore for repair" });
    const recipeTask = composer.locator(".erp-batch-order-draft").filter({ hasText: "Task for Repair recipe knowledge" });
    await itemTask.getByLabel("Manual work type").selectOption("GATHER");
    await itemTask.getByLabel("Assigned character (optional)").selectOption(character);
    await itemTask.getByLabel("Planned source character (optional)").selectOption(character);
    await recipeTask.getByLabel("Manual work type").selectOption("INVESTIGATE");
    await recipeTask.getByLabel("Assigned character (optional)").selectOption(character);
    const firstTaskDependency = await recipeTask.locator('option[value^="draft:"]').getAttribute("value");
    assert.ok(firstTaskDependency);
    await recipeTask.getByLabel("Prerequisites (optional)").selectOption([firstTaskDependency]);
    await composer.getByRole("button", { name: "Save 2 planned work orders" }).click();

    const rest = await page.evaluate(async () => (await (await fetch("/api/versions/retail/erp/projects")).json()).projects.find((entry) => entry.title === "Repair kit for the workshop"));
    assert.deepEqual(rest.needs.map((need) => [need.kind, need.resourceKey, need.label, need.requiredQuantity]), [
      ["ITEM_ID", "987654", "Copper Ore for repair", 8],
      ["RECIPE", "123456", "Repair recipe knowledge", 1],
    ]);
    const gather = rest.workOrders.find((order) => order.kind === "GATHER");
    const investigate = rest.workOrders.find((order) => order.kind === "INVESTIGATE");
    assert.deepEqual([gather.status, gather.resourceNeedIds, gather.sourceIdentityKey, gather.assignedIdentityKey], ["PLANNED", [rest.needs[0].stableId], character, character]);
    assert.deepEqual([investigate.status, investigate.resourceNeedIds, investigate.dependsOn], ["PLANNED", [rest.needs[1].stableId], [gather.stableId]]);
    assert.match(gather.instructions, /does not establish a gathering route/);
    assert.match(investigate.instructions, /SYSTEM EVIDENCE BOUNDARY/);

    const account = await page.evaluate(async () => (await (await fetch("/api/account-context")).json()));
    const accountProject = account.planning.projects.find((entry) => entry.stableId === rest.stableId);
    assert.ok(accountProject);
    assert.deepEqual([accountProject.revision, accountProject.needsCount, accountProject.workOrderCounts, accountProject.fulfillment], [rest.revision, rest.needs.length, { PLANNED: 2 }, rest.fulfillment]);
    const renderedWorkOrders = await project.locator(".erp-work-order-list").innerText();
    assert.match(renderedWorkOrders, /GATHER: Copper Ore for repair[\s\S]*PLANNED/);
    assert.match(renderedWorkOrders, /INVESTIGATE: Repair recipe knowledge[\s\S]*PLANNED/);
    assert.match(renderedWorkOrders, /does not establish a gathering route/);
    const mcpEntrypoint = path.resolve(process.cwd(), "packages/mcp/src/index.ts");
    const mcp = new Client({ name: "wowsync-full-fulfillment-browser", version: "0.1.0" });
    mcpClient = mcp;
    await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [mcpEntrypoint], cwd: process.cwd(), env: { ...process.env, WOWSYNC_MCP_DB_PATH: databasePath }, stderr: "pipe" }));
    const result = await mcp.callTool({ name: "get_erp_projects", arguments: { version: "retail", limit: 20 } });
    assert.equal(result.isError, undefined);
    const mcpProject = result.structuredContent.projects.find((entry) => entry.stableId === rest.stableId);
    assert.deepEqual(mcpProject.needs.map((need) => [need.stableId, need.resourceKey]), rest.needs.map((need) => [need.stableId, need.resourceKey]));
    assert.deepEqual(mcpProject.workOrders.map((order) => [order.stableId, order.kind, order.resourceNeedIds, order.dependsOn]), rest.workOrders.map((order) => [order.stableId, order.kind, order.resourceNeedIds, order.dependsOn]));
    assert.equal(mcpProject.fulfillment.activeWorkOrderCount, rest.fulfillment.activeWorkOrderCount);
    assert.match(await project.innerText(), /Supply unknown|Evidence review required|UNKNOWN/);
    assert.deepEqual(pageErrors, []);
  } finally {
    if (mcpClient) await mcpClient.close();
    if (browser) await browser.close();
    if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("[SYNTHETIC BROWSER ACCEPTANCE] changed observations create a linked, non-causal review plan consistently across UI, REST, AccountContext, and MCP", async () => {
  assert.ok(existsSync(path.join(webDist, "index.html")), "build the web UI before browser acceptance");
  const directory = mkdtempSync(path.join(os.tmpdir(), "wowsync-erp-observation-review-browser-"));
  const databasePath = path.join(directory, "browser.sqlite");
  let store;
  let server;
  let browser;
  let mcpClient;
  try {
    store = new SqliteSnapshotStore(databasePath);
    const now = Math.floor(Date.now() / 1000);
    const before = store.importSnapshot(renderExport({ name: "Observation Review Fixture", realm: "Cairne", generated: now - 120, bags: observedSection([row(ITEM_ID, 5), row(ITEM_ID + 1, 4)], now - 120), bank: observedSection([], now - 120) }));
    store.importSnapshot(renderExport({ name: "Observation Review Fixture", realm: "Cairne", generated: now, bags: observedSection([row(ITEM_ID, 3), row(ITEM_ID + 1, 2)], now), bank: observedSection([], now) }));
    const project = store.createErpProject({ version: "retail", title: "Review changed workshop stock", needs: [
      { stableId: "stone_need", kind: "ITEM_REF", resourceKey: fullRef(ITEM_ID), label: "Mycobloom", requiredQuantity: 6, sourceIdentityKey: before.character.identityKey },
      { stableId: "herb_need", kind: "ITEM_REF", resourceKey: fullRef(ITEM_ID + 1), label: "Briarthorn", requiredQuantity: 5, sourceIdentityKey: before.character.identityKey },
    ] });
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
    const queue = page.getByRole("region", { name: "Changed resource observations" });
    await queue.getByText("Mycobloom").waitFor();
    await queue.getByText("Briarthorn").waitFor();
    assert.match(await queue.innerText(), /bags: 5 → 3 \(-2\)/);
    assert.match(await queue.innerText(), /The cause remains unknown/);
    await queue.getByRole("checkbox", { name: "Include Mycobloom in grouped review" }).check();
    await queue.getByRole("checkbox", { name: "Include Briarthorn in grouped review" }).check();
    await queue.getByRole("button", { name: "Save a planned review for 2 changed needs in Review changed workshop stock" }).click();

    const rest = await page.evaluate(async () => (await (await fetch("/api/versions/retail/erp/projects")).json()).projects.find((entry) => entry.title === "Review changed workshop stock"));
    assert.equal(rest.workOrders.length, 1);
    assert.deepEqual([rest.workOrders[0].kind, rest.workOrders[0].status, rest.workOrders[0].resourceNeedIds], ["INVESTIGATE", "PLANNED", ["stone_need", "herb_need"]]);
    assert.match(rest.workOrders[0].instructions, /saved evidence summary was generated/);
    assert.match(rest.workOrders[0].instructions, /changed sections bags 5→3 \(-2\), previous /);
    assert.match(rest.workOrders[0].instructions, /latest 20[0-9]{2}-[0-9]{2}-[0-9]{2}T/);
    assert.match(rest.workOrders[0].instructions, /does not reserve or move resources/);
    assert.match(rest.workOrders[0].instructions, /does not assert .* action completion/);
    assert.match(rest.workOrders[0].instructions, /does not assert .* action completion/);

    const triage = page.getByTestId("erp-fulfillment-triage");
    const stoneTriage = triage.locator("article").filter({ hasText: "Mycobloom" }).first();
    await stoneTriage.waitFor();
    assert.match(await stoneTriage.innerText(), /Rows with changed observations/);
    assert.match(await stoneTriage.innerText(), /Rows linked to open manual work/);
    assert.match(await stoneTriage.innerText(), /bags 5 → 3 \(-2; latest /);
    assert.match(await stoneTriage.innerText(), /Cause UNKNOWN/);
    const detailLink = stoneTriage.getByRole("link", { name: "Open requirement and planning detail" });
    const detailTarget = await detailLink.getAttribute("href");
    assert.ok(detailTarget);
    assert.equal(await page.locator(`[id="${detailTarget.slice(1)}"]`).count(), 1, "triage links to the exact need detail in the project card");
    await detailLink.click();
    await page.waitForFunction((target) => window.location.hash === target, detailTarget);

    const account = await page.evaluate(async () => (await (await fetch("/api/account-context")).json()));
    const accountProject = account.planning.projects.find((entry) => entry.stableId === project.stableId);
    assert.deepEqual([accountProject.revision, accountProject.workOrderCounts], [2, { PLANNED: 1 }]);
    assert.equal(account.planning.needObservationChangeReviews.retail.changedNeedCount, 2, "change review remains a snapshot summary until comparable evidence changes");
    assert.equal(account.planning.fulfillmentTriage.retail.counts.CHANGED_OBSERVATION, 2);
    assert.equal(account.planning.fulfillmentTriage.retail.counts.OPEN_WORK_ORDER, 2);
    const mcpEntrypoint = path.resolve(process.cwd(), "packages/mcp/src/index.ts");
    const mcp = new Client({ name: "wowsync-observation-review-browser", version: "0.1.0" });
    mcpClient = mcp;
    await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [mcpEntrypoint], cwd: process.cwd(), env: { ...process.env, WOWSYNC_MCP_DB_PATH: databasePath }, stderr: "pipe" }));
    const result = await mcp.callTool({ name: "get_erp_projects", arguments: { version: "retail", limit: 20 } });
    const mcpProject = result.structuredContent.projects.find((entry) => entry.stableId === project.stableId);
    assert.deepEqual(mcpProject.workOrders.map((order) => [order.kind, order.status, order.resourceNeedIds]), rest.workOrders.map((order) => [order.kind, order.status, order.resourceNeedIds]));
    assert.equal(result.structuredContent.observationChanges.totalCount, 2);
    const restTriage = await page.evaluate(async () => (await (await fetch("/api/versions/retail/erp/projects")).json()).fulfillmentTriage);
    assert.deepEqual(result.structuredContent.fulfillmentTriage, restTriage, "MCP and REST share the exact deterministic fulfillment triage projection");
    assert.deepEqual(pageErrors, []);
  } finally {
    if (mcpClient) await mcpClient.close();
    if (browser) await browser.close();
    if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("[SYNTHETIC BROWSER ACCEPTANCE] one stale-safe planning session atomically reserves bounded supply with cross-project manual work", async () => {
  assert.ok(existsSync(path.join(webDist, "index.html")), "build the web UI before browser acceptance");
  const directory = mkdtempSync(path.join(os.tmpdir(), "wowsync-erp-cross-project-plan-"));
  const databasePath = path.join(directory, "browser.sqlite");
  let store; let server; let browser; let mcpClient;
  try {
    store = new SqliteSnapshotStore(databasePath);
    const now = Math.floor(Date.now() / 1000);
    const source = store.importSnapshot(renderExport({ name: "Fulfillment Planner", realm: "Cairne", generated: now, bags: observedSection([row(ITEM_ID, 2, { name: "Mycobloom" }), row(ITEM_ID + 1, 1, { name: "Briarthorn" })], now), bank: observedSection([], now) }));
    const observedLead = store.importSnapshot(renderExport({ name: "Possible Source Lead", realm: "Cairne", generated: now, bags: observedSection([row(ITEM_ID, 7, { name: "Mycobloom" })], now), bank: observedSection([], now) }));
    const first = store.createErpProject({ version: "retail", title: "Provision the crafter", needs: [{ stableId: "mycobloom_need", kind: "ITEM_REF", resourceKey: fullRef(ITEM_ID), label: "Mycobloom", requiredQuantity: 5, sourceIdentityKey: source.character.identityKey, destinationIdentityKey: source.character.identityKey }], reservations: [{ stableId: "existing_hold", needId: "mycobloom_need", sourceIdentityKey: source.character.identityKey, quantity: 1, status: "ACTIVE", createdAt: now, updatedAt: now }] });
    const second = store.createErpProject({ version: "retail", title: "Prepare the second recipe", needs: [{ stableId: "briar_need", kind: "ITEM_REF", resourceKey: fullRef(ITEM_ID + 1), label: "Briarthorn", requiredQuantity: 4, sourceIdentityKey: source.character.identityKey, destinationIdentityKey: source.character.identityKey }] });
    const third = store.createErpProject({ version: "retail", title: "Provision the reserve crafter", needs: [{ stableId: "reserve_myco_need", kind: "ITEM_REF", resourceKey: fullRef(ITEM_ID), label: "Mycobloom reserve", requiredQuantity: 3, sourceIdentityKey: source.character.identityKey, destinationIdentityKey: source.character.identityKey }] });
    server = await listenOnce(createApp(store, 0, webDist, { allowedHosts: LOOPBACK_HOSTNAMES }), "127.0.0.1", 0);
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const executablePath = process.env.WOWSYNC_CHROMIUM_PATH ?? (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);
    browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
    const page = await browser.newPage(); page.setDefaultTimeout(5_000);
    const pageErrors = []; page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(`http://127.0.0.1:${address.port}/#/retail/overview`);
    await page.getByRole("button", { name: "Projects & Work Orders" }).click();
    const composer = page.getByTestId("erp-cross-project-plan"); await composer.waitFor();
    await composer.getByRole("checkbox", { name: /Provision the crafter · Mycobloom/ }).check();
    await composer.getByRole("checkbox", { name: /Prepare the second recipe · Briarthorn/ }).check();
    await composer.getByRole("checkbox", { name: /Provision the reserve crafter · Mycobloom reserve/ }).check();
    const firstEvidence = composer.locator(".erp-cross-project-choice").filter({ hasText: /Provision the crafter · Mycobloom/ }).first();
    assert.match(await firstEvidence.innerText(), /2 observed/);
    assert.match(await firstEvidence.innerText(), /2 active needs \/ 8 planned units · 1 exact-scope units reserved/);
    assert.match(await firstEvidence.innerText(), /1 observed lower-bound units not reserved/);
    const firstTask = composer.getByRole("group", { name: "Provision the crafter: Mycobloom" });
    const secondTask = composer.getByRole("group", { name: "Prepare the second recipe: Briarthorn" });
    assert.equal(await composer.locator('select[aria-label^="Portfolio prerequisites for "]').count(), 3);
    const secondPrerequisites = composer.getByLabel("Portfolio prerequisites for Briarthorn", { exact: true });
    await secondPrerequisites.selectOption(JSON.stringify([first.stableId, "mycobloom_need"]));
    const firstPrerequisites = composer.getByLabel("Portfolio prerequisites for Mycobloom", { exact: true });
    await firstPrerequisites.selectOption(JSON.stringify([second.stableId, "briar_need"]));
    assert.match(await composer.getByRole("alert").innerText(), /contain a cycle/);
    assert.equal(await composer.getByRole("button", { name: "Create 3 planned manual steps" }).isDisabled(), true, "the UI refuses a cyclic player-authored package");
    await firstPrerequisites.selectOption([]);
    await firstTask.getByLabel("Manual step type").selectOption("INVESTIGATE");
    const sourceLead = firstTask.getByLabel("Observed source to investigate for Mycobloom");
    assert.equal(await sourceLead.locator("option").filter({ hasText: /Possible Source Lead/ }).count(), 1);
    await sourceLead.selectOption(observedLead.character.identityKey);
    assert.match(await firstTask.innerText(), /Account membership, access, and transferability remain UNKNOWN/);
    await secondTask.getByLabel("Manual step type").selectOption("PURCHASE");
    await secondTask.getByLabel("Assigned same-version character").selectOption(source.character.identityKey);
    await secondTask.getByLabel("Purchase spending ceiling for Briarthorn").fill("25000");
    const thirdTask = composer.getByRole("group", { name: "Provision the reserve crafter: Mycobloom reserve" });
    await thirdTask.getByLabel("Manual step type").selectOption("GATHER");
    const firstReserve = firstTask.getByLabel("Optional reservation quantity for Mycobloom");
    const thirdReserve = thirdTask.getByLabel("Optional reservation quantity for Mycobloom reserve");
    await firstReserve.fill("1"); await thirdReserve.fill("1");
    await composer.getByRole("button", { name: "Create 3 planned manual steps" }).click();
    await composer.getByRole("alert").getByText(/Grouped reservations exceed the current observed lower bound/).waitFor();
    const rejected = await page.evaluate(async () => (await (await fetch("/api/versions/retail/erp/projects")).json()));
    assert.deepEqual(Object.fromEntries(rejected.projects.filter((project) => [first.stableId, second.stableId, third.stableId].includes(project.stableId)).map((project) => [project.title, [project.revision, project.workOrders.length, project.reservations.length]])), { "Provision the crafter": [1, 0, 1], "Prepare the second recipe": [1, 0, 0], "Provision the reserve crafter": [1, 0, 0] }, "the over-capacity request changes no project");
    await thirdReserve.fill("0");
    await composer.getByRole("button", { name: "Create 3 planned manual steps" }).click();
    await page.locator(".erp-project-card").filter({ hasText: "Provision the crafter" }).getByText(/INVESTIGATE · PLANNED/).waitFor();
    await page.locator(".erp-project-card").filter({ hasText: "Prepare the second recipe" }).getByText(/PURCHASE · PLANNED/).waitFor();
    await page.locator(".erp-project-card").filter({ hasText: "Provision the reserve crafter" }).getByText(/GATHER · PLANNED/).waitFor();

    const read = async () => page.evaluate(async () => (await (await fetch("/api/versions/retail/erp/projects")).json()));
    const rest = await read();
    const firstRead = rest.projects.find((project) => project.title === "Provision the crafter");
    const secondRead = rest.projects.find((project) => project.title === "Prepare the second recipe");
    const thirdRead = rest.projects.find((project) => project.title === "Provision the reserve crafter");
    const portfolioPackage = rest.portfolioFulfillment.packages.find((entry) => entry.steps.some((step) => step.needId === "briar_need"));
    assert.ok(portfolioPackage, "REST includes the connected cross-project package");
    assert.deepEqual(portfolioPackage.steps.map((step) => step.needId), ["mycobloom_need", "briar_need"], "portfolio view puts the evidence prerequisite before dependent work");
    assert.equal(portfolioPackage.steps[0].reviewState, "WORK_ORDER_REVIEW");
    assert.equal(portfolioPackage.steps[1].reviewState, "WORK_ORDER_REVIEW");
    assert.equal(portfolioPackage.steps[1].prerequisiteGate.state, "PREREQUISITE_EVIDENCE_REVIEW", "fresh but short observed supply does not satisfy the dependent step's evidence gate");
    assert.equal(portfolioPackage.steps[1].prerequisiteGate.blockers[0].evidenceState, "SHORTFALL_OBSERVED");
    const portfolioPanel = page.getByTestId("erp-portfolio-fulfillment");
    assert.match(await portfolioPanel.innerText(), /Portfolio fulfillment packages/);
    assert.match(await portfolioPanel.innerText(), /prerequisites the player linked/);
    assert.equal(firstRead.revision, 2); assert.equal(secondRead.revision, 2);
    assert.deepEqual(firstRead.workOrders.map((order) => [order.kind, order.status, order.resourceNeedIds, order.sourceIdentityKey, order.investigationSourceLeadIdentityKey]), [["INVESTIGATE", "PLANNED", ["mycobloom_need"], source.character.identityKey, observedLead.character.identityKey]]);
    const investigationOrder = page.locator(".erp-work-order-list li").filter({ has: page.getByText("Review fulfillment: Mycobloom", { exact: true }) });
    assert.match(await investigationOrder.innerText(), /Observed source lead to investigate: Possible Source Lead/);
    assert.match(await investigationOrder.innerText(), /Account membership, access, and transferability remain UNKNOWN/);
    assert.deepEqual(secondRead.workOrders.map((order) => [order.kind, order.status, order.resourceNeedIds]), [["PURCHASE", "PLANNED", ["briar_need"]]]);
    assert.deepEqual(secondRead.workOrders[0].portfolioPrerequisites, [{ projectId: first.stableId, needId: "mycobloom_need" }]);
    assert.equal(secondRead.workOrderReadiness[0].state, "WAITING_FOR_PORTFOLIO_PREREQUISITE");
    assert.equal(secondRead.workOrderReadiness[0].portfolioPrerequisites[0].state, "OBSERVED_SHORTFALL");
    const downstreamOrder = page.locator(".erp-work-order-list li").filter({ has: page.getByText("Review fulfillment: Briarthorn", { exact: true }) });
    assert.match(await downstreamOrder.innerText(), /Waiting for a portfolio prerequisite observation/);
    assert.match(await downstreamOrder.innerText(), /Provision the crafter: Mycobloom/);
    assert.deepEqual(secondRead.workOrders[0].procurementPlan, { targetNeedId: "briar_need", spendingCeilingCopper: 25000 }, "the player-set copper limit remains linked to the selected item need");
    assert.deepEqual(thirdRead.workOrders.map((order) => [order.kind, order.status, order.resourceNeedIds]), [["GATHER", "PLANNED", ["reserve_myco_need"]]]);
    assert.deepEqual(firstRead.reservations.map((reservation) => [reservation.quantity, reservation.status]), [[1, "ACTIVE"], [1, "ACTIVE"]], "the accepted player request is recorded beside the existing reservation");
    assert.equal(thirdRead.reservations.length, 0, "the rejected overlapping request remains absent");
    assert.equal(rest.resourceCommitments.items.find((entry) => entry.resourceKey === fullRef(ITEM_ID)).observedQuantity, 2, "planning work does not change observed stock");
    const context = await page.evaluate(async () => (await (await fetch("/api/account-context")).json()));
    assert.ok(context.planning.projects.some((project) => project.title === firstRead.title && project.revision === firstRead.revision));
    assert.ok(context.planning.projects.some((project) => project.title === secondRead.title && project.revision === secondRead.revision));
    assert.ok(context.planning.projects.some((project) => project.title === thirdRead.title && project.revision === thirdRead.revision));
    assert.equal(context.planning.projects.find((project) => project.stableId === secondRead.stableId).workOrderReadinessStates.WAITING_FOR_PORTFOLIO_PREREQUISITE, 1);
    assert.deepEqual(context.planning.portfolioFulfillment.retail, { packageCount: 1, stepCount: 2, stepsNeedingReview: 2, stepsWithPrerequisiteReview: 1, truncated: false });
    mcpClient = new Client({ name: "wowsync-cross-project-plan-browser", version: "0.1.0" });
    await mcpClient.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve(process.cwd(), "packages/mcp/src/index.ts")], cwd: process.cwd(), env: { ...process.env, WOWSYNC_MCP_DB_PATH: databasePath }, stderr: "pipe" }));
    const mcp = await mcpClient.callTool({ name: "get_erp_projects", arguments: { version: "retail", limit: 20 } });
    const mcpProjectsById = new Map(mcp.structuredContent.projects.map((project) => [project.stableId, project]));
    assert.deepEqual(mcp.structuredContent.portfolioFulfillment, rest.portfolioFulfillment, "MCP and REST share the exact dependency-first portfolio projection");
    for (const project of [firstRead, secondRead, thirdRead]) {
      assert.deepEqual(mcpProjectsById.get(project.stableId).workOrders.map((order) => [order.kind, order.status, order.resourceNeedIds, order.procurementPlan]), project.workOrders.map((order) => [order.kind, order.status, order.resourceNeedIds, order.procurementPlan]));
      assert.deepEqual(mcpProjectsById.get(project.stableId).reservations, project.reservations, "MCP and REST expose the same explicit reservation intent");
    }
    assert.equal(mcpProjectsById.get(firstRead.stableId).workOrders[0].investigationSourceLeadIdentityKey, observedLead.character.identityKey, "MCP preserves the lead as a separate field from the need source");
    assert.deepEqual(mcpProjectsById.get(secondRead.stableId).workOrders[0].portfolioPrerequisites, secondRead.workOrders[0].portfolioPrerequisites, "MCP and REST preserve the cross-project prerequisite link");
    assert.deepEqual(mcpProjectsById.get(secondRead.stableId).workOrderReadiness[0].portfolioPrerequisites, secondRead.workOrderReadiness[0].portfolioPrerequisites, "MCP and REST expose the same prerequisite evidence state");
    store.importSnapshot(renderExport({ name: "Fulfillment Planner", realm: "Cairne", generated: now + 20, bags: observedSection([row(ITEM_ID, 1, { name: "Mycobloom" }), row(ITEM_ID + 1, 1, { name: "Briarthorn" })], now + 20), bank: observedSection([], now + 20) }));
    await page.reload();
    const afterObservation = await read();
    const afterFirst = afterObservation.projects.find((project) => project.stableId === first.stableId);
    assert.equal(afterFirst.needEvidence.find((entry) => entry.needId === "mycobloom_need").observedQuantity, 1);
    assert.deepEqual(afterFirst.reservationReview.map((entry) => entry.state), ["EXCEEDS_OBSERVED_SUPPLY", "EXCEEDS_OBSERVED_SUPPLY"], "a later observed shortage flags both active reservations for review");
    assert.equal(afterFirst.workOrders[0].status, "PLANNED", "inventory changes do not claim that the manual step occurred");
    const changedContext = await page.evaluate(async () => (await (await fetch("/api/account-context")).json()));
    const contextFirst = changedContext.planning.projects.find((project) => project.stableId === first.stableId);
    assert.equal(contextFirst.reservationReviewStates.EXCEEDS_OBSERVED_SUPPLY, 2);
    const changedMcp = await mcpClient.callTool({ name: "get_erp_projects", arguments: { version: "retail", limit: 20 } });
    assert.deepEqual(changedMcp.structuredContent.portfolioFulfillment, afterObservation.portfolioFulfillment, "portfolio readiness is recomputed from the same later observation for REST and MCP");
    const afterShortfallPackage = afterObservation.portfolioFulfillment.packages.find((entry) => entry.stableId === portfolioPackage.stableId);
    assert.equal(afterShortfallPackage.steps[1].prerequisiteGate.state, "PREREQUISITE_EVIDENCE_REVIEW", "a newer shortfall keeps the downstream evidence gate open");
    const changedMcpFirst = changedMcp.structuredContent.projects.find((project) => project.stableId === first.stableId);
    assert.deepEqual(changedMcpFirst.reservationReview, afterFirst.reservationReview, "MCP and REST agree after the resource observation changes");
    assert.deepEqual(changedMcpFirst.workOrders.map((order) => order.status), afterFirst.workOrders.map((order) => order.status));
    store.importSnapshot(renderExport({ name: "Fulfillment Planner", realm: "Cairne", generated: now + 40, bags: observedSection([row(ITEM_ID, 5, { name: "Mycobloom" }), row(ITEM_ID + 1, 1, { name: "Briarthorn" })], now + 40), bank: observedSection([], now + 40) }));
    await page.reload();
    const afterRecovery = await read();
    const recoveredPackage = afterRecovery.portfolioFulfillment.packages.find((entry) => entry.stableId === portfolioPackage.stableId);
    assert.equal(recoveredPackage.steps[1].prerequisiteGate.state, "CURRENT_OBSERVED_EVIDENCE_MET", "a later fresh observation can satisfy the declared evidence gate");
    assert.deepEqual(recoveredPackage.steps[1].prerequisiteGate.blockers, []);
    const recoveredContext = await page.evaluate(async () => (await (await fetch("/api/account-context")).json()));
    assert.equal(recoveredContext.planning.portfolioFulfillment.retail.stepsWithPrerequisiteReview, 0);
    const recoveredMcp = await mcpClient.callTool({ name: "get_erp_projects", arguments: { version: "retail", limit: 20 } });
    assert.deepEqual(recoveredMcp.structuredContent.portfolioFulfillment, afterRecovery.portfolioFulfillment, "the satisfied gate stays consistent across REST and MCP after a later export");
    assert.equal(recoveredMcp.structuredContent.portfolioFulfillment.packages[0].steps[1].prerequisiteGate.state, "CURRENT_OBSERVED_EVIDENCE_MET");
    assert.deepEqual(pageErrors, []);
  } finally {
    if (mcpClient) await mcpClient.close();
    if (browser) await browser.close();
    if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    store?.close(); rmSync(directory, { recursive: true, force: true });
  }
});




test("[SYNTHETIC BROWSER ACCEPTANCE] manage manual work-order lifecycle from the cross-project queue and preserve player completion evidence", async () => {
  assert.ok(existsSync(path.join(webDist, "index.html")), "build the web UI before browser acceptance");
  const directory = mkdtempSync(path.join(os.tmpdir(), "wowsync-erp-queue-lifecycle-"));
  const databasePath = path.join(directory, "browser.sqlite");
  let store; let server; let browser; let mcpClient;
  try {
    store = new SqliteSnapshotStore(databasePath);
    const now = Math.floor(Date.now() / 1000);
    const imported = store.importSnapshot(renderExport({ name: "Queue Operator", realm: "Cairne", generated: now, bags: observedSection([], now), bank: observedSection([], now) }));
    const project = store.createErpProject({ version: "retail", title: "Queue lifecycle project", needs: [{ stableId: "material", kind: "ITEM_REF", resourceKey: fullRef(ITEM_ID), label: "Mycobloom", requiredQuantity: 1, sourceIdentityKey: imported.character.identityKey }], workOrders: [{ stableId: "manual-gather", kind: "GATHER", status: "PLANNED", title: "Manually review gathering", instructions: "Player controlled only", assignedIdentityKey: imported.character.identityKey, sourceIdentityKey: imported.character.identityKey, resourceNeedIds: ["material"], dependsOn: [] }] });
    server = await listenOnce(createApp(store, 0, webDist, { allowedHosts: LOOPBACK_HOSTNAMES }), "127.0.0.1", 0);
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const executablePath = process.env.WOWSYNC_CHROMIUM_PATH ?? (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);
    browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
    const page = await browser.newPage(); page.setDefaultTimeout(5_000); const pageErrors = []; page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(`http://127.0.0.1:${address.port}/#/retail/overview`);
    await page.getByRole("button", { name: "Projects & Work Orders" }).click();
    const queue = page.getByRole("region", { name: "Work order review queue" });
    const task = queue.getByTestId(`erp-queue-order-${project.stableId}-manual-gather`);
    await task.waitFor();
    assert.match(await task.innerText(), /MANUAL SUPPLY STEP RECOMMENDED/);
    await task.getByRole("button", { name: "Open project" }).click();
    const projectOrders = page.locator(".erp-work-order-list");
    await projectOrders.getByRole("button", { name: "Manage in review queue" }).waitFor();
    assert.equal(await projectOrders.getByRole("button", { name: "Mark in progress" }).count(), 0, "status mutation is available from one queue surface");
    await projectOrders.getByRole("button", { name: "Manage in review queue" }).click();
    assert.equal(await page.evaluate(() => document.activeElement?.id), "erp-work-order-queue-title", "detail action returns the player to the shared queue");
    await task.getByRole("button", { name: "Mark in progress" }).click();
    await task.getByText(/GATHER · IN_PROGRESS/).waitFor();
    let rest = await page.evaluate(async () => (await (await fetch("/api/versions/retail/erp/projects")).json()));
    let current = rest.projects.find((entry) => entry.stableId === project.stableId);
    assert.equal(current.workOrders[0].status, "IN_PROGRESS");
    let context = await page.evaluate(async () => (await (await fetch("/api/account-context")).json()));
    assert.equal(context.planning.projects.find((entry) => entry.stableId === project.stableId).workOrderCounts.IN_PROGRESS, 1);
    mcpClient = new Client({ name: "wowsync-queue-lifecycle-browser", version: "0.1.0" });
    await mcpClient.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve(process.cwd(), "packages/mcp/src/index.ts")], cwd: process.cwd(), env: { ...process.env, WOWSYNC_MCP_DB_PATH: databasePath }, stderr: "pipe" }));
    let mcp = await mcpClient.callTool({ name: "get_erp_projects", arguments: { version: "retail", limit: 20 } });
    assert.equal(mcp.structuredContent.projects.find((entry) => entry.stableId === project.stableId).workOrders[0].status, current.workOrders[0].status);
    await task.getByRole("button", { name: "Wait for evidence" }).click();
    await task.getByText(/GATHER · WAITING_FOR_EVIDENCE/).waitFor();
    await task.getByRole("button", { name: "Resume manual work" }).click();
    await task.getByText(/GATHER · IN_PROGRESS/).waitFor();
    page.once("dialog", (dialog) => dialog.accept("Player reports the check is complete; no resource outcome is asserted."));
    await task.getByRole("button", { name: /Record completion/ }).click();
    await page.getByText("No unfinished work orders currently require evidence review.").waitFor();
    rest = await page.evaluate(async () => (await (await fetch("/api/versions/retail/erp/projects")).json()));
    current = rest.projects.find((entry) => entry.stableId === project.stableId);
    assert.equal(current.workOrders[0].status, "COMPLETED");
    assert.equal(current.workOrders[0].completionNote, "Player reports the check is complete; no resource outcome is asserted.");
    assert.equal(current.workOrderProgress[0].reconciliation, "COMPLETION_CONFLICTS_WITH_LINKED_SHORTFALL", "the player-entered completion is kept distinct from contrary current supply evidence");
    context = await page.evaluate(async () => (await (await fetch("/api/account-context")).json()));
    assert.equal(context.planning.projects.find((entry) => entry.stableId === project.stableId).workOrderProgressStates.COMPLETION_CONFLICTS_WITH_LINKED_SHORTFALL, 1);
    mcp = await mcpClient.callTool({ name: "get_erp_projects", arguments: { version: "retail", limit: 20 } });
    const mcpProject = mcp.structuredContent.projects.find((entry) => entry.stableId === project.stableId);
    assert.deepEqual(mcpProject.workOrders, current.workOrders);
    assert.deepEqual(mcpProject.workOrderProgress, current.workOrderProgress);
    assert.match(await page.locator(".erp-work-order-list").innerText(), /Completion note conflicts with a linked shortfall/);
    assert.deepEqual(pageErrors, []);
  } finally {
    if (mcpClient) await mcpClient.close();
    if (browser) await browser.close();
    if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    store?.close(); rmSync(directory, { recursive: true, force: true });
  }
});

test("[SYNTHETIC BROWSER ACCEPTANCE] review combined unfinished purchase ceilings against linked planned gold across UI, REST, AccountContext, and MCP", async () => {
  assert.ok(existsSync(path.join(webDist, "index.html")), "build the web UI before browser acceptance");
  const directory = mkdtempSync(path.join(os.tmpdir(), "wowsync-erp-procurement-budget-review-"));
  const databasePath = path.join(directory, "browser.sqlite");
  let store; let server; let browser; let mcpClient;
  try {
    store = new SqliteSnapshotStore(databasePath);
    const now = Math.floor(Date.now() / 1000);
    const exportText = renderExport({ name: "Budget Buyer", realm: "Cairne", generated: now, bags: observedSection([], now), bank: observedSection([], now) }).replace("MoneyCopper: ?", "MoneyCopper: 12000");
    const imported = store.importSnapshot(exportText);
    const buyer = imported.character.identityKey;
    const project = store.createErpProject({ version: "retail", title: "Two-item provision", needs: [
      { stableId: "stone", kind: "ITEM_REF", resourceKey: fullRef(ITEM_ID), label: "Mycobloom exact variant", requiredQuantity: 3, sourceIdentityKey: buyer, destinationIdentityKey: buyer },
      { stableId: "cloth", kind: "ITEM_ID", resourceKey: String(ITEM_ID + 1), label: "Linen Cloth", requiredQuantity: 2, sourceIdentityKey: buyer, destinationIdentityKey: buyer },
      { stableId: "budget", kind: "GOLD_COPPER", resourceKey: "copper", label: "Provisioning budget", requiredQuantity: 1000, sourceIdentityKey: buyer, destinationIdentityKey: buyer },
    ], workOrders: [
      { stableId: "purchase-stone", kind: "PURCHASE", status: "PLANNED", title: "Review stone quote", assignedIdentityKey: buyer, resourceNeedIds: ["stone", "budget"], dependsOn: [], procurementPlan: { targetNeedId: "stone", budgetNeedId: "budget", spendingCeilingCopper: 700 } },
      { stableId: "purchase-cloth", kind: "PURCHASE", status: "IN_PROGRESS", title: "Review cloth quote", assignedIdentityKey: buyer, resourceNeedIds: ["cloth", "budget"], dependsOn: [], procurementPlan: { targetNeedId: "cloth", budgetNeedId: "budget", spendingCeilingCopper: 500 } },
    ] });
    server = await listenOnce(createApp(store, 0, webDist, { allowedHosts: LOOPBACK_HOSTNAMES }), "127.0.0.1", 0);
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const executablePath = process.env.WOWSYNC_CHROMIUM_PATH ?? (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);
    browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
    const page = await browser.newPage(); page.setDefaultTimeout(5_000); const pageErrors = []; page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(`http://127.0.0.1:${address.port}/#/retail/overview`);
    await page.getByRole("button", { name: "Projects & Work Orders" }).click();
    const panel = page.getByTestId("erp-procurement-budget-review");
    const line = panel.getByTestId(`erp-procurement-budget-${project.stableId}-budget`);
    await line.waitFor();
    assert.match(await line.innerText(), /CEILINGS EXCEED PLANNED BUDGET/);
    assert.match(await line.innerText(), /1200 copper across 2 unfinished purchase plans against 1000 copper explicitly planned/);
    assert.match(await line.innerText(), /exceed the planned amount by 200 copper/);
    assert.match(await line.innerText(), /12000 copper observed/);
    assert.match(await panel.innerText(), /not predicted spend, a quote, or a purchase/i);
    const quotePrompts = ["650", "3", "player checked", "400", "2", "player checked"];
    page.on("dialog", (dialog) => void dialog.accept(quotePrompts.shift() ?? ""));
    await page.getByTestId(`erp-queue-order-${project.stableId}-purchase-stone`).getByRole("button", { name: "Record quote..." }).click();
    await page.waitForFunction((id) => document.querySelector(`[data-testid="erp-procurement-budget-${id}-budget"]`)?.textContent?.includes("player quote 650 copper for 3 units"), project.stableId);
    await page.getByTestId(`erp-queue-order-${project.stableId}-purchase-cloth`).getByRole("button", { name: "Record quote..." }).click();
    await page.waitForFunction((id) => document.querySelector(`[data-testid="erp-procurement-budget-${id}-budget"]`)?.textContent?.includes("player quote 400 copper for 2 units"), project.stableId);
    assert.match(await line.innerText(), /RECENT QUOTES COVER OBSERVED GAPS/);
    assert.match(await line.innerText(), /1050 copper in recent player-entered quotes/);
    assert.match(await line.innerText(), /RECENT QUOTES ABOVE PLANNED BUDGET/);
    assert.match(await line.innerText(), /Quote totals cover only the quantities the player recorded/);
    await page.getByRole("searchbox", { name: "Search work orders" }).fill("filter hides every quote order");
    await line.getByRole("button", { name: "Review quote task" }).first().click();
    await page.waitForFunction((id) => document.activeElement?.id === id, `erp-queue-quote-${encodeURIComponent(project.stableId)}-${encodeURIComponent("purchase-stone")}`);
    assert.equal(await page.evaluate(() => document.activeElement?.id), `erp-queue-quote-${encodeURIComponent(project.stableId)}-${encodeURIComponent("purchase-stone")}`);
    assert.equal(await page.getByRole("searchbox", { name: "Search work orders" }).inputValue(), "", "portfolio navigation clears a search that hid the quote task");
    const rest = await page.evaluate(async () => (await (await fetch("/api/versions/retail/erp/projects")).json()));
    assert.deepEqual(rest.procurementBudgetReview.lines[0].orders.map((order) => [order.targetNeedId, order.targetResourceKey, order.spendingCeilingCopper]), [["stone", fullRef(ITEM_ID), 700], ["cloth", String(ITEM_ID + 1), 500]]);
    const context = await page.evaluate(async () => (await (await fetch("/api/account-context")).json()));
    assert.equal(context.schemaVersion, "30");
    assert.deepEqual(context.planning.procurementBudgetReview.retail, { lineCount: 1, overPlannedBudget: 1, totalOpenCeilingCopper: 1200, quoteReviewStates: { RECENT_QUOTES_COVER_OBSERVED_GAPS: 1 }, quoteBudgetsAbovePlan: 1, quoteBudgetsIncomplete: 0, truncated: false });
    await line.getByRole("button", { name: "Review project plans" }).click();
    assert.equal(await page.evaluate(() => document.activeElement?.id), `erp-project-title-${encodeURIComponent(project.stableId)}`);
    mcpClient = new Client({ name: "wowsync-procurement-budget-browser", version: "0.1.0" });
    await mcpClient.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve(process.cwd(), "packages/mcp/src/index.ts")], cwd: process.cwd(), env: { ...process.env, WOWSYNC_MCP_DB_PATH: databasePath }, stderr: "pipe" }));
    const mcp = await mcpClient.callTool({ name: "get_erp_projects", arguments: { version: "retail", limit: 20 } });
    assert.deepEqual(mcp.structuredContent.procurementBudgetReview.lines, rest.procurementBudgetReview.lines);
    assert.deepEqual(pageErrors, []);
  } finally {
    if (mcpClient) await mcpClient.close();
    if (browser) await browser.close();
    if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    store?.close(); rmSync(directory, { recursive: true, force: true });
  }
});
