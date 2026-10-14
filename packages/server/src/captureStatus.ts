import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { CaptureStatusEvent } from "./watchSaved.ts";

export interface CaptureAgentStatus {
  schemaVersion: 1;
  target: "DEV";
  serviceState: "starting" | "running" | "waiting-for-files" | "stopped";
  processId: number;
  startedAt: string;
  heartbeatAt: string;
  watchRoot?: string;
  watchedFiles: Array<{ path: string; product: string }>;
  connectivity: "unknown" | "connected" | "unavailable";
  connectivityCheckedAt?: string;
  pendingSpoolCount: number;
  drainingBacklog: boolean;
  lastSavedVariablesObservation?: { at: string; path: string; product: string };
  lastExport?: { at: string; character?: string; realm?: string; version?: string; product: string };
  lastAcknowledgement?: { at: string; captureId: string; character?: string; realm?: string; version?: string; product: string };
  lastError?: { at: string; message: string };
}

/** Small local operational snapshot. It intentionally contains no credential or export text. */
export function createCaptureStatusWriter(file: string, now: () => Date = () => new Date()) {
  const destination = path.resolve(file);
  mkdirSync(path.dirname(destination), { recursive: true });
  let current: CaptureAgentStatus = {
    schemaVersion: 1,
    target: "DEV",
    serviceState: "starting",
    processId: process.pid,
    startedAt: now().toISOString(),
    heartbeatAt: now().toISOString(),
    watchedFiles: [],
    connectivity: "unknown",
    pendingSpoolCount: 0,
    drainingBacklog: false,
  };
  try {
    const prior = JSON.parse(readFileSync(destination, "utf8")) as Partial<CaptureAgentStatus>;
    if (prior.schemaVersion === 1 && prior.target === "DEV") {
      current = { ...current, lastSavedVariablesObservation: prior.lastSavedVariablesObservation, lastExport: prior.lastExport, lastAcknowledgement: prior.lastAcknowledgement, lastError: prior.lastError };
    }
  } catch { /* first run or an interrupted earlier write: start with a clean status record */ }

  // The status file is advisory. On Windows a reader (tray icon, antivirus, indexer) holding status.json
  // open makes the replace fail with EPERM/EBUSY for a moment; retry briefly, then skip this update.
  // A status write must never stop capture.
  function write(patch: Partial<CaptureAgentStatus> = {}): void {
    current = { ...current, ...patch, heartbeatAt: now().toISOString() };
    const temporary = `${destination}.${process.pid}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(current, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      for (let attempt = 0; ; attempt += 1) {
        try { renameSync(temporary, destination); return; } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (attempt >= 5 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw error;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * (attempt + 1));
        }
      }
    } catch (error) {
      try { unlinkSync(temporary); } catch { /* already gone */ }
      process.stderr.write(`capture status not updated (${(error as NodeJS.ErrnoException).code ?? "error"}); capture continues\n`);
    }
  }

  function apply(event: CaptureStatusEvent): void {
    switch (event.type) {
      case "service": write({ serviceState: event.state, ...(event.watchRoot ? { watchRoot: event.watchRoot } : {}) }); break;
      case "targets": write({ watchedFiles: event.files }); break;
      case "pending": write({ pendingSpoolCount: event.count, drainingBacklog: event.draining }); break;
      case "connectivity": write({ connectivity: event.state, connectivityCheckedAt: event.checkedAt }); break;
      case "observation": write({ lastSavedVariablesObservation: { at: event.at, path: event.file, product: event.product } }); break;
      case "export": write({ lastExport: { at: event.at, product: event.product, character: event.character, realm: event.realm, version: event.version } }); break;
      case "acknowledgement": write({ lastAcknowledgement: { at: event.at, captureId: event.captureId, product: event.product, character: event.character, realm: event.realm, version: event.version } }); break;
      case "error": write({ lastError: { at: event.at, message: event.message } }); break;
    }
  }

  return { write, apply, snapshot: () => ({ ...current }) };
}
