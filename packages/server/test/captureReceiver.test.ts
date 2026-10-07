import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SqliteSnapshotStore } from "@wowsync-dashboard/core";
import { createCaptureApp } from "../src/captureReceiver.ts";
import { createCaptureTransport } from "../src/captureTransport.ts";
import { listenOnce } from "../src/net.ts";
import { observation } from "../../core/test/equipmentObservationFixtures.ts";

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

test("receiver probe checks capture HTTP reachability without sending the token", async () => {
  const spool = mkdtempSync(join(tmpdir(), "wowsync-probe-"));
  const states: string[] = [];
  try {
    const transport = createCaptureTransport({
      origin: "http://127.0.0.1:4175", token, target: "DEV", spoolDirectory: spool,
      onConnectivity: (state) => states.push(state),
      fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
        assert.equal(init?.method, "POST");
        assert.equal((init?.headers as Record<string, string>).Authorization, undefined);
        assert.equal(init?.body, "{}");
        return new Response(JSON.stringify({ code: "CAPTURE_UNAUTHORIZED" }), { status: 401 });
      }) as typeof fetch,
    });
    await transport.probe(true);
    assert.deepEqual(states, ["connected"]);
    assert.equal(transport.pendingCount(), 0);
  } finally { rmSync(spool, { recursive: true, force: true }); }
});

// --- Slice A: equipment observations through the capture sender/receiver ------------------------------------

const digestOf = (tuple: unknown[]) => createHash("sha256").update(JSON.stringify(tuple)).digest("hex");

/** A receiver over a file-backed store, plus a raw view of the observation table. */
async function withObservedReceiver(run: (base: string, rows: () => Array<Record<string, any>>) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "wowsync-capture-eq-"));
  const dbPath = join(dir, "test.sqlite");
  const store = new SqliteSnapshotStore(dbPath);
  const raw = new DatabaseSync(dbPath);
  const spoolDir = join(dir, "receiver");
  const app = createCaptureApp(store, { token, directory: spoolDir, target: "DEV" });
  const server = await listenOnce(app, "127.0.0.1", 0);
  try { await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, () => raw.prepare("SELECT * FROM snapshot_equipment_observations ORDER BY id").all() as Array<Record<string, any>>); }
  finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    raw.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
const postCapture = (base: string, payload: unknown) => fetch(`${base}/api/captures`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(payload) });

test("A17 A18 the receiver verifies a digest that covers the equipment observation and forwards it to the store", async () => {
  await withObservedReceiver(async (base, rows) => {
    const equipmentObservation = observation({ projection: true });
    const body = { ...envelope(), equipmentObservation, payloadSha256: digestOf(["DEV", text, null, null, equipmentObservation]) };
    const accepted = await postCapture(base, body);
    assert.equal(accepted.status, 200);
    const [row] = rows();
    assert.deepEqual([row.observed_at, row.capture, row.revision], [1791375064, 29, 220]);

    const tampered = structuredClone(equipmentObservation);
    (tampered.envelope.specEquipmentObservation as any).activeSpecBefore.specID = 255;
    const forged = await postCapture(base, { ...body, captureId: randomUUID(), equipmentObservation: tampered });
    assert.equal(forged.status, 422);
    assert.equal(((await forged.json()) as { code: string }).code, "CAPTURE_PAYLOAD_HASH_MISMATCH");
    const stripped = await postCapture(base, { ...body, captureId: randomUUID(), equipmentObservation: undefined });
    assert.equal(stripped.status, 422, "dropping the observation from a payload whose digest covered it is detected");
    const oldDigestWithField = await postCapture(base, { ...body, captureId: randomUUID(), payloadSha256: digestOf(["DEV", text, null]) });
    assert.equal(oldDigestWithField.status, 422, "an observation cannot ride on an old-format digest");
    assert.equal(rows().length, 1);
  });
});

test("A45 old-format captures (no equipment observation) keep validating, including one queued in the sender outbox before the upgrade", async () => {
  const spool = mkdtempSync(join(tmpdir(), "wowsync-outbox-eq-"));
  try {
    const captureId = randomUUID();
    const queued = { captureId, target: "DEV", sha256: createHash("sha256").update(text).digest("hex"), payloadSha256: digestOf(["DEV", text, null]), text };
    writeFileSync(join(spool, `${captureId}.json`), JSON.stringify(queued));
    await withObservedReceiver(async (base, rows) => {
      const legacy = await postCapture(base, { ...envelope(), payloadSha256: digestOf(["DEV", text, null, { formatVersion: 1, clientFamily: "Retail" }]), characterState: { formatVersion: 1, clientFamily: "Retail" } });
      assert.equal(legacy.status, 200, "the characterState-only digest form is unchanged");
      const sender = createCaptureTransport({ origin: base, token, target: "DEV", spoolDirectory: spool, fetch });
      await sender.flush();
      assert.equal(readdirSync(spool).length, 0, "the pre-upgrade outbox entry was validated and delivered");
      assert.equal(rows().length, 0);
    });
  } finally { rmSync(spool, { recursive: true, force: true }); }
});

test("A18 A45 sender and receiver compute the same digest: a new sender's observation reaches the store through the real receiver", async () => {
  const spool = mkdtempSync(join(tmpdir(), "wowsync-outbox-eq-"));
  try {
    await withObservedReceiver(async (base, rows) => {
      const sender = createCaptureTransport({ origin: base, token, target: "DEV", spoolDirectory: spool, fetch });
      const equipmentObservation = observation();
      const capture = await sender.send(text, undefined, undefined, equipmentObservation);
      assert.equal(capture.payloadSha256, digestOf(["DEV", text, null, null, equipmentObservation]));
      assert.equal(readdirSync(spool).length, 0, "acknowledged");
      assert.equal(rows().length, 1);
      const plain = await sender.send(text);
      assert.equal(plain.payloadSha256, digestOf(["DEV", text, null]), "without the field the digest is the old one");
    });
  } finally { rmSync(spool, { recursive: true, force: true }); }
});
