// The foreground watcher (ROADMAP #8, slice 1): notice that WoW has saved GearExport's SavedVariables file, and send the
// newest persisted export through the Dashboard's normal `POST /api/import`. Design and rationale:
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
import { parseArgs } from "node:util";
import {
  BridgeError,
  ImportPostError,
  assertSavedVariablesSize,
  consistencyProblems,
  describeExport,
  describeImportResult,
  discoverSavedVariables,
  importEndpoint,
  iso,
  parseSavedExports,
  postImport,
  resolveDashboardUrl,
  type SavedExport,
} from "./importSaved.ts";

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
 * The single export to send: the NEWEST `latestExport` (by `generatedAt`) across every saved character, or undefined when no
 * record has one. Two records generated at the same time with different text are refused rather than guessed between.
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
  /** `--once`: one catch-up import of the newest saved export, then finish. Otherwise only changes after start are acted on. */
  once: boolean;
  pollMs: number;
  quietMs: number;
}

export interface WatchDeps {
  fs: WatchFs;
  /** Monotonic milliseconds. */
  clock: () => number;
  fetch: typeof fetch;
  timeoutMs?: number;
  out: (line: string) => void;
  err: (line: string) => void;
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
  let lastSent: Sent | undefined; // in memory only: a restart re-sends once and the server no-ops
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

    let chosen: SavedExport | undefined;
    try {
      chosen = selectNewestExport(parseSavedExports(source, config.file));
    } catch (e) {
      if (e instanceof BridgeError) return stop(e.message);
      throw e;
    }
    if (chosen === undefined) {
      out("The file has no saved export (no latestExport.text on any character): nothing to send. Run /wowsync, then /reload or log out.");
      return finish(1);
    }

    const text = chosen.text!;
    const summary = describeExport(text);
    const problems = consistencyProblems(chosen, summary, { character: summary.name ?? chosen.name ?? "" });
    if (problems.length > 0) return stop(`Not sent: the newest saved export is not consistent.\n${problems.map((p) => `  - ${p}`).join("\n")}\n  Nothing was sent.`);

    const generatedAt = summary.generatedAt ?? chosen.generatedAt ?? 0;
    // What is actually known: when WoW last wrote the file, and when the newest export in it was generated. Not "no export since".
    out(`SavedVariables last written ${iso(Math.floor(mtimeMs / 1000))}; newest export in it: ${summary.name ?? "?"} · ${summary.realm ?? "?"}, generated ${iso(generatedAt)}.`);
    if (lastSent !== undefined && lastSent.generatedAt === generatedAt && lastSent.sha256 === summary.sha256) {
      out("  Same export as the one already sent: nothing to do.");
      return finish(0);
    }
    if (lastSent !== undefined && generatedAt < lastSent.generatedAt) {
      out(`  Older than the export already sent (${iso(lastSent.generatedAt)}): not sent.`);
      return finish(0);
    }

    out(`  Sending ${summary.bytes} bytes (SHA-256 ${summary.sha256}) to ${importEndpoint(config.origin)} ...`);
    try {
      const result = await postImport(deps, config.origin, text);
      for (const line of describeImportResult(result, summary.sha256)) out(`  ${line}`);
      lastSent = { generatedAt, sha256: summary.sha256 };
      sendFailures = 0;
      return finish(0);
    } catch (e) {
      if (e instanceof ImportPostError && e.failure === "unreachable" && !config.once) {
        // The file is the source of truth, so nothing is lost: retry with capped backoff until the Dashboard is back.
        const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** sendFailures++);
        retryAt = now + delay;
        err(`${e.message}\n  Will retry in ${Math.round(delay / 1000)}s.`);
        return;
      }
      if (e instanceof BridgeError) return stop(e.message); // the Dashboard answered and refused: the same text would be refused again
      throw e;
    }
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
        if (config.once) {
          if (next === undefined) return stop("The SavedVariables file cannot be read.");
          pending = true;
          out("Waiting for the file to be stable, then importing the newest saved export once.");
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

Watches one GearExport SavedVariables file and, when WoW saves it, sends the newest saved export to the running Dashboard
through the normal POST /api/import. Foreground; stop it with Ctrl+C. Read-only: it never writes to SavedVariables or WoW,
and cannot make WoW save.

WoW writes SavedVariables when you /reload, log out or exit, NOT when you run /wowsync. Run /wowsync, then /reload or log out:
the watcher picks the export up then.

  --file <path>          The GearExport.lua SavedVariables file.
  --wow-dir <path>       The WoW folder (or ONE product folder such as _retail_) to find it in.
  --url <url>            The Dashboard's address (default: from PORT / WOWSYNC_HOST, else http://127.0.0.1:4173). Loopback only.
  --once                 Import the newest saved export now, then exit (a catch-up). Without it, the file's state at startup is
                         ignored and only later saves are imported.
  --help                 This text.

Environment (a .env file works too): WOWSYNC_SAVED_VARIABLES, WOWSYNC_WOW_DIR, WOWSYNC_URL.`;

export interface WatchOptions {
  once: boolean;
  help: boolean;
  file?: string;
  wowDir?: string;
  url?: string;
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
      },
    });
    if (positionals.length > 0) throw new BridgeError(`Unexpected argument "${positionals[0]}".`, true);
    return { once: values.once === true, help: values.help === true, file: values.file, wowDir: values["wow-dir"], url: values.url };
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
    const found = discoverSavedVariables({ file: options.file, wowDir: options.wowDir, env: deps.env });
    const target = resolveDashboardUrl(options, deps.env);
    if (target.warning) {
      throw new BridgeError(`Refusing to watch: ${target.warning}\n  The watcher only sends to this machine. Use a loopback --url (e.g. http://127.0.0.1:4173).`);
    }
    const config: WatchConfig = { file: found.path, origin: target.origin, once: options.once, pollMs: deps.pollMs ?? DEFAULT_POLL_MS, quietMs: deps.quietMs ?? DEFAULT_QUIET_MS };
    deps.out(`Watching ${found.path}  (from ${found.via}; read-only)`);
    deps.out(`Dashboard:  ${importEndpoint(target.origin)}`);
    deps.out(`Polling every ${config.pollMs / 1000}s; a change is read once the file has been unchanged for ${config.quietMs / 1000}s.`);
    if (!options.once) {
      deps.out("WoW saves SavedVariables at /reload, logout or exit, not at /wowsync: an export arrives then. The file's current contents are ignored (use --once to import the newest saved export now).");
    }

    const watcher = createWatcher(config, deps);
    while (!signal.aborted && !watcher.finished) {
      await watcher.tick();
      if (watcher.finished) break;
      await deps.sleep(config.pollMs, signal);
    }
    return watcher.finished ? watcher.exitCode : 0;
  } catch (err) {
    if (err instanceof BridgeError) {
      deps.err(`error: ${err.message}`);
      if (err.usage) for (const line of ["", ...USAGE.split("\n")]) deps.err(line);
      return err.usage ? 2 : 1;
    }
    throw err;
  }
}
