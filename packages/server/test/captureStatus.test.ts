import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createCaptureStatusWriter } from "../src/captureStatus.ts";

test("capture status is durable, useful, and excludes credentials and export content", () => {
  const root = mkdtempSync(join(tmpdir(), "wowsync-status-"));
  try {
    let time = new Date("2026-09-29T20:00:00.000Z");
    const file = join(root, "status.json");
    const status = createCaptureStatusWriter(file, () => time);
    status.apply({ type: "service", state: "running", watchRoot: "C:\\Games\\WoW" });
    status.apply({ type: "targets", files: [{ path: "C:\\Games\\WoW\\_retail_\\GearExport.lua", product: "_retail_" }] });
    time = new Date("2026-09-29T20:01:00.000Z");
    status.apply({ type: "observation", at: time.toISOString(), file: "C:\\Games\\WoW\\_retail_\\GearExport.lua", product: "_retail_" });
    status.apply({ type: "export", at: time.toISOString(), file: "ignored", product: "_retail_", character: "Virek", realm: "Cairne", version: "retail" });
    status.apply({ type: "pending", count: 1, draining: false });
    status.apply({ type: "connectivity", state: "unavailable", checkedAt: time.toISOString() });
    status.apply({ type: "error", at: time.toISOString(), message: "ECONNREFUSED" });
    time = new Date("2026-09-29T20:02:00.000Z");
    status.apply({ type: "connectivity", state: "connected", checkedAt: time.toISOString() });
    status.apply({ type: "pending", count: 0, draining: false });
    status.apply({ type: "acknowledgement", at: time.toISOString(), file: "ignored", product: "_retail_", captureId: "capture-id", character: "Virek", realm: "Cairne", version: "retail" });

    const raw = readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    assert.equal(parsed.target, "DEV");
    assert.equal(parsed.connectivity, "connected");
    assert.equal(parsed.pendingSpoolCount, 0);
    assert.equal(parsed.lastAcknowledgement.character, "Virek");
    assert.equal(parsed.lastAcknowledgement.version, "retail");
    assert.match(parsed.lastError.message, /ECONNREFUSED/);
    assert.doesNotMatch(raw, /Bearer|capture-secret|WOWSYNC_CAPTURE_TOKEN|GearExport text/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
