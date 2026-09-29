import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SqliteSnapshotStore } from "@wowsync-dashboard/core";
import { createCaptureApp } from "../src/captureReceiver.ts";
import { createCaptureTransport } from "../src/captureTransport.ts";
import { listenOnce } from "../src/net.ts";

const fixtures = new URL("../../core/test/fixtures/retail/stoneharry-1789491879.wowsync.txt", import.meta.url);
const text = await (await import("node:fs/promises")).readFile(fixtures, "utf8");
const token = "dev-capture-test-secret-0123456789abcdef";

async function withReceiver(run: (base: string, dir: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "wowsync-capture-"));
  const store = new SqliteSnapshotStore(":memory:");
  const app = createCaptureApp(store, { token, directory: dir, target: "DEV" });
  const server = await listenOnce(app, "127.0.0.1", 0);
  try { await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, dir); }
  finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function envelope(captureId = randomUUID()) {
  return { captureId, target: "DEV", sha256: createHash("sha256").update(text).digest("hex"), payloadSha256: createHash("sha256").update(JSON.stringify(["DEV", text, null])).digest("hex"), text };
}

test("capture receiver requires its dedicated token and verifies immutable payload hash", async () => {
  await withReceiver(async (base) => {
    const body = envelope();
    const dashboardRoute = await fetch(`${base}/api/versions`);
    assert.equal(dashboardRoute.status, 404, "the tunnel listener exposes no general Dashboard API");
    const noAuth = await fetch(`${base}/api/captures`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    assert.equal(noAuth.status, 401);
    const wrongTarget = await fetch(`${base}/api/captures`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ ...body, target: "LIVE", payloadSha256: createHash("sha256").update(JSON.stringify(["LIVE", text, null])).digest("hex") }) });
    assert.equal(wrongTarget.status, 409);
    const badHash = await fetch(`${base}/api/captures`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ ...body, sha256: "0".repeat(64) }) });
    assert.equal(badHash.status, 422);
  });
});

test("capture receiver commits before acknowledging and replays the same durable receipt", async () => {
  await withReceiver(async (base, dir) => {
    const body = envelope();
    const send = (payload: unknown) => fetch(`${base}/api/captures`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const first = await send(body);
    assert.equal(first.status, 200);
    const accepted = await first.json() as { target: string; receipt: { captureId: string; sha256: string; result: { snapshotId: number } }; duplicate: boolean };
    assert.equal(accepted.target, "DEV");
    assert.equal(accepted.duplicate, false);
    assert.equal(accepted.receipt.sha256, body.sha256);
    assert.ok(accepted.receipt.result.snapshotId > 0);

    const again = await send(body);
    assert.equal(again.status, 200);
    const replay = await again.json() as typeof accepted;
    assert.equal(replay.duplicate, true);
    assert.deepEqual(replay.receipt, accepted.receipt);

    const conflict = await send({ ...body, text: `${body.text}\n` });
    assert.equal(conflict.status, 422, "digest validation happens before capture ID conflict handling");
    const changed = `${body.text}\n`;
    const properConflict = await send({ ...body, sha256: createHash("sha256").update(changed).digest("hex"), payloadSha256: createHash("sha256").update(JSON.stringify(["DEV", changed, null])).digest("hex"), text: changed });
    assert.equal(properConflict.status, 409);
    assert.equal(readdirSync(dir).length, 1, "the staging copy is removed after durable import and receipt; the receipt remains");
  });
});

test("sender outbox removes a capture only after the receiver returns the matching durable receipt", async () => {
  const spool = mkdtempSync(join(tmpdir(), "wowsync-outbox-"));
  try {
    const down = createCaptureTransport({ origin: "https://receiver.example", token, target: "DEV", spoolDirectory: spool, fetch: (async () => { throw new Error("offline"); }) as typeof fetch });
    await assert.rejects(down.send(text), /remains in .*Retry in/);
    assert.equal(readdirSync(spool).length, 1, "a failed delivery remains queued on disk");

    await withReceiver(async (base) => {
      const sender = createCaptureTransport({ origin: base, token, target: "DEV", spoolDirectory: spool, fetch });
      await sender.flush();
      assert.equal(readdirSync(spool).length, 0, "the matching durable ACK permits deletion from the sender outbox");
      await sender.send(text);
      assert.equal(readdirSync(spool).length, 0);
    });
  } finally { rmSync(spool, { recursive: true, force: true }); }
});
