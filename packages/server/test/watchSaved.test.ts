// The foreground watcher (`npm run watch:saved`, ROADMAP #8 slice 1): a stable-file detector in front of the same bridge
// code `import:saved` uses. Everything runs on a fake clock over a fake filesystem (so "the file is still changing" is
// exact, not a race), plus real temp files for the read-only guarantees and one real server on an ephemeral port.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { SqliteSnapshotStore } from "@wowsync-dashboard/core";
import { createApp } from "../src/app.ts";
import { LOOPBACK_HOSTNAMES, listenOnce } from "../src/net.ts";
import { createWatcher, nodeFs, runWatchSaved, selectNewestExport, type RunDeps, type WatchConfig, type WatchDeps, type WatchFs } from "../src/watchSaved.ts";
import { discoverWatchTargets, watchTargetLabel } from "../src/importSaved.ts";
import { exportFor, record, savedVariables } from "./savedVariablesFixtures.ts";

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

let root: string;
before(() => {
  root = mkdtempSync(join(tmpdir(), "wowsync-watch-"));
});
after(() => rmSync(root, { recursive: true, force: true }));

let counter = 0;
/** A real file on disk (for discovery and the read-only tests); returns its path. */
function realFile(text: string): string {
  const dir = join(root, `f${counter++}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "GearExport.lua");
  writeFileSync(file, text);
  return file;
}
let stamp = 1_700_000_000;
/** Rewrites a real file and gives it a distinct mtime, so a same-size rewrite within one millisecond is still a change. */
function rewrite(file: string, text: string): void {
  writeFileSync(file, text);
  utimesSync(file, ++stamp, stamp);
}

// --- a fake filesystem, clock and Dashboard -----------------------------------------------------------------

const FILE = "/wow/_retail_/WTF/Account/A1/SavedVariables/GearExport.lua";
const ORIGIN = "http://127.0.0.1:4173";
const POLL = 2_000;
const QUIET = 3_000;

class FakeFs implements WatchFs {
  private files = new Map<string, { content: string; mtimeMs: number }>();
  private version = 0;
  reads = 0;
  stats = 0;
  /** Set to make the next reads fail (a sharing violation): called with the read number, returns an error to throw or undefined. */
  failRead?: (n: number) => Error | undefined;
  failStat?: Error;
  set(path: string, content: string): void {
    this.files.set(path, { content, mtimeMs: 1_000_000 + ++this.version * 1_000 });
  }
  stat(path: string) {
    this.stats++;
    if (this.failStat) throw this.failStat;
    const f = this.files.get(path);
    if (!f) throw new Error("ENOENT: no such file");
    return { size: Buffer.byteLength(f.content), mtimeMs: f.mtimeMs };
  }
  readText(path: string): string {
    this.reads++;
    const failure = this.failRead?.(this.reads);
    if (failure) throw failure;
    const f = this.files.get(path);
    if (!f) throw new Error("ENOENT: no such file");
    return f.content;
  }
}

interface Call {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const importedOk = (raw: string, over: Record<string, unknown> = {}) =>
  json(200, { result: { character: { identityKey: "retail::cairne::virek" }, snapshot: { id: 7, parsed: { raw } }, isDuplicate: false, isLatest: true, sharedStorage: [], ...over } });
const refusedConnection = () => Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });

interface Harness {
  fs: FakeFs;
  w: ReturnType<typeof createWatcher>;
  calls: Call[];
  out: string[];
  err: string[];
  /** Advance the clock by one poll interval and tick once. */
  step(): Promise<void>;
  /** Enough polls for a change to pass the quiet window and be handled. */
  settle(): Promise<void>;
  now(): number;
}

function harness(initial: string | undefined, fetchImpl?: (call: Call, n: number) => Response | Promise<Response>, config: Partial<WatchConfig> = {}): Harness {
  const fs = new FakeFs();
  if (initial !== undefined) fs.set(FILE, initial);
  let t = 0;
  const calls: Call[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const deps: WatchDeps = {
    fs,
    clock: () => t,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      const call: Call = { url: String(url), method: init?.method, headers: init?.headers as Record<string, string>, body: init?.body as string };
      calls.push(call);
      if (!fetchImpl) throw new Error("fetch must not be called in this test");
      return fetchImpl(call, calls.length);
    }) as typeof fetch,
  };
  const w = createWatcher({ file: FILE, origin: ORIGIN, once: false, pollMs: POLL, quietMs: QUIET, ...config }, deps);
  const step = async () => {
    t += POLL;
    await w.tick();
  };
  const settle = async () => {
    for (let i = 0; i < 4; i++) await step();
  };
  return { fs, w, calls, out, err, step, settle, now: () => t };
}

const all = (lines: string[]) => lines.join("\n");
const VIREK = record("Virek", 1_790_022_739);
const VIREK_SV = savedVariables([VIREK]);
const ok = (raw = VIREK.text!) => () => importedOk(raw);

// --- when it reads --------------------------------------------------------------------------------------------

test("the file's state at startup is ignored: no read, no POST, however long it sits", async () => {
  const h = harness(VIREK_SV);
  await h.w.tick();
  for (let i = 0; i < 10; i++) await h.step();
  assert.equal(h.fs.reads, 0);
  assert.equal(h.calls.length, 0);
  assert.equal(h.out.length, 0);
});

test("a file that is still changing is never read; it is read once, after it has been quiet for the quiet window", async () => {
  const h = harness(VIREK_SV, ok());
  await h.w.tick();
  for (let i = 1; i <= 6; i++) {
    h.fs.set(FILE, VIREK_SV + " ".repeat(i)); // WoW is still writing: every poll sees a different size and mtime
    await h.step();
  }
  assert.equal(h.fs.reads, 0, "no read while the file keeps changing");
  assert.equal(h.calls.length, 0);
  await h.step(); // unchanged for 1 poll (2s < 3s quiet)
  assert.equal(h.fs.reads, 0, "2s of quiet is not enough");
  await h.step(); // unchanged for 2 polls (4s >= 3s)
  assert.equal(h.fs.reads, 1);
  assert.equal(h.calls.length, 1);
  assert.match(all(h.out), /SavedVariables changed \(WoW saved it\); waiting/);
});

test("a truncated file is rejected (nothing sent, one message, no retry loop) and accepted once it is complete", async () => {
  const h = harness("placeholder", () => importedOk(""));
  const complete = savedVariables([record("Virek", 1_790_030_000)]);
  await h.w.tick();
  h.fs.set(FILE, complete.slice(0, Math.floor(complete.length / 2)));
  await h.settle();
  assert.equal(h.calls.length, 0);
  assert.equal(h.err.length, 1);
  assert.match(all(h.err), /not a SavedVariables file this tool can read as data.*Nothing was sent/s);
  assert.match(all(h.err), /Waiting for the file to change again/);
  const reads = h.fs.reads;
  for (let i = 0; i < 10; i++) await h.step();
  assert.equal(h.fs.reads, reads, "no tight retry loop: it waits for the file to change");
  assert.equal(h.err.length, 1, "logged once");
  h.fs.set(FILE, complete);
  await h.settle();
  assert.equal(h.calls.length, 1);
  assert.equal(JSON.parse(h.calls[0].body!).text, exportFor("Virek", 1_790_030_000));
});

// --- what it sends --------------------------------------------------------------------------------------------

test("a new generatedAt is ONE POST of {text} carrying exactly the persisted bytes", async () => {
  const h = harness(VIREK_SV, ok(""));
  await h.w.tick();
  const newer = record("Virek", 1_790_030_000, { spec: { itemMetadata: [{ id: 5 }] } });
  h.fs.set(FILE, savedVariables([newer]));
  await h.settle();
  assert.equal(h.calls.length, 1);
  const [call] = h.calls;
  assert.equal(call.url, `${ORIGIN}/api/import`);
  assert.equal(call.method, "POST");
  assert.equal(call.headers?.["Content-Type"], "application/json");
  const sent = JSON.parse(call.body!);
  assert.deepEqual(Object.keys(sent), ["text"]);
  assert.equal(sent.text, newer.text, "byte for byte");
  assert.match(all(h.out), new RegExp(sha(newer.text!)));
  assert.match(all(h.out), /Result: imported as a new snapshot/);
  assert.equal(h.err.length, 0);
});

test("identical content re-flushed is NOT posted again (every WoW save rewrites the file); a new export is", async () => {
  const h = harness(VIREK_SV, ok());
  await h.w.tick();
  h.fs.set(FILE, VIREK_SV + " "); // a new file version (WoW saved) carrying an export not yet sent
  await h.settle();
  assert.equal(h.calls.length, 1);
  h.fs.set(FILE, VIREK_SV + "\r\n"); // WoW saved again; latestExport unchanged
  await h.settle();
  h.fs.set(FILE, savedVariables([VIREK, record("Ciao", 5)])); // another character saved, but its export is older
  await h.settle();
  assert.equal(h.calls.length, 1, "no re-POST for an unrelated flush");
  assert.match(all(h.out), /Same export as the one already sent: nothing to do/);
  const later = record("Virek", 1_790_040_000);
  h.fs.set(FILE, savedVariables([later]));
  await h.settle();
  assert.equal(h.calls.length, 2);
  assert.equal(JSON.parse(h.calls[1].body!).text, later.text);
});

test("only the newest export in the file is sent, and an older one never displaces a newer one", async () => {
  const h = harness(VIREK_SV, ok());
  await h.w.tick();
  const newest = record("Ciao", 1_790_050_000);
  h.fs.set(FILE, savedVariables([record("Virek", 1_790_010_000), newest, record("Bromrik", 1_790_020_000)]));
  await h.settle();
  assert.equal(h.calls.length, 1);
  assert.equal(JSON.parse(h.calls[0].body!).text, newest.text, "the newest of three characters");
  // The file later holds only something older than what was already sent (e.g. the newest character's record is gone).
  h.fs.set(FILE, savedVariables([record("Virek", 1_790_010_000)]));
  await h.settle();
  assert.equal(h.calls.length, 1, "an older export is not sent after a newer one");
  assert.match(all(h.out), /Older than the export already sent/);
});

test("selectNewestExport: none when no record has text; refuses equal times with different text; equal text is fine", () => {
  const rec = (name: string, generatedAt: number, text?: string) => ({ name, realm: "Cairne", generatedAt, text });
  assert.equal(selectNewestExport([rec("A", 1), rec("B", 2)]), undefined);
  assert.equal(selectNewestExport([rec("A", 1, "x"), rec("B", 2, "y"), rec("C", 3)])!.text, "y");
  assert.throws(() => selectNewestExport([rec("A", 5, "x"), rec("B", 5, "y")]), /same time .* with different text; refusing to guess/);
  assert.equal(selectNewestExport([rec("A", 5, "x"), rec("B", 5, "x")])!.text, "x");
});

test("a file with no saved export, or an export the Dashboard would reject or that disagrees with its record, sends nothing", async () => {
  const h = harness(VIREK_SV);
  await h.w.tick();
  h.fs.set(FILE, savedVariables([{ guid: "Player-1-FRESH", name: "Fresh", realm: "Cairne" }]));
  await h.settle();
  assert.match(all(h.out), /no saved export \(no latestExport\.text on any character\)/);
  h.fs.set(FILE, savedVariables([{ guid: "Player-1-V", name: "Virek", realm: "Cairne", text: "not an export at all", generatedAt: 5 }]));
  await h.settle();
  assert.match(all(h.err), /Dashboard would reject this export, so it was not sent/);
  h.fs.set(FILE, savedVariables([{ ...record("Virek", 100), generatedAt: 999 }]));
  await h.settle();
  assert.match(all(h.err), /WoW saved generatedAt 999 but the export text says Generated: 100/);
  h.fs.set(FILE, savedVariables([record("Ciao", 7), { ...record("Virek", 7), text: exportFor("Virek", 7, { level: 60 }) }]));
  await h.settle();
  assert.match(all(h.err), /refusing to guess which is newest/);
  assert.equal(h.calls.length, 0);
});

test("malicious SavedVariables content is refused as not-data, never executed", async () => {
  const g = globalThis as Record<string, unknown>;
  g.__watchPwned = false;
  const h = harness(VIREK_SV);
  await h.w.tick();
  for (const evil of ['WoWSyncDB = os.execute("calc")', 'WoWSyncDB = { ["characters"] = { ["x"] = (function() globalThis.__watchPwned = true end)() } }']) {
    h.fs.set(FILE, evil);
    await h.settle();
  }
  assert.match(all(h.err), /can read as data/);
  assert.equal(h.calls.length, 0);
  assert.equal(g.__watchPwned, false);
  delete g.__watchPwned;
});

test("what it reports is what it knows: when WoW last wrote the file and when the newest export was generated, never 'synced at'", async () => {
  const h = harness(VIREK_SV, ok());
  await h.w.tick();
  h.fs.set(FILE, VIREK_SV + " ");
  await h.settle();
  const text = all(h.out);
  assert.match(text, /SavedVariables last written \d{4}-\d\d-\d\dT[\d:]+Z; newest export in it: Virek · Cairne, generated 2026-09-21T20:32:19Z/);
  assert.doesNotMatch(text, /synced/i);
  assert.doesNotMatch(text, /Player-/, "a character GUID is never printed");
});

// --- the Dashboard is not there -------------------------------------------------------------------------------

test("Dashboard down: retry with capped backoff, never crash, nothing lost; the export is sent when it returns", async () => {
  const h = harness(VIREK_SV, (_c, n) => (n < 3 ? Promise.reject(refusedConnection()) : importedOk(VIREK.text!)));
  await h.w.tick();
  h.fs.set(FILE, VIREK_SV + " ");
  await h.settle();
  assert.equal(h.calls.length, 1);
  assert.match(all(h.err), /Can't reach the Dashboard at http:\/\/127\.0\.0\.1:4173 \(ECONNREFUSED\)/);
  assert.match(all(h.err), /Will retry in 5s/);
  await h.step(); // 2s after settling: 4s after the failure, retry due at 5s
  assert.equal(h.calls.length, 1, "backing off: too soon");
  await h.step(); // 6s after the failure
  assert.equal(h.calls.length, 2);
  assert.match(all(h.err), /Will retry in 10s/);
  for (let i = 0; i < 4; i++) await h.step(); // 8s
  assert.equal(h.calls.length, 2);
  await h.step(); // 10s
  assert.equal(h.calls.length, 3);
  assert.match(all(h.out), /Result: imported as a new snapshot/);
  for (let i = 0; i < 20; i++) await h.step();
  assert.equal(h.calls.length, 3, "once delivered it stops retrying");
});

test("the retry delay is capped at 60s", async () => {
  const h = harness(VIREK_SV, () => Promise.reject(refusedConnection()));
  await h.w.tick();
  h.fs.set(FILE, VIREK_SV + " ");
  await h.settle();
  for (let i = 0; i < 400 && (all(h.err).match(/Will retry in/g) ?? []).length < 8; i++) await h.step();
  const delays = [...all(h.err).matchAll(/Will retry in (\d+)s/g)].map((m) => Number(m[1]));
  assert.deepEqual(delays.slice(0, 8), [5, 10, 20, 40, 60, 60, 60, 60]);
});

test("a change to the file resets the backoff; a Dashboard that REFUSES (HTTP error) is reported once, not retried", async () => {
  const h = harness(VIREK_SV, () => json(422, { error: "Malformed [ITEM METADATA] isCraftingReagent" }));
  await h.w.tick();
  h.fs.set(FILE, VIREK_SV + " ");
  await h.settle();
  for (let i = 0; i < 20; i++) await h.step();
  assert.equal(h.calls.length, 1, "the same text would be refused again");
  assert.match(all(h.err), /refused the import \(HTTP 422\)/);
  assert.match(all(h.err), /Malformed \[ITEM METADATA\] isCraftingReagent/);
  assert.match(all(h.err), /Waiting for the file to change again/);
  assert.doesNotMatch(all(h.out), /Result:/);
  h.fs.set(FILE, VIREK_SV + "  "); // WoW saved again: worth another try
  await h.settle();
  assert.equal(h.calls.length, 2);
});

test("a transient read failure (a Windows sharing violation) is retried a bounded number of times, then left until the file changes", async () => {
  const busy = () => Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
  const h = harness(VIREK_SV, ok());
  await h.w.tick();
  h.fs.failRead = (n) => (n <= 2 ? busy() : undefined);
  h.fs.set(FILE, VIREK_SV + " ");
  await h.settle();
  await h.settle();
  assert.equal(h.fs.reads, 3, "two failures, then a success");
  assert.equal(h.calls.length, 1);
  assert.match(all(h.err), /Cannot read .* yet \(EBUSY/);

  const g = harness(VIREK_SV, ok());
  await g.w.tick();
  g.fs.failRead = () => busy();
  g.fs.set(FILE, VIREK_SV + " ");
  await g.settle();
  for (let i = 0; i < 10; i++) await g.step();
  assert.equal(g.fs.reads, 3, "bounded: 3 attempts, no more");
  assert.equal(g.calls.length, 0);
  assert.match(all(g.err), /after 3 attempts/);
  g.fs.failRead = undefined;
  g.fs.set(FILE, VIREK_SV + "  ");
  await g.settle();
  assert.equal(g.calls.length, 1, "the next change is tried afresh");
});

test("a file that disappears (or cannot be stat'ed) is reported once and does not stop the watcher", async () => {
  const h = harness(VIREK_SV, ok());
  await h.w.tick();
  h.fs.failStat = new Error("EPERM: operation not permitted");
  for (let i = 0; i < 5; i++) await h.step();
  assert.equal(h.err.filter((l) => /Cannot stat/.test(l)).length, 1);
  h.fs.failStat = undefined;
  h.fs.set(FILE, savedVariables([record("Virek", 1_790_060_000)]));
  await h.settle();
  assert.match(all(h.out), /is readable again/);
  assert.equal(h.calls.length, 1);
});

// --- the command: options, discovery, --once ------------------------------------------------------------------

function runDeps(fs: WatchFs, fetchImpl?: (call: Call) => Response | Promise<Response>, env: Record<string, string> = {}) {
  let t = 0;
  const calls: Call[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const deps: RunDeps = {
    env,
    fs,
    clock: () => t,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    sleep: async (ms) => {
      t += ms;
    },
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      const call: Call = { url: String(url), method: init?.method, headers: init?.headers as Record<string, string>, body: init?.body as string };
      calls.push(call);
      if (!fetchImpl) throw new Error("fetch must not be called in this test");
      return fetchImpl(call);
    }) as typeof fetch,
  };
  return { deps, calls, out, err };
}
const run = (argv: string[], d: ReturnType<typeof runDeps>) => runWatchSaved(argv, d.deps, new AbortController().signal);

test("--once imports the newest saved export after the file has been stable, then exits 0", async () => {
  const file = realFile(savedVariables([record("Bromrik", 1_790_010_000), VIREK]));
  const d = runDeps(nodeFs, ok());
  assert.equal(await run(["--file", file, "--once"], d), 0);
  assert.equal(d.calls.length, 1);
  assert.equal(JSON.parse(d.calls[0].body!).text, VIREK.text);
  assert.match(all(d.out), /importing the newest saved export once/);
  assert.match(all(d.out), /Result: imported as a new snapshot/);
});

test("--once exits 1 when there is nothing to import, when the file is not readable as data, or when the Dashboard is down (no retry)", async () => {
  const none = realFile(savedVariables([{ guid: "Player-1-F", name: "Fresh", realm: "Cairne" }]));
  const a = runDeps(nodeFs);
  assert.equal(await run(["--file", none, "--once"], a), 1);
  assert.equal(a.calls.length, 0);

  const junk = realFile('WoWSyncDB = os.execute("calc")');
  const b = runDeps(nodeFs);
  assert.equal(await run(["--file", junk, "--once"], b), 1);
  assert.match(all(b.err), /can read as data/);

  const good = realFile(VIREK_SV);
  const c = runDeps(nodeFs, () => Promise.reject(refusedConnection()));
  assert.equal(await run(["--file", good, "--once"], c), 1);
  assert.equal(c.calls.length, 1, "--once makes one attempt");
  assert.match(all(c.err), /Can't reach the Dashboard/);
});

test("without --once, aborting stops a healthy watcher cleanly with exit 0 and nothing sent from the startup state", async () => {
  const file = realFile(VIREK_SV);
  const controller = new AbortController();
  const d = runDeps(nodeFs);
  let sleeps = 0;
  d.deps.sleep = async () => {
    if (++sleeps === 4) controller.abort();
  };
  assert.equal(await runWatchSaved(["--file", file], d.deps, controller.signal), 0);
  assert.equal(d.calls.length, 0);
  assert.match(all(d.out), /Watching .*GearExport\.lua {2}\(from --file; read-only\)/);
  assert.match(all(d.out), /not at \/wowsync/);
});

test("several accounts or products are ALL watched (each file independent); one product folder still works", async () => {
  const dir = join(root, `wow${counter++}`);
  for (const rel of ["_retail_/WTF/Account/AAA", "_retail_/WTF/Account/BBB", "_classic_era_/WTF/Account/AAA"]) {
    mkdirSync(join(dir, ...rel.split("/"), "SavedVariables"), { recursive: true });
    writeFileSync(join(dir, ...rel.split("/"), "SavedVariables", "GearExport.lua"), VIREK_SV);
  }
  const d = runDeps(nodeFs, ok());
  assert.equal(await run(["--wow-dir", dir, "--once"], d), 0, all(d.err) || all(d.out));
  assert.match(all(d.out), /Watching 3 SavedVariables files/);
  assert.match(all(d.out), /_retail_/);
  assert.match(all(d.out), /_classic_era_/);
  assert.equal(d.calls.length, 3);
  // One product folder with one account still resolves to a single watch.
  const one = runDeps(nodeFs, ok());
  assert.equal(await run(["--wow-dir", join(dir, "_classic_era_"), "--once"], one), 0);
  assert.match(all(one.out), /from --wow-dir/);
  assert.match(all(one.out), /Watching .*GearExport\.lua/);
});

test("a non-loopback Dashboard URL is REFUSED (the bridge only warns): nothing is watched or sent", async () => {
  const file = realFile(VIREK_SV);
  for (const url of ["http://192.168.1.5:4173", "https://dashboard.example.com", "http://10.0.0.2:4173"]) {
    const d = runDeps(nodeFs);
    assert.equal(await run(["--file", file, "--once", "--url", url], d), 1, url);
    assert.match(all(d.err), /Refusing to watch: .* is not this machine/);
    assert.match(all(d.err), /loopback --url/);
    assert.equal(d.calls.length, 0);
    assert.equal(d.out.length, 0);
  }
  const env = runDeps(nodeFs);
  assert.equal(await run(["--file", file, "--once"], { ...env, deps: { ...env.deps, env: { WOWSYNC_URL: "http://192.168.1.5:4173" } } }), 1, "WOWSYNC_URL is checked too");
  for (const [args, env2, expected] of [
    [[], {}, `${ORIGIN}/api/import`],
    [["--url", "http://localhost:6000"], {}, "http://localhost:6000/api/import"],
    [["--url", "http://[::1]:6000/"], {}, "http://[::1]:6000/api/import"],
    [[], { PORT: "5000" }, "http://127.0.0.1:5000/api/import"],
  ] as const) {
    const ok1 = runDeps(nodeFs, ok(), { ...env2 });
    assert.equal(await run(["--file", file, "--once", ...args], ok1), 0);
    assert.equal(ok1.calls[0].url, expected);
  }
});

test("usage: --help, bad URLs, unknown flags, stray arguments, --file with --wow-dir, and no location at all", async () => {
  const file = realFile(VIREK_SV);
  const help = runDeps(nodeFs);
  assert.equal(await run(["--help"], help), 0);
  assert.match(all(help.out), /Usage: npm run watch:saved/);
  assert.match(all(help.out), /NOT when you run \/wowsync/);
  for (const [argv, code, expected] of [
    [["--file", file, "--url", "not a url"], 2, /not a valid URL/],
    [["--file", file, "--url", "ftp://x"], 2, /Only http and https/],
    [["--file", file, "--frobnicate"], 2, /frobnicate/],
    [["--file", file, "Virek"], 2, /Unexpected argument "Virek"/],
    [["--file", file, "--wow-dir", root], 2, /either --file or --wow-dir, not both/],
    [[], 2, /Where is the SavedVariables file\?/],
    [["--file", join(root, "nope.lua")], 1, /SavedVariables file not found/],
  ] as const) {
    const d = runDeps(nodeFs);
    assert.equal(await run([...argv], d), code, argv.join(" "));
    assert.match(all(d.err), expected);
    assert.equal(d.calls.length, 0);
  }
});

// --- read-only guarantees -------------------------------------------------------------------------------------

test("READ-ONLY: a full watch (a save, an unchanged re-save, an error, an outage) leaves the file and its folder byte- and mtime-identical", async () => {
  const file = realFile(VIREK_SV);
  const dir = join(file, "..");
  const snapshot = () => ({ bytes: readFileSync(file).toString("base64"), mtime: statSync(file).mtimeMs, size: statSync(file).size, dirMtime: statSync(dir).mtimeMs });
  let t = 0;
  const out: string[] = [];
  const err: string[] = [];
  const calls: Call[] = [];
  let mode: "ok" | "down" | "refuse" = "ok";
  const w = createWatcher(
    { file, origin: ORIGIN, once: false, pollMs: POLL, quietMs: QUIET },
    {
      fs: nodeFs,
      clock: () => t,
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), body: init?.body as string });
        if (mode === "down") throw refusedConnection();
        if (mode === "refuse") return json(500, { error: "boom" });
        return importedOk(JSON.parse(init?.body as string).text);
      }) as typeof fetch,
    },
  );
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      t += POLL;
      await w.tick();
    }
  };
  await w.tick();
  rewrite(file, savedVariables([record("Virek", 1_790_030_000)]));
  const before = snapshot(); // taken after the test's own write: from here on only the watcher acts
  await settle();
  assert.equal(calls.length, 1);
  rewrite(file, savedVariables([record("Virek", 1_790_030_000)]) + "\r\n");
  const before2 = snapshot();
  await settle();
  assert.equal(calls.length, 1, "unchanged export");
  assert.deepEqual(snapshot(), before2);
  mode = "refuse";
  rewrite(file, savedVariables([record("Virek", 1_790_040_000)]));
  await settle();
  mode = "down";
  rewrite(file, savedVariables([record("Virek", 1_790_050_000)]));
  const before4 = snapshot();
  await settle();
  await settle();
  assert.deepEqual(snapshot(), before4);
  assert.notDeepEqual(before, before4, "sanity: the test's own rewrites did change the file between snapshots");
  assert.match(all(err), /HTTP 500/);
  assert.match(all(err), /Can't reach the Dashboard/);
});

test("READ-ONLY / NO-CODE / NO-SECOND-IMPORTER by construction: the watcher's source", () => {
  for (const rel of ["../src/watchSaved.ts", "../src/watchSavedCli.ts"]) {
    const source = readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const banned of [/writeFile/, /appendFile/, /createWriteStream/, /\bunlink/, /\brename/, /copyFile/, /\brmSync/, /\bmkdir/, /truncate/, /\bchmod/, /child_process/, /\bexecSync|\bspawn|\bexecFile/, /\beval\s*\(/, /new Function/, /node:vm/, /\bimport\(/, /require\s*\(/, /\bopenSync|\bwatchFile|\bfs\.watch|\bwatch\(/]) {
      assert.doesNotMatch(source, banned, `${rel} must not use ${banned}`);
    }
    assert.doesNotMatch(source, /SQLite|sqliteStore|node:sqlite/, `${rel} must not touch the database: the server owns it`);
    assert.doesNotMatch(source, /parseSavedVariables|parseWowSyncExport|importSnapshot/, `${rel} must not contain a parser or importer: it reuses the bridge's`);
    assert.doesNotMatch(source, /JSON\.stringify|Content-Type|method:\s*"POST"/, `${rel} must not copy the import POST: it calls postImport`);
  }
});

// --- end to end through the real server -----------------------------------------------------------------------

test("END TO END: a real save, then a re-save with the same export, then a new export, through the real /api/import", async () => {
  const store = new SqliteSnapshotStore(":memory:");
  const server = await listenOnce(createApp(store, 0, undefined, { allowedHosts: LOOPBACK_HOSTNAMES }), "127.0.0.1", 0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const file = realFile(VIREK_SV);
    let t = 0;
    let posts = 0;
    const out: string[] = [];
    const err: string[] = [];
    const w = createWatcher(
      { file, origin: base, once: false, pollMs: POLL, quietMs: QUIET },
      {
        fs: nodeFs,
        clock: () => t,
        out: (l) => out.push(l),
        err: (l) => err.push(l),
        fetch: ((url: string | URL | Request, init?: RequestInit) => {
          posts++;
          return fetch(url, init);
        }) as typeof fetch,
      },
    );
    const settle = async () => {
      for (let i = 0; i < 4; i++) {
        t += POLL;
        await w.tick();
      }
    };
    await w.tick();
    await settle();
    assert.equal(posts, 0, "startup state is ignored");
    assert.equal(store.listCharacters("retail").length, 0);

    const first = record("Virek", 1_790_030_000, { spec: { itemMetadata: [{ id: 236949, classId: 7, subclassId: 11, bindType: 0, expansionId: 11, reagent: true }] } });
    rewrite(file, savedVariables([first]));
    await settle();
    assert.deepEqual(err, []);
    assert.equal(posts, 1);
    assert.match(all(out), /Result: imported as a new snapshot/);
    assert.match(all(out), /stored text:\s+SHA-256 matches what was sent/);
    const stored = store.listSnapshots("retail::cairne::virek");
    assert.equal(stored.length, 1);
    assert.equal(stored[0].parsed.raw, first.text, "the server stored the exact persisted text");
    assert.ok(store.loadItemEvidence("retail").length >= 1, "item metadata arrived through the normal import");

    rewrite(file, savedVariables([first]) + "\r\n"); // WoW saved again, export unchanged
    await settle();
    assert.equal(posts, 1);
    assert.equal(store.listSnapshots("retail::cairne::virek").length, 1);

    const second = record("Virek", 1_790_040_000);
    rewrite(file, savedVariables([second]));
    await settle();
    assert.equal(posts, 2);
    assert.equal(store.listSnapshots("retail::cairne::virek").length, 2);

    // A restart forgets what it sent: it re-POSTs once with --once and the server reports a duplicate, changing nothing.
    const d = runDeps(nodeFs);
    d.deps.fetch = fetch;
    assert.equal(await run(["--file", file, "--once", "--url", base], d), 0, all(d.err));
    assert.match(all(d.out), /Result: ALREADY IMPORTED \(duplicate\)/);
    assert.equal(store.listSnapshots("retail::cairne::virek").length, 2);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  }
});

test("watchTargetLabel picks the product folder from a SavedVariables path", () => {
  assert.equal(watchTargetLabel("D:/World of Warcraft/_retail_/WTF/Account/EY215/SavedVariables/GearExport.lua"), "_retail_");
  assert.equal(watchTargetLabel("D:/World of Warcraft/_anniversary_/WTF/Account/EY215/SavedVariables/GearExport.lua"), "_anniversary_");
  assert.equal(watchTargetLabel("D:/World of Warcraft/_classic_beta_/WTF/Account/262269#1/SavedVariables/GearExport.lua"), "_classic_beta_");
});

test("discoverWatchTargets returns every GearExport.lua under an install root", () => {
  const install = join(root, "multi-install");
  const files = [];
  for (const product of ["_retail_", "_anniversary_"]) {
    const dir = join(install, product, "WTF", "Account", "A1", "SavedVariables");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "GearExport.lua");
    writeFileSync(file, savedVariables([record("Virek", 1_790_022_739)]));
    files.push(file);
  }
  const found = discoverWatchTargets({ wowDir: install, env: {} });
  assert.equal(found.length, 2);
  assert.deepEqual(found.map((f) => f.path).sort(), files.sort());
});

test("two product files change independently: each POSTs its own export (lastSent is per-file)", async () => {
  const FILE_A = "/wow/_retail_/WTF/Account/A1/SavedVariables/GearExport.lua";
  const FILE_B = "/wow/_anniversary_/WTF/Account/A1/SavedVariables/GearExport.lua";
  const fs = new FakeFs();
  fs.set(FILE_A, savedVariables([record("Virek", 1_790_022_739)]));
  fs.set(FILE_B, savedVariables([record("Torahn", 1_700_000_000)]));
  let t = 0;
  const calls = [];
  const out = [];
  const err = [];
  const baseDeps = {
    fs,
    clock: () => t,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? init.body : "";
      calls.push({ url: String(url), body });
      const text = JSON.parse(body || "{}").text ?? "";
      return importedOk(text);
    }) as typeof fetch,
  };
  const wA = createWatcher({ file: FILE_A, origin: ORIGIN, once: false, pollMs: POLL, quietMs: QUIET }, {
    ...baseDeps,
    out: (l) => out.push(l.startsWith(" ") || l === "" ? l : `[_retail_] ${l}`),
    err: (l) => err.push(l.startsWith(" ") || l === "" ? l : `[_retail_] ${l}`),
  });
  const wB = createWatcher({ file: FILE_B, origin: ORIGIN, once: false, pollMs: POLL, quietMs: QUIET }, {
    ...baseDeps,
    out: (l) => out.push(l.startsWith(" ") || l === "" ? l : `[_anniversary_] ${l}`),
    err: (l) => err.push(l.startsWith(" ") || l === "" ? l : `[_anniversary_] ${l}`),
  });
  await wA.tick();
  await wB.tick();
  const newerRetail = record("Virek", 1_790_050_000);
  const newerAnni = record("Torahn", 1_700_010_000);
  fs.set(FILE_A, savedVariables([newerRetail]));
  fs.set(FILE_B, savedVariables([newerAnni]));
  for (let i = 0; i < 4; i++) {
    t += POLL;
    await wA.tick();
    await wB.tick();
  }
  assert.equal(calls.length, 2, all(err) || all(out));
  const bodies = calls.map((c) => JSON.parse(c.body).text);
  assert.ok(bodies.includes(newerRetail.text));
  assert.ok(bodies.includes(newerAnni.text));
  assert.match(all(out), /\[_retail_\]/);
  assert.match(all(out), /\[_anniversary_\]/);
});

test("runWatchSaved with --wow-dir install root watches every product file", async () => {
  const install = join(root, "run-multi");
  for (const product of ["_retail_", "_classic_era_"]) {
    const dir = join(install, product, "WTF", "Account", "A1", "SavedVariables");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "GearExport.lua"), savedVariables([record(product === "_retail_" ? "Virek" : "Hallok", 1_790_022_739)]));
  }
  const d = runDeps(nodeFs, () => importedOk(""));
  const code = await run(["--wow-dir", install, "--once", "--url", ORIGIN], d);
  assert.equal(code, 0, all(d.err) || all(d.out));
  assert.match(all(d.out), /Watching 2 SavedVariables files/);
  assert.match(all(d.out), /_retail_/);
  assert.match(all(d.out), /_classic_era_/);
});