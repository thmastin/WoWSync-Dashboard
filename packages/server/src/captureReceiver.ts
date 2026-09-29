import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, openSync, closeSync, renameSync, unlinkSync, writeSync, fsyncSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import express, { type Express, type Request, type Response } from "express";
import { WowSyncParseError, type SnapshotStore } from "@wowsync-dashboard/core";
import { LOOPBACK_HOSTNAMES, hostGuard } from "./net.ts";

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/i;

export interface CaptureReceiverOptions {
  /** Dedicated DEV transport secret. Never reuse an application or production credential. */
  token: string;
  /** Writable receiver journal directory on the same host as the Dashboard database. */
  directory: string;
  /** Stable deployment identity returned to senders, such as "DEV" or "LIVE". */
  target: string;
}

/** A separate minimal listener: tunnel/proxy clients cannot reach Dashboard read/delete/Ask routes. */
export function createCaptureApp(store: SnapshotStore, options: CaptureReceiverOptions): Express {
  const app = express();
  app.use(hostGuard(LOOPBACK_HOSTNAMES));
  app.use(express.json({ limit: "10mb" }));
  captureReceiver(app, store, options);
  app.use((_req, res) => res.status(404).json({ error: "Not found.", code: "NOT_FOUND" }));
  return app;
}

interface CaptureEnvelope {
  captureId: string;
  target: string;
  sha256: string;
  payloadSha256: string;
  text: string;
  currencies?: unknown;
}

function jsonError(res: Response, status: number, error: string, code: string) {
  return res.status(status).json({ error, code });
}

function validSecret(expected: string, provided: string | undefined): boolean {
  if (!provided?.startsWith("Bearer ")) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(provided.slice(7));
  return a.length === b.length && timingSafeEqual(a, b);
}
function payloadDigest(target: string, text: string, currencies: unknown): string {
  return createHash("sha256").update(JSON.stringify([target, text, currencies ?? null]), "utf8").digest("hex");
}

function durableWrite(file: string, value: string) {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeSync(fd, value, undefined, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, file);
  const dirFd = openSync(path.dirname(file), "r");
  try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
}

function readReceipt(file: string): { captureId: string; sha256: string; payloadSha256: string; acceptedAt: string; result: unknown } | undefined {
  if (!existsSync(file)) return undefined;
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return undefined; }
}

/** Adds a separate, authenticated ingestion endpoint. The ordinary browser import API is unchanged. */
export function captureReceiver(app: Express, store: SnapshotStore, options: CaptureReceiverOptions): void {
  if (options.token.length < 32) throw new Error("WOWSYNC_CAPTURE_TOKEN must contain at least 32 characters.");
  if (!path.isAbsolute(options.directory)) throw new Error("WOWSYNC_CAPTURE_DIR must be an absolute path.");
  if (!/^[A-Z][A-Z0-9_-]{1,15}$/.test(options.target)) throw new Error("WOWSYNC_CAPTURE_TARGET must be a short uppercase deployment name.");
  const dir = path.resolve(options.directory);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const inFlight = new Map<string, { payloadSha256: string; promise: Promise<unknown> }>();

  app.post("/api/captures", async (req: Request, res: Response) => {
    if (!validSecret(options.token, req.header("authorization"))) return jsonError(res, 401, "Capture authorization required.", "CAPTURE_UNAUTHORIZED");
    const body = req.body as Partial<CaptureEnvelope> | undefined;
    if (typeof body?.captureId !== "string" || !ID.test(body.captureId)) return jsonError(res, 400, "A UUID v4 captureId is required.", "INVALID_CAPTURE_ID");
    if (typeof body.text !== "string" || body.text.trim().length === 0) return jsonError(res, 400, "Capture text is required.", "MISSING_CAPTURE_TEXT");
    if (typeof body.sha256 !== "string" || !HASH.test(body.sha256)) return jsonError(res, 400, "A SHA-256 digest is required.", "INVALID_CAPTURE_HASH");
    const actual = createHash("sha256").update(body.text, "utf8").digest("hex");
    if (actual !== body.sha256.toLowerCase()) return jsonError(res, 422, "Capture digest does not match its text.", "CAPTURE_HASH_MISMATCH");
    if (typeof body.payloadSha256 !== "string" || !HASH.test(body.payloadSha256) || payloadDigest(body.target ?? "", body.text, body.currencies) !== body.payloadSha256.toLowerCase()) return jsonError(res, 422, "Capture payload digest does not match its immutable fields.", "CAPTURE_PAYLOAD_HASH_MISMATCH");

    const captureId = body.captureId.toLowerCase();
    if (body.target !== options.target) return jsonError(res, 409, `Capture is routed to ${body.target ?? "an unspecified target"}, but this receiver is ${options.target}.`, "CAPTURE_TARGET_MISMATCH");
    const payloadSha256 = body.payloadSha256.toLowerCase();
    const receiptPath = path.join(dir, `${captureId}.json`);
    const prior = readReceipt(receiptPath);
    if (prior) {
      if (prior.sha256 !== actual || prior.payloadSha256 !== payloadSha256) return jsonError(res, 409, "This captureId was already accepted with different content.", "CAPTURE_ID_CONFLICT");
      const staleStage = path.join(dir, `${captureId}.staging.json`);
      if (existsSync(staleStage)) unlinkSync(staleStage);
      return res.json({ target: options.target, receipt: prior, duplicate: true });
    }

    let pending = inFlight.get(captureId);
    if (pending && pending.payloadSha256 !== payloadSha256) return jsonError(res, 409, "This captureId is already being accepted with different content.", "CAPTURE_ID_CONFLICT");
    if (!pending) {
      const promise = (async () => {
        // Persist the exact immutable envelope before import. If the process stops here, retrying the
        // same id resumes safely; importSnapshot is idempotent and the receipt is written only after commit.
        const staged = path.join(dir, `${captureId}.staging.json`);
        if (existsSync(staged)) {
          const saved = JSON.parse(readFileSync(staged, "utf8")) as CaptureEnvelope;
          if (saved.sha256 !== actual || saved.payloadSha256 !== body.payloadSha256 || saved.text !== body.text || saved.target !== options.target || JSON.stringify(saved.currencies ?? null) !== JSON.stringify(body.currencies ?? null)) throw new Error("Capture ID conflicts with its durable staged payload.");
        } else {
          durableWrite(staged, JSON.stringify({ ...body, captureId, sha256: actual }));
        }
        const result = store.importSnapshot(body.text!, body.currencies === undefined ? {} : { currencies: body.currencies });
        const receipt = { captureId, sha256: actual, payloadSha256, acceptedAt: new Date().toISOString(), result: { isDuplicate: result.isDuplicate, identityKey: result.character.identityKey, snapshotId: result.snapshot.id } };
        durableWrite(receiptPath, JSON.stringify(receipt));
        unlinkSync(staged);
        return { target: options.target, receipt, duplicate: false };
      })();
      pending = { payloadSha256, promise };
      inFlight.set(captureId, pending);
      promise.finally(() => inFlight.delete(captureId)).catch(() => undefined);
    }
    try { return res.json(await pending.promise); }
    catch (error) {
      console.error("Capture receiver import failed:", error instanceof Error ? error.message : String(error));
      if (error instanceof WowSyncParseError) return jsonError(res, 422, error.message, "INVALID_WOWSYNC_EXPORT");
      if (error instanceof Error && error.message.includes("conflicts with its durable staged payload")) return jsonError(res, 409, error.message, "CAPTURE_ID_CONFLICT");
      return jsonError(res, 500, "Capture was not acknowledged; the sender may retry the same captureId.", "CAPTURE_IMPORT_FAILED");
    }
  });
}
