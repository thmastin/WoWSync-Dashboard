// The developer bridge (`npm run import:saved`): SavedVariables -> exact persisted export text -> the normal POST /api/import.
// Everything runs against synthetic SavedVariables written into temp folders (never a real WoW install) and an injected
// fetch, plus one real server on an ephemeral port for the end-to-end cases.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { SqliteSnapshotStore } from "@wowsync-dashboard/core";
import { createApp } from "../src/app.ts";
import { BridgeError, findSavedVariablesFiles, readSavedExports, runImportSaved, selectExport, type Deps } from "../src/importSaved.ts";
import { LOOPBACK_HOSTNAMES, listenOnce } from "../src/net.ts";
import { warband } from "../../core/test/sharedStorageBuilders.ts";
import { exportFor, record, savedVariables } from "./savedVariablesFixtures.ts";

// Fixtures (WoW-style SavedVariables text) live in savedVariablesFixtures.ts, shared with watchSaved.test.ts.
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

let root: string;
before(() => {
  root = mkdtempSync(join(tmpdir(), "wowsync-bridge-"));
});
after(() => rmSync(root, { recursive: true, force: true }));

let counter = 0;
/** A fresh WoW-like folder: writes each `product/account -> SavedVariables text` and returns the WoW root. */
function wow(layout: Record<string, string>): string {
  const dir = join(root, `wow${counter++}`);
  for (const [relative, content] of Object.entries(layout)) {
    const file = join(dir, ...relative.split("/"));
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, content);
  }
  return dir;
}
const svPath = (product: string, account: string) => `${product}/WTF/Account/${account}/SavedVariables/GearExport.lua`;
/** One SavedVariables file on its own; returns its path. */
function svFile(text: string): string {
  const dir = join(root, `f${counter++}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "GearExport.lua");
  writeFileSync(file, text);
  return file;
}

// --- deps ---------------------------------------------------------------------------------------------------

const NOW = 1_790_030_000;
interface Call {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}
function deps(fetchImpl?: (call: Call) => Response | Promise<Response>, env: Record<string, string | undefined> = {}): Deps & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    env,
    now: () => NOW,
    calls,
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      const call: Call = { url: String(url), method: init?.method, headers: init?.headers as Record<string, string>, body: init?.body as string };
      calls.push(call);
      if (!fetchImpl) throw new Error("fetch must not be called in this test");
      return fetchImpl(call);
    }) as typeof fetch,
  };
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const importedOk = (over: Record<string, unknown> = {}, raw?: string) =>
  json(200, { result: { character: { identityKey: "retail::cairne::virek" }, snapshot: { id: 7, parsed: { raw } }, isDuplicate: false, isLatest: true, isFirstSnapshot: false, sharedStorage: [], ...over } });
const all = (r: { stdout: string[]; stderr: string[] }) => [...r.stdout, ...r.stderr].join("\n");

const VIREK = record("Virek", 1_790_022_739, { spec: { itemMetadata: [{ id: 236949, classId: 7, subclassId: 11, bindType: 0, expansionId: 11, reagent: true }, { id: 5 }] } });

// --- reading SavedVariables ---------------------------------------------------------------------------------

test("reads the saved exports of several characters, with the exact text WoW persisted", () => {
  const ciao = record("Ciao", 1_790_000_000);
  const file = svFile(savedVariables([VIREK, ciao, { guid: "Player-1-NOEXPORT", name: "Fresh", realm: "Cairne" }]));
  const records = readSavedExports(file);
  assert.deepEqual(records.map((r) => `${r.name}-${r.realm}`), ["Ciao-Cairne", "Fresh-Cairne", "Virek-Cairne"]);
  assert.equal(records.find((r) => r.name === "Virek")!.text, VIREK.text, "byte-for-byte");
  assert.equal(records.find((r) => r.name === "Fresh")!.text, undefined);
  assert.equal(records.find((r) => r.name === "Virek")!.generatedAt, 1_790_022_739);
});

test("the legacy GearExportDB table is skipped, never interpreted", () => {
  const file = svFile(savedVariables([VIREK], { legacy: '["weird"] = { "kept", ["n"] = 1 },' }));
  assert.equal(readSavedExports(file).length, 1);
});

test("malformed SavedVariables fail loudly and read nothing: truncated, garbled, not GearExport, unsupported schema", () => {
  const good = savedVariables([VIREK]);
  const cases: Array<[string, string, RegExp]> = [
    ["truncated mid-write", good.slice(0, Math.floor(good.length / 2)), /not a SavedVariables file this tool can read as data.*Nothing was sent/s],
    ["garbled", good.replace('["characters"] = {', '["characters"] = ???'), /can read as data/],
    ["no WoWSyncDB", 'GearExportDB = {\r\n["exports"] = {\r\n},\r\n}\r\n', /has no WoWSyncDB/],
    ["future schema", savedVariables([VIREK], { schemaVersion: 2 }), /schemaVersion 2 is not supported/],
  ];
  for (const [label, text, expected] of cases) {
    assert.throws(() => readSavedExports(svFile(text)), (e) => e instanceof BridgeError && expected.test(e.message), label);
  }
});

test("malicious SavedVariables content is never executed: it is refused as not-data", async () => {
  const g = globalThis as Record<string, unknown>;
  g.__bridgePwned = false;
  for (const evil of [
    'WoWSyncDB = os.execute("calc")',
    'WoWSyncDB = { ["characters"] = { ["x"] = (function() globalThis.__bridgePwned = true end)() } }',
    'WoWSyncDB = loadstring("globalThis.__bridgePwned = true")()',
  ]) {
    const file = svFile(evil);
    const d = deps();
    const result = await runImportSaved(["--list", "--file", file], d);
    assert.equal(result.exitCode, 1);
    assert.match(all(result), /can read as data/);
    assert.equal(d.calls.length, 0);
  }
  assert.equal(g.__bridgePwned, false);
  delete g.__bridgePwned;
});

// --- discovery ----------------------------------------------------------------------------------------------

test("an explicit --file is used as given", async () => {
  const file = svFile(savedVariables([VIREK]));
  const result = await runImportSaved(["--list", "--file", file], deps());
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout[0], /from --file; read-only/);
  assert.match(all(result), /Virek-Cairne/);
});

test("a missing --file is an error that names the path", async () => {
  const result = await runImportSaved(["--list", "--file", join(root, "nope.lua")], deps());
  assert.equal(result.exitCode, 1);
  assert.match(all(result), /SavedVariables file not found/);
});

test("--wow-dir finds the one GearExport.lua under a product folder, whatever the account folder is called", async () => {
  for (const account of ["ACCT1", "262269#1", "Some Account"]) {
    const dir = wow({ [svPath("_retail_", account)]: savedVariables([VIREK]) });
    const found = findSavedVariablesFiles(dir);
    assert.equal(found.length, 1);
    const result = await runImportSaved(["--list", "--wow-dir", dir], deps());
    assert.equal(result.exitCode, 0, account);
    assert.match(result.stdout[0], /from --wow-dir/);
  }
});

test("--wow-dir may also be a product folder itself", async () => {
  const dir = wow({ [svPath("_retail_", "A1")]: savedVariables([VIREK]), [svPath("_classic_era_", "A1")]: savedVariables([record("Bromrik", 5)]) });
  const result = await runImportSaved(["--list", "--wow-dir", join(dir, "_retail_")], deps());
  assert.equal(result.exitCode, 0);
  assert.match(all(result), /Virek-Cairne/);
  assert.doesNotMatch(all(result), /Bromrik/);
});

test("several account folders or products are AMBIGUOUS: nothing is guessed, and the message says what to specify", async () => {
  const dir = wow({
    [svPath("_retail_", "AAA")]: savedVariables([VIREK]),
    [svPath("_retail_", "BBB")]: savedVariables([record("Ciao", 3)]),
    [svPath("_classic_era_", "AAA")]: savedVariables([record("Bromrik", 5)]),
  });
  const d = deps();
  const result = await runImportSaved(["--character", "Virek", "--wow-dir", dir], d);
  assert.equal(result.exitCode, 1);
  const text = all(result);
  assert.match(text, /3 GearExport\.lua files were found/);
  assert.match(text, /refusing to guess/);
  for (const needle of ["_retail_", "AAA", "BBB", "_classic_era_"]) assert.ok(text.includes(needle), needle);
  assert.match(text, /--wow-dir at one product folder .* or pass the exact file with --file/);
  assert.equal(d.calls.length, 0);
  // Narrowing to one product still has two accounts: still ambiguous, not silently the first.
  const narrowed = await runImportSaved(["--list", "--wow-dir", join(dir, "_retail_")], deps());
  assert.equal(narrowed.exitCode, 1);
  assert.match(all(narrowed), /2 GearExport\.lua files/);
  // --file resolves it.
  const exact = await runImportSaved(["--list", "--file", join(dir, ...svPath("_retail_", "AAA").split("/"))], deps());
  assert.equal(exact.exitCode, 0);
});

test("nothing found, and WoW's account-independent SavedVariables folder is not an account", async () => {
  const dir = wow({ "_retail_/WTF/Account/SavedVariables/GearExport.lua": savedVariables([VIREK]), "_retail_/WTF/Account/A1/SavedVariables/Other.lua": "X = {}" });
  const result = await runImportSaved(["--list", "--wow-dir", dir], deps());
  assert.equal(result.exitCode, 1);
  assert.match(all(result), /No GearExport\.lua found under/);
  assert.match(all(result), /\/reload or log out/);
  const gone = await runImportSaved(["--list", "--wow-dir", join(root, "missing-dir")], deps());
  assert.match(all(gone), /WoW folder not found/);
});

test("environment configuration: WOWSYNC_SAVED_VARIABLES / WOWSYNC_WOW_DIR, with flags winning and never combined", async () => {
  const fileA = svFile(savedVariables([VIREK]));
  const fileB = svFile(savedVariables([record("Ciao", 3)]));
  const dir = wow({ [svPath("_retail_", "A1")]: savedVariables([record("Bromrik", 5)]) });
  const viaEnvFile = await runImportSaved(["--list"], deps(undefined, { WOWSYNC_SAVED_VARIABLES: fileA }));
  assert.match(all(viaEnvFile), /Virek-Cairne/);
  assert.match(viaEnvFile.stdout[0], /WOWSYNC_SAVED_VARIABLES \(environment\)/);
  const viaEnvDir = await runImportSaved(["--list"], deps(undefined, { WOWSYNC_WOW_DIR: dir }));
  assert.match(all(viaEnvDir), /Bromrik-Cairne/);
  const flagWins = await runImportSaved(["--list", "--file", fileB], deps(undefined, { WOWSYNC_SAVED_VARIABLES: fileA, WOWSYNC_WOW_DIR: dir }));
  assert.match(all(flagWins), /Ciao-Cairne/);
  assert.doesNotMatch(all(flagWins), /Virek/);
  const fileBeforeDir = await runImportSaved(["--list"], deps(undefined, { WOWSYNC_SAVED_VARIABLES: fileA, WOWSYNC_WOW_DIR: dir }));
  assert.match(all(fileBeforeDir), /Virek/);
  const both = await runImportSaved(["--list", "--file", fileA, "--wow-dir", dir], deps());
  assert.equal(both.exitCode, 2);
  assert.match(all(both), /either --file or --wow-dir, not both/);
  const none = await runImportSaved(["--list"], deps());
  assert.equal(none.exitCode, 2);
  assert.match(all(none), /Where is the SavedVariables file\?/);
});

// --- character selection ------------------------------------------------------------------------------------

test("--character selects by name (case-insensitively); an unknown name lists what IS saved and imports nothing", async () => {
  const file = svFile(savedVariables([VIREK, record("Ciao", 1_790_000_000)]));
  const d = deps();
  const dry = await runImportSaved(["--character", "virek", "--dry-run", "--file", file], d);
  assert.equal(dry.exitCode, 0);
  assert.match(all(dry), /Export:\s+Virek · Cairne/);
  const missing = await runImportSaved(["--character", "Nobody", "--file", file], d);
  assert.equal(missing.exitCode, 1);
  assert.match(all(missing), /No saved character named "Nobody"/);
  assert.match(all(missing), /Ciao-Cairne, Virek-Cairne/);
  assert.equal(d.calls.length, 0);
});

test("the same name on two realms needs --realm: it is never chosen silently", async () => {
  const file = svFile(savedVariables([record("Ciao", 10, { spec: { realm: "Cairne" } }), record("Ciao", 20, { spec: { realm: "Ravenholdt" }, guid: "Player-2-CIAO2" })]));
  const d = deps();
  const ambiguous = await runImportSaved(["--character", "Ciao", "--file", file], d);
  assert.equal(ambiguous.exitCode, 1);
  assert.match(all(ambiguous), /More than one character is named "Ciao": Cairne, Ravenholdt/);
  assert.match(all(ambiguous), /--realm/);
  assert.equal(d.calls.length, 0);
  const chosen = await runImportSaved(["--character", "Ciao", "--realm", "ravenholdt", "--dry-run", "--file", file], d);
  assert.equal(chosen.exitCode, 0);
  assert.match(all(chosen), /Ciao · Ravenholdt/);
  const wrongRealm = await runImportSaved(["--character", "Ciao", "--realm", "Thrall", "--file", file], d);
  assert.match(all(wrongRealm), /saved on Cairne, Ravenholdt, not on "Thrall"/);
});

test("a saved character without latestExport.text is an error: no other character is imported in its place", async () => {
  const file = svFile(savedVariables([VIREK, { guid: "Player-9-NOEXP", name: "Fresh", realm: "Cairne" }]));
  const d = deps();
  const result = await runImportSaved(["--character", "Fresh", "--file", file], d);
  assert.equal(result.exitCode, 1);
  assert.match(all(result), /Fresh-Cairne has no saved export \(no latestExport\.text\)/);
  assert.match(all(result), /Nothing else was imported instead/);
  assert.equal(d.calls.length, 0);
  // An empty saved text counts as none.
  const empty = svFile(savedVariables([{ guid: "Player-9-E", name: "Empty", realm: "Cairne", text: "", generatedAt: 5 }]));
  assert.match(all(await runImportSaved(["--character", "Empty", "--file", empty], d)), /no saved export/);
});

test("two saved records for one name+realm resolve to the NEWEST export, with a warning; equal times with different text are refused", () => {
  const older = record("Virek", 100, { guid: "Player-1-OLD" });
  const newer = record("Virek", 200, { guid: "Player-1-NEW" });
  const { chosen, warnings } = selectExport([older, newer].map(({ name, realm, text, generatedAt }) => ({ name, realm, text, generatedAt })), { character: "Virek" });
  assert.equal(chosen.generatedAt, 200);
  assert.match(warnings[0], /2 saved records exist for Virek-Cairne/);
  const tie = [record("Virek", 100), { ...record("Virek", 100), text: exportFor("Virek", 100, { level: 60 }) }].map(({ name, realm, text, generatedAt }) => ({ name, realm, text, generatedAt }));
  assert.throws(() => selectExport(tie, { character: "Virek" }), /same time with different text/);
});

// --- consistency checks --------------------------------------------------------------------------------------

test("STOPS when the saved export is for a different character than the record or the request says", async () => {
  const ciaoText = exportFor("Ciao", 1_790_000_000);
  const file = svFile(savedVariables([{ guid: "Player-1-VIREK", name: "Virek", realm: "Cairne", text: ciaoText, generatedAt: 1_790_000_000 }]));
  const d = deps();
  const result = await runImportSaved(["--character", "Virek", "--file", file], d);
  assert.equal(result.exitCode, 1);
  assert.match(all(result), /Stopping: this saved export is not what was asked for/);
  assert.match(all(result), /You asked for "Virek" but the saved export is for "Ciao"/);
  assert.match(all(result), /The saved record is named "Virek" but its export text is for "Ciao"/);
  assert.match(all(result), /Nothing was sent/);
  assert.equal(d.calls.length, 0);
});

test("STOPS on a realm mismatch and on a generatedAt that disagrees with the export's own Generated line", async () => {
  const wrongRealm = svFile(savedVariables([{ ...record("Virek", 100), realm: "Thrall" }]));
  const a = await runImportSaved(["--character", "Virek", "--file", wrongRealm], deps());
  assert.match(all(a), /saved record is on "Thrall" but its export text is for "Cairne"/);
  const wrongTime = svFile(savedVariables([{ ...record("Virek", 100), generatedAt: 999 }]));
  const b = await runImportSaved(["--character", "Virek", "--file", wrongTime], deps());
  assert.equal(b.exitCode, 1);
  assert.match(all(b), /WoW saved generatedAt 999 but the export text says Generated: 100/);
});

test("text the Dashboard would reject is not sent (the server stays the authority, but the bridge does not knowingly send garbage)", async () => {
  const file = svFile(savedVariables([{ guid: "Player-1-V", name: "Virek", realm: "Cairne", text: "not an export at all", generatedAt: 5 }]));
  const d = deps();
  const result = await runImportSaved(["--character", "Virek", "--file", file], d);
  assert.equal(result.exitCode, 1);
  assert.match(all(result), /Dashboard would reject this export, so it was not sent/);
  assert.equal(d.calls.length, 0);
});

// --- list and dry run ---------------------------------------------------------------------------------------

test("--list contacts nothing and shows character, realm, generated time, age and whether [ITEM METADATA] is present", async () => {
  const file = svFile(savedVariables([VIREK, record("Ciao", 1_789_900_000), { guid: "Player-9-NOEXP", name: "Fresh", realm: "Cairne" }]));
  const d = deps(); // would throw if fetch were called
  const result = await runImportSaved(["--list", "--file", file], d);
  assert.equal(result.exitCode, 0);
  assert.equal(d.calls.length, 0);
  const text = all(result);
  assert.match(text, /Saved exports \(2 of 3 characters have one\)/);
  assert.match(text, /Virek-Cairne\s+2026-09-21T20:32:19Z \(\d+h ago\)\s+ITEM METADATA: yes/);
  assert.match(text, /Ciao-Cairne\s+2026-09-20T.*ITEM METADATA: no/);
  assert.match(text, /Fresh-Cairne\s+no saved export/);
  assert.doesNotMatch(text, /Player-/, "a character GUID is never printed");
});

test("--dry-run performs no HTTP request and changes nothing; it reports identity, freshness, version, metadata and the hash", async () => {
  const file = svFile(savedVariables([VIREK]));
  const before = { bytes: readFileSync(file), mtime: statSync(file).mtimeMs };
  const d = deps();
  const result = await runImportSaved(["--character", "Virek", "--dry-run", "--file", file], d);
  assert.equal(result.exitCode, 0);
  assert.equal(d.calls.length, 0);
  const text = all(result);
  assert.match(text, /Export:\s+Virek · Cairne · retail \(12\.1\.0 build 69875 Retail\)/);
  assert.match(text, /Generated:\s+2026-09-21T20:32:19Z \(2h ago\)\s+\[unix 1790022739\]/);
  assert.match(text, new RegExp(`Text:\\s+${VIREK.text!.length} characters, ${Buffer.byteLength(VIREK.text!)} bytes`));
  assert.match(text, new RegExp(`SHA-256:\\s+${sha(VIREK.text!)}`));
  assert.match(text, /\[ITEM METADATA\] present \(2 rows\)/);
  assert.match(text, /Dashboard identity: retail::cairne::virek/);
  assert.match(text, /Dry run: nothing was sent/);
  assert.doesNotMatch(text, /Player-/);
  assert.deepEqual({ bytes: readFileSync(file), mtime: statSync(file).mtimeMs }, before, "the SavedVariables file is untouched");
});

test("an export without [ITEM METADATA] is fine and reported as absent (older addon or other client)", async () => {
  const file = svFile(savedVariables([record("Ciao", 100)]));
  const result = await runImportSaved(["--character", "Ciao", "--dry-run", "--file", file], deps());
  assert.equal(result.exitCode, 0);
  assert.match(all(result), /\[ITEM METADATA\] absent/);
});

// --- the import ---------------------------------------------------------------------------------------------

test("a real import POSTs {text} to /api/import with EXACTLY the persisted text, and reports the server's answer", async () => {
  const file = svFile(savedVariables([VIREK]));
  const d = deps(() =>
    importedOk({ sharedStorage: [{ section: "accountBank", outcome: "source-added", ownerKey: "retail::warband::local", becameCurrent: false }, { section: "guildBank", outcome: "skipped", reason: "unknown-state" }] }, VIREK.text),
  );
  const result = await runImportSaved(["--character", "Virek", "--file", file], d);
  assert.equal(result.exitCode, 0, all(result));
  assert.equal(d.calls.length, 1);
  const [call] = d.calls;
  assert.equal(call.url, "http://127.0.0.1:4173/api/import");
  assert.equal(call.method, "POST");
  assert.equal(call.headers?.["Content-Type"], "application/json");
  const sent = JSON.parse(call.body!);
  assert.deepEqual(Object.keys(sent), ["text"]);
  assert.equal(sent.text, VIREK.text, "the exact persisted text, byte for byte");
  assert.equal(sha(sent.text), sha(VIREK.text!));
  const text = all(result);
  assert.match(text, /Sending to http:\/\/127\.0\.0\.1:4173\/api\/import/);
  assert.match(text, /Result: imported as a new snapshot/);
  assert.match(text, /character:\s+retail::cairne::virek/);
  assert.match(text, /snapshot id:\s+7 \(now the character's latest\)/);
  assert.match(text, /stored text:\s+SHA-256 matches what was sent/);
  assert.match(text, /shared storage: accountBank: source-added \[retail::warband::local\]/);
  assert.match(text, /shared storage: guildBank: skipped \(unknown-state\)/);
});

test("the persisted text is preserved through the SavedVariables encoding: backslashes, quotes, tabs, unicode, a trailing newline", async () => {
  const items = warband({ observedAt: 1_790_000_000, items: [['Back\\\\slash "Quoted"', 3], ["Café Ünïcödé ✓", 2], ["Line\\nbreak-like", 1]] });
  const text = exportFor("Virek", 1_790_022_739, { warband: items });
  assert.ok(text.endsWith("\n") && text.includes("\\\\") && text.includes('"') && text.includes("é"));
  const file = svFile(savedVariables([{ ...VIREK, text }]));
  const d = deps(() => importedOk({}, text));
  const result = await runImportSaved(["--character", "Virek", "--file", file], d);
  assert.equal(result.exitCode, 0, all(result));
  assert.equal(JSON.parse(d.calls[0].body!).text, text);
  assert.equal(readSavedExports(file)[0].text, text);
  assert.match(all(result), new RegExp(`SHA-256:\\s+${sha(text)}`));
});

test("a duplicate is reported as such, and a stored copy that differs in whitespace is called out", async () => {
  const file = svFile(savedVariables([VIREK]));
  const same = await runImportSaved(["--character", "Virek", "--file", file], deps(() => importedOk({ isDuplicate: true, isLatest: false }, VIREK.text)));
  assert.match(all(same), /Result: ALREADY IMPORTED \(duplicate\): the Dashboard changed nothing/);
  assert.match(all(same), /older than the character's latest/);
  const differs = await runImportSaved(["--character", "Virek", "--file", file], deps(() => importedOk({ isDuplicate: true }, VIREK.text!.replace(/\n/g, "\r\n"))));
  assert.match(all(differs), /SHA-256 differs from what was sent/);
});

test("Dashboard HTTP errors are reported with the server's message and nothing is claimed as imported", async () => {
  const file = svFile(savedVariables([VIREK]));
  const refused = await runImportSaved(["--character", "Virek", "--file", file], deps(() => json(422, { error: "Malformed [ITEM METADATA] isCraftingReagent" })));
  assert.equal(refused.exitCode, 1);
  assert.match(all(refused), /refused the import \(HTTP 422\)/);
  assert.match(all(refused), /Malformed \[ITEM METADATA\] isCraftingReagent/);
  assert.match(all(refused), /Nothing was imported/);
  assert.doesNotMatch(all(refused), /Result:/);
  const integrity = await runImportSaved(["--character", "Virek", "--file", file], deps(() => json(500, { error: "Shared-storage data is damaged. The export was NOT imported.", code: "SHARED_STORAGE_INTEGRITY" })));
  assert.match(all(integrity), /HTTP 500, SHARED_STORAGE_INTEGRITY/);
  const html = await runImportSaved(["--character", "Virek", "--file", file], deps(() => new Response("<html>Bad gateway</html>", { status: 502 })));
  assert.match(all(html), /HTTP 502/);
  assert.match(all(html), /Bad gateway/);
  const notDashboard = await runImportSaved(["--character", "Virek", "--file", file], deps(() => json(200, { hello: "world" })));
  assert.equal(notDashboard.exitCode, 1);
  assert.match(all(notDashboard), /not like the Dashboard's import API/);
});

test("an unreachable Dashboard gives a useful error naming the URL, and nothing is claimed as imported", async () => {
  const file = svFile(savedVariables([VIREK]));
  const refused = await runImportSaved(["--character", "Virek", "--file", file], deps(() => {
    throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  }));
  assert.equal(refused.exitCode, 1);
  assert.match(all(refused), /Can't reach the Dashboard at http:\/\/127\.0\.0\.1:4173 \(ECONNREFUSED\)/);
  assert.match(all(refused), /Is the server running \(npm start\)\?/);
  assert.match(all(refused), /Nothing was imported/);
  const timedOut = await runImportSaved(["--character", "Virek", "--file", file], deps(() => {
    throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
  }));
  assert.match(all(timedOut), /did not answer in time/);
});

test("the Dashboard address: --url, WOWSYNC_URL, then PORT / WOWSYNC_HOST as the server itself resolves them; bad URLs are usage errors", async () => {
  const file = svFile(savedVariables([VIREK]));
  const target = async (argv: string[], env: Record<string, string> = {}) => {
    const d = deps(() => importedOk({}, VIREK.text), env);
    const r = await runImportSaved(["--character", "Virek", "--file", file, ...argv], d);
    return { r, url: d.calls[0]?.url };
  };
  assert.equal((await target([])).url, "http://127.0.0.1:4173/api/import");
  assert.equal((await target([], { PORT: "5000" })).url, "http://127.0.0.1:5000/api/import");
  assert.equal((await target([], { PORT: "5000", WOWSYNC_HOST: "0.0.0.0" })).url, "http://127.0.0.1:5000/api/import", "a wildcard bind is reached on loopback");
  assert.equal((await target([], { WOWSYNC_URL: "http://localhost:6000" })).url, "http://localhost:6000/api/import");
  assert.equal((await target(["--url", "http://127.0.0.1:7000/"], { WOWSYNC_URL: "http://localhost:6000" })).url, "http://127.0.0.1:7000/api/import");
  const remote = await target(["--url", "http://192.168.1.5:4173"]);
  assert.match(remote.r.stderr.join("\n"), /warning: http:\/\/192\.168\.1\.5:4173 is not this machine/);
  const local = await target(["--url", "http://localhost:4173"]);
  assert.doesNotMatch(local.r.stderr.join("\n"), /not this machine/);
  for (const [bad, expected] of [["not a url", /not a valid URL/], ["ftp://x", /Only http and https/]] as const) {
    const d = deps();
    const r = await runImportSaved(["--character", "Virek", "--file", file, "--url", bad], d);
    assert.equal(r.exitCode, 2);
    assert.match(all(r), expected);
    assert.equal(d.calls.length, 0);
  }
  const badPort = await target([], { PORT: "banana" });
  assert.equal(badPort.r.exitCode, 1);
  assert.equal(badPort.url, undefined);
});

// --- usage --------------------------------------------------------------------------------------------------

test("usage: --help, a missing --character, unknown flags and stray arguments", async () => {
  const d = deps();
  const help = await runImportSaved(["--help"], d);
  assert.equal(help.exitCode, 0);
  assert.match(help.stdout.join("\n"), /Usage: npm run import:saved/);
  const noChar = await runImportSaved(["--file", svFile(savedVariables([VIREK]))], d);
  assert.equal(noChar.exitCode, 2);
  assert.match(all(noChar), /Which character\?/);
  const unknown = await runImportSaved(["--character", "Virek", "--frobnicate"], d);
  assert.equal(unknown.exitCode, 2);
  const stray = await runImportSaved(["Virek"], d);
  assert.equal(stray.exitCode, 2);
  assert.match(all(stray), /Unexpected argument "Virek"/);
  assert.equal(d.calls.length, 0);
});

// --- read-only guarantees ------------------------------------------------------------------------------------

test("READ-ONLY: a full run (list, dry run, import) leaves the SavedVariables file and its folder exactly as they were", async () => {
  const dir = wow({ [svPath("_retail_", "A1")]: savedVariables([VIREK, record("Ciao", 5)]) });
  const file = join(dir, ...svPath("_retail_", "A1").split("/"));
  const snapshot = () => ({ bytes: readFileSync(file).toString("base64"), mtime: statSync(file).mtimeMs, size: statSync(file).size, dir: statSync(join(file, "..")).mtimeMs });
  const before = snapshot();
  await runImportSaved(["--list", "--wow-dir", dir], deps());
  await runImportSaved(["--character", "Virek", "--dry-run", "--wow-dir", dir], deps());
  await runImportSaved(["--character", "Virek", "--wow-dir", dir], deps(() => importedOk({}, VIREK.text)));
  await runImportSaved(["--character", "Ciao", "--wow-dir", dir], deps(() => json(500, { error: "boom" })));
  assert.deepEqual(snapshot(), before);
});

test("READ-ONLY / NO-CODE by construction: the bridge, the watcher and the reader use no write, spawn or eval API", () => {
  const dirs = ["../src/importSaved.ts", "../src/importSavedCli.ts", "../src/watchSaved.ts", "../src/watchSavedCli.ts", "../../core/src/savedVariables.ts"];
  for (const rel of dirs) {
    const source = readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const banned of [/writeFile/, /appendFile/, /createWriteStream/, /\bunlink/, /\brename/, /copyFile/, /\brmSync/, /\bmkdir/, /truncate/, /\bchmod/, /child_process/, /\bexecSync|\bspawn|\bexecFile/, /\beval\s*\(/, /new Function/, /node:vm/, /\bimport\(/, /require\s*\(/]) {
      assert.doesNotMatch(source, banned, `${rel} must not use ${banned}`);
    }
    assert.doesNotMatch(source, /SQLite|sqliteStore|node:sqlite/, `${rel} must not touch the database: the server owns it`);
  }
});

// --- end to end through the real server ---------------------------------------------------------------------

async function withServer(run: (base: string, store: SqliteSnapshotStore) => Promise<void>) {
  const store = new SqliteSnapshotStore(":memory:");
  const server = await listenOnce(createApp(store, 0, undefined, { allowedHosts: LOOPBACK_HOSTNAMES }), "127.0.0.1", 0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await run(base, store);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  }
}
const live = (base: string): Deps => ({ env: {}, now: () => NOW, fetch });

test("END TO END: the bridge imports through the real /api/import; a second run is a duplicate; the Warband is one observation however it arrives", async () => {
  const wb = warband({ observedAt: 1_790_000_000, items: [["Mote of Light", 13], ["Linen Cloth", 5]] });
  const virek = record("Virek", 1_790_022_739, { spec: { warband: wb, itemMetadata: [{ id: 236949, classId: 7, subclassId: 11, bindType: 0, expansionId: 11, reagent: true }] } });
  const ciao = record("Ciao", 1_790_022_800, { spec: { warband: wb, level: 60 } });
  const file = svFile(savedVariables([virek, ciao]));
  await withServer(async (base, store) => {
    const first = await runImportSaved(["--character", "Virek", "--file", file, "--url", base], live(base));
    assert.equal(first.exitCode, 0, all(first));
    assert.match(all(first), /Result: imported as a new snapshot/);
    assert.match(all(first), /stored text:\s+SHA-256 matches what was sent/);
    assert.match(all(first), /accountBank: recorded/);
    const stored = store.listSnapshots("retail::cairne::virek");
    assert.equal(stored.length, 1);
    assert.equal(stored[0].parsed.raw, virek.text, "the server stored the exact persisted text");
    assert.equal(store.loadItemEvidence("retail").length, 5, "item metadata reached the evidence store through the normal import");

    const again = await runImportSaved(["--character", "Virek", "--file", file, "--url", base], live(base));
    assert.equal(again.exitCode, 0);
    assert.match(all(again), /Result: ALREADY IMPORTED \(duplicate\)/);
    assert.equal(store.listSnapshots("retail::cairne::virek").length, 1, "a replay through the bridge adds no snapshot");

    // Another character carrying the very same Warband observation: a new source, never a new observation.
    const second = await runImportSaved(["--character", "Ciao", "--file", file, "--url", base], live(base));
    assert.equal(second.exitCode, 0, all(second));
    assert.match(all(second), /accountBank: source-added/);
    const journal = store.loadSharedJournal();
    const warbandEntries = [...journal.entries.entries()].filter(([key]) => key.includes("warband"));
    assert.equal(warbandEntries.length, 1, "one observation");
    assert.equal(warbandEntries[0][1].sources.size, 2, "carried by two exports (Virek's and Ciao's)");
  });
});

test("END TO END: a refusal by the real server and an absent server both leave the Dashboard untouched", async () => {
  const file = svFile(savedVariables([VIREK]));
  const store = new SqliteSnapshotStore(":memory:");
  // A real server whose Host guard does not allow the address the bridge uses: a genuine 403 from the real app.
  const server = await listenOnce(createApp(store, 0, undefined, { allowedHosts: ["only-this-host.example"] }), "127.0.0.1", 0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const refused = await runImportSaved(["--character", "Virek", "--file", file, "--url", base], live(base));
    assert.equal(refused.exitCode, 1);
    assert.match(all(refused), /refused the import \(HTTP 403, HOST_NOT_ALLOWED\)/);
    assert.match(all(refused), /Nothing was imported/);
    assert.equal(store.listCharacters("retail").length, 0);
    // Nothing is listening on port 1.
    const dead = await runImportSaved(["--character", "Virek", "--file", file, "--url", "http://127.0.0.1:1"], live(base));
    assert.equal(dead.exitCode, 1);
    assert.match(all(dead), /Can't reach the Dashboard at http:\/\/127\.0\.0\.1:1/);
    assert.equal(store.listCharacters("retail").length, 0);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  }
});
