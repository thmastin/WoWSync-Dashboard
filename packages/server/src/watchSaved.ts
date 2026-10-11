// The foreground watcher (ROADMAP #8, slice 1) detects stable SavedVariables writes and sends each character's newest
// persisted export through the same bridge code `import:saved` uses. Design and rationale:
// docs/DESKTOP_COMPANION_FEASIBILITY.md. It is the developer bridge (importSaved.ts) run by a loop, and nothing more:
//
//  - It has NO importer of its own. Reading the file (`parseSavedExports`), describing/validating the text (`describeExport`,
//    `consistencyProblems`) and the send itself (`postImport`) are the bridge's; parsing, dedupe, snapshots, shared storage
//    and item metadata are the server's. No second parser, no database, no diff logic.
//  - READ-ONLY. It only stats and reads one file: never a write handle, rename, delete, lock or spawn, and nothing is
//    evaluated (the file is parsed as data). It cannot make WoW save and does not try.
//  - WoW saves SavedVariables at /reload, logout and exit, NOT at /wowsync. So it can only deliver an export at the next
//    save, and it says so instead of implying it knows when /wowsync ran. mtime is a "look now" trigger only: the export's
//    own `Generated` is its observation time, and the exact persisted text is what is sent.
//  - It POSTs only to a loopback Dashboard (no token in this slice: see ROADMAP "Needs Decision").
//
// Pure of process state like importSaved.ts: filesystem, clock, fetch and output are injected, and `tick()` is a single
// deterministic step, so the tests drive a fake clock over a fake filesystem. `watchSavedCli.ts` is the thin process entry.
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  BridgeError,
  ImportPostError,
  assertSavedVariablesSize,
  consistencyProblems,
  describeExport,
  describeImportResult,
  discoverWatchTargets,
  findSavedVariablesFiles,
  importEndpoint,
  watchTargetLabel,
  iso,
  parseSavedExports,
  postImport,
  resolveDashboardUrl,
  sidecarPayloadHash,
  type SavedExport,
} from "./importSaved.ts";
import type { createCaptureTransport } from "./captureTransport.ts";
import { createCaptureTransport as makeCaptureTransport } from "./captureTransport.ts";

export const DEFAULT_POLL_MS = 2_000;
/** How long the file must stay unchanged (size and mtime) before it is read: WoW may still be writing it. */
export const DEFAULT_QUIET_MS = 3_000;
/** A failed read (a Windows sharing violation while WoW holds the file) is retried this many times in all, then left until the file changes. */
export const READ_ATTEMPTS = 3;
/** A Dashboard that cannot be reached is retried after 5s, 10s, 20s, ... up to this. */
export const RETRY_BASE_MS = 5_000;
export const RETRY_MAX_MS = 60_000;

// --- selecting what to send ---------------------------------------------------------------------------

/**
 * Select one globally newest record only for callers that explicitly need a single export. The watcher
 * imports each canonical character's newest record independently and does not use this helper.
 */
export function selectNewestExport(records: readonly SavedExport[]): SavedExport | undefined {
  const withText = records.filter((r) => r.text !== undefined);
  if (withText.length === 0) return undefined;
  const newest = Math.max(...withText.map((r) => r.generatedAt ?? 0));
  const top = withText.filter((r) => (r.generatedAt ?? 0) === newest);
  if (new Set(top.map((r) => r.text)).size > 1) {
    throw new BridgeError(`${top.length} saved records were generated at the same time (${iso(newest)}) with different text; refusing to guess which is newest.`);
  }
  return top[0];
}

// --- the watcher --------------------------------------------------------------------------------------

/** The two filesystem calls the watcher makes, both read-only. Injected so tests need no real file to be "still changing". */
export interface WatchFs {
  stat(path: string): { size: number; mtimeMs: number };
  readText(path: string): string;
}
export const nodeFs: WatchFs = {
  stat: (p) => {
    const s = statSync(p);
    return { size: s.size, mtimeMs: s.mtimeMs };
  },
  readText: (p) => readFileSync(p, "utf8"),
};

export interface WatchConfig {
  /** The one SavedVariables file to watch. */
  file: string;
  /** The Dashboard's origin (already checked to be loopback). */
  origin: string;
  /** `--once`: catch up every character export currently saved in each file, then finish. */
  once: boolean;
  pollMs: number;
  quietMs: number;
  /** Import each latest-per-character persisted export when a persistent service attaches to a file. */
  initialImport?: boolean;
}

export type CaptureStatusEvent =
  | { type: "service"; state: "running" | "waiting-for-files" | "stopped"; watchRoot?: string }
  | { type: "targets"; files: Array<{ path: string; product: string }> }
  | { type: "pending"; count: number; draining: boolean }
  | { type: "observation"; at: string; file: string; product: string }
  | { type: "export"; at: string; file: string; product: string; character?: string; realm?: string; version?: string }
  | { type: "acknowledgement"; at: string; file: string; product: string; captureId: string; character?: string; realm?: string; version?: string }
  | { type: "connectivity"; state: "connected" | "unavailable"; checkedAt: string }
  | { type: "error"; at: string; message: string };

export interface WatchDeps {
  fs: WatchFs;
  /** Monotonic milliseconds. */
  clock: () => number;
  fetch: typeof fetch;
  timeoutMs?: number;
  out: (line: string) => void;
  err: (line: string) => void;
  /** Optional authenticated remote receiver with a durable local outbox. */
  captureTransport?: ReturnType<typeof createCaptureTransport>;
  status?: (event: CaptureStatusEvent) => void;
}

export interface Watcher {
  /** One poll: stat, and, when a change has been quiet long enough, read and (if new) send. Never throws for a fixable problem. */
  tick(): Promise<void>;
  /** True once `--once` has reached its answer; a continuous watcher never finishes on its own. */
  readonly finished: boolean;
  /** 0 when `--once` imported (or found the export already imported); 1 otherwise. */
  readonly exitCode: number;
}

interface Sent {
  generatedAt: number;
  sha256: string;
  /** Structured SavedVariables domains are not part of text, so they need independent deduplication. */
  structuredSha256: string;
}

export function createWatcher(config: WatchConfig, deps: WatchDeps): Watcher {
  const { fs, out, err } = deps;
  let started = false;
  let signature: string | undefined; // "size:mtimeMs" at the last poll; undefined when the file could not be stat'ed
  let statProblem: string | undefined;
  let mtimeMs = 0;
  let size = 0;
  let changedAt = 0; // clock at which `signature` was first seen
  let pending = false; // a change (or the --once catch-up) is waiting to be read
  let readFailures = 0;
  let sendFailures = 0;
  let retryAt = 0;
  // SavedVariables contains the latest export for several characters. Keep
  // an acknowledgement cursor per canonical character identity so a newer
  // export for another character cannot hide this character's update.
  // A process restart replays current records once; snapshot imports are idempotent.
  const lastSentByIdentity = new Map<string, Sent>();
  let finished = false;
  let exitCode = 0;

  const finish = (code: number) => {
    pending = false;
    if (config.once) {
      finished = true;
      exitCode = code;
    }
  };
  /** Give up on this version of the file; the next change to it is tried afresh. */
  const stop = (message: string) => {
    deps.status?.({ type: "error", at: new Date().toISOString(), message });
    err(config.once ? message : `${message}\n  Waiting for the file to change again.`);
    finish(1);
  };

  async function deliver(now: number): Promise<void> {
    let source: string;
    try {
      assertSavedVariablesSize(config.file, size);
      source = fs.readText(config.file);
    } catch (e) {
      if (e instanceof BridgeError) return stop(e.message);
      // A transient IO error (on Windows, a sharing violation while WoW writes): retry a bounded number of times.
      readFailures++;
      const why = (e as Error).message;
      if (readFailures >= READ_ATTEMPTS) return stop(`Cannot read ${config.file} (${why}) after ${readFailures} attempts.`);
      err(`Cannot read ${config.file} yet (${why}); retrying.`);
      retryAt = now + config.pollMs;
      return;
    }

    let records: SavedExport[];
    try {
      records = parseSavedExports(source, config.file);
    } catch (e) {
      if (e instanceof BridgeError) return stop(e.message);
      throw e;
    }
    const withText = records.filter((record) => record.text !== undefined);
    if (withText.length === 0) {
      out("The file has no saved export (no latestExport.text on any character): nothing to send. Run /wowsync, then /reload or log out.");
      return finish(1);
    }

    const product = watchTargetLabel(config.file);
    const stranded = records.filter((record) => record.text === undefined && (record.currencies !== undefined || record.characterState !== undefined));
    for (const record of stranded) {
      out(`  Structured read for ${record.name ?? "?"} · ${record.realm ?? "?"} has no saved text export to attach to; run /wowsync on that character, then /reload or log out.`);
    }

    const invalid: string[] = [];
    const byIdentity = new Map<string, { record: SavedExport; text: string; summary: ReturnType<typeof describeExport>; structuredSha256: string; generatedAt: number; identityKey: string }>();
    const conflictingIdentities = new Set<string>();
    for (const record of withText) {
      const text = record.text!;
      const summary = describeExport(text);
      const problems = consistencyProblems(record, summary, { character: summary.name ?? record.name ?? "" });
      if (problems.length > 0) {
        invalid.push(`${record.name ?? "?"} · ${record.realm ?? "?"}: ${problems.join("; ")}`);
        continue;
      }
      const identityKey = summary.identityKey ?? `${summary.version ?? "unknown"}::${record.realm ?? "?"}::${record.name ?? "?"}`;
      const structuredSha256 = sidecarPayloadHash({ currencies: record.currencies, characterState: record.characterState, equipmentObservation: record.equipmentObservation });
      const generatedAt = summary.generatedAt ?? record.generatedAt ?? 0;
      if (conflictingIdentities.has(identityKey)) continue;
      const existing = byIdentity.get(identityKey);
      if (existing && generatedAt === existing.generatedAt) {
        if (summary.sha256 !== existing.summary.sha256 || structuredSha256 !== existing.structuredSha256) {
          invalid.push(`${record.name ?? "?"} - ${record.realm ?? "?"}: conflicting records have the same character identity and generation time.`);
          byIdentity.delete(identityKey);
          conflictingIdentities.add(identityKey);
        }
        continue;
      }
      if (existing && generatedAt < existing.generatedAt) continue;
      byIdentity.set(identityKey, { record, text, summary, structuredSha256, generatedAt, identityKey });
    }

    const pendingExports: Array<{ record: SavedExport; text: string; summary: ReturnType<typeof describeExport>; structuredSha256: string; generatedAt: number; identityKey: string; previous?: Sent }> = [];
    for (const item of byIdentity.values()) {
      const previous = lastSentByIdentity.get(item.identityKey);
      if (previous && previous.generatedAt === item.generatedAt && previous.sha256 === item.summary.sha256 && previous.structuredSha256 === item.structuredSha256) continue;
      if (previous && item.generatedAt < previous.generatedAt) {
        out(`  Older ${item.record.name ?? "?"} export (${iso(item.generatedAt)}) is behind its acknowledged export (${iso(previous.generatedAt)}); not sent.`);
        continue;
      }
      pendingExports.push({ ...item, previous });
    }

    if (invalid.length > 0) {
      const message = `Some saved exports were not sent because they are inconsistent:\n${invalid.map((item) => `  - ${item}`).join("\n")}`;
      deps.status?.({ type: "error", at: new Date().toISOString(), message });
      err(message);
    }
    pendingExports.sort((a, b) => a.generatedAt - b.generatedAt || a.identityKey.localeCompare(b.identityKey));
    if (pendingExports.length === 0) {
      if (invalid.length === withText.length) return stop("No saved character export passed consistency validation; nothing was sent.");
      out("Saved character exports are unchanged; nothing to send.");
      return finish(invalid.length > 0 ? 1 : 0);
    }
    out(`SavedVariables last written ${iso(Math.floor(mtimeMs / 1000))}; checking ${withText.length} saved character export(s).`);

    for (const item of pendingExports) {
      const { record, text, summary, structuredSha256, generatedAt, identityKey, previous } = item;
      const { sha256: exportSha } = summary;
      const fields = { file: config.file, product, character: summary.name, realm: summary.realm, version: summary.version };
      deps.status?.({ type: "export", at: new Date().toISOString(), ...fields });
      out(`  ${summary.name ?? "?"} · ${summary.realm ?? "?"}: export generated ${iso(generatedAt)}.`);
      if (previous && previous.generatedAt === generatedAt && previous.sha256 === exportSha) {
        out("  Same text with changed structured SavedVariables state: attaching the newer sidecar observations.");
      }
      out(`  Sending ${summary.bytes} text bytes plus structured SavedVariables state (SHA-256 ${exportSha}) to ${deps.captureTransport ? `${config.origin}/api/captures` : importEndpoint(config.origin)} ...`);
      try {
        if (deps.captureTransport) {
          const capture = await deps.captureTransport.send(text, record.currencies, record.characterState, record.equipmentObservation);
          deps.status?.({ type: "acknowledgement", at: new Date().toISOString(), ...fields, captureId: capture.captureId });
          out(`  Receiver acknowledged capture ${capture.captureId} for ${capture.target}; durable outbox copy removed.`);
        } else {
          const result = await postImport(deps, config.origin, text, record.currencies, record.characterState, record.equipmentObservation);
          for (const line of describeImportResult(result, exportSha)) out(`  ${line}`);
        }
        lastSentByIdentity.set(identityKey, { generatedAt, sha256: exportSha, structuredSha256 });
        sendFailures = 0;
      } catch (e) {
        if (e instanceof ImportPostError && e.failure === "unreachable" && !config.once) {
          // The source file remains authoritative; retry the unacknowledged character exports with capped backoff.
          const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** sendFailures++);
          retryAt = now + delay;
          deps.status?.({ type: "error", at: new Date().toISOString(), message: e.message });
          err(`${e.message}\n  Will retry in ${Math.round(delay / 1000)}s.`);
          return;
        }
        if (e instanceof BridgeError) return stop(e.message); // The receiver refused this export; retry only after source change/restart.
        throw e;
      }
    }
    return finish(invalid.length > 0 ? 1 : 0);
  }

  return {
    get finished() {
      return finished;
    },
    get exitCode() {
      return exitCode;
    },
    async tick() {
      if (finished) return;
      const now = deps.clock();
      let next: string | undefined;
      try {
        const s = fs.stat(config.file);
        next = `${s.size}:${s.mtimeMs}`;
        size = s.size;
        mtimeMs = s.mtimeMs;
        if (statProblem !== undefined) out(`${config.file} is readable again.`);
        statProblem = undefined;
      } catch (e) {
        const why = (e as Error).message;
        if (why !== statProblem) err(`Cannot stat ${config.file} (${why}).`);
        statProblem = why;
      }

      if (!started) {
        started = true;
        signature = next;
        changedAt = now;
        if (next !== undefined) deps.status?.({ type: "observation", at: new Date().toISOString(), file: config.file, product: watchTargetLabel(config.file) });
        if (config.once) {
          if (next === undefined) return stop("The SavedVariables file cannot be read.");
          pending = true;
          out("Waiting for the file to be stable, then checking all saved character exports once.");
        } else if (config.initialImport && next !== undefined) {
          pending = true;
          out("Persistent capture attached to this SavedVariables file; checking all latest-per-character exports.");
        }
      } else if (next !== signature) {
        signature = next;
        changedAt = now;
        readFailures = 0;
        sendFailures = 0;
        retryAt = 0;
        if (next !== undefined) {
          if (!pending) out("SavedVariables changed (WoW saved it); waiting for it to stop changing ...");
          pending = true;
        }
      }

      if (!pending || next === undefined || now - changedAt < config.quietMs || now < retryAt) return;
      try {
        await deliver(now);
      } catch (e) {
        // Anything unexpected must not turn into a tight retry loop or a dead watcher.
        err(`Unexpected failure: ${e instanceof Error ? e.message : String(e)}`);
        finish(1);
      }
    },
  };
}

// --- options and running ------------------------------------------------------------------------------

export const USAGE = `Usage: npm run watch:saved -- [options]

Watches one or more GearExport SavedVariables files and, when WoW saves them, sends each changed character export to the running Dashboard
through the normal POST /api/import. Foreground; stop it with Ctrl+C. Read-only: it never writes to SavedVariables or WoW,
and cannot make WoW save.

Point --wow-dir at the install root (e.g. "D:\\World of Warcraft") to watch every product that has GearExport.lua
(_retail_, _anniversary_, _classic_era_, _classic_, _classic_beta_). Point it at one product folder to watch only that client.
--file still watches a single file. import:saved still refuses when several files match; only the watcher accepts multiples.

WoW writes SavedVariables when you /reload, log out or exit, NOT when you run /wowsync. An export arrives on the next save.

  --file <path>          One GearExport.lua SavedVariables file.
  --wow-dir <path>       WoW install root (all products) or ONE product folder such as _retail_.
  --url <url>            Receiver URL (default: from PORT / WOWSYNC_HOST, else http://127.0.0.1:4173).
  --capture-target <id>  Send to the authenticated capture receiver (for example DEV); requires token and spool directory.
  --spool-dir <path>     Absolute durable outbox path (or WOWSYNC_CAPTURE_SPOOL_DIR).
  --service              Persistent mode: discover new files and catch up each character's latest saved export after startup.
  --once                 Import changed saved character exports from each watched file now, then exit (a catch-up). Without it, each file's
                         state at startup is ignored and only later saves are imported.
  --help                 This text.

Environment (a .env file works too): WOWSYNC_SAVED_VARIABLES, WOWSYNC_WOW_DIR, WOWSYNC_URL,
WOWSYNC_CAPTURE_TARGET, WOWSYNC_CAPTURE_TOKEN, WOWSYNC_CAPTURE_SPOOL_DIR, WOWSYNC_CAPTURE_STATUS_PATH.`;

export interface WatchOptions {
  once: boolean;
  help: boolean;
  file?: string;
  wowDir?: string;
  url?: string;
  captureTarget?: string;
  spoolDir?: string;
  service: boolean;
}

export function parseWatchOptions(argv: readonly string[]): WatchOptions {
  try {
    const { values, positionals } = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        once: { type: "boolean" },
        help: { type: "boolean", short: "h" },
        file: { type: "string" },
        "wow-dir": { type: "string" },
        url: { type: "string" },
        "capture-target": { type: "string" },
        "spool-dir": { type: "string" },
        service: { type: "boolean" },
      },
    });
    if (positionals.length > 0) throw new BridgeError(`Unexpected argument "${positionals[0]}".`, true);
    return { once: values.once === true, help: values.help === true, file: values.file, wowDir: values["wow-dir"], url: values.url, captureTarget: values["capture-target"], spoolDir: values["spool-dir"], service: values.service === true };
  } catch (err) {
    if (err instanceof BridgeError) throw err;
    throw new BridgeError((err as Error).message, true);
  }
}

export interface RunDeps extends WatchDeps {
  env: Record<string, string | undefined>;
  /** Resolves after `ms`, or as soon as `signal` aborts. */
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  pollMs?: number;
  quietMs?: number;
}

/** Runs the watcher until `signal` aborts (or, with --once, until it has its answer). Resolves to the process exit code. */
export async function runWatchSaved(argv: readonly string[], deps: RunDeps, signal: AbortSignal): Promise<number> {
  try {
    const options = parseWatchOptions(argv);
    if (options.help) {
      for (const line of USAGE.split("\n")) deps.out(line);
      return 0;
    }
    let found: ReturnType<typeof discoverWatchTargets>;
    let serviceRoot: string | undefined;
    if (options.service) {
      if (options.file) throw new BridgeError("Persistent service mode requires --wow-dir so product/account files can be discovered.", true);
      const root = options.wowDir?.trim() || deps.env.WOWSYNC_WOW_DIR?.trim();
      if (!root) throw new BridgeError("Persistent service mode requires --wow-dir or WOWSYNC_WOW_DIR.", true);
      serviceRoot = path.resolve(root);
      try { if (!statSync(serviceRoot).isDirectory()) throw new Error("not a directory"); }
      catch { throw new BridgeError(`WoW install folder not found: ${serviceRoot}`, true); }
      found = findSavedVariablesFiles(serviceRoot).map((file) => ({ path: file, via: "--service product/account discovery" }));
    } else {
      found = discoverWatchTargets({ file: options.file, wowDir: options.wowDir, env: deps.env });
    }
    const target = resolveDashboardUrl(options, deps.env);
    const captureTarget = options.captureTarget?.trim() || deps.env.WOWSYNC_CAPTURE_TARGET?.trim();
    if (target.warning && !captureTarget) {
      throw new BridgeError(`Refusing to watch: ${target.warning}\n  Remote capture requires --capture-target, a dedicated token, and a durable outbox.`);
    }
    if (target.warning && new URL(target.origin).protocol !== "https:") throw new BridgeError("Remote capture requires HTTPS. For the current DEV host, use a private SSH tunnel and a loopback URL.");
    let captureTransport: WatchDeps["captureTransport"];
    if (captureTarget) {
      const token = deps.env.WOWSYNC_CAPTURE_TOKEN?.trim();
      const spoolDirectory = options.spoolDir?.trim() || deps.env.WOWSYNC_CAPTURE_SPOOL_DIR?.trim();
      if (!token || token.length < 32) throw new BridgeError("Authenticated capture needs WOWSYNC_CAPTURE_TOKEN (at least 32 characters).", true);
      if (!spoolDirectory || !path.isAbsolute(spoolDirectory)) throw new BridgeError("Authenticated capture needs an absolute --spool-dir or WOWSYNC_CAPTURE_SPOOL_DIR.", true);
      if (!/^[A-Z][A-Z0-9_-]{1,15}$/.test(captureTarget)) throw new BridgeError("Capture target must be a short uppercase name such as DEV.", true);
      captureTransport = makeCaptureTransport({ origin: target.origin, token, target: captureTarget, spoolDirectory, fetch: deps.fetch, timeoutMs: deps.timeoutMs, onConnectivity: (state, checkedAt) => deps.status?.({ type: "connectivity", state, checkedAt }) });
    }
    const pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
    const quietMs = deps.quietMs ?? DEFAULT_QUIET_MS;
    const multi = options.service || found.length > 1;
    if (options.service) {
      deps.out(`Persistent capture discovery under ${serviceRoot}; new product/account files are added automatically.`);
      if (found.length === 0) deps.out("No GearExport.lua SavedVariables files exist yet; waiting for WoW to create them.");
    } else if (multi) {
      deps.out(`Watching ${found.length} SavedVariables files  (from ${found[0].via}; read-only)`);
      for (const f of found) deps.out(`  [${watchTargetLabel(f.path)}] ${f.path}`);
    } else {
      deps.out(`Watching ${found[0].path}  (from ${found[0].via}; read-only)`);
    }
    deps.out(`${captureTarget ? `Capture receiver (${captureTarget})` : "Dashboard"}:  ${captureTarget ? `${target.origin}/api/captures` : importEndpoint(target.origin)}`);
    deps.out(`Polling every ${pollMs / 1000}s; a change is read once the file has been unchanged for ${quietMs / 1000}s.`);
    if (!options.once && !options.service) {
      deps.out("WoW saves SavedVariables at /reload, logout or exit, not at /wowsync: an export arrives then. Each file's current contents are ignored (use --once to import saved character exports now).");
    }

    const watchers = new Map<string, Watcher>();
    const addWatcher = (f: { path: string; via: string }) => {
      if (watchers.has(f.path)) return;
      const label = watchTargetLabel(f.path);
      const prefix = multi ? `[${label}] ` : "";
      const fileDeps: WatchDeps = {
        ...deps,
        captureTransport,
        out: (line) => deps.out(line.startsWith(" ") || line === "" ? line : `${prefix}${line}`),
        err: (line) => deps.err(line.startsWith(" ") || line === "" ? line : `${prefix}${line}`),
      };
      watchers.set(f.path, createWatcher({ file: f.path, origin: target.origin, once: options.once, pollMs, quietMs, initialImport: options.service }, fileDeps));
    };
    for (const f of found) addWatcher(f);
    const reportTargets = () => {
      const files = [...watchers.keys()].map((file) => ({ path: file, product: watchTargetLabel(file) }));
      deps.status?.({ type: "targets", files });
      if (options.service) deps.status?.({ type: "service", state: files.length ? "running" : "waiting-for-files", watchRoot: serviceRoot });
    };
    reportTargets();

    while (!signal.aborted && (options.service || ![...watchers.values()].every((w) => w.finished))) {
      if (options.service && serviceRoot) {
        const before = watchers.size;
        for (const file of findSavedVariablesFiles(serviceRoot)) addWatcher({ path: file, via: "--service product/account discovery" });
        if (watchers.size !== before) reportTargets();
      }
      const pendingBefore = captureTransport?.pendingCount() ?? 0;
      if (pendingBefore > 0) deps.status?.({ type: "pending", count: pendingBefore, draining: true });
      if (captureTransport) {
        if (options.service) await captureTransport.probe();
        try { await captureTransport.flush(); }
        catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          deps.err(message);
          deps.status?.({ type: "error", at: new Date().toISOString(), message });
        }
      }
      for (const w of watchers.values()) {
        if (!w.finished) await w.tick();
      }
      const pendingAfter = captureTransport?.pendingCount() ?? 0;
      deps.status?.({ type: "pending", count: pendingAfter, draining: pendingAfter > 0 && pendingAfter < pendingBefore });
      if (!options.service && [...watchers.values()].every((w) => w.finished)) break;
      await deps.sleep(pollMs, signal);
    }
    if (options.service) deps.status?.({ type: "service", state: "stopped", watchRoot: serviceRoot });
    if (![...watchers.values()].some((w) => w.finished)) return 0;
    return Math.max(...[...watchers.values()].map((w) => w.exitCode));
  } catch (err) {
    if (err instanceof BridgeError) {
      deps.err(`error: ${err.message}`);
      if (err.usage) for (const line of ["", ...USAGE.split("\n")]) deps.err(line);
      return err.usage ? 2 : 1;
    }
    throw err;
  }
}
