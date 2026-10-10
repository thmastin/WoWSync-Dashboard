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
    page.once("dialog", (dialog) => dialog.accept("1"));
    await needEvidence.getByRole("button", { name: "Reserve" }).click();
    await needEvidence.locator(".erp-status").filter({ hasText: /1 reserved across overlapping plans/ }).waitFor();
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
    await craftForm.getByLabel("Assigned character").selectOption({ label: "Other Potential Holder — Thrall" });
    await craftForm.getByLabel("Linked resource needs").selectOption([{ label: "Leatherworking skill 1" }, { label: "Mycobloom" }]);
    await craftForm.getByRole("button", { name: "Add work order" }).click();
    const craftOrder = projectCard.locator(".erp-work-order-list li").filter({ hasText: "Check the assigned character's profession evidence" });
    await craftOrder.waitFor();
    await craftOrder.getByText("Compare planned crafter input observations (crafting cause unknown)").click();
    const craftText = await craftOrder.innerText();
    assert.match(craftText, /Checked on assigned character: Other Potential Holder — Thrall/);
    assert.match(craftText, /unknown freshness/);
    assert.match(craftText, /does not meet Exact profession Leatherworking at skill 1|assigned crafter is unknown/);
    assert.match(craftText, /Planned craft output \(intent only\)/);
    assert.match(craftText, /Quantity in recorded evidence: 2/);
    assert.match(craftText, /do not verify this craft or complete the work order/);
    assert.match(craftText, /Compare planned crafter input observations \(crafting cause unknown\)/);
    assert.match(craftText, /Input changes do not establish consumption or link them causally to the planned output/);
    const persistedCraft = await page.evaluate(async () => (await (await fetch("/api/versions/retail/erp/projects")).json()).projects.find((entry) => entry.title === "Provision the crafter").workOrders.find((entry) => entry.title === "Check the assigned character's profession evidence"));
    assert.deepEqual(persistedCraft.plannedOutput, { kind: "ITEM_ID", resourceKey: String(ITEM_ID), label: "Planned Mycobloom output", quantity: 2 });

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
    const quoteAnswers = [" "];
    page.on("dialog", async (dialog) => dialog.accept(quoteAnswers.shift() ?? ""));
    await purchaseOrder.getByRole("button", { name: "Record checked quote…" }).click();
    await page.locator(".erp-form-error").filter({ hasText: "Enter a non-negative whole-copper amount" }).waitFor();
    let persistedProject = await page.evaluate(async () => (await (await fetch("/api/versions/retail/erp/projects")).json()).projects.find((entry) => entry.title === "Provision the crafter"));
    let persistedPurchase = persistedProject.workOrders.find((entry) => entry.title === "Review the observed item gap without purchasing");
    assert.equal(persistedPurchase.procurementPlan.playerQuote, undefined, "blank price input cannot create a zero-copper player quote");
    quoteAnswers.push("80", "5", "Town vendor checked by player");
    await purchaseOrder.getByRole("button", { name: "Record checked quote…" }).click();
    await page.waitForFunction(() => document.querySelector(".erp-procurement-review")?.textContent?.includes("Town vendor checked by player"));
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
    assert.match(await purchaseOrder.innerText(), /Record checked quote/);
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
