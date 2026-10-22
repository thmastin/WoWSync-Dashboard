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

test("[SYNTHETIC BROWSER ACCEPTANCE] Forever Character Detail separates objective, readiness, history, and unknown evidence", async () => {
  assert.ok(existsSync(path.join(webDist, "index.html")), "build the web UI before browser acceptance");
  const directory = mkdtempSync(path.join(os.tmpdir(), "wowsync-forever-quests-"));
  let store; let server; let browser;
  try {
    store = new SqliteSnapshotStore(path.join(directory, "quests.sqlite"));
    const now = Math.floor(Date.now() / 1000);
    const identity = { name: "Questhero", realm: "Classic Beta PvP 2" };
    const generatedAt = now - 5;
    const text = buildWowSyncExport({ generatedAt, character: { ...identity, clientFamily: "Forever", clientVersion: "1.60.1", clientBuild: "70338", interface: "16001", class: "WARRIOR", level: 8 }, equipment: { slots: [] }, bank: { unknown: true } });
    const imported = store.importSnapshot(text, { foreverGearObservation: {
      clientProfile: "Forever:1.60.1:70338:16001", ...identity, generatedAt, sourceCharacterGuid: "Player-QUEST-TEST",
      quests: { observedAt: now - 2, completeness: "partial", data: {
        formatVersion: 1, clientProfile: "Forever:1.60.1:70338:16001", clientFamily: "Forever", source: "C_QuestLog", observedAt: now - 2,
        activeState: "OBSERVED", activeCompleteness: "partial", activeCounts: { visibleEntries: 2, quests: 1, scannedRows: 2, returnedQuests: 1 },
        active: [{ questID: 9001, title: "A Local Problem", level: 8, objectiveState: "PARTIAL", objectives: [{ text: "Collect local reports", finished: false, numFulfilled: 1, numRequired: 3 }], completionState: "OBSERVED", isComplete: false, turnInReadinessState: "UNKNOWN", waypoint: { mapID: 12, x: 0.25, y: 0.5 } }],
        completedHistory: { state: "OBSERVED", questIDs: [8999], quests: [{ questID: 8999, title: "An Earlier Errand", titleState: "OBSERVED" }], returnedCount: 1 },
        issues: ["ReadyForTurnIn unknown"],
      } },
    } });
    server = await listenOnce(createApp(store, 0, webDist, { allowedHosts: LOOPBACK_HOSTNAMES }), "127.0.0.1", 0);
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const executablePath = process.env.WOWSYNC_CHROMIUM_PATH ?? (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);
    browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
    const page = await browser.newPage(); page.setDefaultTimeout(8_000);
    const pageErrors = []; page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(`http://127.0.0.1:${address.port}/#/forever/c/${encodeURIComponent(imported.character.identityKey)}`);
    const quests = page.locator("#detail-forever-quests");
    await quests.getByRole("heading", { name: "Forever quests and objectives" }).waitFor();
    await page.waitForFunction(() => document.querySelector("#detail-forever-quests")?.textContent?.includes("OBSERVED · partial coverage"));
    assert.match(await quests.innerText(), /OBSERVED · partial coverage/);
    assert.match(await quests.innerText(), /A Local Problem/);
    assert.match(await quests.innerText(), /Collect local reports · Finished OBSERVED \(no\) · Progress OBSERVED 1\/3/);
    assert.match(await quests.innerText(), /Complete: OBSERVED \(no\)/);
    assert.match(await quests.innerText(), /Turn-in readiness: UNKNOWN/);
    assert.match(await quests.innerText(), /Observed waypoint: map 12/);
    assert.match(await quests.innerText(), /An Earlier Errand/);
    assert.match(await page.locator(".detail-toc").innerText(), /Quests/);
    assert.deepEqual(pageErrors, []);
  } finally {
    if (browser) await browser.close();
    if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    store?.close(); rmSync(directory, { recursive: true, force: true });
  }
});
