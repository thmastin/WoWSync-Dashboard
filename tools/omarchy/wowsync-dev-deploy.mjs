#!/usr/bin/node
import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, lstat, readlink, writeFile, symlink, chmod } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync, backup } from 'node:sqlite';

function execFile(file, args, options = {}) {
  return new Promise((resolve, reject) => {
  const child = spawn(file, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  child.on('error', reject);
  child.on('close', (code, signal) => {
    if (code === 0) resolve({ stdout, stderr });
    else {
      const error = new Error(`${file} ${args.join(' ')} failed (${signal ?? code}): ${stderr.trim()}\n${stdout.slice(-12000)}`);
      error.code = code;
      reject(error);
    }
  });
  });
}

const PATHS = Object.freeze({
  source: '/home/wowsync-dev/src/WoWSync-Dashboard',
  deploy: '/home/wowsync-dev/deploy',
  cache: '/home/wowsync-dev/deploy/git-cache.git',
  staging: '/home/wowsync-dev/deploy/staging',
  releases: '/home/wowsync-dev/releases',
  current: '/home/wowsync-dev/releases/current',
  database: '/var/lib/wowsync-dev/db/wowsync.sqlite',
  backups: '/var/lib/wowsync-dev/backups/deploy',
  audit: '/var/lib/wowsync-dev/deployments.jsonl',
  serviceHelper: '/usr/local/sbin/wowsync-dev-app-services',
  baseUrl: 'http://127.0.0.1:4174',
});

const DASHBOARD_UNIT = 'wowsync-dev-dashboard.service';
const MCP_UNIT = 'wowsync-dev-mcp-tunnel.service';
// The only units a deployment stops/starts. Herdr is deliberately absent.
const APP_UNITS = [DASHBOARD_UNIT, MCP_UNIT];
const HERDR_UNIT = 'wowsync-dev-herdr.service';
const TARGET_UNIT = 'wowsync-dev.target';
const RELEASE_ENTRIES = Object.freeze({
  'wowsync-dev-dashboard.service': 'packages/server/src/index.ts',
  'wowsync-dev-mcp-tunnel.service': 'packages/mcp/src/index.ts',
});
const DEFAULT_VALIDATION_ROUTES = [
  { path: '/', status: 200 },
  { path: '/api/versions', status: 200 },
];
export function validateSha(value) {
  if (!/^[0-9a-f]{40}$/.test(value ?? '')) throw new Error('SHA must be exactly 40 lowercase hexadecimal characters.');
  return value;
}

export function validateRemoteRef(value) {
  if (!value || (!value.startsWith('refs/heads/') && !value.startsWith('refs/tags/'))) {
    throw new Error('Expected a full remote ref beginning with refs/heads/ or refs/tags/.');
  }
  const result = spawnSync('/usr/bin/git', ['check-ref-format', value], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`Invalid Git ref: ${value}`);
  return value;
}

export function parseRoute(value) {
  const match = /^([/]([A-Za-z0-9._~!$&'()*+,;=:@%/-]*))=(\d{3})$/.exec(value ?? '');
  if (!match || Number(match[3]) < 100 || Number(match[3]) > 599 || value.includes('..')) {
    throw new Error(`Invalid route expectation: ${value}. Use /path=HTTP_STATUS.`);
  }
  return { path: match[1], status: Number(match[3]) };
}

async function run(file, args, options = {}) {
  const result = await execFile(file, args, { cwd: options.cwd, env: options.env ?? process.env, maxBuffer: 16 * 1024 * 1024 });
  return result.stdout.trimEnd();
}

async function gitAt(args, directory) { return run('/usr/bin/git', ['-C', directory, ...args]); }
async function gitBare(args, directory) { return run('/usr/bin/git', ['--git-dir', directory, ...args]); }

async function ensureCache(paths) {
  await mkdir(path.dirname(paths.cache), { recursive: true, mode: 0o700 });
  try { await lstat(paths.cache); }
  catch { await run('/usr/bin/git', ['init', '--bare', paths.cache]); }
  const origin = await gitAt(['remote', 'get-url', 'origin'], paths.source);
  let cachedOrigin;
  try { cachedOrigin = await gitBare(['remote', 'get-url', 'origin'], paths.cache); }
  catch { await gitBare(['remote', 'add', 'origin', origin], paths.cache); cachedOrigin = origin; }
  if (cachedOrigin !== origin) throw new Error(`Deployment cache origin differs from developer checkout origin: ${cachedOrigin}`);
  return origin;
}

export async function resolveExactCommit(sha, ref, paths = PATHS) {
  validateSha(sha);
  validateRemoteRef(ref);
  await ensureCache(paths);
  await gitBare(['fetch', '--no-tags', '--force', 'origin', `${ref}:refs/deploy/expected`], paths.cache);
  const fetched = await gitBare(['rev-parse', 'refs/deploy/expected^{commit}'], paths.cache);
  if (fetched !== sha) throw new Error(`Remote ref ${ref} resolves to ${fetched}, not requested SHA ${sha}.`);
  return { sha, ref, origin: await gitBare(['remote', 'get-url', 'origin'], paths.cache) };
}

async function gitTreeManifest(sha, paths) {
  const { stdout } = await execFile('/usr/bin/git', ['--git-dir', paths.cache, 'ls-tree', '-rz', '--full-tree', sha]);
  return stdout.split('\0').filter(Boolean).map((entry) => {
    const [metadata, file] = entry.split('\t', 2);
    const [mode, type, oid] = metadata.split(' ');
    if (type !== 'blob') throw new Error(`Unsupported non-blob Git entry in release: ${file}`);
    return { path: file, mode, oid };
  });
}

async function hashGitBlob(filePath) {
  const info = await lstat(filePath);
  let bytes;
  if (info.isSymbolicLink()) bytes = Buffer.from(await readlink(filePath));
  else if (info.isFile()) bytes = await readFile(filePath);
  else throw new Error(`Expected a regular source file or symlink: ${filePath}`);
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

function isGeneratedSourcePath(relative) {
  return relative.split(path.sep).includes('node_modules') || relative === 'packages/web/dist' || relative.startsWith(`packages/web${path.sep}dist${path.sep}`);
}

async function actualSourceFiles(root, relative = '') {
  const found = [];
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const child = path.join(relative, entry.name);
    if (child === 'release.json' || isGeneratedSourcePath(child)) continue;
    if (entry.isDirectory()) found.push(...await actualSourceFiles(root, child));
    else if (entry.isFile() || entry.isSymbolicLink()) found.push(child);
    else throw new Error(`Unsupported source entry: ${child}`);
  }
  return found;
}

export async function assertReleaseSourceClean(root, manifest) {
  const expected = new Map(manifest.map((item) => [item.path, item]));
  const actualPaths = await actualSourceFiles(root);
  for (const relative of actualPaths) {
    const item = expected.get(relative);
    if (!item) throw new Error(`Release contains untracked/invalid source entry: ${relative}`);
    const info = await lstat(path.join(root, relative));
    if ((item.mode === '120000') !== info.isSymbolicLink()) throw new Error(`Release source type changed after export: ${relative}`);
    if (item.mode === '100755' && (info.mode & 0o111) === 0) throw new Error(`Executable bit was removed from release source: ${relative}`);
    if (item.mode === '100644' && (info.mode & 0o111) !== 0) throw new Error(`Unexpected executable bit on release source: ${relative}`);
    const actualOid = await hashGitBlob(path.join(root, relative));
    if (actualOid !== item.oid) throw new Error(`Release source was modified after export: ${relative}`);
    expected.delete(relative);
  }
  if (expected.size) throw new Error(`Release source is missing tracked file: ${expected.keys().next().value}`);
}

export async function assertWorkspaceSelfContained(root) {
  const rootReal = await realpath(root);
  const inspect = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        let target;
        try { target = await realpath(full); }
        catch { throw new Error(`Broken dependency/source symlink: ${full}`); }
        if (target !== rootReal && !target.startsWith(`${rootReal}${path.sep}`)) {
          throw new Error(`Workspace dependency escapes release: ${full} -> ${target}`);
        }
      } else if (entry.isDirectory()) await inspect(full);
    }
  };
  await inspect(path.join(root, 'node_modules'));
  return true;
}

async function extractArchive(sha, destination, paths) {
  await mkdir(destination, { recursive: false, mode: 0o700 });
  const archive = spawn('/usr/bin/git', ['--git-dir', paths.cache, 'archive', '--format=tar', sha], { stdio: ['ignore', 'pipe', 'pipe'] });
  const tar = spawn('/usr/bin/tar', ['-x', '-C', destination, '--no-same-owner'], { stdio: ['pipe', 'ignore', 'pipe'] });
  archive.stdout.pipe(tar.stdin);
  let archiveError = '';
  let tarError = '';
  archive.stderr.setEncoding('utf8').on('data', (chunk) => { archiveError += chunk; });
  tar.stderr.setEncoding('utf8').on('data', (chunk) => { tarError += chunk; });
  const [archiveStatus, tarStatus] = await Promise.all([
    new Promise((resolve, reject) => { archive.on('error', reject); archive.on('close', resolve); }),
    new Promise((resolve, reject) => { tar.on('error', reject); tar.on('close', resolve); }),
  ]);
  if (archiveStatus !== 0 || tarStatus !== 0) throw new Error(`Git archive extraction failed: ${archiveError} ${tarError}`);
}

async function runBuildValidation(stage) {
  await run('/usr/bin/npm', ['ci'], { cwd: stage });
  for (const workspace of ['core', 'server', 'mcp', 'web']) {
    await run('/usr/bin/node', ['node_modules/typescript/bin/tsc', '--noEmit', '-p', `packages/${workspace}/tsconfig.json`], { cwd: stage });
  }
  const testCommand = "ip link set lo up; npm test";
  await run('/usr/bin/unshare', ['--user', '--map-root-user', '--net', '--', '/usr/bin/bash', '-c', testCommand], { cwd: stage });
  await run('/usr/bin/npm', ['run', 'build:web'], { cwd: stage });
  await assertWorkspaceSelfContained(stage);
}

async function makeReleaseReadOnly(root) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) await makeReleaseReadOnly(full);
    else if (!entry.isSymbolicLink()) {
      const info = await lstat(full);
      await chmod(full, info.mode & ~0o222);
    }
  }
  const info = await lstat(root);
  await chmod(root, info.mode & ~0o222);
}

async function makeReleaseWritable(root) {
  await chmod(root, 0o700).catch(() => {});
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) await makeReleaseWritable(full);
    else if (!entry.isSymbolicLink()) await chmod(full, 0o600).catch(() => {});
  }
}

export async function prepareRelease(sha, ref, paths = PATHS, validateBuild = runBuildValidation) {
  await resolveExactCommit(sha, ref, paths);
  await mkdir(paths.staging, { recursive: true, mode: 0o700 });
  await mkdir(paths.releases, { recursive: true, mode: 0o700 });
  const finalPath = path.join(paths.releases, sha);
  try {
    await lstat(finalPath);
    throw new Error(`Release already exists; refusing to overwrite: ${finalPath}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const stage = path.join(paths.staging, `${sha}-${randomUUID()}`);
  try {
    const manifest = await gitTreeManifest(sha, paths);
    await extractArchive(sha, stage, paths);
    await assertReleaseSourceClean(stage, manifest);
    await validateBuild(stage);
    await assertReleaseSourceClean(stage, manifest);
    const release = {
      schemaVersion: 1,
      sha,
      ref,
      origin: await gitBare(['remote', 'get-url', 'origin'], paths.cache),
      preparedAt: new Date().toISOString(),
      sourceManifest: manifest,
    };
    await writeFile(path.join(stage, 'release.json'), `${JSON.stringify(release, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(stage, finalPath);
    await makeReleaseReadOnly(finalPath);
    await validateRelease(finalPath, sha, paths);
    return finalPath;
  } catch (error) {
    await makeReleaseWritable(stage);
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}

export async function validateRelease(releasePath, sha, paths = PATHS) {
  const metadata = JSON.parse(await readFile(path.join(releasePath, 'release.json'), 'utf8'));
  if (metadata.sha !== sha || metadata.schemaVersion !== 1) throw new Error(`Release metadata mismatch at ${releasePath}`);
  const gitManifest = await gitTreeManifest(sha, paths);
  if (JSON.stringify(metadata.sourceManifest) !== JSON.stringify(gitManifest)) throw new Error(`Release source manifest does not match Git SHA ${sha}.`);
  await assertReleaseSourceClean(releasePath, metadata.sourceManifest);
  await assertWorkspaceSelfContained(releasePath);
  return metadata;
}

export async function atomicSetCurrent(releasesPath, sha) {
  validateSha(sha);
  const releasePath = path.join(releasesPath, sha);
  await lstat(releasePath);
  const next = path.join(releasesPath, `.current-${process.pid}-${randomUUID()}`);
  await symlink(releasePath, next);
  await rename(next, path.join(releasesPath, 'current'));
}

export async function currentSha(releasesPath) {
  try {
    const target = await readlink(path.join(releasesPath, 'current'));
    const sha = path.basename(target);
    validateSha(sha);
    if (path.resolve(releasesPath, target) !== path.join(releasesPath, sha)) throw new Error('current must point directly to a SHA-named release.');
    return sha;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function openDatabase(file, readOnly = true) {
  return new DatabaseSync(file, { readOnly });
}

// SQLite's own objects (sqlite_autoindex_*, sqlite_sequence, sqlite_stat*)
// are implied by the user objects' SQL and are never compared or declared.
// GLOB is exact and case-sensitive; LIKE 'sqlite_%' also hid user objects
// such as "sqliteXfoo" because `_` is a LIKE wildcard.
const USER_SCHEMA_OBJECTS = "name NOT GLOB 'sqlite_*'";

// The one SQL normalization and hash used by databaseEvidence, the schema
// planner, schema declarations, and the post-start classifier.
export function normalizeSchemaSql(sql) {
  // sqlite_schema.sql is already SQLite's canonical stored statement. Preserve
  // it byte-for-byte: whitespace inside any quoted token can be semantic.
  // Formatting-only differences may conservatively fail closed as schema changes.
  return typeof sql === 'string' ? sql : null;
}

export function schemaSqlSha256(sql) {
  return createHash('sha256').update(normalizeSchemaSql(sql) ?? '', 'utf8').digest('hex');
}

export function databaseEvidence(dbPath) {
  const db = openDatabase(dbPath, true);
  try {
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND ${USER_SCHEMA_OBJECTS} ORDER BY name`).all().map((row) => row.name);
    const integrity = db.prepare('PRAGMA integrity_check').all();
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') throw new Error(`SQLite integrity_check failed: ${JSON.stringify(integrity)}`);
    const counts = {};
    for (const table of tables) {
      const safeTable = table.replaceAll('"', '""');
      counts[table] = db.prepare(`SELECT COUNT(*) AS count FROM "${safeTable}"`).get().count;
    }
    const userVersion = db.prepare('PRAGMA user_version').get().user_version;
    const schema = db.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master
      WHERE ${USER_SCHEMA_OBJECTS} ORDER BY type, name, tbl_name`).all().map((item) => ({
      ...item, sql: normalizeSchemaSql(item.sql),
    }));
    const schemaSha256 = createHash('sha256').update(JSON.stringify({ userVersion, schema })).digest('hex');
    let demand = null;
    if (tables.includes('demands')) {
      demand = {
        total: db.prepare('SELECT COUNT(*) AS count FROM demands').get().count,
        byStatus: db.prepare('SELECT status, COUNT(*) AS count FROM demands GROUP BY status ORDER BY status').all(),
        latestUpdatedAt: db.prepare('SELECT MAX(updated_at) AS value FROM demands').get().value,
      };
    }
    return { integrityCheck: 'ok', userVersion, schema, schemaSha256, counts, demand };
  } finally { db.close(); }
}

export async function makeConsistentBackup(dbPath, backupPath) {
  await mkdir(path.dirname(backupPath), { recursive: true, mode: 0o700 });
  try {
    await lstat(backupPath);
    throw new Error(`Refusing to overwrite an existing SQLite backup: ${backupPath}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const source = openDatabase(dbPath, true);
  try { await backup(source, backupPath); }
  finally { source.close(); }
  const check = openDatabase(backupPath, true);
  try {
    const result = check.prepare('PRAGMA integrity_check').all();
    if (result.length !== 1 || result[0].integrity_check !== 'ok') throw new Error(`Backup integrity_check failed: ${JSON.stringify(result)}`);
  } finally { check.close(); }
  const handle = await open(backupPath, 'r');
  await handle.chmod(0o600);
  await handle.close();
  return backupPath;
}

export function assertSchemaCompatible(before, after) {
  if (before.integrityCheck !== 'ok' || after.integrityCheck !== 'ok') throw new Error('SQLite integrity_check did not pass before and after deployment.');
  return before.userVersion === after.userVersion && before.schemaSha256 === after.schemaSha256;
}

// --- Expected additive schema changes ---------------------------------------
// An operator may authorize, for one deploy invocation, the addition of exact
// tables/indexes, each bound to the sha256 of its normalized SQL. Nothing else
// (removal, change, rename, trigger, view, user_version) can be authorized.

const SCHEMA_DECLARATION = /^(table|index):([a-z][a-z0-9_]{0,62})@([0-9a-f]{64})$/;
const DECLARABLE_TYPES = new Set(['table', 'index']);

export function parseSchemaDeclaration(value) {
  const match = SCHEMA_DECLARATION.exec(value ?? '');
  if (!match) throw new Error(`Invalid --expect-schema-add declaration: ${value}. Use table:<name>@<sha256> or index:<name>@<sha256> exactly as printed by \`prepare\`.`);
  const [, type, name, sqlSha256] = match;
  if (/^sqlite/i.test(name)) throw new Error(`Invalid --expect-schema-add declaration: ${value}. Names beginning with "sqlite" are SQLite-internal and cannot be declared.`);
  return { type, name, sqlSha256 };
}

export function validateSchemaDeclarations(declarations) {
  if (!Array.isArray(declarations)) throw new Error('Schema declarations must be a list.');
  const byName = new Map();
  for (const declaration of declarations) {
    const parsed = parseSchemaDeclaration(`${declaration?.type}:${declaration?.name}@${declaration?.sqlSha256}`);
    const prior = byName.get(parsed.name);
    if (prior?.type === parsed.type) throw new Error(`Duplicate --expect-schema-add declaration for ${parsed.type} ${parsed.name}.`);
    if (prior) throw new Error(`${parsed.name} is declared as both ${prior.type} and ${parsed.type}; SQLite object names share one namespace.`);
    byName.set(parsed.name, parsed);
  }
  return [...byName.values()];
}

export function formatSchemaDeclaration(object) {
  return `${object.type}:${object.name}@${object.sqlSha256}`;
}

// Structural comparison of two databaseEvidence() results, optionally against
// this invocation's declarations. Classifications:
//   NONE              no user-schema or user_version difference
//   DECLARED_ADDITIVE only declared tables/indexes were added, each with the
//                     declared SQL hash; everything that existed is unchanged
//   UNDECLARED        anything else (including a declared object that is absent)
//   UNKNOWN           evidence missing or unusable; never treated as compatible
export function classifySchemaChange(before, after, declarations = []) {
  const unknown = (reason) => ({ classification: 'UNKNOWN', declarationsSatisfied: false, added: [], removed: [], changed: [], userVersion: null, problems: [reason] });
  if (!before || !after || !Array.isArray(before.schema) || !Array.isArray(after.schema)) return unknown('schema evidence is missing');
  if (before.integrityCheck !== 'ok' || after.integrityCheck !== 'ok') return unknown('SQLite integrity_check did not pass before and after');
  let declared;
  try { declared = validateSchemaDeclarations(declarations); }
  catch (error) { return unknown(error.message); }
  const index = (schema) => {
    const map = new Map();
    for (const item of schema) {
      if (map.has(item.name)) return null;
      map.set(item.name, item);
    }
    return map;
  };
  const beforeObjects = index(before.schema);
  const afterObjects = index(after.schema);
  if (!beforeObjects || !afterObjects) return unknown('schema evidence contains duplicate object names');
  const describe = (item) => ({ type: item.type, name: item.name, tbl_name: item.tbl_name, sql: normalizeSchemaSql(item.sql), sqlSha256: schemaSqlSha256(item.sql) });
  const removed = [];
  const changed = [];
  const added = [];
  for (const [name, item] of beforeObjects) {
    const next = afterObjects.get(name);
    if (!next) removed.push(describe(item));
    else if (next.type !== item.type || next.tbl_name !== item.tbl_name || normalizeSchemaSql(next.sql) !== normalizeSchemaSql(item.sql)) {
      changed.push({ before: describe(item), after: describe(next) });
    }
  }
  for (const [name, item] of afterObjects) if (!beforeObjects.has(name)) added.push(describe(item));
  const userVersion = { before: before.userVersion, after: after.userVersion };
  const problems = [];
  if (before.userVersion !== after.userVersion) problems.push(`user_version changed ${before.userVersion} -> ${after.userVersion}`);
  for (const item of removed) problems.push(`${item.type} ${item.name} was removed`);
  for (const item of changed) problems.push(`${item.before.type} ${item.before.name} changed definition`);
  const declaredByName = new Map(declared.map((item) => [item.name, item]));
  const addedTables = new Set(added.filter((item) => item.type === 'table').map((item) => item.name));
  for (const item of added) {
    const declaration = declaredByName.get(item.name);
    if (!DECLARABLE_TYPES.has(item.type)) problems.push(`${item.type} ${item.name} was added; only tables and indexes can be declared`);
    else if (!declaration) problems.push(`${item.type} ${item.name} was added but not declared (${formatSchemaDeclaration(item)})`);
    else if (declaration.type !== item.type) problems.push(`${item.name} was declared as ${declaration.type} but is a ${item.type}`);
    else if (declaration.sqlSha256 !== item.sqlSha256) problems.push(`${item.type} ${item.name} SQL hash ${item.sqlSha256} does not match the declared ${declaration.sqlSha256}`);
    else if (item.type === 'index' && !beforeObjects.has(item.tbl_name) && !(addedTables.has(item.tbl_name) && declaredByName.get(item.tbl_name)?.type === 'table')) {
      problems.push(`index ${item.name} belongs to ${item.tbl_name}, which is neither pre-existing nor a declared new table`);
    }
  }
  const addedNames = new Set(added.map((item) => item.name));
  for (const declaration of declared) {
    if (!addedNames.has(declaration.name)) problems.push(`declared ${declaration.type} ${declaration.name} was not added`);
  }
  const structurallyNone = removed.length === 0 && changed.length === 0 && added.length === 0 && before.userVersion === after.userVersion;
  let classification;
  if (structurallyNone) classification = 'NONE';
  else classification = problems.length === 0 && declared.length > 0 ? 'DECLARED_ADDITIVE' : 'UNDECLARED';
  return { classification, declarationsSatisfied: problems.length === 0, added, removed, changed, userVersion, problems };
}

// Whether the observed change is exactly what this invocation may accept:
// nothing without declarations, exactly the declarations with them.
export function schemaChangeAccepted(change, declarations = []) {
  if (!change) return false;
  if (declarations.length === 0) return change.classification === 'NONE';
  return change.classification === 'DECLARED_ADDITIVE' && change.declarationsSatisfied === true;
}

// Run one release's real store initialization against a fresh disposable
// SQLite file. The database path travels in the environment; the script is
// a single module string so the tool itself imports only Node built-ins.
export async function runReleaseSchemaInit(releasePath, dbFile, { node = '/usr/bin/node', timeoutMs = 60000 } = {}) {
  const storeFile = path.join(releasePath, 'packages', 'core', 'src', 'sqliteStore.ts');
  if (!(await exists(storeFile))) throw new Error(`Schema initialization failed: ${storeFile} does not exist.`);
  const storeUrl = pathToFileURL(storeFile).href;
  const script = ['import { SqliteSnapshotStore } from ', JSON.stringify(storeUrl), ';\n',
    'const store = new SqliteSnapshotStore(process.env.WOWSYNC_SCHEMA_PLAN_DB);\n',
    'store.close();\n'].join('');
  await execFile(node, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', script], {
    cwd: releasePath,
    timeout: timeoutMs,
    env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', HOME: process.env.HOME ?? '/', WOWSYNC_SCHEMA_PLAN_DB: dbFile },
  });
}

function planState(change) {
  if (change.classification === 'NONE') return 'NONE';
  const additiveOnly = change.removed.length === 0 && change.changed.length === 0
    && change.userVersion.before === change.userVersion.after
    && change.added.every((item) => DECLARABLE_TYPES.has(item.type));
  return additiveOnly ? 'ADDITIVE' : 'NON_ADDITIVE';
}

// Predict the schema a candidate release would add, comparing the empty
// schema created by the previous release with the one created by the
// candidate. Only disposable files under stagingDir are created; the real
// database is never opened. Prediction is preventive; the post-start
// classification of the real database remains authoritative.
export async function predictSchemaChange({ previousRelease, candidateRelease, stagingDir, declarations = [], runStore = runReleaseSchemaInit }) {
  await mkdir(stagingDir, { recursive: true, mode: 0o700 });
  const workspace = await mkdtemp(path.join(stagingDir, 'schema-plan-'));
  try {
    const evidence = {};
    for (const [label, release] of [['previous', previousRelease], ['candidate', candidateRelease]]) {
      const dbFile = path.join(workspace, `${label}.sqlite`);
      await runStore(release, dbFile);
      evidence[label] = databaseEvidence(dbFile);
    }
    const structural = classifySchemaChange(evidence.previous, evidence.candidate, []);
    const state = planState(structural);
    const matched = declarations.length ? classifySchemaChange(evidence.previous, evidence.candidate, declarations) : structural;
    return {
      state,
      added: structural.added.map((item) => ({ ...item, declaration: formatSchemaDeclaration(item) })),
      removed: structural.removed,
      changed: structural.changed,
      userVersion: structural.userVersion,
      problems: structural.problems.filter((problem) => !/was added but not declared/.test(problem)),
      declarations: declarations.map(formatSchemaDeclaration),
      declarationsMatch: schemaChangeAccepted(matched, declarations),
      declarationProblems: declarations.length ? matched.problems : [],
    };
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

// Decide what a pre-stop plan permits for this invocation. Returns null when
// the deploy may proceed, otherwise the reason it must stop before touching DEV.
export function schemaPlanRejection(plan, declarations = []) {
  if (plan.state === 'NON_ADDITIVE') {
    return `Candidate schema plan is NON-ADDITIVE (${[...plan.problems, ...plan.added.filter((item) => !DECLARABLE_TYPES.has(item.type)).map((item) => `${item.type} ${item.name} added`)].join('; ')}); declarations cannot authorize it.`;
  }
  if (plan.state === 'NONE') {
    return declarations.length ? `No schema change is predicted for the candidate, but --expect-schema-add was given (${declarations.map(formatSchemaDeclaration).join(', ')}).` : null;
  }
  if (declarations.length === 0) {
    return `Candidate adds schema objects that were not declared. Review them, then re-run deploy with: ${plan.added.map((item) => `--expect-schema-add ${item.declaration}`).join(' ')}`;
  }
  if (!plan.declarationsMatch) return `Declared schema additions do not match the candidate plan: ${plan.declarationProblems.join('; ')}.`;
  return null;
}

// The recovery decision after a failed candidate. `schema` is the
// post-stop classification of the real database (null when it could not be
// read). Without `schema`, the original boolean contract applies.
export function recoveryPolicy({ schemaChanged = false, candidateStarted = false, schema, declarations = [], previousCodeCompatible = false }) {
  const stop = { action: 'stop-review-required', mayStartPreviousCode: false };
  const restore = { action: 'restore-previous-release-and-validate', mayStartPreviousCode: true };
  if (schema !== undefined) {
    if (schema === null || !schema.classification) return stop;
    if (schema.classification === 'NONE') return restore;
    if (schema.classification === 'DECLARED_ADDITIVE' && previousCodeCompatible === true
      && declarations.length > 0 && schemaChangeAccepted(schema, declarations)) {
      return { action: 'restore-previous-release-retaining-declared-additions', mayStartPreviousCode: true, retainedAdditions: schema.added.map((item) => ({ type: item.type, name: item.name })) };
    }
    return stop;
  }
  if (schemaChanged === true || (candidateStarted && schemaChanged !== false)) return stop;
  return restore;
}

export async function recoverFailedPromotion({ schemaChanged = false, candidateStarted = false, schema, declarations, previousCodeCompatible, priorStopResult, stop, setPrevious, startPrevious, validatePrevious }) {
  const policy = recoveryPolicy({ schemaChanged, candidateStarted, schema, declarations, previousCodeCompatible });
  if (!policy.mayStartPreviousCode) {
    if (priorStopResult) return { state: 'stopped-review-required', stopResult: priorStopResult, action: policy.action };
    try { await stop(); return { state: 'stopped-review-required', stopResult: 'succeeded', action: policy.action }; }
    catch (error) { return { state: 'stopped-review-required', stopResult: `failed: ${error.message}`, action: policy.action }; }
  }
  if (priorStopResult !== 'succeeded') await stop();
  await setPrevious();
  await startPrevious();
  const validation = await validatePrevious();
  return { state: 'validated', action: policy.action, validation, ...(policy.retainedAdditions ? { retainedAdditions: policy.retainedAdditions } : {}) };
}

// Record the attempt before invoking the service boundary: systemd may launch
// Dashboard and still return an error to the caller.
export async function startCandidateConservatively(start, markMayHaveStarted) {
  markMayHaveStarted();
  return start();
}

// Stop first, then inspect schema. If stop or inspection fails, compatibility
// is unknown and callers must not start old application code automatically.
export async function stopCandidateThenInspectSchema({ candidateMayHaveRun, stop, inspectSchema }) {
  if (!candidateMayHaveRun) return { stopResult: 'not-needed', schemaChanged: false };
  try { await stop(); }
  catch (error) { return { stopResult: `failed: ${error.message}`, schemaChanged: null }; }
  try { return { stopResult: 'succeeded', schemaChanged: await inspectSchema() }; }
  catch { return { stopResult: 'succeeded', schemaChanged: null }; }
}

export async function waitForReadiness({ fetchFn = fetch, baseUrl, routes = DEFAULT_VALIDATION_ROUTES, timeoutMs = 30000, intervalMs = 250, settleMs = 1500, sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = () => Date.now(), onProbe = () => {} }) {
  const deadline = now() + timeoutMs;
  let lastError = 'no successful readiness response';
  while (now() < deadline) {
    try {
      const results = [];
      for (const route of routes) {
        const response = await fetchFn(new URL(route.path, baseUrl), { signal: AbortSignal.timeout(Math.min(5000, timeoutMs)) });
        results.push({ path: route.path, status: response.status });
        if (response.status !== route.status) throw new Error(`${route.path}: HTTP ${response.status}, expected ${route.status}`);
      }
      onProbe({ ok: true, results });
      const settleDeadline = now() + settleMs;
      while (now() < settleDeadline) {
        await sleepFn(Math.min(intervalMs, settleDeadline - now()));
        for (const route of routes) {
          const response = await fetchFn(new URL(route.path, baseUrl), { signal: AbortSignal.timeout(Math.min(5000, timeoutMs)) });
          if (response.status !== route.status) throw new Error(`readiness stability check ${route.path}: HTTP ${response.status}, expected ${route.status}`);
        }
      }
      return results;
    } catch (error) {
      lastError = error.message;
      onProbe({ ok: false, error: lastError });
      await sleepFn(Math.min(intervalMs, Math.max(1, deadline - now())));
    }
  }
  throw new Error(`Dashboard readiness timed out after ${timeoutMs}ms: ${lastError}`);
}

async function sha256File(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

export function parseSystemdServiceState(output) {
  const fields = ['ActiveState', 'SubState', 'MainPID', 'NRestarts', 'Result'];
  const parsed = new Map();
  for (const line of output.split(/\r?\n/).filter(Boolean)) {
    const separator = line.indexOf('=');
    if (separator <= 0) throw new Error(`Malformed systemctl show property: ${line}`);
    const name = line.slice(0, separator);
    if (!fields.includes(name)) continue;
    if (parsed.has(name)) throw new Error(`Duplicate systemctl show property: ${name}`);
    parsed.set(name, line.slice(separator + 1));
  }
  for (const field of fields) {
    if (!parsed.has(field) || parsed.get(field) === '') throw new Error(`Missing or empty systemctl show property: ${field}`);
  }
  const parseCounter = (field) => {
    const value = parsed.get(field);
    if (!/^\d+$/.test(value)) throw new Error(`Invalid numeric systemctl show property ${field}: ${value}`);
    const numeric = Number(value);
    if (!Number.isSafeInteger(numeric)) throw new Error(`Out-of-range systemctl show property ${field}: ${value}`);
    return numeric;
  };
  return {
    ActiveState: parsed.get('ActiveState'),
    SubState: parsed.get('SubState'),
    MainPID: parseCounter('MainPID'),
    NRestarts: parseCounter('NRestarts'),
    Result: parsed.get('Result'),
  };
}

export function assertServiceStateHealthy(unit, state) {
  if (state.ActiveState !== 'active' || state.Result !== 'success' || !Number.isInteger(state.MainPID) || state.MainPID <= 0) {
    throw new Error(`${unit} is not healthy: ${JSON.stringify(state)}`);
  }
  return state;
}

export function parseSystemdTargetState(output) {
  const fields = ['ActiveState', 'SubState'];
  const parsed = new Map();
  for (const line of output.split(/\r?\n/).filter(Boolean)) {
    const separator = line.indexOf('=');
    if (separator <= 0) throw new Error(`Malformed systemctl target property: ${line}`);
    const name = line.slice(0, separator);
    if (!fields.includes(name)) continue;
    if (parsed.has(name)) throw new Error(`Duplicate systemctl target property: ${name}`);
    parsed.set(name, line.slice(separator + 1));
  }
  for (const field of fields) {
    if (!parsed.has(field) || parsed.get(field) === '') throw new Error(`Missing or empty systemctl target property: ${field}`);
  }
  return { ActiveState: parsed.get('ActiveState'), SubState: parsed.get('SubState') };
}

export function assertTargetActive(state) {
  if (state.ActiveState !== 'active') throw new Error(`wowsync-dev.target is not active: ${JSON.stringify(state)}`);
  return state;
}

function parseShowProperties(output, fields, label) {
  const parsed = new Map();
  for (const line of output.split(/\r?\n/).filter(Boolean)) {
    const separator = line.indexOf('=');
    if (separator <= 0) throw new Error(`Malformed systemctl ${label} property: ${line}`);
    const name = line.slice(0, separator);
    if (!fields.includes(name)) continue;
    if (parsed.has(name)) throw new Error(`Duplicate systemctl ${label} property: ${name}`);
    parsed.set(name, line.slice(separator + 1));
  }
  for (const field of fields) {
    if (!parsed.has(field) || parsed.get(field) === '') throw new Error(`Missing or empty systemctl ${label} property: ${field}`);
  }
  if (!/^[0-9a-f]{32}$/.test(parsed.get('InvocationID'))) throw new Error(`Invalid systemctl ${label} property InvocationID: ${parsed.get('InvocationID')}`);
  return Object.fromEntries(parsed);
}

export function parseSystemdInvocationId(output) {
  return parseShowProperties(output, ['InvocationID'], 'invocation').InvocationID;
}

export function parseSystemdReleaseUnitState(output) {
  const state = parseShowProperties(output, ['InvocationID', 'NeedDaemonReload', 'WorkingDirectory', 'ExecStart'], 'release unit');
  if (!['yes', 'no'].includes(state.NeedDaemonReload)) throw new Error(`Invalid systemctl release unit property NeedDaemonReload: ${state.NeedDaemonReload}`);
  return state;
}

// A new InvocationID proves systemd started this unit after the pre-stop
// invocation ended; the loaded unit proves it was started via releases/current.
export function assertReleaseUnitInvocation(unit, state, { current, priorInvocationIds }) {
  const entry = RELEASE_ENTRIES[unit];
  if (!entry) throw new Error(`No release entry point is defined for ${unit}.`);
  if (state.NeedDaemonReload !== 'no') throw new Error(`${unit} has NeedDaemonReload=${state.NeedDaemonReload}; the running invocation may not match the installed unit.`);
  if (state.WorkingDirectory !== current) throw new Error(`${unit} WorkingDirectory is ${state.WorkingDirectory}, expected ${current}.`);
  const argv = [...state.ExecStart.matchAll(/argv\[\]=([^;]*) ;/g)];
  if (argv.length !== 1 || !argv[0][1].split(/\s+/).includes(`${current}/${entry}`)) {
    throw new Error(`${unit} ExecStart does not execute ${current}/${entry}: ${state.ExecStart}`);
  }
  if (!Array.isArray(priorInvocationIds) || priorInvocationIds.length === 0) throw new Error(`${unit} has no recorded pre-stop InvocationID; invocation freshness cannot be proven.`);
  if (priorInvocationIds.includes(state.InvocationID)) throw new Error(`${unit} InvocationID ${state.InvocationID} is not a new invocation after the stop.`);
  return state;
}

async function serviceState(unit) {
  const fields = ['ActiveState', 'SubState', 'MainPID', 'Result', 'NRestarts'];
  const output = await run('/usr/bin/systemctl', ['show', ...fields.flatMap((field) => ['-p', field]), unit]);
  return parseSystemdServiceState(output);
}

async function targetState(unit) {
  const output = await run('/usr/bin/systemctl', ['show', '-p', 'ActiveState', '-p', 'SubState', unit]);
  return parseSystemdTargetState(output);
}

async function releaseUnitState(unit) {
  const output = await run('/usr/bin/systemctl', ['show', '-p', 'InvocationID', '-p', 'NeedDaemonReload', '-p', 'WorkingDirectory', '-p', 'ExecStart', unit]);
  return parseSystemdReleaseUnitState(output);
}

async function readInvocationId(unit) {
  return parseSystemdInvocationId(await run('/usr/bin/systemctl', ['show', '-p', 'InvocationID', unit]));
}

async function unitConfig(unit) {
  return {
    WorkingDirectory: await run('/usr/bin/systemctl', ['show', '-p', 'WorkingDirectory', '--value', unit]),
    ExecStart: await run('/usr/bin/systemctl', ['show', '-p', 'ExecStart', '--value', unit]),
  };
}

async function readJournalWarnings(since, paths = PATHS) {
  const journalSince = since.replace(/\.\d{3}Z$/, 'Z');
  return run('/usr/bin/sudo', ['-n', paths.serviceHelper, 'warnings', journalSince]);
}

// Every host interaction a deployment makes: the root service helper, systemd
// properties, HTTP probes, process working directories, and the release build.
// Tests substitute a simulated host; nothing else in the deployment path
// touches systemd, sudo, HTTP, or /proc.
export function hostOps(paths = PATHS) {
  return {
    serviceHelper: async (operation) => { await run('/usr/bin/sudo', ['-n', paths.serviceHelper, operation]); },
    journalWarnings: (since) => readJournalWarnings(since, paths),
    serviceState,
    targetState,
    releaseUnitState,
    invocationId: readInvocationId,
    unitConfig,
    processCwd: (pid) => realpath(`/proc/${pid}/cwd`),
    fetch: (url, options) => fetch(url, options),
    validateBuild: runBuildValidation,
    runSchemaStore: (releasePath, dbFile) => runReleaseSchemaInit(releasePath, dbFile),
    readiness: {},
  };
}

async function captureInvocationIds(readId) {
  const ids = {};
  for (const unit of APP_UNITS) ids[unit] = [await readId(unit)];
  return ids;
}

function excludedInvocations(preStop, observed) {
  return Object.fromEntries(APP_UNITS.map((unit) => [unit, [...(preStop[unit] ?? []), ...(observed[unit] ?? [])]]));
}

async function validateHttp(routes, baseUrl, fetchFn) {
  const results = [];
  for (const route of routes) {
    const response = await fetchFn(new URL(route.path, baseUrl), { signal: AbortSignal.timeout(5000) });
    results.push({ path: route.path, expected: route.status, actual: response.status });
    if (response.status !== route.status) throw new Error(`HTTP ${route.path}: expected ${route.status}, got ${response.status}`);
  }
  return results;
}

// Pre-stop/no-op checks of long-running services only. Never call this with a
// SHA after starting units: a just-started hardened unit's /proc/<MainPID>/cwd
// was unreadable (EACCES) on the real host. Use assertFreshReleaseServices.
async function assertApplicationServices(expectedSha, { paths, ops }) {
  const states = {};
  const expectedCwd = expectedSha ? await realpath(path.join(paths.releases, expectedSha)) : null;
  for (const unit of APP_UNITS) {
    states[unit] = await ops.serviceState(unit);
    assertServiceStateHealthy(unit, states[unit]);
    if (expectedCwd) {
      const cwd = await ops.processCwd(states[unit].MainPID);
      if (cwd !== expectedCwd) throw new Error(`${unit} runs from ${cwd}, expected release ${expectedSha} at ${expectedCwd}.`);
    }
  }
  const target = assertTargetActive(await ops.targetState(TARGET_UNIT));
  return { target, units: states };
}

// Post-start validation. Proves each unit is a new invocation, started through
// the releases/current topology, while releases/current resolves to the
// expected immutable release — without inspecting another process's /proc.
export async function assertFreshReleaseServices(expectedSha, priorInvocations, {
  paths = PATHS,
  readServiceState = serviceState,
  readReleaseUnitState = releaseUnitState,
  readTargetState = targetState,
  realpathFn = realpath,
  observedInvocations = {},
} = {}) {
  validateSha(expectedSha);
  const expectedRelease = await realpathFn(path.join(paths.releases, expectedSha));
  const assertCurrent = async () => {
    const resolved = await realpathFn(paths.current);
    if (resolved !== expectedRelease) throw new Error(`${paths.current} resolves to ${resolved}, expected release ${expectedSha} at ${expectedRelease}.`);
  };
  await assertCurrent();
  const units = {};
  for (const unit of APP_UNITS) {
    const state = assertServiceStateHealthy(unit, await readServiceState(unit));
    const release = await readReleaseUnitState(unit);
    (observedInvocations[unit] ??= []).push(release.InvocationID);
    assertReleaseUnitInvocation(unit, release, { current: paths.current, priorInvocationIds: priorInvocations[unit] });
    units[unit] = { ...state, InvocationID: release.InvocationID };
  }
  await assertCurrent();
  const target = assertTargetActive(await readTargetState('wowsync-dev.target'));
  return { target, units };
}

// Validate at start, wait for readiness, then validate again: the same fresh
// invocations must survive readiness and releases/current must still resolve
// to the expected release afterwards.
export async function validateStartedRelease(expectedSha, priorInvocations, { awaitReadiness, ...options }) {
  const atStart = await assertFreshReleaseServices(expectedSha, priorInvocations, options);
  await awaitReadiness();
  const afterReadiness = await assertFreshReleaseServices(expectedSha, priorInvocations, options);
  for (const unit of APP_UNITS) {
    if (afterReadiness.units[unit].InvocationID !== atStart.units[unit].InvocationID) {
      throw new Error(`${unit} invocation changed during readiness: ${atStart.units[unit].InvocationID} -> ${afterReadiness.units[unit].InvocationID}.`);
    }
  }
  assertRestartCountersStable(atStart, afterReadiness);
  return { atStart, afterReadiness };
}

async function assertReleaseUnitPaths({ paths, ops }) {
  for (const unit of APP_UNITS) {
    const { WorkingDirectory: cwd, ExecStart: command } = await ops.unitConfig(unit);
    if (cwd !== paths.current || !command.includes(`${paths.current}/packages/`)) {
      throw new Error(`${unit} is not configured to execute from ${paths.current}; observed WorkingDirectory=${cwd}, ExecStart=${command}`);
    }
  }
}

export function assertRestartCountersStable(before, after) {
  for (const unit of Object.keys(after.units)) {
    const beforeCount = before.units?.[unit]?.NRestarts;
    const afterCount = after.units[unit].NRestarts;
    if (Number(afterCount) !== 0) throw new Error(`${unit} NRestarts is ${afterCount} after start/settle; expected 0 for the current invocation.`);
    if (beforeCount !== undefined && Number(beforeCount) !== Number(afterCount)) throw new Error(`${unit} NRestarts changed during validation: ${beforeCount} -> ${afterCount}.`);
  }
}

export async function appendAudit(record, paths = PATHS) {
  await mkdir(path.dirname(paths.audit), { recursive: true, mode: 0o700 });
  const handle = await open(paths.audit, 'a', 0o600);
  try { await handle.write(`${JSON.stringify({ schemaVersion: 2, ...record })}\n`); await handle.sync(); }
  finally { await handle.close(); }
}

// The tool normally runs from the deployed immutable release, so the release
// SHA identifies the deployment code that ran.
async function deploymentToolIdentity(paths = PATHS) {
  const entryPath = await realpath(fileURLToPath(import.meta.url));
  const relative = path.relative(paths.releases, entryPath);
  const [first] = relative.split(path.sep);
  const releaseSha = !relative.startsWith('..') && /^[0-9a-f]{40}$/.test(first) ? first : null;
  return { version: '3', entryPath, releaseSha, entrySha256: await sha256File(entryPath) };
}

async function toolIdentity(paths, ops) {
  return typeof ops.deploymentToolIdentity === 'function'
    ? ops.deploymentToolIdentity(paths)
    : deploymentToolIdentity(paths);
}

export async function collectJournalWarnings(since, paths = PATHS, reader = readJournalWarnings) {
  try { return { ok: true, output: await reader(since, paths) }; }
  catch (error) { return { ok: false, error: error.message }; }
}


export function normalizeRef(value) {
  if (!value) throw new Error('A branch or ref to deploy is required.');
  return validateRemoteRef(value.startsWith('refs/') ? value : `refs/heads/${value}`);
}

export function validateExpectedSha(value) {
  if (!/^[0-9a-f]{7,40}$/.test(value ?? '')) {
    throw new Error('The validated SHA is required: 7-40 lowercase hexadecimal characters (normally the full SHA).');
  }
  return value;
}

// Fetch the requested remote ref and require it to still point at the commit
// the caller validated. Returns the full SHA.
export async function resolveRequestedCommit(ref, expectedSha, paths = PATHS) {
  validateRemoteRef(ref);
  validateExpectedSha(expectedSha);
  await ensureCache(paths);
  await gitBare(['fetch', '--no-tags', '--force', 'origin', `${ref}:refs/deploy/expected`], paths.cache);
  const fetched = await gitBare(['rev-parse', 'refs/deploy/expected^{commit}'], paths.cache);
  if (!fetched.startsWith(expectedSha)) {
    throw new Error(`Remote ${ref} points to ${fetched}, not the validated SHA ${expectedSha}. Push the validated commit, or deploy the SHA the ref now points to.`);
  }
  return fetched;
}

export class DeployError extends Error {
  constructor(message, outcome) {
    super(message);
    this.outcome = outcome;
  }
}

const iso = () => new Date().toISOString();

async function exists(file) {
  try { await lstat(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

// A failure before the first service stop: DEV was not touched.
async function rejectUnchanged(error, context, tool, paths) {
  if (error instanceof DeployError) return error;
  const outcome = {
    state: 'UNCHANGED',
    kind: context.kind,
    requestedSha: context.sha ?? context.expectedSha ?? null,
    requestedRef: context.ref ?? null,
    runningSha: context.previousSha ?? null,
    manualIntervention: Boolean(error.manualIntervention),
    cause: error.message,
    ...(error.schemaPlan ? { schemaPlan: error.schemaPlan } : {}),
  };
  await appendAudit({
    schemaVersion: 2, operation: `${context.kind}_COMMAND_FAILURE`, tool, requestedSha: outcome.requestedSha,
    requestedRef: outcome.requestedRef, previousSha: outcome.runningSha, candidateSha: outcome.requestedSha,
    devChanged: false, error: error.message, ...(error.schemaPlan ? { schemaPlan: error.schemaPlan } : {}), at: iso(),
  }, paths).catch(() => {});
  return new DeployError(error.message, outcome);
}

// Build and verify releases/<sha> unless it already exists, in which case
// re-verify it against Git. Never touches the running services.
async function ensureRelease(sha, ref, { tool, paths, ops }) {
  const releasePath = path.join(paths.releases, sha);
  if (await exists(releasePath)) {
    await validateRelease(releasePath, sha, paths);
    return 'reused';
  }
  let release;
  try { release = await prepareRelease(sha, ref, paths, ops.validateBuild); }
  catch (error) {
    await appendAudit({ schemaVersion: 2, operation: 'PREPARE_FAILURE', tool, requestedSha: sha, requestedRef: ref, candidateSha: sha, error: error.message, at: iso() }, paths).catch(() => {});
    throw new Error(`Release build/validation failed: ${error.message}`);
  }
  await appendAudit({ schemaVersion: 2, operation: 'PREPARE_SUCCESS', tool, requestedSha: sha, requestedRef: ref, candidateSha: sha, release, at: iso() }, paths);
  return 'built';
}

async function planCandidateSchema(previousSha, sha, declarations, { paths, ops }) {
  return predictSchemaChange({
    previousRelease: await realpath(path.join(paths.releases, previousSha)),
    candidateRelease: path.join(paths.releases, sha),
    stagingDir: paths.staging,
    declarations,
    runStore: ops.runSchemaStore ?? runReleaseSchemaInit,
  });
}

// Troubleshooting/host-setup operation: build (or re-verify) a release
// without touching DEV, e.g. to create the first release on a rebuilt host.
// Also prints the candidate's schema plan and any copy-ready declarations.
export async function prepare({ ref, expectedSha }, { paths = PATHS, ops = hostOps(paths) } = {}) {
  const tool = await toolIdentity(paths, ops);
  const context = { kind: 'PREPARE', expectedSha, sha: null, ref: null, previousSha: null };
  let releaseState;
  try {
    context.ref = normalizeRef(ref);
    context.previousSha = await currentSha(paths.releases);
    context.sha = await resolveRequestedCommit(context.ref, expectedSha, paths);
    releaseState = await ensureRelease(context.sha, context.ref, { tool, paths, ops });
  } catch (error) {
    throw await rejectUnchanged(error, context, tool, paths);
  }
  let schemaPlan;
  if (!context.previousSha) schemaPlan = { state: 'UNAVAILABLE', error: 'no deployed release to compare against' };
  else if (context.previousSha === context.sha) schemaPlan = { state: 'NONE', added: [], removed: [], changed: [], problems: [], note: 'candidate is the deployed release' };
  else {
    try { schemaPlan = await planCandidateSchema(context.previousSha, context.sha, [], { paths, ops }); }
    catch (error) { schemaPlan = { state: 'UNAVAILABLE', error: error.message }; }
  }
  return { state: 'PREPARED', kind: 'PREPARE', sha: context.sha, ref: context.ref, release: releaseState, releasePath: path.join(paths.releases, context.sha), runningSha: context.previousSha, schemaPlan, auditPath: paths.audit };
}

const SWITCH_OPERATION = /^(PROMOTE|ROLLBACK)_(INTENT|SUCCESS|FAILURE)$/;

// The last release-switch record (INTENT/SUCCESS/FAILURE of PROMOTE or
// ROLLBACK) in the audit journal. An INTENT with nothing after it means a
// switch was interrupted. A torn final line is treated the same way.
export async function lastSwitchRecord(auditPath) {
  let text;
  try { text = await readFile(auditPath, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    return { operation: 'UNREADABLE_JOURNAL', unreadable: true, error: error.message };
  }
  const lines = text.split('\n').filter((line) => line.trim());
  let last = null;
  for (let index = 0; index < lines.length; index += 1) {
    let record;
    try { record = JSON.parse(lines[index]); }
    catch {
      if (index === lines.length - 1) return { operation: 'UNREADABLE_FINAL_RECORD', torn: true };
      continue;
    }
    if (typeof record?.operation === 'string' && SWITCH_OPERATION.test(record.operation)) last = record;
  }
  return last;
}

const FULL_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const APP_SERVICE_UNITS = ['wowsync-dev-dashboard.service', 'wowsync-dev-mcp-tunnel.service'];
const isFullSha = (value) => typeof value === 'string' && FULL_SHA.test(value);
const isSha256 = (value) => typeof value === 'string' && SHA256.test(value);
const isOperation = (value, pattern) => typeof value === 'string' && pattern.test(value);
const isAuditTime = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString() === value;

function isPlainRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validToolIdentity(tool, expectedReleaseSha) {
  if (!isPlainRecord(tool) || tool.version !== '3' || typeof tool.entryPath !== 'string'
    || !path.isAbsolute(tool.entryPath) || !isSha256(tool.entrySha256)) return false;
  return isFullSha(tool.releaseSha) && tool.releaseSha === expectedReleaseSha;
}

function validHttpEvidence(http) {
  return Array.isArray(http) && http.length > 0 && http.every((item) => isPlainRecord(item)
    && typeof item.path === 'string' && item.path.startsWith('/')
    && Number.isInteger(item.expected) && item.expected >= 100 && item.expected <= 599
    && Number.isInteger(item.actual) && item.actual === item.expected);
}

function validServiceEvidence(services, { fresh }) {
  if (!isPlainRecord(services) || !isPlainRecord(services.units) || !isPlainRecord(services.target)
    || services.target.ActiveState !== 'active' || services.target.SubState !== 'active') return false;
  for (const unit of APP_SERVICE_UNITS) {
    const state = services.units[unit];
    if (!isPlainRecord(state) || state.ActiveState !== 'active' || state.SubState !== 'running'
      || state.Result !== 'success' || !Number.isSafeInteger(state.MainPID) || state.MainPID <= 0
      || !Number.isSafeInteger(state.NRestarts) || state.NRestarts < 0
      || (fresh && state.NRestarts !== 0)) return false;
    if (fresh && (typeof state.InvocationID !== 'string' || !/^[0-9a-f]{32}$/.test(state.InvocationID))) return false;
    if (!fresh && Object.hasOwn(state, 'InvocationID')) return false;
  }
  return services.units[APP_SERVICE_UNITS[0]].MainPID !== services.units[APP_SERVICE_UNITS[1]].MainPID;
}

function validSchemaItems(items) {
  return Array.isArray(items) && items.every((item) => isPlainRecord(item)
    && ['table', 'index'].includes(item.type)
    && typeof item.name === 'string' && /^[a-z][a-z0-9_]{0,62}$/.test(item.name) && !/^sqlite/i.test(item.name)
    && typeof item.tbl_name === 'string' && item.tbl_name.length > 0
    && typeof item.sql === 'string' && isSha256(item.sqlSha256)
    && schemaSqlSha256(item.sql) === item.sqlSha256);
}

function validSchemaEvidence(change, { declared } = {}) {
  if (!isPlainRecord(change) || !['NONE', 'DECLARED_ADDITIVE'].includes(change.classification)
    || change.declarationsSatisfied !== true || !validSchemaItems(change.added)
    || !Array.isArray(change.removed) || change.removed.length !== 0
    || !Array.isArray(change.changed) || change.changed.length !== 0
    || !Array.isArray(change.problems) || change.problems.length !== 0
    || !isPlainRecord(change.userVersion) || !Number.isSafeInteger(change.userVersion.before)
    || change.userVersion.before < 0 || !Number.isSafeInteger(change.userVersion.after)
    || change.userVersion.after !== change.userVersion.before) return false;
  if (change.classification === 'NONE') return change.added.length === 0 && (!declared || declared.length === 0);
  if (!change.added.length || !Array.isArray(declared)) return false;
  let parsed;
  try { parsed = validateSchemaDeclarations(declared.map((value) => {
    const match = typeof value === 'string' && /^(table|index):([a-z][a-z0-9_]{0,62})@([0-9a-f]{64})$/.exec(value);
    if (!match) throw new Error('invalid declaration');
    return { type: match[1], name: match[2], sqlSha256: match[3] };
  })); } catch { return false; }
  const expected = change.added.map((item) => `${item.type}:${item.name}@${item.sqlSha256}`).sort();
  return expected.length === parsed.length && expected.join('\n') === declared.slice().sort().join('\n')
    && change.added.every((item) => item.type !== 'index' || typeof item.tbl_name === 'string');
}

function validSchemaSuccessEvidence(record) {
  const change = record.schemaChange;
  if (!isPlainRecord(record.dataBefore) || !isPlainRecord(record.dataAfter)
    || record.dataBefore.integrityCheck !== 'ok' || record.dataAfter.integrityCheck !== 'ok'
    || !Array.isArray(record.dataBefore.schema) || !Array.isArray(record.dataAfter.schema)
    || !Number.isSafeInteger(record.dataBefore.userVersion) || !Number.isSafeInteger(record.dataAfter.userVersion)
    || !Array.isArray(change?.declared) || typeof change.previousCodeCompatible !== 'boolean'
    || typeof record.schemaChanged !== 'boolean') return false;
  let declarations;
  try {
    declarations = validateSchemaDeclarations(change.declared.map((value) => {
      const match = typeof value === 'string' && /^(table|index):([a-z][a-z0-9_]{0,62})@([0-9a-f]{64})$/.exec(value);
      if (!match) throw new Error('invalid declaration');
      return { type: match[1], name: match[2], sqlSha256: match[3] };
    }));
  } catch { return false; }
  const observed = classifySchemaChange(
    { integrityCheck: 'ok', userVersion: record.dataBefore.userVersion, schema: record.dataBefore.schema },
    { integrityCheck: 'ok', userVersion: record.dataAfter.userVersion, schema: record.dataAfter.schema },
    declarations,
  );
  return validSchemaEvidence(change, { declared: change.declared })
    && observed.classification === change.classification
    && observed.declarationsSatisfied === change.declarationsSatisfied
    && JSON.stringify(observed.added) === JSON.stringify(change.added)
    && JSON.stringify(observed.removed) === JSON.stringify(change.removed)
    && JSON.stringify(observed.changed) === JSON.stringify(change.changed)
    && JSON.stringify(observed.userVersion) === JSON.stringify(change.userVersion)
    && JSON.stringify(observed.problems) === JSON.stringify(change.problems)
    && record.schemaChanged === (change.classification === 'DECLARED_ADDITIVE');
}

function auditedSchemaChangeMatches(before, after, change, declared) {
  if (!isPlainRecord(before) || !isPlainRecord(after) || before.integrityCheck !== 'ok' || after.integrityCheck !== 'ok'
    || !Number.isSafeInteger(before.userVersion) || !Number.isSafeInteger(after.userVersion)
    || !Array.isArray(before.schema) || !Array.isArray(after.schema)) return false;
  let declarations;
  try {
    declarations = validateSchemaDeclarations(declared.map((value) => {
      const match = typeof value === 'string' && /^(table|index):([a-z][a-z0-9_]{0,62})@([0-9a-f]{64})$/.exec(value);
      if (!match) throw new Error('invalid declaration');
      return { type: match[1], name: match[2], sqlSha256: match[3] };
    }));
  } catch { return false; }
  const observed = classifySchemaChange(
    { integrityCheck: before.integrityCheck, userVersion: before.userVersion, schema: before.schema },
    { integrityCheck: after.integrityCheck, userVersion: after.userVersion, schema: after.schema },
    declarations,
  );
  return observed.classification === change.classification
    && observed.declarationsSatisfied === change.declarationsSatisfied
    && JSON.stringify(observed.added) === JSON.stringify(change.added)
    && JSON.stringify(observed.removed) === JSON.stringify(change.removed)
    && JSON.stringify(observed.changed) === JSON.stringify(change.changed)
    && JSON.stringify(observed.userVersion) === JSON.stringify(change.userVersion)
    && JSON.stringify(observed.problems) === JSON.stringify(change.problems);
}

function validatedSwitchSha(record) {
  const { operation, requestedSha, candidateSha, deployedSha, previousSha } = record ?? {};
  if (!['PROMOTE_SUCCESS', 'ROLLBACK_SUCCESS'].includes(operation)
    || record.schemaVersion !== 2 || !isAuditTime(record.at)
    || !isFullSha(requestedSha) || requestedSha !== candidateSha || candidateSha !== deployedSha
    || !isFullSha(previousSha) || previousSha === deployedSha
    || record.validation !== 'passed' || !validSchemaSuccessEvidence(record)
    || !validServiceEvidence(record.services, { fresh: true }) || !validHttpEvidence(record.http)
    || !validToolIdentity(record.tool, previousSha)) return null;
  if (operation === 'PROMOTE_SUCCESS' && !(typeof record.requestedRef === 'string'
    && (record.requestedRef.startsWith('refs/heads/') || record.requestedRef.startsWith('refs/tags/')))) return null;
  if (operation === 'ROLLBACK_SUCCESS' && record.requestedRef !== null) return null;
  return deployedSha;
}

function validatedRecoverySha(record) {
  const { operation, requestedSha, candidateSha, previousSha, recoveryAction, recoveryResult,
    restored, schemaChange, selectedSha } = record ?? {};
  if (!['PROMOTE_FAILURE', 'ROLLBACK_FAILURE'].includes(operation)
    || record.schemaVersion !== 2 || !isAuditTime(record.at)
    || !isFullSha(requestedSha) || requestedSha !== candidateSha
    || !isFullSha(previousSha) || previousSha === candidateSha || selectedSha !== previousSha
    || recoveryResult !== 'validated' || !isPlainRecord(schemaChange)
    || !validServiceEvidence(restored?.services, { fresh: true }) || !validHttpEvidence(restored?.http)
    || !validToolIdentity(record.tool, previousSha)) return null;
  if (operation === 'PROMOTE_FAILURE' && !(typeof record.requestedRef === 'string'
    && (record.requestedRef.startsWith('refs/heads/') || record.requestedRef.startsWith('refs/tags/')))) return null;
  if (operation === 'ROLLBACK_FAILURE' && record.requestedRef !== null) return null;
  const declared = record.declaredSchemaAdditions;
  if (recoveryAction === 'restore-previous-release-and-validate'
    && Array.isArray(declared) && declared.length === 0
    && validSchemaEvidence(schemaChange, { declared }) && schemaChange.classification === 'NONE'
    && auditedSchemaChangeMatches(record.schemaBefore, record.schemaAfter, schemaChange, declared)
    && record.schemaChanged === false) return previousSha;
  const retained = record.schemaAdditionsRetained;
  const retainedNames = Array.isArray(retained) && retained.every((item) => isPlainRecord(item)
    && ['table', 'index'].includes(item.type) && typeof item.name === 'string')
    ? retained.map((item) => `${item.type}:${item.name}`).sort() : null;
  const actualNames = validSchemaItems(schemaChange.added)
    ? schemaChange.added.map((item) => `${item.type}:${item.name}`).sort() : null;
  if (recoveryAction === 'restore-previous-release-retaining-declared-additions'
    && Array.isArray(declared) && retainedNames && retainedNames.join('\n') === actualNames?.join('\n')
    && validSchemaEvidence(schemaChange, { declared })
    && auditedSchemaChangeMatches(record.schemaBefore, record.schemaAfter, schemaChange, declared)
    && schemaChange.classification === 'DECLARED_ADDITIVE'
    && record.previousCodeCompatible === true && record.schemaChanged === true) return previousSha;
  return null;
}

function validatedNoopSha(record, { allowLegacyBootstrap, priorValidatedSha }) {
  const { requestedSha, candidateSha, deployedSha, previousSha, noopAuthorization } = record ?? {};
  if (record?.operation !== 'PROMOTE_NOOP' || record.schemaVersion !== 2 || !isAuditTime(record.at)
    || !isFullSha(requestedSha)
    || requestedSha !== candidateSha || candidateSha !== deployedSha || deployedSha !== previousSha
    || !(typeof record.requestedRef === 'string'
      && (record.requestedRef.startsWith('refs/heads/') || record.requestedRef.startsWith('refs/tags/')))
    || record.validation !== 'passed' || !isPlainRecord(noopAuthorization)
    || noopAuthorization.selectedSha !== deployedSha
    || !validServiceEvidence(record.services, { fresh: false }) || !validHttpEvidence(record.http)
    || !validToolIdentity(record.tool, deployedSha)) return null;
  if (!['LEGACY_EMPTY', 'VALIDATED'].includes(noopAuthorization.state)) return null;
  if (noopAuthorization.state === 'LEGACY_EMPTY'
    && (!allowLegacyBootstrap || noopAuthorization.selectedSha !== deployedSha)) return null;
  if (noopAuthorization.state === 'VALIDATED'
    && (priorValidatedSha !== deployedSha || noopAuthorization.selectedSha !== deployedSha)) return null;
  return deployedSha;
}

// A nonempty journal authorizes a no-op only when its latest switch outcome
// proves that this exact release was selected and validated.
export function determineNoopReviewState(text, currentSha) {
  if (typeof text !== 'string') return { state: 'UNRESOLVED', reason: 'journal content is not text' };
  if (!text) return { state: 'LEGACY_EMPTY' };
  const lines = text.split('\n').filter((line) => line.trim());
  if (!lines.length) return { state: 'LEGACY_EMPTY' };
  let selectedSha = null;
  let unresolved = null;
  for (let index = 0; index < lines.length; index += 1) {
    let record;
    try { record = JSON.parse(lines[index]); }
    catch { return { state: 'UNRESOLVED', reason: index === lines.length - 1 ? 'unreadable journal tail' : 'unreadable journal record' }; }
    const operation = record?.operation;
    if (!isPlainRecord(record) || typeof operation !== 'string') {
      return { state: 'UNRESOLVED', reason: 'journal record has no valid operation name' };
    }
    if (isOperation(operation, /^(PROMOTE|ROLLBACK)_INTENT$/)) {
      selectedSha = null;
      unresolved = { state: 'INTERRUPTED', operation };
    } else if (isOperation(operation, /^(PROMOTE|ROLLBACK)_SUCCESS$/)) {
      const sha = validatedSwitchSha(record);
      selectedSha = sha;
      unresolved = sha ? null : { state: 'UNRESOLVED', operation, reason: 'success lacks structured validation evidence' };
    } else if (isOperation(operation, /^(PROMOTE|ROLLBACK)_FAILURE$/)) {
      const sha = validatedRecoverySha(record);
      selectedSha = sha;
      unresolved = sha ? null : { state: 'UNRESOLVED', operation, reason: 'failure recovery is not proven validated' };
    } else if (operation === 'PROMOTE_NOOP') {
      const priorValidatedSha = unresolved ? null : selectedSha;
      const sha = validatedNoopSha(record, { allowLegacyBootstrap: index === 0, priorValidatedSha });
      selectedSha = sha;
      unresolved = sha ? null : { state: 'UNRESOLVED', operation, reason: 'no-op authorization evidence is missing or invalid' };
    } else if (isOperation(operation, /^(PROMOTE|ROLLBACK)_(INTERRUPTED_REVIEW_REQUIRED|UNRESOLVED_REVIEW_REQUIRED)$/)) {
      selectedSha = null;
      unresolved = { state: operation.includes('INTERRUPTED') ? 'INTERRUPTED' : 'UNRESOLVED', operation };
    } else if (isOperation(operation, /^(PROMOTE|ROLLBACK)_/)
      && !['PROMOTE_COMMAND_FAILURE', 'ROLLBACK_COMMAND_FAILURE'].includes(operation)) {
      selectedSha = null;
      unresolved = { state: 'UNRESOLVED', operation, reason: 'unexpected release operation in audit journal' };
    }
  }
  if (unresolved) return unresolved;
  if (!isFullSha(currentSha) || selectedSha !== currentSha) return { state: 'UNRESOLVED', reason: 'journal does not validate the current release', selectedSha };
  return { state: 'VALIDATED', selectedSha };
}

async function noopJournalState(auditPath, currentSha) {
  let text;
  try { text = await readFile(auditPath, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return { state: 'LEGACY_EMPTY' };
    return { state: 'UNRESOLVED', reason: `journal unreadable: ${error.message}` };
  }
  return determineNoopReviewState(text, currentSha);
}

async function findSwitchBackups(record, paths) {
  if (typeof record?.at !== 'string' || !isFullSha(record.previousSha) || !isFullSha(record.candidateSha)) return [];
  const prefix = `${record.at.replaceAll(':', '').replaceAll('-', '')}-`;
  const suffix = `-${record.previousSha}-to-${record.candidateSha}.sqlite`;
  const names = await readdir(paths.backups).catch(() => []);
  return names.filter((name) => name.startsWith(prefix) && name.endsWith(suffix)).map((name) => path.join(paths.backups, name));
}

async function interruptedSwitch(context, tool, paths) {
  const record = await lastSwitchRecord(paths.audit);
  if (!record || !(record.torn || record.unreadable || /_INTENT$/.test(record.operation))) return null;
  const backups = record.torn || record.unreadable ? [] : await findSwitchBackups(record, paths);
  const outcome = {
    state: record.unreadable ? 'UNRESOLVED_REVIEW_REQUIRED' : 'INTERRUPTED_REVIEW_REQUIRED', kind: context.kind, requestedSha: context.sha, requestedRef: context.ref,
    lastKnownSha: context.previousSha, manualIntervention: true,
    interrupted: record.torn || record.unreadable ? { operation: record.operation } : { operation: record.operation, at: record.at, previousSha: record.previousSha, candidateSha: record.candidateSha },
    backupPaths: backups,
    cause: record.unreadable
      ? `The deployment audit journal cannot be read (${record.error}); release-switch provenance is unknown.`
      : record.torn
        ? 'The deployment audit journal ends with an unreadable record; the last release switch may have been interrupted.'
      : `The last release switch (${record.operation} ${record.previousSha} -> ${record.candidateSha} at ${record.at}) never recorded a result; releases/current already names ${context.sha}, but that switch was not validated.`,
    auditPath: paths.audit,
  };
  await appendAudit({
    schemaVersion: 2, operation: `${context.kind}_${record.unreadable ? 'UNRESOLVED' : 'INTERRUPTED'}_REVIEW_REQUIRED`, tool, requestedSha: context.sha, requestedRef: context.ref,
    previousSha: context.previousSha, candidateSha: context.sha, interrupted: outcome.interrupted, backupPaths: backups, at: iso(),
  }, paths).catch(() => {});
  return new DeployError(outcome.cause, outcome);
}

// The one routine operation: deploy a validated, pushed SHA to DEV. Prepares
// the immutable release when needed, recognises an already-deployed SHA, and
// otherwise switches releases with backup, validation, and automatic recovery.
export async function deploy({ ref, expectedSha, routes = DEFAULT_VALIDATION_ROUTES, schemaDeclarations = [], previousCodeCompatible = false }, { paths = PATHS, ops = hostOps(paths) } = {}) {
  const tool = await toolIdentity(paths, ops);
  const context = { kind: 'PROMOTE', expectedSha, sha: null, ref: null, previousSha: null };
  let releaseState;
  let declarations;
  let schemaPlan;
  try {
    context.ref = normalizeRef(ref);
    validateExpectedSha(expectedSha);
    declarations = validateSchemaDeclarations(schemaDeclarations);
    if (previousCodeCompatible === true && declarations.length === 0) throw new Error('--previous-code-compatible requires at least one --expect-schema-add declaration.');
    if (previousCodeCompatible !== true && previousCodeCompatible !== false) throw new Error('previousCodeCompatible must be a boolean.');
    context.previousSha = await currentSha(paths.releases);
    if (!context.previousSha) {
      throw Object.assign(new Error(`No deployed release exists at ${paths.current}; DEV was not set up for release deployment.`), { manualIntervention: true });
    }
    await assertReleaseUnitPaths({ paths, ops });
    context.sha = await resolveRequestedCommit(context.ref, expectedSha, paths);
    releaseState = await ensureRelease(context.sha, context.ref, { tool, paths, ops });
    if (context.sha === context.previousSha) {
      const interrupted = await interruptedSwitch(context, tool, paths);
      if (interrupted) throw interrupted;
      const reviewState = await noopJournalState(paths.audit, context.sha);
      if (!['VALIDATED', 'LEGACY_EMPTY'].includes(reviewState.state)) {
        const outcome = {
          state: reviewState.state === 'INTERRUPTED' ? 'INTERRUPTED_REVIEW_REQUIRED' : 'UNRESOLVED_REVIEW_REQUIRED',
          kind: 'PROMOTE', requestedSha: context.sha, requestedRef: context.ref, lastKnownSha: context.previousSha,
          manualIntervention: true, reviewState, cause: 'DEV deploy blocked: the selected release has unresolved review-required deployment history.', auditPath: paths.audit,
        };
        await appendAudit({ schemaVersion: 2, operation: 'PROMOTE_UNRESOLVED_REVIEW_REQUIRED', tool, requestedSha: context.sha, requestedRef: context.ref, selectedSha: context.sha, reviewState, at: iso() }, paths).catch(() => {});
        throw new DeployError(outcome.cause, outcome);
      }
      if (declarations.length) throw new Error(`${context.sha} is already deployed; --expect-schema-add does not apply to a no-op deployment.`);
      const services = await assertApplicationServices(context.sha, { paths, ops });
      const http = await validateHttp(routes, paths.baseUrl, ops.fetch);
      const record = {
        schemaVersion: 2, operation: 'PROMOTE_NOOP', tool, requestedSha: context.sha, requestedRef: context.ref,
        previousSha: context.previousSha, candidateSha: context.sha, deployedSha: context.sha, at: iso(), services, http, validation: 'passed',
        noopAuthorization: { state: reviewState.state, selectedSha: reviewState.selectedSha ?? context.sha },
      };
      await appendAudit(record, paths);
      return { state: 'NOOP', record, auditPath: paths.audit };
    }
    // Pre-stop schema plan: predict the candidate's schema on disposable
    // databases before anything is stopped. It can only refuse a deployment;
    // the post-start classification of the real database stays authoritative.
    try { schemaPlan = await planCandidateSchema(context.previousSha, context.sha, declarations, { paths, ops }); }
    catch (error) { throw new Error(`Schema plan failed before any service was stopped: ${error.message}`); }
    const rejection = schemaPlanRejection(schemaPlan, declarations);
    if (rejection) throw Object.assign(new Error(rejection), { schemaPlan });
  } catch (error) {
    throw await rejectUnchanged(error, context, tool, paths);
  }
  return switchRelease({ kind: 'PROMOTE', sha: context.sha, ref: context.ref, previousSha: context.previousSha, routes, tool, releaseState, paths, ops, declarations, previousCodeCompatible, schemaPlan });
}

// Explicit troubleshooting operation: switch back to a retained release using
// the same backup, validation, and recovery path as deploy.
export async function rollback({ sha, routes = DEFAULT_VALIDATION_ROUTES }, { paths = PATHS, ops = hostOps(paths) } = {}) {
  const tool = await toolIdentity(paths, ops);
  const context = { kind: 'ROLLBACK', sha, ref: null, previousSha: null };
  try {
    validateSha(sha);
    await validateRelease(path.join(paths.releases, sha), sha, paths);
    context.previousSha = await currentSha(paths.releases);
    if (!context.previousSha) {
      throw Object.assign(new Error(`No deployed release exists at ${paths.current}.`), { manualIntervention: true });
    }
    if (context.previousSha === sha) throw new Error(`Release ${sha} is already current.`);
    await assertReleaseUnitPaths({ paths, ops });
  } catch (error) {
    throw await rejectUnchanged(error, context, tool, paths);
  }
  return switchRelease({ kind: 'ROLLBACK', sha, ref: null, previousSha: context.previousSha, routes, tool, releaseState: 'retained', paths, ops });
}

// Stop Dashboard/MCP, back up SQLite, switch releases/current, start, and
// validate. On failure, restore the previous release only when the schema is
// known to be unchanged; never restore the database automatically.
async function switchRelease({ kind, sha, ref, previousSha, routes, tool, releaseState, paths, ops, declarations = [], previousCodeCompatible = false, schemaPlan = null }) {
  const preparedAt = iso();
  const readers = { readServiceState: ops.serviceState, readReleaseUnitState: ops.releaseUnitState, readTargetState: ops.targetState };
  const readiness = (checkRoutes) => waitForReadiness({ fetchFn: ops.fetch, baseUrl: paths.baseUrl, routes: checkRoutes, ...ops.readiness });
  let journalBefore;
  let previousServices;
  let preStopInvocations;
  let herdrBefore;
  try {
    journalBefore = await collectJournalWarnings(preparedAt, paths, ops.journalWarnings);
    previousServices = await assertApplicationServices(previousSha, { paths, ops });
    preStopInvocations = await captureInvocationIds(ops.invocationId);
    herdrBefore = await ops.serviceState(HERDR_UNIT);
    await appendAudit({
      schemaVersion: 2, operation: `${kind}_INTENT`, tool, requestedSha: sha, requestedRef: ref, previousSha, candidateSha: sha, at: preparedAt, journalBefore,
      ...(kind === 'PROMOTE' ? { schemaPlan, declaredSchemaAdditions: declarations.map(formatSchemaDeclaration), previousCodeCompatible } : {}),
    }, paths);
  } catch (error) {
    throw await rejectUnchanged(error, { kind, sha, ref, previousSha }, tool, paths);
  }
  const observedInvocations = {};
  let backupPath;
  let backupSha256;
  let beforeEvidence;
  let schemaChanged = null;
  let schemaChange = null;
  let candidateStarted = false;
  let candidateValidated = false;
  let recoveryAfterEvidence = null;
  try {
    await ops.serviceHelper('stop');
    beforeEvidence = databaseEvidence(paths.database);
    const stamp = `${preparedAt.replaceAll(':', '').replaceAll('-', '')}-${randomUUID().slice(0, 8)}`;
    backupPath = path.join(paths.backups, `${stamp}-${previousSha}-to-${sha}.sqlite`);
    await makeConsistentBackup(paths.database, backupPath);
    const backupEvidence = databaseEvidence(backupPath);
    if (JSON.stringify(beforeEvidence) !== JSON.stringify(backupEvidence)) throw new Error('SQLite online backup data evidence does not match the stopped runtime database.');
    backupSha256 = await sha256File(backupPath);
    await atomicSetCurrent(paths.releases, sha);
    await startCandidateConservatively(() => ops.serviceHelper('start'), () => { candidateStarted = true; });
    const { afterReadiness: services } = await validateStartedRelease(sha, preStopInvocations, {
      paths, observedInvocations, ...readers, awaitReadiness: () => readiness(routes),
    });
    const http = await validateHttp(routes, paths.baseUrl, ops.fetch);
    const afterEvidence = databaseEvidence(paths.database);
    assertSchemaCompatible(beforeEvidence, afterEvidence); // throws unless integrity_check passed before and after
    schemaChange = classifySchemaChange(beforeEvidence, afterEvidence, declarations);
    schemaChanged = schemaChange.classification !== 'NONE';
    if (!schemaChangeAccepted(schemaChange, declarations)) {
      throw new Error(declarations.length
        ? `Database schema change during candidate validation is not exactly the declared additions (${schemaChange.classification}: ${schemaChange.problems.join('; ') || 'no change'}).`
        : `Database schema changed during candidate validation (user_version ${beforeEvidence.userVersion} -> ${afterEvidence.userVersion}, schema ${beforeEvidence.schemaSha256} -> ${afterEvidence.schemaSha256}; ${schemaChange.problems.join('; ')}). Code rollback requires an operator compatibility decision.`);
    }
    const herdrAfter = await ops.serviceState(HERDR_UNIT);
    if (herdrBefore.MainPID !== herdrAfter.MainPID || herdrAfter.ActiveState !== 'active') {
      throw new Error(`Herdr changed during application deployment: before=${JSON.stringify(herdrBefore)} after=${JSON.stringify(herdrAfter)}`);
    }
    candidateValidated = true;
    const record = {
      schemaVersion: 2,
      operation: `${kind}_SUCCESS`,
      tool,
      requestedSha: sha,
      requestedRef: ref,
      previousSha,
      deployedSha: sha,
      candidateSha: sha,
      release: releaseState,
      at: iso(),
      backup: { path: backupPath, sha256: backupSha256, integrityCheck: 'ok', data: backupEvidence },
      dataBefore: { integrityCheck: beforeEvidence.integrityCheck, userVersion: beforeEvidence.userVersion, schemaSha256: beforeEvidence.schemaSha256, schema: beforeEvidence.schema, demand: beforeEvidence.demand },
      dataAfter: { integrityCheck: afterEvidence.integrityCheck, userVersion: afterEvidence.userVersion, schemaSha256: afterEvidence.schemaSha256, demand: afterEvidence.demand, schema: afterEvidence.schema },
      schemaChanged,
      schemaChange: { ...schemaChange, declared: declarations.map(formatSchemaDeclaration), previousCodeCompatible },
      ...(kind === 'PROMOTE' ? { schemaPlan } : {}),
      previousServices,
      services,
      herdr: { before: herdrBefore, after: herdrAfter },
      http,
      journalDiagnostics: await collectJournalWarnings(preparedAt, paths, ops.journalWarnings),
      validation: 'passed',
    };
    await appendAudit(record, paths);
    return { state: kind === 'ROLLBACK' ? 'ROLLED_BACK' : 'DEPLOYED', record, auditPath: paths.audit };
  } catch (error) {
    const base = { kind, requestedSha: sha, requestedRef: ref, previousSha, backupPath: backupPath ?? null, cause: error.message, auditPath: paths.audit };
    if (candidateValidated) {
      throw new DeployError(`${sha} passed validation and is running, but the audit record could not be written; no rollback was triggered. ${error.message}`, {
        ...base, state: 'AUDIT_FAILED', runningSha: sha, manualIntervention: false,
      });
    }
    const preRecovery = await stopCandidateThenInspectSchema({
      candidateMayHaveRun: candidateStarted,
      stop: () => ops.serviceHelper('stop'),
      inspectSchema: () => {
        const after = databaseEvidence(paths.database);
        recoveryAfterEvidence = after;
        return beforeEvidence ? classifySchemaChange(beforeEvidence, after, declarations) : null;
      },
    });
    if (preRecovery.schemaChanged === false) recoveryAfterEvidence = beforeEvidence;
    // A candidate that never ran cannot have changed the schema; otherwise the
    // classification is what was observed after the stop, or null (unknown).
    const recoverySchema = preRecovery.schemaChanged === false ? {
      classification: 'NONE', declarationsSatisfied: declarations.length === 0,
      added: [], removed: [], changed: [], userVersion: { before: beforeEvidence?.userVersion, after: beforeEvidence?.userVersion }, problems: [],
    } : preRecovery.schemaChanged;
    schemaChange = recoverySchema;
    schemaChanged = recoverySchema ? recoverySchema.classification !== 'NONE' : null;
    const failure = { schemaVersion: 2, operation: `${kind}_FAILURE`, tool, requestedSha: sha, requestedRef: ref, previousSha, candidateSha: sha, backupPath, backupSha256, error: error.message, recoveryAttempted: true,
      declaredSchemaAdditions: declarations.map(formatSchemaDeclaration), previousCodeCompatible,
      schemaBefore: beforeEvidence ? { integrityCheck: beforeEvidence.integrityCheck, userVersion: beforeEvidence.userVersion, schema: beforeEvidence.schema } : null,
      schemaAfter: recoveryAfterEvidence ? { integrityCheck: recoveryAfterEvidence.integrityCheck, userVersion: recoveryAfterEvidence.userVersion, schema: recoveryAfterEvidence.schema } : null };
    let recovery;
    try {
      recovery = await recoverFailedPromotion({
        schemaChanged, candidateStarted, schema: recoverySchema, declarations, previousCodeCompatible,
        priorStopResult: candidateStarted ? preRecovery.stopResult : undefined,
        stop: () => ops.serviceHelper('stop'),
        setPrevious: () => atomicSetCurrent(paths.releases, previousSha),
        startPrevious: () => ops.serviceHelper('start'),
        validatePrevious: async () => {
          await readiness(DEFAULT_VALIDATION_ROUTES);
          const restoredServices = await assertFreshReleaseServices(previousSha, excludedInvocations(preStopInvocations, observedInvocations), { paths, ...readers });
          assertRestartCountersStable({}, restoredServices);
          const restoredHttp = await validateHttp(DEFAULT_VALIDATION_ROUTES, paths.baseUrl, ops.fetch);
          const diagnostics = await collectJournalWarnings(preparedAt, paths, ops.journalWarnings);
          const herdrAfter = await ops.serviceState(HERDR_UNIT);
          return { services: restoredServices, http: restoredHttp, herdr: herdrAfter, journalDiagnostics: diagnostics };
        },
      });
    } catch (recoveryError) {
      const lastKnownSha = await currentSha(paths.releases).catch(() => null);
      await appendAudit({ ...failure, schemaChanged, schemaChange, recoveryResult: `failed: ${recoveryError.message}`, at: iso() }, paths).catch(() => {});
      throw new DeployError(`Deployment failed (${error.message}); automatic recovery to ${previousSha} also failed (${recoveryError.message}).`, {
        ...base, state: 'RECOVERY_FAILED', lastKnownSha, manualIntervention: true, recoveryError: recoveryError.message,
      });
    }
    if (recovery.state === 'stopped-review-required') {
      const lastKnownSha = await currentSha(paths.releases).catch(() => null);
      await appendAudit({ ...failure, schemaChanged, schemaChange, recoveryResult: recovery.state, recoveryAction: recovery.action, candidateStopResult: recovery.stopResult, at: iso() }, paths).catch(() => {});
      throw new DeployError(`Candidate failed and the database schema changed or could not be verified; Dashboard/MCP were stopped (${recovery.stopResult}) and previous code was not started. ${error.message}`, {
        ...base, state: 'STOPPED_REVIEW_REQUIRED', lastKnownSha, schemaChanged, schemaChange, servicesStopped: recovery.stopResult, manualIntervention: true,
      });
    }
    let auditWarning = null;
    const retained = recovery.retainedAdditions ?? [];
    try {
      await appendAudit({
        ...failure, schemaChanged, schemaChange, recoveryResult: 'validated', recoveryAction: recovery.action, selectedSha: previousSha, restored: recovery.validation,
        ...(retained.length ? { schemaAdditionsRetained: retained, previousCodeCompatible: true } : {}), at: iso(),
      }, paths);
    }
    catch (auditError) { auditWarning = `recovery audit could not be written: ${auditError.message}`; }
    const retainedText = retained.length ? ` Declared schema additions were retained: ${retained.map((item) => `${item.type} ${item.name}`).join(', ')}.` : '';
    throw new DeployError(`Deployment validation failed; previous release ${previousSha} was restarted and validated; database was not restored.${retainedText} ${error.message}`, {
      ...base, state: 'RECOVERED', runningSha: previousSha, devHealthy: true, databaseRestored: false, manualIntervention: false, auditWarning, recovery: recovery.validation,
      ...(retained.length ? { schemaAdditionsRetained: retained } : {}),
    });
  }
}

async function backupOnly(label, routes, { paths = PATHS, ops = hostOps(paths) } = {}) {
  const tool = await toolIdentity(paths, ops);
  if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(label ?? '')) throw new Error('Backup label must be 1-48 lowercase letters, digits, or hyphens.');
  const at = iso();
  const services = {};
  for (const unit of [...APP_UNITS, HERDR_UNIT]) services[unit] = await ops.serviceState(unit);
  services[TARGET_UNIT] = assertTargetActive(await ops.targetState(TARGET_UNIT));
  const http = await validateHttp(routes, paths.baseUrl, ops.fetch);
  const filename = `${at.replaceAll(':', '').replaceAll('-', '')}-${randomUUID().slice(0, 8)}-${label}.sqlite`;
  const backupPath = path.join(paths.backups, filename);
  await makeConsistentBackup(paths.database, backupPath);
  const backupEvidence = databaseEvidence(backupPath);
  const record = { schemaVersion: 2, operation: 'BACKUP_SUCCESS', tool, label, at, backup: { path: backupPath, sha256: await sha256File(backupPath), integrityCheck: 'ok', data: backupEvidence }, services, http };
  await appendAudit(record, paths);
  return { state: 'BACKUP', record, auditPath: paths.audit };
}

function serviceHealthy(unit, state) {
  try { assertServiceStateHealthy(unit, state); return true; }
  catch { return false; }
}

async function lastAuditRecord(auditPath) {
  let text;
  try { text = await readFile(auditPath, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const line = text.trimEnd().split('\n').at(-1);
  try {
    const record = JSON.parse(line);
    return { operation: record.operation, at: record.at, requestedSha: record.requestedSha ?? null };
  } catch { return null; }
}

// Read-only: what is deployed and whether Dashboard/MCP are healthy.
export async function status({ paths = PATHS, ops = hostOps(paths) } = {}) {
  let sha = null;
  let shaError = null;
  try { sha = await currentSha(paths.releases); }
  catch (error) { shaError = error.message; }
  let ref = null;
  if (sha) {
    try { ref = JSON.parse(await readFile(path.join(paths.releases, sha, 'release.json'), 'utf8')).ref ?? null; }
    catch { ref = null; }
  }
  const services = {};
  for (const unit of [...APP_UNITS, HERDR_UNIT]) {
    try {
      const state = await ops.serviceState(unit);
      services[unit] = { ...state, healthy: serviceHealthy(unit, state) };
    } catch (error) { services[unit] = { healthy: false, error: error.message }; }
  }
  let http;
  try { http = { ok: true, results: await validateHttp(DEFAULT_VALIDATION_ROUTES, paths.baseUrl, ops.fetch) }; }
  catch (error) { http = { ok: false, error: error.message }; }
  const lastDeployment = await lastAuditRecord(paths.audit).catch(() => null);
  const healthy = Boolean(sha) && services[DASHBOARD_UNIT].healthy && http.ok && services[MCP_UNIT].healthy;
  return { state: 'STATUS', sha, shaError, ref, healthy, services, http, lastDeployment, auditPath: paths.audit };
}

function httpSummary(results) {
  return (results ?? []).map((item) => `${item.path} ${item.actual ?? item.status}`).join(', ');
}

function journalSummary(diagnostics) {
  if (!diagnostics) return 'not collected';
  if (!diagnostics.ok) return `unavailable (${diagnostics.error})`;
  const lines = diagnostics.output.split('\n').filter((line) => line.trim() && !line.startsWith('-- '));
  return lines.length === 0 ? 'none' : `${lines.length} line(s); see the audit record`;
}

function unitSummary(unit, units) {
  const state = units?.[unit];
  return state && state.ActiveState === 'active' && state.Result === 'success' ? 'healthy' : 'NOT VERIFIED';
}

function schemaLine(record) {
  const change = record.schemaChange;
  if (change?.classification === 'DECLARED_ADDITIVE') return `ADDED (declared) ${change.added.map((item) => item.name).join(', ')}`;
  if (change?.classification === 'NONE') return 'unchanged';
  return record.schemaChanged ? 'CHANGED' : 'unchanged';
}

// Lines describing a candidate schema plan (prepare output, and a deploy
// refused before any stop because of its plan).
export function schemaPlanLines(plan) {
  if (!plan) return [];
  if (plan.state === 'UNAVAILABLE') return [`Schema plan: UNAVAILABLE (${plan.error})`];
  if (plan.state === 'NONE') return ['Schema plan: none'];
  const lines = [];
  if (plan.state === 'NON_ADDITIVE') {
    lines.push('Schema plan: NON-ADDITIVE (cannot be declared; deploy will refuse it)');
    for (const problem of plan.problems) lines.push(`  - ${problem}`);
    for (const item of plan.added.filter((object) => !DECLARABLE_TYPES.has(object.type))) lines.push(`  - ${item.type} ${item.name} added`);
    return lines;
  }
  lines.push('Schema plan: additive (requires explicit approval)');
  for (const item of plan.added) {
    lines.push(`  ${item.type} ${item.name}  sql sha256 ${item.sqlSha256}`);
    lines.push(`    --expect-schema-add ${item.declaration}`);
  }
  return lines;
}

// The routine, human-facing result. Detailed evidence stays in the audit
// record and in --json output.
export function formatResult(result) {
  const lines = [];
  const line = (label, value) => lines.push(`${`${label}:`.padEnd(21)}${value}`);
  const action = { ROLLBACK: 'ROLLBACK', PREPARE: 'PREPARE' }[result.kind] ?? 'DEPLOY';
  const manual = (required) => line('Manual intervention', required ? 'REQUIRED' : 'NO');
  switch (result.state) {
    case 'DEPLOYED':
    case 'ROLLED_BACK': {
      const record = result.record;
      const units = record.services?.units;
      lines.push(result.state === 'DEPLOYED' ? 'DEV DEPLOYED' : 'DEV ROLLED BACK');
      line('SHA', record.deployedSha);
      if (record.requestedRef) line('Ref', record.requestedRef);
      line('Previous', record.previousSha);
      line('Release', { built: 'built and tested in staging', reused: 'reused prepared release', retained: 'retained release' }[record.release] ?? record.release);
      line('Data backup', `OK, integrity ok (${record.backup.path})`);
      line('Schema', schemaLine(record));
      line('Dashboard', `${unitSummary(DASHBOARD_UNIT, units)} (${httpSummary(record.http)})`);
      line('MCP', unitSummary(MCP_UNIT, units));
      line('Herdr', record.herdr?.before?.MainPID === record.herdr?.after?.MainPID ? 'untouched' : 'CHANGED');
      line('Journal warnings', journalSummary(record.journalDiagnostics));
      line('Details', `${result.auditPath} (or --json)`);
      break;
    }
    case 'NOOP': {
      const record = result.record;
      lines.push(`DEV ALREADY AT ${record.deployedSha}`);
      line('Ref', record.requestedRef);
      line('Changed', 'nothing (no restart, no backup)');
      line('Dashboard', `${unitSummary(DASHBOARD_UNIT, record.services?.units)} (${httpSummary(record.http)})`);
      line('MCP', unitSummary(MCP_UNIT, record.services?.units));
      break;
    }
    case 'UNCHANGED':
      lines.push(`DEV ${action} FAILED — DEV UNCHANGED`);
      line('Requested', result.requestedSha ?? 'unresolved');
      if (result.requestedRef) line('Ref', result.requestedRef);
      line('Running', result.runningSha ? `${result.runningSha} (untouched)` : 'unknown (untouched)');
      manual(result.manualIntervention);
      line('Cause', result.cause);
      lines.push(...schemaPlanLines(result.schemaPlan));
      break;
    case 'RECOVERED':
      lines.push(`DEV ${action} FAILED — RECOVERED`);
      line('Requested', result.requestedSha);
      line('Recovered to', result.runningSha);
      line('DEV health', 'OK (previous release restarted and validated)');
      line('Database', `not restored; pre-deploy backup at ${result.backupPath ?? 'none (failed before backup)'}`);
      if (result.schemaAdditionsRetained?.length) line('Schema', `additions retained: ${result.schemaAdditionsRetained.map((item) => `${item.type} ${item.name}`).join(', ')} (--previous-code-compatible)`);
      manual(false);
      line('Cause', result.cause);
      if (result.auditWarning) line('Warning', result.auditWarning);
      break;
    case 'STOPPED_REVIEW_REQUIRED':
      lines.push(`DEV ${action} FAILED — DASHBOARD/MCP STOPPED`);
      line('Requested', result.requestedSha);
      line('Release pointer', result.lastKnownSha ?? 'unknown');
      line('Previous', result.previousSha);
      line('Reason', 'database schema changed or could not be verified; previous code was not restarted');
      line('Data backup', result.backupPath ?? 'none');
      manual(true);
      line('Cause', result.cause);
      break;
    case 'INTERRUPTED_REVIEW_REQUIRED':
      lines.push(`DEV ${action} INTERRUPTED — REVIEW REQUIRED`);
      line('Requested', result.requestedSha);
      line('Release pointer', result.lastKnownSha ?? 'unknown');
      line('Interrupted', result.interrupted?.at ? `${result.interrupted.operation} ${result.interrupted.previousSha} -> ${result.interrupted.candidateSha} at ${result.interrupted.at}` : result.interrupted?.operation ?? 'unknown');
      line('Data backup', result.backupPaths?.length ? result.backupPaths.join(', ') : 'none recorded');
      manual(true);
      line('Cause', result.cause);
      line('Next', `wowsync-dev-deploy status; review ${result.auditPath}; then rollback to the previous release or re-validate`);
      break;
    case 'UNRESOLVED_REVIEW_REQUIRED':
      lines.push('DEV DEPLOY BLOCKED — REVIEW REQUIRED');
      line('Requested', result.requestedSha);
      line('Selected release', result.lastKnownSha ?? 'unknown');
      line('Reason', result.reviewState?.reason ?? result.reviewState?.operation ?? 'deployment history is unresolved');
      manual(true);
      line('Cause', result.cause);
      line('Next', `wowsync-dev-deploy status; review ${result.auditPath}; then perform a validated deploy or rollback`);
      break;
    case 'RECOVERY_FAILED':
      lines.push('DEV RECOVERY FAILED');
      line('Requested', result.requestedSha);
      line('Previous', result.previousSha);
      line('Last known release', result.lastKnownSha ?? 'unknown');
      line('Data backup', result.backupPath ?? 'none');
      manual(true);
      line('Cause', result.cause);
      line('Recovery error', result.recoveryError);
      line('Next', `wowsync-dev-deploy status; details in ${result.auditPath}`);
      break;
    case 'AUDIT_FAILED':
      lines.push('DEV DEPLOYED — AUDIT WRITE FAILED');
      line('SHA', result.runningSha);
      line('DEV health', 'OK (validated before the audit write failed)');
      manual(false);
      line('Cause', result.cause);
      break;
    case 'LOCKED':
      lines.push(`DEV ${action} NOT STARTED — another deployment is running`);
      line('DEV', 'untouched by this command');
      manual(false);
      line('Next', 'retry after the running deployment finishes');
      break;
    case 'PREPARED':
      lines.push('RELEASE PREPARED — DEV UNTOUCHED');
      line('SHA', result.sha);
      line('Ref', result.ref);
      line('Release', result.release === 'built' ? `built and tested (${result.releasePath})` : `already prepared, re-verified (${result.releasePath})`);
      line('Running', result.runningSha ?? 'no deployed release');
      lines.push(...schemaPlanLines(result.schemaPlan));
      break;
    case 'BACKUP':
      lines.push('DEV BACKUP OK');
      line('Backup', `${result.record.backup.path} (integrity ok)`);
      break;
    case 'BACKUP_FAILED':
      lines.push('DEV BACKUP FAILED — DEV UNCHANGED');
      line('Cause', result.cause);
      break;
    case 'STATUS': {
      const units = result.services;
      const describe = (unit) => (units[unit].healthy ? 'healthy' : `UNHEALTHY (${units[unit].error ?? `${units[unit].ActiveState}/${units[unit].Result}`})`);
      lines.push(result.healthy ? 'DEV STATUS: HEALTHY' : 'DEV STATUS: NOT HEALTHY');
      line('SHA', result.sha ?? `unknown${result.shaError ? ` (${result.shaError})` : ''}`);
      if (result.ref) line('Ref', result.ref);
      line('Dashboard', `${describe(DASHBOARD_UNIT)}; HTTP ${result.http.ok ? httpSummary(result.http.results) : `FAILED (${result.http.error})`}`);
      line('MCP', describe(MCP_UNIT));
      line('Herdr', units[HERDR_UNIT].healthy ? 'running (not managed by deploy)' : describe(HERDR_UNIT));
      if (result.lastDeployment) line('Last action', `${result.lastDeployment.operation} ${result.lastDeployment.requestedSha ?? ''} at ${result.lastDeployment.at}`.replace('  ', ' '));
      break;
    }
    default:
      lines.push(`DEV ${action} ERROR — DEV STATE NOT DETERMINED`);
      manual(true);
      line('Cause', result.cause ?? 'unknown');
      line('Next', 'wowsync-dev-deploy status');
  }
  return lines.join('\n');
}

export const EXIT = Object.freeze({ OK: 0, FAILED_DEV_OK: 1, MANUAL_REQUIRED: 2, USAGE: 64, LOCKED: 75, IDENTITY: 77 });

export function exitCodeFor(result) {
  if (['DEPLOYED', 'ROLLED_BACK', 'NOOP', 'PREPARED', 'BACKUP', 'AUDIT_FAILED'].includes(result.state)) return EXIT.OK;
  if (result.state === 'STATUS') return result.healthy ? EXIT.OK : EXIT.FAILED_DEV_OK;
  if (result.state === 'LOCKED') return EXIT.LOCKED;
  if (result.manualIntervention === false && ['UNCHANGED', 'RECOVERED', 'BACKUP_FAILED'].includes(result.state)) return EXIT.FAILED_DEV_OK;
  return EXIT.MANUAL_REQUIRED;
}

export const USAGE = `Usage:
  wowsync-dev-deploy deploy <branch|refs/heads/...|refs/tags/...> <validated-sha> [--route /path=HTTP_STATUS ...] [--json]
      [--expect-schema-add table:<name>@<sha256> | index:<name>@<sha256> ...] [--previous-code-compatible]
  wowsync-dev-deploy status [--json]

Troubleshooting, only when explicitly asked:
  wowsync-dev-deploy rollback <retained-full-sha> [--route /path=HTTP_STATUS ...] [--json]
  wowsync-dev-deploy backup <label> [--route /path=HTTP_STATUS ...] [--json]
  wowsync-dev-deploy prepare <ref> <validated-sha> [--json]   (build a release and print its schema plan; DEV untouched)

deploy fetches the ref, requires it to point at the validated SHA, builds and tests the
release if it is not already prepared, backs up SQLite, restarts only Dashboard and MCP,
validates them, and restores the previous release automatically if validation fails.
Default checks are GET / and GET /api/versions => 200; --route adds a feature check.
A candidate that changes the database schema is refused before anything is stopped unless
every change is an added table/index declared exactly (copy the declarations printed by
\`prepare\`). --previous-code-compatible additionally lets a failed candidate fall back to
the previous release while the declared additions stay in the database.
`;

const RETIRED_COMMANDS = Object.freeze({
  promote: '`promote` was replaced by `deploy <ref> <validated-sha>`, which prepares and promotes in one step.',
  'seed-initial': 'The one-time runtime topology migration is complete; `seed-initial` was removed.',
});

export function parseArgs(argv) {
  const args = [...argv];
  const command = args.shift();
  if (RETIRED_COMMANDS[command]) throw new Error(RETIRED_COMMANDS[command]);
  if (!['deploy', 'status', 'rollback', 'backup', 'prepare'].includes(command)) throw new Error(command ? `Unknown command: ${command}` : 'A command is required.');
  const positional = [];
  const routes = [...DEFAULT_VALIDATION_ROUTES];
  const declarations = [];
  let previousCodeCompatible = false;
  let json = false;
  while (args.length) {
    const arg = args.shift();
    if (arg === '--json') json = true;
    else if (arg === '--route' && !['status', 'prepare'].includes(command)) routes.push(parseRoute(args.shift()));
    else if ((arg === '--expect-schema-add' || arg === '--previous-code-compatible') && command !== 'deploy') throw new Error(`${arg} is accepted only by deploy.`);
    else if (arg === '--expect-schema-add') declarations.push(parseSchemaDeclaration(args.shift()));
    else if (arg === '--previous-code-compatible') {
      if (previousCodeCompatible) throw new Error('--previous-code-compatible was given more than once.');
      previousCodeCompatible = true;
    }
    else if (arg === '--previous-runtime-sha') throw new Error('--previous-runtime-sha belonged to the completed one-time topology migration and is not accepted.');
    else if (arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`);
    else positional.push(arg);
  }
  const expected = { deploy: 2, prepare: 2, status: 0, rollback: 1, backup: 1 }[command];
  if (positional.length !== expected) throw new Error(`${command} takes ${expected} argument(s); got ${positional.length}.`);
  if (command === 'deploy') {
    const schemaDeclarations = validateSchemaDeclarations(declarations);
    if (previousCodeCompatible && schemaDeclarations.length === 0) throw new Error('--previous-code-compatible requires at least one --expect-schema-add declaration.');
    return { command, ref: normalizeRef(positional[0]), expectedSha: validateExpectedSha(positional[1]), routes, json, schemaDeclarations, previousCodeCompatible };
  }
  if (command === 'prepare') return { command, ref: normalizeRef(positional[0]), expectedSha: validateExpectedSha(positional[1]), routes, json };
  if (command === 'rollback') return { command, sha: validateSha(positional[0]), routes, json };
  if (command === 'backup') return { command, label: positional[0], routes, json };
  return { command, json };
}

export async function runCli(argv, { paths = PATHS, ops = hostOps(paths), write = (text) => process.stdout.write(`${text}\n`), writeError = (text) => process.stderr.write(`${text}\n`) } = {}) {
  let parsed;
  try { parsed = parseArgs(argv); }
  catch (error) {
    writeError(`wowsync-dev-deploy: ${error.message}\n\n${USAGE}`);
    return EXIT.USAGE;
  }
  let result;
  try {
    if (parsed.command === 'deploy') result = await deploy(parsed, { paths, ops });
    else if (parsed.command === 'rollback') result = await rollback(parsed, { paths, ops });
    else if (parsed.command === 'prepare') result = await prepare(parsed, { paths, ops });
    else if (parsed.command === 'status') result = await status({ paths, ops });
    else {
      try { result = await backupOnly(parsed.label, parsed.routes, { paths, ops }); }
      catch (error) { result = { state: 'BACKUP_FAILED', manualIntervention: false, cause: error.message, auditPath: paths.audit }; }
    }
  } catch (error) {
    result = error instanceof DeployError
      ? error.outcome
      : { state: 'ERROR', kind: { rollback: 'ROLLBACK', prepare: 'PREPARE' }[parsed.command] ?? 'PROMOTE', manualIntervention: true, cause: error.message, auditPath: paths.audit };
  }
  write(parsed.json ? JSON.stringify(result, null, 2) : formatResult(result));
  return exitCodeFor(result);
}

const LOCK_PATH = '/home/wowsync-dev/deploy/deploy.lock';
const LOCKED_COMMANDS = new Set(['deploy', 'prepare', 'rollback', 'backup']);

// Serialise mutating commands with a non-blocking flock; a held lock is
// reported as LOCKED rather than waiting.
export function runUnderDeployLock(lockPath, command, args, { env = process.env, stdio = 'inherit' } = {}) {
  const result = spawnSync('/usr/bin/flock', ['--nonblock', '--conflict-exit-code', String(EXIT.LOCKED), lockPath, command, ...args], {
    stdio, env: { ...env, WOWSYNC_DEPLOY_LOCK: lockPath },
  });
  if (result.status === EXIT.LOCKED) return { locked: true, status: EXIT.LOCKED };
  return { locked: false, status: result.status ?? 1 };
}

const invokedPath = process.argv[1] ? (() => { try { return realpathSync(process.argv[1]); } catch { return null; } })() : null;
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  const args = process.argv.slice(2);
  if ((await run('/usr/bin/id', ['-un'])) !== 'wowsync-dev') {
    console.error('wowsync-dev-deploy: run this through the wowsync-dev-deploy launcher (it switches to the wowsync-dev identity).');
    process.exitCode = EXIT.IDENTITY;
  } else if (LOCKED_COMMANDS.has(args[0]) && process.env.WOWSYNC_DEPLOY_LOCK !== LOCK_PATH) {
    await mkdir(path.dirname(LOCK_PATH), { recursive: true, mode: 0o700 });
    const { locked, status: exitStatus } = runUnderDeployLock(LOCK_PATH, process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), ...args]);
    if (locked) {
      const result = { state: 'LOCKED', kind: args[0] === 'rollback' ? 'ROLLBACK' : 'PROMOTE', manualIntervention: false };
      console.log(args.includes('--json') ? JSON.stringify(result, null, 2) : formatResult(result));
    }
    process.exitCode = exitStatus;
  } else {
    process.exitCode = await runCli(args);
  }
}
