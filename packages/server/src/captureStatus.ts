import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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

  function write(patch: Partial<CaptureAgentStatus> = {}): void {
    current = { ...current, ...patch, heartbeatAt: now().toISOString() };
    const temporary = `${destination}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(current, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, destination);
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
