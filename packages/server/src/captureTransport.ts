import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";
import { ImportPostError } from "./importSaved.ts";

export interface CaptureEnvelope {
  captureId: string;
  target: string;
  sha256: string;
  payloadSha256: string;
  text: string;
  currencies?: unknown;
}

export interface CaptureTransportOptions {
  origin: string;
  token: string;
  target: string;
  spoolDirectory: string;
  fetch: typeof fetch;
  timeoutMs?: number;
  onConnectivity?: (state: "connected" | "unavailable", checkedAt: string) => void;
}

function digest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
function payloadDigest(target: string, text: string, currencies: unknown): string {
  return createHash("sha256").update(JSON.stringify([target, text, currencies ?? null]), "utf8").digest("hex");
}

function stage(directory: string, capture: CaptureEnvelope): string {
  const destination = path.join(directory, `${capture.captureId}.json`);
  const temporary = `${destination}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try { writeSync(fd, JSON.stringify(capture), undefined, "utf8"); fsyncSync(fd); }
  finally { closeSync(fd); }
  renameSync(temporary, destination);
  return destination;
}

function isCapture(value: unknown): value is CaptureEnvelope {
  const c = value as Partial<CaptureEnvelope> | null;
  return !!c && typeof c.captureId === "string" && typeof c.target === "string" && typeof c.sha256 === "string" && typeof c.payloadSha256 === "string" && typeof c.text === "string";
}

/** Durable Windows outbox. A spool file is removed only after the receiver confirms its durable receipt. */
export function createCaptureTransport(options: CaptureTransportOptions) {
  if (options.token.length < 32) throw new Error("A dedicated capture token of at least 32 characters is required.");
  if (!path.isAbsolute(options.spoolDirectory)) throw new Error("Capture spool directory must be an absolute path.");
  mkdirSync(options.spoolDirectory, { recursive: true, mode: 0o700 });
  const directory = path.resolve(options.spoolDirectory);
  let failures = 0;
  let retryAt = 0;
  let lastProbeAt = 0;
  const acknowledged = new Map<string, CaptureEnvelope>();

  async function deliver(file: string, capture: CaptureEnvelope): Promise<void> {
    let response: Response;
    try {
      response = await options.fetch(`${options.origin}/api/captures`, {
        method: "POST",
        headers: { Authorization: `Bearer ${options.token}`, "Content-Type": "application/json" },
        body: JSON.stringify(capture),
        signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
      });
    } catch (error) {
      options.onConnectivity?.("unavailable", new Date().toISOString());
      const why = (error as Error).name === "TimeoutError" ? "request timed out" : ((error as Error & { cause?: { code?: string } }).cause?.code ?? (error as Error).message);
      const delay = Math.min(60_000, 5_000 * 2 ** failures++);
      retryAt = Date.now() + delay;
      throw new ImportPostError(`Capture receiver at ${options.origin} is unreachable (${why}); the capture remains in ${file}. Retry in ${Math.ceil(delay / 1000)}s.`, "unreachable");
    }
    options.onConnectivity?.("connected", new Date().toISOString());
    const raw = await response.text();
    let body: any;
    try { body = raw ? JSON.parse(raw) : undefined; } catch { body = undefined; }
    if (!response.ok) throw new ImportPostError(`Capture receiver refused the capture (HTTP ${response.status}): ${body?.error ?? raw.slice(0, 300) ?? response.statusText}. The outbox copy is retained.`, "refused");
    const receipt = body?.receipt;
    if (body?.target !== options.target || receipt?.captureId !== capture.captureId || receipt?.sha256 !== capture.sha256 || receipt?.payloadSha256 !== capture.payloadSha256) {
      throw new ImportPostError("Receiver response did not acknowledge the expected target and capture identity. The outbox copy is retained.", "refused");
    }
    unlinkSync(file);
    acknowledged.set(capture.payloadSha256, capture);
    failures = 0;
    retryAt = 0;
  }

  async function flush(force = false): Promise<void> {
    if (!force && Date.now() < retryAt) return;
    const files = readdirSync(directory).filter((name) => name.endsWith(".json")).sort();
    for (const name of files) {
      const file = path.join(directory, name);
      let capture: unknown;
      try { capture = JSON.parse(readFileSync(file, "utf8")); }
      catch { throw new ImportPostError(`Invalid capture outbox entry ${file}; it is retained for inspection.`, "refused"); }
      if (!isCapture(capture) || capture.target !== options.target || digest(capture.text) !== capture.sha256 || payloadDigest(capture.target, capture.text, capture.currencies) !== capture.payloadSha256) {
        throw new ImportPostError(`Capture outbox entry ${file} failed its identity, target, or digest check; it is retained.`, "refused");
      }
      await deliver(file, capture);
    }
  }

  async function send(text: string, currencies?: unknown): Promise<CaptureEnvelope> {
    const sha256 = digest(text);
    const payloadSha256 = payloadDigest(options.target, text, currencies);
    const alreadyAcknowledged = acknowledged.get(payloadSha256);
    if (alreadyAcknowledged) return alreadyAcknowledged;
    let capture: CaptureEnvelope | undefined;
    for (const name of readdirSync(directory).filter((entry) => entry.endsWith(".json")).sort()) {
      try {
        const candidate = JSON.parse(readFileSync(path.join(directory, name), "utf8")) as CaptureEnvelope;
        if (candidate.target === options.target && candidate.sha256 === sha256 && candidate.payloadSha256 === payloadSha256 && candidate.text === text && JSON.stringify(candidate.currencies ?? null) === JSON.stringify(currencies ?? null)) {
          capture = candidate;
          break;
        }
      } catch { /* flush() reports malformed entries without deleting them. */ }
    }
    capture ??= { captureId: randomUUID(), target: options.target, sha256, payloadSha256, text, ...(currencies === undefined ? {} : { currencies }) };
    const file = path.join(directory, `${capture.captureId}.json`);
    try { readFileSync(file); }
    catch { stage(directory, capture); }
    await flush(true);
    // A successful flush removes it; reaching here is the receiver's durable acknowledgement.
    return capture;
  }

  function pendingCount(): number {
    return readdirSync(directory).filter((name) => name.endsWith(".json")).length;
  }

  async function probe(force = false): Promise<void> {
    if (!force && Date.now() - lastProbeAt < 30_000) return;
    lastProbeAt = Date.now();
    let state: "connected" | "unavailable" = "unavailable";
    try {
      const response = await options.fetch(`${options.origin}/api/captures`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(Math.min(options.timeoutMs ?? 30_000, 5_000)),
      });
      // This capture-only endpoint authenticates before validating request content.
      // Its expected 401 proves connectivity without sending or logging the token.
      if (response.status === 401) state = "connected";
    } catch { /* unavailable */ }
    options.onConnectivity?.(state, new Date().toISOString());
  }

  return { flush: () => flush(), send, pendingCount, probe };
}
