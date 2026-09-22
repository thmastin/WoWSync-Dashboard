// The developer bridge: send the export GearExport already PERSISTED (WoWSyncDB.characters[guid].latestExport.text in the
// SavedVariables file) through the Dashboard's normal `POST /api/import`. It is transport only:
//
//  - It reads a SavedVariables file as DATA (core `parseSavedVariables`; nothing is ever evaluated) and never writes
//    to it, to the addon or to anything else in the WoW folder.
//  - It sends the exact persisted text. It does not rebuild an export from tables, rewrite a section, normalize a value
//    or regenerate a timestamp; it reports the text's length and SHA-256 so what left the file can be matched to what the
//    server stored.
//  - It has no importer of its own: parsing, validation, snapshots, shared-storage reconciliation and item metadata are
//    all the server's, through the same endpoint the web Import dialog uses. (The core parser is used only to REPORT what
//    is about to be sent and to refuse text the server would reject anyway.)
//  - It never guesses: an ambiguous WoW folder, an ambiguous character, or an export that is not the character asked for
//    stops with a message that says what to specify.
//
// Pure of process state: everything the CLI needs (environment, clock, fetch) is passed in, so it is tested without a
// WoW install or a running server. `importSavedCli.ts` is the thin process entry.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  SavedVariablesParseError,
  WowSyncParseError,
  characterIdentity,
  detectVersion,
  isLuaTable,
  luaGet,
  parseSavedVariables,
  parseWowSyncExport,
  type LuaValue,
} from "@wowsync-dashboard/core";
import { ConfigError, classifyAddress, loopbackOrigin, resolveHost, resolvePort } from "./net.ts";

// --- errors ------------------------------------------------------------------------------------------

/** A problem the developer can fix, reported plainly. `usage` errors also print the usage text. */
export class BridgeError extends Error {
  readonly usage: boolean;
  constructor(message: string, usage = false) {
    super(message);
    this.name = "BridgeError";
    this.usage = usage;
  }
}

// --- discovery ---------------------------------------------------------------------------------------

/** WoW's per-product folders. Discovery looks in these (and in the folder itself), never anywhere else. */
export const PRODUCT_FOLDERS = ["_retail_", "_classic_era_", "_classic_", "_anniversary_", "_classic_beta_"] as const;
export const SAVED_VARIABLES_FILE = "GearExport.lua";
/** A SavedVariables file larger than this is not what GearExport writes; refuse it rather than load it. */
export const MAX_SAVED_VARIABLES_BYTES = 256 * 1024 * 1024;

export interface DiscoveryInput {
  /** `--file`: an explicit SavedVariables file. */
  file?: string;
  /** `--wow-dir`: the WoW folder (or one product folder inside it). */
  wowDir?: string;
  env: Record<string, string | undefined>;
}

export interface Discovered {
  path: string;
  /** How it was chosen, for the report. */
  via: string;
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Every `<root>/WTF/Account/<account>/SavedVariables/GearExport.lua` under the folder (and its product folders), sorted. */
export function findSavedVariablesFiles(wowDir: string): string[] {
  const roots = [wowDir, ...PRODUCT_FOLDERS.map((p) => path.join(wowDir, p))];
  const found: string[] = [];
  for (const root of roots) {
    const accounts = path.join(root, "WTF", "Account");
    if (!isDirectory(accounts)) continue;
    for (const entry of readdirSync(accounts, { withFileTypes: true })) {
      // `WTF/Account/SavedVariables` (no account level) is WoW's account-independent folder, not an account.
      if (!entry.isDirectory() || entry.name === "SavedVariables") continue;
      const candidate = path.join(accounts, entry.name, "SavedVariables", SAVED_VARIABLES_FILE);
      if (isFile(candidate)) found.push(candidate);
    }
  }
  return found.sort();
}

/** Chooses the SavedVariables file deterministically, or says exactly what to specify. Precedence: --file, --wow-dir, WOWSYNC_SAVED_VARIABLES, WOWSYNC_WOW_DIR. */
export function discoverSavedVariables(input: DiscoveryInput): Discovered {
  if (input.file !== undefined && input.wowDir !== undefined) {
    throw new BridgeError("Give either --file or --wow-dir, not both.", true);
  }
  const envFile = input.env.WOWSYNC_SAVED_VARIABLES?.trim();
  const envDir = input.env.WOWSYNC_WOW_DIR?.trim();
  const file = input.file ?? (input.wowDir === undefined ? envFile : undefined);
  const dir = input.wowDir ?? (input.file === undefined && !envFile ? envDir : undefined);
  const source = (flag: string, envName: string, fromFlag: boolean) => (fromFlag ? flag : `${envName} (environment)`);

  if (file) {
    const resolved = path.resolve(file);
    if (!isFile(resolved)) throw new BridgeError(`SavedVariables file not found: ${resolved}`);
    return { path: resolved, via: source("--file", "WOWSYNC_SAVED_VARIABLES", input.file !== undefined) };
  }
  if (dir) {
    const root = path.resolve(dir);
    const via = source("--wow-dir", "WOWSYNC_WOW_DIR", input.wowDir !== undefined);
    if (!isDirectory(root)) throw new BridgeError(`WoW folder not found: ${root}`);
    const found = findSavedVariablesFiles(root);
    if (found.length === 0) {
      throw new BridgeError(
        `No ${SAVED_VARIABLES_FILE} found under ${root}.\n` +
          `  Looked for WTF/Account/<account>/SavedVariables/${SAVED_VARIABLES_FILE} in that folder and in ${PRODUCT_FOLDERS.join(", ")}.\n` +
          `  Has GearExport run and been saved (/reload or log out) yet? Or pass the file itself with --file.`,
      );
    }
    if (found.length > 1) {
      throw new BridgeError(
        `${found.length} ${SAVED_VARIABLES_FILE} files were found under ${root}; refusing to guess:\n` +
          found.map((f) => `    ${path.relative(root, f) || f}`).join("\n") +
          `\n  Point --wow-dir at one product folder (e.g. ${path.join(root, "_retail_")}) or pass the exact file with --file.`,
      );
    }
    return { path: found[0], via };
  }
  throw new BridgeError(
    "Where is the SavedVariables file? Pass --file <GearExport.lua>, or --wow-dir <WoW folder>\n" +
      "  (or set WOWSYNC_SAVED_VARIABLES / WOWSYNC_WOW_DIR, e.g. in .env).",
    true,
  );
}

// --- reading the persisted exports -------------------------------------------------------------------

/** One saved character record, reduced to what the bridge needs. The character GUID is deliberately not kept. */
export interface SavedExport {
  name?: string;
  realm?: string;
  /** `latestExport.generatedAt` as WoW saved it. */
  generatedAt?: number;
  /** `latestExport.text`, exactly as GearExport persisted it. Absent when the record has none. */
  text?: string;
}

/** Refuses a file too large to be what GearExport writes, before it is read. */
export function assertSavedVariablesSize(filePath: string, size: number): void {
  if (size > MAX_SAVED_VARIABLES_BYTES) throw new BridgeError(`${filePath} is ${size} bytes, far larger than GearExport writes; refusing to read it.`);
}

/** Reads the file as data and returns every saved character record, in a stable order (realm, name, newest first). Read-only. */
export function readSavedExports(filePath: string): SavedExport[] {
  assertSavedVariablesSize(filePath, statSync(filePath).size);
  let source: string;
  try {
    source = readFileSync(filePath, "utf8");
  } catch (err) {
    throw new BridgeError(`Cannot read ${filePath}: ${(err as Error).message}`);
  }
  return parseSavedExports(source, filePath);
}

/** The pure half of {@link readSavedExports}: the file's text (already read) to its saved character records. `filePath` is for messages only. */
export function parseSavedExports(source: string, filePath: string): SavedExport[] {
  let variables: Record<string, LuaValue>;
  try {
    variables = parseSavedVariables(source, { only: ["WoWSyncDB"] });
  } catch (err) {
    if (err instanceof SavedVariablesParseError) {
      throw new BridgeError(`${filePath} is not a SavedVariables file this tool can read as data: ${err.message}\n  Nothing was sent. If WoW was writing the file just now, wait for it to finish and try again.`);
    }
    throw err;
  }
  const db = variables.WoWSyncDB;
  if (db === undefined) throw new BridgeError(`${filePath} has no WoWSyncDB variable: it is not GearExport's SavedVariables (or GearExport has never saved).`);
  if (!isLuaTable(db)) throw new BridgeError("WoWSyncDB is not a table.");
  const schema = luaGet(db, "schemaVersion");
  if (schema !== undefined && schema !== 1) throw new BridgeError(`WoWSyncDB schemaVersion ${String(schema)} is not supported by this tool (expected 1).`);
  const characters = luaGet(db, "characters");
  if (characters === undefined || characters === null) return [];
  if (!isLuaTable(characters)) throw new BridgeError("WoWSyncDB.characters is not a table.");

  const out: SavedExport[] = [];
  for (const record of characters.values()) {
    if (!isLuaTable(record)) continue;
    const identity = luaGet(record, "identity");
    const latest = luaGet(record, "latestExport");
    const text = luaGet(latest, "text");
    const generatedAt = luaGet(latest, "generatedAt");
    const name = luaGet(identity, "name");
    const realm = luaGet(identity, "realm");
    out.push({
      name: typeof name === "string" ? name : undefined,
      realm: typeof realm === "string" ? realm : undefined,
      generatedAt: typeof generatedAt === "number" ? generatedAt : undefined,
      text: typeof text === "string" && text.length > 0 ? text : undefined,
    });
  }
  return out.sort(
    (a, b) => (a.realm ?? "").localeCompare(b.realm ?? "") || (a.name ?? "").localeCompare(b.name ?? "") || (b.generatedAt ?? 0) - (a.generatedAt ?? 0),
  );
}

// --- selecting a character ---------------------------------------------------------------------------

const norm = (s: string | undefined): string => (s ?? "").normalize("NFC").trim().toLowerCase();
const label = (e: { name?: string; realm?: string }): string => `${e.name ?? "(unnamed)"}-${e.realm ?? "?"}`;

export interface Selection {
  chosen: SavedExport;
  warnings: string[];
}

/**
 * The saved export for exactly one character identity (name, plus realm when needed), or an error that says what to specify.
 * Never falls back to a different character. Several records for the same name+realm (a deleted and re-created character)
 * resolve to the NEWEST saved export, with a warning; two with the same time but different text is an error.
 */
export function selectExport(records: readonly SavedExport[], request: { character: string; realm?: string }): Selection {
  const byName = records.filter((r) => norm(r.name) === norm(request.character));
  if (byName.length === 0) {
    const known = [...new Set(records.map(label))];
    throw new BridgeError(
      `No saved character named "${request.character}".` + (known.length ? `\n  Saved characters: ${known.join(", ")} (use --list for details).` : "\n  The file has no saved characters."),
    );
  }
  const matches = request.realm === undefined ? byName : byName.filter((r) => norm(r.realm) === norm(request.realm));
  if (matches.length === 0) {
    throw new BridgeError(`"${request.character}" is saved on ${[...new Set(byName.map((r) => r.realm ?? "?"))].join(", ")}, not on "${request.realm}".`);
  }
  const realms = [...new Set(matches.map((r) => norm(r.realm)))];
  if (realms.length > 1) {
    throw new BridgeError(
      `More than one character is named "${request.character}": ${[...new Set(matches.map((r) => r.realm ?? "?"))].join(", ")}.\n  Say which with --realm <realm>.`,
    );
  }
  const withText = matches.filter((r) => r.text !== undefined);
  if (withText.length === 0) {
    throw new BridgeError(
      `${label(matches[0])} has no saved export (no latestExport.text).\n  Run /wowsync on that character, then /reload or log out so WoW saves it. Nothing else was imported instead.`,
    );
  }
  const newest = Math.max(...withText.map((r) => r.generatedAt ?? 0));
  const top = withText.filter((r) => (r.generatedAt ?? 0) === newest);
  if (new Set(top.map((r) => r.text)).size > 1) {
    throw new BridgeError(`${label(top[0])} has ${top.length} saved records generated at the same time with different text; refusing to guess.`);
  }
  const warnings: string[] = [];
  if (withText.length > 1) {
    warnings.push(`${withText.length} saved records exist for ${label(top[0])} (a re-created character?); using the newest generated export.`);
  }
  return { chosen: top[0], warnings };
}

// --- describing an export ----------------------------------------------------------------------------

export interface ExportSummary {
  bytes: number;
  chars: number;
  sha256: string;
  /** From the export's own text (via the core parser, the same one the server uses). */
  name?: string;
  realm?: string;
  generatedAt?: number;
  clientVersion?: string;
  clientBuild?: string;
  clientFamily?: string;
  /** The Dashboard's version space for this client. */
  version?: string;
  identityKey?: string;
  hasItemMetadata: boolean;
  itemMetadataRows?: number;
  /** Set when the server would reject this text; the reason is the parser's own. */
  invalid?: string;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function describeExport(text: string): ExportSummary {
  const base = { bytes: Buffer.byteLength(text, "utf8"), chars: text.length, sha256: sha256(text), hasItemMetadata: /^\[ITEM METADATA\]$/m.test(text) };
  try {
    const parsed = parseWowSyncExport(text);
    const version = detectVersion(parsed.character);
    return {
      ...base,
      name: parsed.character.name,
      realm: parsed.character.realm,
      generatedAt: parsed.generatedAt,
      clientVersion: parsed.character.clientVersion,
      clientBuild: parsed.character.clientBuild,
      clientFamily: parsed.character.clientFamily,
      version,
      identityKey: characterIdentity(version, parsed.character).key,
      hasItemMetadata: parsed.itemMetadata !== undefined,
      itemMetadataRows: parsed.itemMetadata?.rows.length,
    };
  } catch (err) {
    if (err instanceof WowSyncParseError) return { ...base, invalid: err.message };
    throw err;
  }
}

/** The reasons this saved export must NOT be sent (an identity or time that disagrees with what was asked / what WoW recorded). Empty = consistent. */
export function consistencyProblems(entry: SavedExport, summary: ExportSummary, request: { character: string; realm?: string }): string[] {
  const problems: string[] = [];
  if (summary.invalid !== undefined) {
    problems.push(`The Dashboard would reject this export, so it was not sent: ${summary.invalid}`);
    return problems;
  }
  if (norm(summary.name) !== norm(request.character)) {
    problems.push(`You asked for "${request.character}" but the saved export is for "${summary.name ?? "?"}".`);
  }
  if (request.realm !== undefined && norm(summary.realm) !== norm(request.realm)) {
    problems.push(`You asked for realm "${request.realm}" but the saved export is for "${summary.realm ?? "?"}".`);
  }
  if (entry.name !== undefined && norm(entry.name) !== norm(summary.name)) {
    problems.push(`The saved record is named "${entry.name}" but its export text is for "${summary.name ?? "?"}".`);
  }
  if (entry.realm !== undefined && norm(entry.realm) !== norm(summary.realm)) {
    problems.push(`The saved record is on "${entry.realm}" but its export text is for "${summary.realm ?? "?"}".`);
  }
  if (entry.generatedAt !== undefined && summary.generatedAt !== undefined && entry.generatedAt !== summary.generatedAt) {
    problems.push(`WoW saved generatedAt ${entry.generatedAt} but the export text says Generated: ${summary.generatedAt}.`);
  }
  return problems;
}

// --- options and running -----------------------------------------------------------------------------

export const USAGE = `Usage: npm run import:saved -- [options]

Sends the export GearExport already saved (latestExport) for one character to the running Dashboard,
through the normal POST /api/import. Read-only: it never writes to SavedVariables or WoW.

  --list                 List the saved exports (character, realm, generated time, whether an export exists). Contacts nothing.
  --character <name>     The character to import (required unless --list).
  --realm <realm>        Needed only when the name exists on more than one realm.
  --dry-run              Do everything except send: report identity, freshness, hash. Contacts nothing.
  --file <path>          The GearExport.lua SavedVariables file.
  --wow-dir <path>       The WoW folder (or a product folder such as _retail_) to search for it.
  --url <url>            The Dashboard's address (default: from PORT / WOWSYNC_HOST, else http://127.0.0.1:4173).
  --help                 This text.

Environment (a .env file works too): WOWSYNC_SAVED_VARIABLES, WOWSYNC_WOW_DIR, WOWSYNC_URL.
Save first: run /wowsync in WoW, then /reload or log out so the export reaches disk.`;

export interface Options {
  list: boolean;
  dryRun: boolean;
  help: boolean;
  character?: string;
  realm?: string;
  file?: string;
  wowDir?: string;
  url?: string;
}

export function parseOptions(argv: readonly string[]): Options {
  try {
    const { values, positionals } = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        list: { type: "boolean" },
        "dry-run": { type: "boolean" },
        help: { type: "boolean", short: "h" },
        character: { type: "string" },
        realm: { type: "string" },
        file: { type: "string" },
        "wow-dir": { type: "string" },
        url: { type: "string" },
      },
    });
    if (positionals.length > 0) throw new BridgeError(`Unexpected argument "${positionals[0]}". Use --character <name>.`, true);
    return {
      list: values.list === true,
      dryRun: values["dry-run"] === true,
      help: values.help === true,
      character: values.character,
      realm: values.realm,
      file: values.file,
      wowDir: values["wow-dir"],
      url: values.url,
    };
  } catch (err) {
    if (err instanceof BridgeError) throw err;
    throw new BridgeError((err as Error).message, true);
  }
}

/** Where to POST. `--url`, then WOWSYNC_URL, then the same host/port resolution the server itself starts with. */
export function resolveDashboardUrl(options: Pick<Options, "url">, env: Record<string, string | undefined>): { origin: string; warning?: string } {
  let raw = options.url ?? env.WOWSYNC_URL?.trim();
  if (!raw) {
    try {
      raw = loopbackOrigin(resolveHost(env).host, resolvePort(env));
    } catch (err) {
      if (err instanceof ConfigError) throw new BridgeError(err.message);
      throw err;
    }
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BridgeError(`"${raw}" is not a valid URL. Example: http://127.0.0.1:4173`, true);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new BridgeError(`Only http and https URLs are supported, not "${url.protocol}".`, true);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const local = host.toLowerCase() === "localhost" || classifyAddress(host) === "loopback";
  return {
    origin: url.origin,
    warning: local ? undefined : `${url.origin} is not this machine: the character's export is being sent over the network to it.`,
  };
}

export interface Deps {
  env: Record<string, string | undefined>;
  /** Unix seconds. */
  now: () => number;
  fetch: typeof fetch;
  /** How long to wait for the Dashboard before giving up. */
  timeoutMs?: number;
}

export interface RunResult {
  exitCode: number;
  stdout: string[];
  stderr: string[];
}

export function iso(seconds: number | undefined): string {
  return seconds === undefined ? "unknown time" : new Date(seconds * 1000).toISOString().replace(".000Z", "Z");
}
function age(seconds: number | undefined, now: number): string {
  if (seconds === undefined) return "age unknown";
  const d = now - seconds;
  if (d < 0) return "in the future?";
  if (d < 90) return `${d}s ago`;
  if (d < 5400) return `${Math.round(d / 60)}m ago`;
  if (d < 172800) return `${Math.round(d / 3600)}h ago`;
  return `${Math.round(d / 86400)}d ago`;
}

function formatList(records: readonly SavedExport[], now: number): string[] {
  if (records.length === 0) return ["  (no saved characters)"];
  const rows = records.map((r) => ({
    who: label(r),
    when: r.text === undefined ? "no saved export" : `${iso(r.generatedAt)} (${age(r.generatedAt, now)})`,
    meta: r.text === undefined ? "" : /^\[ITEM METADATA\]$/m.test(r.text) ? "ITEM METADATA: yes" : "ITEM METADATA: no",
  }));
  const w = Math.max(...rows.map((r) => r.who.length));
  return rows.map((r) => `  ${r.who.padEnd(w)}  ${r.when}${r.meta ? `  ${r.meta}` : ""}`);
}

function describeSummary(s: ExportSummary, now: number): string[] {
  const product = s.version ?? "unknown product";
  const client = [s.clientVersion, s.clientBuild ? `build ${s.clientBuild}` : undefined, s.clientFamily].filter(Boolean).join(" ");
  return [
    `Export:     ${s.name ?? "?"} · ${s.realm ?? "?"} · ${product}${client ? ` (${client})` : ""}`,
    `Generated:  ${iso(s.generatedAt)} (${age(s.generatedAt, now)})  [unix ${s.generatedAt ?? "?"}]`,
    `Text:       ${s.chars} characters, ${s.bytes} bytes`,
    `SHA-256:    ${s.sha256}`,
    `Sections:   [ITEM METADATA] ${s.hasItemMetadata ? `present${s.itemMetadataRows !== undefined ? ` (${s.itemMetadataRows} rows)` : ""}` : "absent"}`,
    ...(s.identityKey ? [`Dashboard identity: ${s.identityKey}`] : []),
  ];
}

// --- the one POST -----------------------------------------------------------------------------------

/** Why a POST did not import: the Dashboard could not be reached (worth retrying), or it answered and did not accept the text. */
export type ImportPostFailure = "unreachable" | "refused";

export class ImportPostError extends BridgeError {
  readonly failure: ImportPostFailure;
  constructor(message: string, failure: ImportPostFailure) {
    super(message);
    this.name = "ImportPostError";
    this.failure = failure;
  }
}

export const importEndpoint = (origin: string): string => `${origin}/api/import`;

/**
 * Sends `{text}` to the Dashboard's `POST /api/import` and returns the server's `result`. The single implementation of the
 * send, shared by `import:saved` and `watch:saved`: neither has any import logic of its own. Throws {@link ImportPostError}
 * (a BridgeError) with the reason; nothing has been imported when it does.
 */
export async function postImport(deps: Pick<Deps, "fetch" | "timeoutMs">, origin: string, text: string): Promise<any> {
  let response: Response;
  try {
    response = await deps.fetch(importEndpoint(origin), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(deps.timeoutMs ?? 30_000),
    });
  } catch (err) {
    const why = (err as Error).name === "TimeoutError" ? "it did not answer in time" : ((err as Error & { cause?: { code?: string } }).cause?.code ?? (err as Error).message);
    throw new ImportPostError(`Can't reach the Dashboard at ${origin} (${why}).\n  Is the server running (npm start)? Use --url or WOWSYNC_URL if it is elsewhere. Nothing was imported.`, "unreachable");
  }
  const raw = await response.text();
  let body: any;
  try {
    body = raw.length > 0 ? JSON.parse(raw) : undefined;
  } catch {
    body = undefined;
  }
  if (!response.ok) {
    const detail = typeof body?.error === "string" ? body.error : raw.slice(0, 300) || response.statusText;
    throw new ImportPostError(
      `The Dashboard refused the import (HTTP ${response.status}${typeof body?.code === "string" ? `, ${body.code}` : ""}):\n  ${detail.split("\n").join("\n  ")}\n  Nothing was imported.`,
      "refused",
    );
  }
  const result = body?.result;
  if (typeof result !== "object" || result === null || typeof result.snapshot?.id !== "number") {
    throw new ImportPostError(`The server at ${origin} answered, but not like the Dashboard's import API (is something else on that port?).`, "refused");
  }
  return result;
}

/** What the server reported for one import, as report lines. `sentSha256` is the hash of the text that was sent. */
export function describeImportResult(result: any, sentSha256: string): string[] {
  const lines = [
    result.isDuplicate ? "Result: ALREADY IMPORTED (duplicate): the Dashboard changed nothing." : "Result: imported as a new snapshot.",
    `  character:     ${result.character?.identityKey ?? "?"}`,
    `  snapshot id:   ${result.snapshot.id}${result.isLatest === undefined ? "" : result.isLatest ? " (now the character's latest)" : " (older than the character's latest)"}`,
  ];
  const stored = typeof result.snapshot.parsed?.raw === "string" ? sha256(result.snapshot.parsed.raw) : undefined;
  lines.push(
    stored === undefined
      ? "  stored text:   not reported by the server"
      : stored === sentSha256
        ? "  stored text:   SHA-256 matches what was sent"
        : "  stored text:   SHA-256 differs from what was sent (an earlier duplicate stored with different whitespace)",
  );
  const shared = Array.isArray(result.sharedStorage) ? result.sharedStorage : [];
  for (const s of shared) lines.push(`  shared storage: ${s.section}: ${s.outcome}${s.reason ? ` (${s.reason})` : ""}${s.ownerKey ? ` [${s.ownerKey}]` : ""}${s.becameCurrent ? " (became current)" : ""}`);
  if (result.snapshot.parsed?.itemMetadata) lines.push(`  item metadata: ${result.snapshot.parsed.itemMetadata.rows?.length ?? "?"} rows carried`);
  return lines;
}

/** Runs the bridge. Never throws for a fixable problem: those become `exitCode` 1 (or 2 for bad usage) and a message. */
export async function runImportSaved(argv: readonly string[], deps: Deps): Promise<RunResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const out = (...lines: string[]) => stdout.push(...lines);
  const now = deps.now();
  try {
    const options = parseOptions(argv);
    if (options.help) return { exitCode: 0, stdout: USAGE.split("\n"), stderr };
    if (!options.list && options.character === undefined) {
      throw new BridgeError("Which character? Pass --character <name> (or --list to see what is saved).", true);
    }

    const found = discoverSavedVariables({ file: options.file, wowDir: options.wowDir, env: deps.env });
    out(`SavedVariables: ${found.path}  (from ${found.via}; read-only)`);
    const records = readSavedExports(found.path);

    if (options.list) {
      out(`Saved exports (${records.filter((r) => r.text !== undefined).length} of ${records.length} characters have one):`, ...formatList(records, now));
      return { exitCode: 0, stdout, stderr };
    }

    const request = { character: options.character!, realm: options.realm };
    const { chosen, warnings } = selectExport(records, request);
    const text = chosen.text!;
    const summary = describeExport(text);
    for (const w of warnings) stderr.push(`warning: ${w}`);
    out(...describeSummary(summary, now));
    const problems = consistencyProblems(chosen, summary, request);
    if (problems.length > 0) {
      throw new BridgeError(`Stopping: this saved export is not what was asked for.\n${problems.map((p) => `  - ${p}`).join("\n")}\n  Nothing was sent.`);
    }

    if (options.dryRun) {
      out("Dry run: nothing was sent and nothing was changed.");
      return { exitCode: 0, stdout, stderr };
    }

    const target = resolveDashboardUrl(options, deps.env);
    if (target.warning) stderr.push(`warning: ${target.warning}`);
    out(`Sending to ${importEndpoint(target.origin)} ...`);
    out(...describeImportResult(await postImport(deps, target.origin, text), summary.sha256));
    return { exitCode: 0, stdout, stderr };
  } catch (err) {
    if (err instanceof BridgeError) {
      stderr.push(`error: ${err.message}`);
      if (err.usage) stderr.push("", ...USAGE.split("\n"));
      return { exitCode: err.usage ? 2 : 1, stdout, stderr };
    }
    throw err;
  }
}
