#!/usr/bin/node
import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, open, readFile, readdir, realpath, rename, rm, lstat, readlink, writeFile, symlink, chmod } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

const APP_UNITS = ['wowsync-dev-dashboard.service', 'wowsync-dev-mcp-tunnel.service'];
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

export function databaseEvidence(dbPath) {
  const db = openDatabase(dbPath, true);
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => row.name);
    const integrity = db.prepare('PRAGMA integrity_check').all();
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') throw new Error(`SQLite integrity_check failed: ${JSON.stringify(integrity)}`);
    const counts = {};
    for (const table of tables) {
      const safeTable = table.replaceAll('"', '""');
      counts[table] = db.prepare(`SELECT COUNT(*) AS count FROM "${safeTable}"`).get().count;
    }
    const userVersion = db.prepare('PRAGMA user_version').get().user_version;
    const schema = db.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name, tbl_name`).all().map((item) => ({
      ...item, sql: item.sql?.replace(/\s+/g, ' ').trim() ?? null,
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

export function recoveryPolicy({ initialMode = false, schemaChanged = false, candidateStarted = false }) {
  if (initialMode) return { action: 'stop-and-reverse-topology', mayStartPreviousCode: false };
  if (schemaChanged === true || (candidateStarted && schemaChanged !== false)) return { action: 'stop-review-required', mayStartPreviousCode: false };
  return { action: 'restore-previous-release-and-validate', mayStartPreviousCode: true };
}

export async function recoverFailedPromotion({ initialMode = false, schemaChanged = false, candidateStarted = false, priorStopResult, stop, setPrevious, startPrevious, validatePrevious }) {
  const policy = recoveryPolicy({ initialMode, schemaChanged, candidateStarted });
  if (!policy.mayStartPreviousCode) {
    if (priorStopResult) return { state: 'stopped-review-required', stopResult: priorStopResult, action: policy.action };
    try { await stop(); return { state: 'stopped-review-required', stopResult: 'succeeded', action: policy.action }; }
    catch (error) { return { state: 'stopped-review-required', stopResult: `failed: ${error.message}`, action: policy.action }; }
  }
  if (priorStopResult !== 'succeeded') await stop();
  await setPrevious();
  await startPrevious();
  const validation = await validatePrevious();
  return { state: 'validated', action: policy.action, validation };
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

async function serviceState(unit) {
  const fields = ['ActiveState', 'SubState', 'MainPID', 'Result', 'NRestarts'];
  const output = await run('/usr/bin/systemctl', ['show', ...fields.flatMap((field) => ['-p', field]), unit]);
  return parseSystemdServiceState(output);
}

async function targetState(unit) {
  const output = await run('/usr/bin/systemctl', ['show', '-p', 'ActiveState', '-p', 'SubState', unit]);
  return parseSystemdTargetState(output);
}

async function invokeServiceHelper(operation, paths = PATHS) {
  await run('/usr/bin/sudo', ['-n', paths.serviceHelper, operation]);
}

async function readJournalWarnings(since, paths = PATHS) {
  const journalSince = since.replace(/\.\d{3}Z$/, 'Z');
  return run('/usr/bin/sudo', ['-n', paths.serviceHelper, 'warnings', journalSince]);
}

async function validateHttp(routes, baseUrl = PATHS.baseUrl) {
  const results = [];
  for (const route of routes) {
    const response = await fetch(new URL(route.path, baseUrl), { signal: AbortSignal.timeout(5000) });
    results.push({ path: route.path, expected: route.status, actual: response.status });
    if (response.status !== route.status) throw new Error(`HTTP ${route.path}: expected ${route.status}, got ${response.status}`);
  }
  return results;
}

async function assertApplicationServices(expectedSha = null) {
  const states = {};
  const expectedCwd = expectedSha ? await realpath(path.join(PATHS.releases, expectedSha)) : null;
  for (const unit of APP_UNITS) {
    states[unit] = await serviceState(unit);
    assertServiceStateHealthy(unit, states[unit]);
    if (expectedCwd) {
      const cwd = await realpath(`/proc/${states[unit].MainPID}/cwd`);
      if (cwd !== expectedCwd) throw new Error(`${unit} runs from ${cwd}, expected release ${expectedSha} at ${expectedCwd}.`);
    }
  }
  const target = assertTargetActive(await targetState('wowsync-dev.target'));
  return { target, units: states };
}

async function assertReleaseUnitPaths() {
  for (const unit of APP_UNITS) {
    const cwd = await run('/usr/bin/systemctl', ['show', '-p', 'WorkingDirectory', '--value', unit]);
    const command = await run('/usr/bin/systemctl', ['show', '-p', 'ExecStart', '--value', unit]);
    if (cwd !== PATHS.current || !command.includes(`${PATHS.current}/packages/`)) {
      throw new Error(`${unit} is not configured to execute from ${PATHS.current}; observed WorkingDirectory=${cwd}, ExecStart=${command}`);
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

async function deploymentToolIdentity(paths = PATHS) {
  const entryPath = fileURLToPath(import.meta.url);
  const entryDir = path.dirname(entryPath);
  const toolRoot = await gitAt(['rev-parse', '--show-toplevel'], entryDir).catch(() => paths.source);
  const gitSha = await gitAt(['rev-parse', 'HEAD'], toolRoot).catch(() => 'unavailable');
  const dirty = await gitAt(['status', '--porcelain=v1', '--untracked-files=all'], toolRoot).catch(() => 'unavailable');
  return {
    version: '2', gitSha, toolRoot, dirtyCheckout: dirty !== '', mutableCheckout: true,
    entrySha256: await sha256File(entryPath),
    wrapperSha256: await sha256File(path.join(entryDir, 'wowsync-dev-deploy')),
  };
}

export async function collectJournalWarnings(since, paths = PATHS, reader = readJournalWarnings) {
  try { return { ok: true, output: await reader(since, paths) }; }
  catch (error) { return { ok: false, error: error.message }; }
}

async function shaAtSource(paths = PATHS) {
  return validateSha(await gitAt(['rev-parse', 'HEAD'], paths.source));
}

async function verifyInitialRuntime(previousSha, targetSha, paths = PATHS, unitsMigrated = false) {
  validateSha(previousSha);
  const sourceReal = await realpath(paths.source);
  const sourceUnits = {};
  for (const unit of APP_UNITS) {
    const state = await serviceState(unit);
    if (state.ActiveState !== 'active' || Number(state.MainPID) <= 0) throw new Error(`Initial migration requires active ${unit}: ${JSON.stringify(state)}`);
    const cwd = await realpath(`/proc/${state.MainPID}/cwd`);
    if (cwd !== sourceReal) throw new Error(`${unit} is not running from the declared old source runtime (${cwd}).`);
    const unitWorkingDirectory = await run('/usr/bin/systemctl', ['show', '-p', 'WorkingDirectory', '--value', unit]);
    const unitExecStart = await run('/usr/bin/systemctl', ['show', '-p', 'ExecStart', '--value', unit]);
    if (unitsMigrated) {
      if (unitWorkingDirectory !== paths.current || !unitExecStart.includes(`${paths.current}/packages/`)) throw new Error(`${unit} installed unit is not configured for the seeded release path.`);
    } else {
      if (unitWorkingDirectory !== paths.source) throw new Error(`${unit} old unit WorkingDirectory is ${unitWorkingDirectory}, expected source checkout ${paths.source}.`);
      const expectedEntry = unit === APP_UNITS[0] ? 'packages/server/src/index.ts' : `${paths.source}/packages/mcp/src/index.ts`;
      if (!unitExecStart.includes(expectedEntry)) throw new Error(`${unit} old ExecStart does not identify expected source runtime entry ${expectedEntry}.`);
    }
    sourceUnits[unit] = { ...state, cwd };
  }
  const appPaths = ['package-lock.json', 'tsconfig.base.json', 'packages/core', 'packages/server', 'packages/mcp', 'packages/web'];
  const diff = spawnSync('/usr/bin/git', ['-C', paths.source, 'diff', '--exit-code', previousSha, '--', ...appPaths], { encoding: 'utf8' });
  if (diff.status !== 0) throw new Error(`Source checkout application files differ from explicitly declared old runtime SHA ${previousSha}; checked paths: ${appPaths.join(', ')}.`);
  const oldPackage = JSON.parse(await gitAt(['show', `${previousSha}:package.json`], paths.source));
  const currentPackage = JSON.parse(await readFile(path.join(paths.source, 'package.json'), 'utf8'));
  const runtimePackageFields = (manifest) => ({
    name: manifest.name, version: manifest.version, type: manifest.type,
    workspaces: manifest.workspaces, engines: manifest.engines,
    dependencies: manifest.dependencies, devDependencies: manifest.devDependencies,
    scripts: Object.fromEntries(['start', 'test', 'build:web', 'dev:server', 'dev:web'].map((key) => [key, manifest.scripts?.[key]])),
  });
  if (JSON.stringify(runtimePackageFields(oldPackage)) !== JSON.stringify(runtimePackageFields(currentPackage))) {
    throw new Error(`Source checkout runtime package configuration differs from declared previous SHA ${previousSha}.`);
  }
  const targetManifest = await validateRelease(path.join(paths.releases, targetSha), targetSha, paths);
  const previousReleaseSource = targetManifest.sourceManifest;
  if (targetSha !== previousSha || previousReleaseSource.length === 0) throw new Error(`Initial topology migration must seed the running exact SHA ${previousSha}; requested ${targetSha}.`);
  return { sha: previousSha, sourceUnits, developerTool: { gitSha: await shaAtSource(paths), mutableCheckout: true } };
}

async function promote(sha, ref, routes, previousRuntimeSha = null, paths = PATHS) {
  const tool = await deploymentToolIdentity(paths);
  await resolveExactCommit(sha, ref, paths);
  let releasePath = path.join(paths.releases, sha);
  try {
    await lstat(releasePath);
    await validateRelease(releasePath, sha, paths);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    releasePath = await prepareRelease(sha, ref, paths);
  }

  const activeSha = await currentSha(paths.releases);
  const initialMode = previousRuntimeSha !== null;
  if (initialMode && activeSha !== sha) throw new Error(`Initial migration requires current seeded to requested same-SHA release ${sha}.`);
  if (initialMode && activeSha !== null && activeSha !== sha) throw new Error(`Initial migration pointer is ${activeSha}; expected seeded SHA ${sha}.`);
  if (!initialMode || activeSha === sha) await assertReleaseUnitPaths();
  const initialRuntime = initialMode ? await verifyInitialRuntime(previousRuntimeSha, sha, paths, true) : null;
  const previousSha = initialMode ? initialRuntime.sha : activeSha;
  if (!initialMode && activeSha === sha) {
    const services = await assertApplicationServices(sha);
    const http = await validateHttp(routes);
    const result = { schemaVersion: 2, operation: 'PROMOTE_NOOP', tool, requestedSha: sha, requestedRef: ref, previousSha, candidateSha: sha, deployedSha: sha, at: new Date().toISOString(), services, http, validation: 'passed' };
    await appendAudit(result, paths);
    console.log(`Already running ${sha}; no restart or backup performed.`);
    return;
  }

  const preparedAt = new Date().toISOString();
  const journalBefore = await collectJournalWarnings(preparedAt, paths);
  const wasActive = await assertApplicationServices(initialMode ? null : activeSha);
  const herdrBefore = await serviceState('wowsync-dev-herdr.service');
  let backupPath;
  let backupSha256;
  let beforeEvidence;
  let schemaChanged = null;
  let candidateStarted = false;
  let candidateValidated = false;
  const intent = { schemaVersion: 2, operation: 'PROMOTE_INTENT', tool, requestedSha: sha, requestedRef: ref, previousSha, candidateSha: sha, initialMode, at: preparedAt, journalBefore };
  await appendAudit(intent, paths);
  try {
    await invokeServiceHelper('stop', paths);
    beforeEvidence = databaseEvidence(paths.database);
    const stamp = `${preparedAt.replaceAll(':', '').replaceAll('-', '')}-${randomUUID().slice(0, 8)}`;
    backupPath = path.join(paths.backups, `${stamp}-${previousSha}-to-${sha}.sqlite`);
    await makeConsistentBackup(paths.database, backupPath);
    const backupEvidence = databaseEvidence(backupPath);
    if (JSON.stringify(beforeEvidence) !== JSON.stringify(backupEvidence)) throw new Error('SQLite online backup data evidence does not match the stopped runtime database.');
    backupSha256 = await sha256File(backupPath);
    await atomicSetCurrent(paths.releases, sha);
    await startCandidateConservatively(() => invokeServiceHelper('start', paths), () => { candidateStarted = true; });
    const serviceAtStart = await assertApplicationServices(sha);
    await waitForReadiness({ baseUrl: paths.baseUrl, routes });
    const serviceStates = await assertApplicationServices(sha);
    assertRestartCountersStable(serviceAtStart, serviceStates);
    const http = await validateHttp(routes);
    const afterEvidence = databaseEvidence(paths.database);
    schemaChanged = !assertSchemaCompatible(beforeEvidence, afterEvidence);
    if (schemaChanged) throw new Error(`Database schema changed during candidate validation (user_version ${beforeEvidence.userVersion} -> ${afterEvidence.userVersion}, schema ${beforeEvidence.schemaSha256} -> ${afterEvidence.schemaSha256}). Code rollback requires an operator compatibility decision.`);
    const herdrAfter = await serviceState('wowsync-dev-herdr.service');
    if (herdrBefore.MainPID !== herdrAfter.MainPID || herdrAfter.ActiveState !== 'active') {
      throw new Error(`Herdr changed during application deployment: before=${JSON.stringify(herdrBefore)} after=${JSON.stringify(herdrAfter)}`);
    }
    candidateValidated = true;
    const result = {
      schemaVersion: 2,
      operation: 'PROMOTE_SUCCESS',
      tool,
      requestedSha: sha,
      requestedRef: ref,
      previousSha,
      deployedSha: sha,
      candidateSha: sha,
      initialMode,
      expectedRef: ref,
      at: new Date().toISOString(),
      backup: { path: backupPath, sha256: backupSha256, integrityCheck: 'ok', data: backupEvidence },
      dataBefore: { integrityCheck: beforeEvidence.integrityCheck, userVersion: beforeEvidence.userVersion, schemaSha256: beforeEvidence.schemaSha256, demand: beforeEvidence.demand },
      dataAfter: { integrityCheck: afterEvidence.integrityCheck, userVersion: afterEvidence.userVersion, schemaSha256: afterEvidence.schemaSha256, demand: afterEvidence.demand },
      schemaChanged,
      previousServices: wasActive,
      services: serviceStates,
      herdr: herdrAfter,
      http,
      journalDiagnostics: await collectJournalWarnings(preparedAt, paths),
      validation: 'passed',
    };
    await appendAudit(result, paths);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    if (candidateValidated) throw new Error(`Deployment passed application validation, but operational audit write failed; no rollback was triggered. Audit path: ${paths.audit}. ${error.message}`);
    const preRecovery = await stopCandidateThenInspectSchema({
      candidateMayHaveRun: candidateStarted,
      stop: () => invokeServiceHelper('stop', paths),
      inspectSchema: () => {
        const after = databaseEvidence(paths.database);
        return beforeEvidence ? !assertSchemaCompatible(beforeEvidence, after) : null;
      },
    });
    schemaChanged = preRecovery.schemaChanged;
    let recoveredValidated = false;
    let recovery;
    try {
      recovery = await recoverFailedPromotion({
        initialMode, schemaChanged, candidateStarted,
        priorStopResult: candidateStarted ? preRecovery.stopResult : undefined,
        stop: () => invokeServiceHelper('stop', paths),
        setPrevious: () => atomicSetCurrent(paths.releases, previousSha),
        startPrevious: () => invokeServiceHelper('start', paths),
        validatePrevious: async () => {
          await waitForReadiness({ baseUrl: paths.baseUrl, routes: DEFAULT_VALIDATION_ROUTES });
          const restoredServices = await assertApplicationServices(previousSha);
          assertRestartCountersStable({}, restoredServices);
          const restoredHttp = await validateHttp(DEFAULT_VALIDATION_ROUTES, paths.baseUrl);
          const diagnostics = await collectJournalWarnings(preparedAt, paths);
          const herdrAfter = await serviceState('wowsync-dev-herdr.service');
          return { services: restoredServices, http: restoredHttp, herdr: herdrAfter, journalDiagnostics: diagnostics };
        },
      });
    } catch (rollbackError) {
      await appendAudit({ schemaVersion: 2, operation: 'PROMOTE_FAILURE', tool, requestedSha: sha, requestedRef: ref, previousSha, candidateSha: sha, backupPath, backupSha256, schemaChanged, error: error.message, recoveryAttempted: true, recoveryResult: `failed: ${rollbackError.message}`, at: new Date().toISOString() }, paths);
      throw new Error(`Deployment failed (${error.message}); automatic code rollback/restart also failed (${rollbackError.message}). Inspect services immediately.`);
    }
    if (recovery.state === 'stopped-review-required') {
      const recoveryCommand = initialMode ? 'sudo /usr/local/libexec/wowsync-dev/migrate-runtime-paths restore CURRENT' : null;
      await appendAudit({ schemaVersion: 2, operation: 'PROMOTE_FAILURE', tool, requestedSha: sha, requestedRef: ref, previousSha, candidateSha: sha, initialMode, backupPath, backupSha256, schemaChanged, error: error.message, recoveryAttempted: true, recoveryResult: recovery.state, recoveryAction: recovery.action, candidateStopResult: recovery.stopResult, oldTopologyRestore: recoveryCommand, at: new Date().toISOString() }, paths);
      if (initialMode) throw new Error(`Initial same-SHA topology promotion failed: ${error.message}. Application units were stopped (${recovery.stopResult}); no previous-code restoration is claimed. Exact reverse-topology action: ${recoveryCommand}. SQLite was not restored.`);
      throw new Error(`Candidate failed after changing database schema. Services were stopped (${recovery.stopResult}); previous code was not started. Review compatibility before any code rollback. Backup: ${backupPath}. ${error.message}`);
    }
    recoveredValidated = true;
    try {
      await appendAudit({ schemaVersion: 2, operation: 'PROMOTE_FAILURE', tool, requestedSha: sha, requestedRef: ref, previousSha, candidateSha: sha, backupPath, backupSha256, schemaChanged: false, error: error.message, recoveryAttempted: true, recoveryResult: 'validated', restored: recovery.validation, at: new Date().toISOString() }, paths);
    } catch (auditError) {
      throw new Error(`Previous release ${previousSha} was restored and validated, but its recovery audit could not be written: ${auditError.message}`);
    }
    throw new Error(`Deployment validation failed; previous release ${previousSha} was restarted and validated; database was not restored. ${error.message}`);
  }
}

async function seedInitial(sha, ref, previousRuntimeSha, paths = PATHS) {
  const tool = await deploymentToolIdentity(paths);
  await resolveExactCommit(sha, ref, paths);
  await validateRelease(path.join(paths.releases, sha), sha, paths);
  if (await currentSha(paths.releases)) throw new Error('Initial seed requires releases/current to be absent.');
  const runtime = await verifyInitialRuntime(previousRuntimeSha, sha, paths);
  const at = new Date().toISOString();
  await appendAudit({ schemaVersion: 2, operation: 'INITIAL_SEED_INTENT', tool, requestedSha: sha, requestedRef: ref, previousSha: previousRuntimeSha, candidateSha: sha, at }, paths);
  await atomicSetCurrent(paths.releases, sha);
  try {
    await appendAudit({ schemaVersion: 2, operation: 'INITIAL_SEED_SUCCESS', tool, requestedSha: sha, requestedRef: ref, previousSha: previousRuntimeSha, candidateSha: sha, release: path.join(paths.releases, sha), runtime, at: new Date().toISOString() }, paths);
  } catch (error) {
    error.message = `current was seeded to ${sha}, but the success audit write failed: ${error.message}`;
    error.seededCurrent = true;
    throw error;
  }
  console.log(`Seeded releases/current to same-SHA release ${sha}; services were not changed.`);
}

async function rollback(sha, routes, paths = PATHS) {
  validateSha(sha);
  const releasePath = path.join(paths.releases, sha);
  await validateRelease(releasePath, sha, paths);
  const current = await currentSha(paths.releases);
  await assertReleaseUnitPaths();
  if (!current) throw new Error('No release current pointer exists; use the documented one-time topology migration procedure.');
  if (current === sha) throw new Error(`Release ${sha} is already current.`);
  await promoteRetained(sha, current, routes, paths);
}

async function backupOnly(label, routes, paths = PATHS) {
  const tool = await deploymentToolIdentity(paths);
  if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(label)) throw new Error('Backup label must be 1-48 lowercase letters, digits, or hyphens.');
  const at = new Date().toISOString();
  const services = {};
  for (const unit of [...APP_UNITS, 'wowsync-dev-herdr.service']) services[unit] = await serviceState(unit);
  services['wowsync-dev.target'] = assertTargetActive(await targetState('wowsync-dev.target'));
  const http = await validateHttp(routes);
  const filename = `${at.replaceAll(':', '').replaceAll('-', '')}-${randomUUID().slice(0, 8)}-${label}.sqlite`;
  const backupPath = path.join(paths.backups, filename);
  await makeConsistentBackup(paths.database, backupPath);
  const backupEvidence = databaseEvidence(backupPath);
  const record = { schemaVersion: 2, operation: 'BACKUP_SUCCESS', tool, label, at, backup: { path: backupPath, sha256: await sha256File(backupPath), integrityCheck: 'ok', data: backupEvidence }, services, http };
  await appendAudit(record, paths);
  console.log(JSON.stringify(record, null, 2));
}

async function promoteRetained(sha, previousSha, routes, paths) {
  const tool = await deploymentToolIdentity(paths);
  const at = new Date().toISOString();
  const journalBefore = await collectJournalWarnings(at, paths);
  await assertApplicationServices(previousSha);
  const herdrBefore = await serviceState('wowsync-dev-herdr.service');
  let backupPath;
  let backupSha256;
  let before;
  let schemaChanged = null;
  let candidateStarted = false;
  let candidateValidated = false;
  let recoveryValidated = false;
  await appendAudit({ schemaVersion: 2, operation: 'ROLLBACK_INTENT', tool, requestedSha: sha, requestedRef: null, previousSha, candidateSha: sha, at, journalBefore }, paths);
  try {
    await invokeServiceHelper('stop', paths);
    before = databaseEvidence(paths.database);
    backupPath = path.join(paths.backups, `${at.replaceAll(':', '').replaceAll('-', '')}-${randomUUID().slice(0, 8)}-${previousSha}-to-${sha}.sqlite`);
    await makeConsistentBackup(paths.database, backupPath);
    const backupEvidence = databaseEvidence(backupPath);
    if (JSON.stringify(before) !== JSON.stringify(backupEvidence)) throw new Error('SQLite online backup data evidence does not match the stopped runtime database.');
    backupSha256 = await sha256File(backupPath);
    await atomicSetCurrent(paths.releases, sha);
    await invokeServiceHelper('start', paths);
    candidateStarted = true;
    const serviceAtStart = await assertApplicationServices(sha);
    await waitForReadiness({ baseUrl: paths.baseUrl, routes });
    const services = await assertApplicationServices(sha);
    assertRestartCountersStable(serviceAtStart, services);
    const http = await validateHttp(routes);
    const after = databaseEvidence(paths.database);
    schemaChanged = !assertSchemaCompatible(before, after);
    if (schemaChanged) throw new Error('Database schema changed during rollback candidate validation; prior code must not be automatically restarted.');
    const herdrAfter = await serviceState('wowsync-dev-herdr.service');
    if (herdrBefore.MainPID !== herdrAfter.MainPID || herdrAfter.ActiveState !== 'active') throw new Error('Herdr was restarted or became inactive.');
    candidateValidated = true;
    const record = { schemaVersion: 2, operation: 'ROLLBACK_SUCCESS', tool, requestedSha: sha, requestedRef: null, previousSha, candidateSha: sha, deployedSha: sha, at: new Date().toISOString(), backup: { path: backupPath, sha256: backupSha256, integrityCheck: 'ok', data: backupEvidence }, dataBefore: { integrityCheck: before.integrityCheck, userVersion: before.userVersion, schemaSha256: before.schemaSha256, demand: before.demand }, dataAfter: { integrityCheck: after.integrityCheck, userVersion: after.userVersion, schemaSha256: after.schemaSha256, demand: after.demand }, schemaChanged, services, herdr: herdrAfter, http, journalDiagnostics: await collectJournalWarnings(at, paths), validation: 'passed' };
    await appendAudit(record, paths);
    console.log(JSON.stringify(record, null, 2));
  } catch (error) {
    if (candidateValidated) throw new Error(`Rollback target passed application validation, but audit write failed; no further rollback was triggered. ${error.message}`);
    if (!recoveryPolicy({ schemaChanged, candidateStarted }).mayStartPreviousCode) {
      let stopResult = 'failed';
      try { await invokeServiceHelper('stop', paths); stopResult = 'succeeded'; } catch (stopError) { stopResult = `failed: ${stopError.message}`; }
      await appendAudit({ schemaVersion: 2, operation: 'ROLLBACK_FAILURE', tool, requestedSha: sha, previousSha, candidateSha: sha, backupPath, backupSha256, schemaChanged, error: error.message, recoveryAttempted: true, recoveryResult: 'stopped-review-required', candidateStopResult: stopResult, at: new Date().toISOString() }, paths);
      throw new Error(`Rollback candidate failed and schema changed or could not be verified (${schemaChanged}). Services stopped (${stopResult}); previous code was not restarted. Operator compatibility review required. ${error.message}`);
    }
    try {
      await invokeServiceHelper('stop', paths);
      await atomicSetCurrent(paths.releases, previousSha);
      await invokeServiceHelper('start', paths);
      await waitForReadiness({ baseUrl: paths.baseUrl, routes: DEFAULT_VALIDATION_ROUTES });
      const restoredServices = await assertApplicationServices(previousSha);
      assertRestartCountersStable({}, restoredServices);
      const restoredHttp = await validateHttp(DEFAULT_VALIDATION_ROUTES, paths.baseUrl);
      recoveryValidated = true;
      await appendAudit({ schemaVersion: 2, operation: 'ROLLBACK_FAILURE', tool, requestedSha: sha, previousSha, candidateSha: sha, backupPath, backupSha256, schemaChanged: false, error: error.message, recoveryAttempted: true, recoveryResult: 'validated', restored: { services: restoredServices, http: restoredHttp }, at: new Date().toISOString() }, paths);
    } catch (rollbackError) {
      if (recoveryValidated) throw new Error(`Previous release ${previousSha} was restored and validated, but its recovery audit could not be written: ${rollbackError.message}`);
      await appendAudit({ schemaVersion: 2, operation: 'ROLLBACK_FAILURE', tool, requestedSha: sha, previousSha, candidateSha: sha, at: new Date().toISOString(), backupPath, backupSha256, error: error.message, recoveryAttempted: true, recoveryResult: `failed: ${rollbackError.message}` }, paths);
      throw new Error(`Rollback validation failed (${error.message}); restoring previous code ${previousSha} also failed (${rollbackError.message}).`);
    }
    await appendAudit({ schemaVersion: 2, operation: 'ROLLBACK_FAILURE', tool, requestedSha: sha, previousSha, candidateSha: sha, backupPath, backupSha256, error: error.message, recoveryAttempted: true, recoveryResult: 'validated', at: new Date().toISOString() }, paths);
    throw new Error(`Rollback validation failed; code pointer restored to ${previousSha}; database was not restored. ${error.message}`);
  }
}

function usage() {
  console.error(`Usage:
  wowsync-dev-deploy backup <label> [--route /path=HTTP_STATUS ...]
  wowsync-dev-deploy prepare <full-sha> <refs/heads/branch|refs/tags/tag>
  wowsync-dev-deploy promote <full-sha> <refs/heads/branch|refs/tags/tag> [--previous-runtime-sha <full-sha>] [--route /path=HTTP_STATUS ...]
  wowsync-dev-deploy seed-initial <full-sha> <refs/heads/branch|refs/tags/tag> --previous-runtime-sha <full-sha>
  wowsync-dev-deploy rollback <retained-full-sha> [--route /path=HTTP_STATUS ...]

Default post-promotion checks are GET / and GET /api/versions => HTTP 200.
Use --route to add a feature-specific expected HTTP status (for example an expected
404 on the pre-feature SHA).`);
}

function parseArgs(args) {
  const command = args.shift();
  if (!['backup', 'prepare', 'promote', 'seed-initial', 'rollback'].includes(command)) { usage(); process.exit(64); }
  if (command === 'backup') {
    const label = args.shift();
    const routes = [...DEFAULT_VALIDATION_ROUTES];
    while (args.length) {
      const option = args.shift();
      if (option !== '--route') throw new Error(`Unknown option: ${option}`);
      routes.push(parseRoute(args.shift()));
    }
    return { command, label, routes };
  }
  const sha = validateSha(args.shift());
  const ref = command === 'rollback' ? null : validateRemoteRef(args.shift());
  const routes = [...DEFAULT_VALIDATION_ROUTES];
  let previousRuntimeSha = null;
  while (args.length) {
    const option = args.shift();
    if (option === '--route') routes.push(parseRoute(args.shift()));
    else if (option === '--previous-runtime-sha' && ['promote', 'seed-initial'].includes(command)) previousRuntimeSha = validateSha(args.shift());
    else throw new Error(`Unknown option: ${option}`);
  }
  if (command === 'seed-initial' && !previousRuntimeSha) throw new Error('seed-initial requires --previous-runtime-sha FULL_SHA.');
  return { command, sha, ref, routes, previousRuntimeSha };
}

async function main(argv) {
  const username = await run('/usr/bin/id', ['-un']);
  if (username !== 'wowsync-dev') throw new Error('Run this command as wowsync-dev; root and other identities must not run release builds.');
  const parsed = parseArgs([...argv]);
  if (parsed.command === 'backup') {
    await backupOnly(parsed.label, parsed.routes);
  } else if (parsed.command === 'prepare') {
    const tool = await deploymentToolIdentity();
    try {
      const release = await prepareRelease(parsed.sha, parsed.ref);
      await appendAudit({ schemaVersion: 2, operation: 'PREPARE_SUCCESS', tool, requestedSha: parsed.sha, requestedRef: parsed.ref, candidateSha: parsed.sha, release, at: new Date().toISOString() });
      console.log(`Prepared immutable SHA release: ${release}`);
    } catch (error) {
      await appendAudit({ schemaVersion: 2, operation: 'PREPARE_FAILURE', tool, requestedSha: parsed.sha, requestedRef: parsed.ref, candidateSha: parsed.sha, error: error.message, at: new Date().toISOString() });
      throw error;
    }
  } else if (parsed.command === 'promote') {
    try { await promote(parsed.sha, parsed.ref, parsed.routes, parsed.previousRuntimeSha); }
    catch (error) {
      await appendAudit({ schemaVersion: 2, operation: 'PROMOTE_COMMAND_FAILURE', tool: await deploymentToolIdentity(), requestedSha: parsed.sha, requestedRef: parsed.ref, candidateSha: parsed.sha, previousSha: await currentSha(PATHS.releases).catch(() => null), error: error.message, at: new Date().toISOString() });
      throw error;
    }
  } else if (parsed.command === 'seed-initial') {
    try { await seedInitial(parsed.sha, parsed.ref, parsed.previousRuntimeSha); }
    catch (error) {
      await appendAudit({ schemaVersion: 2, operation: error.seededCurrent ? 'INITIAL_SEED_AUDIT_FAILURE' : 'INITIAL_SEED_FAILURE', tool: await deploymentToolIdentity(), requestedSha: parsed.sha, requestedRef: parsed.ref, previousSha: parsed.previousRuntimeSha, candidateSha: parsed.sha, pointerChanged: Boolean(error.seededCurrent), error: error.message, at: new Date().toISOString() });
      throw error;
    }
  } else {
    try { await rollback(parsed.sha, parsed.routes); }
    catch (error) {
      await appendAudit({ schemaVersion: 2, operation: 'ROLLBACK_COMMAND_FAILURE', tool: await deploymentToolIdentity(), requestedSha: parsed.sha, requestedRef: null, candidateSha: parsed.sha, previousSha: await currentSha(PATHS.releases).catch(() => null), error: error.message, at: new Date().toISOString() });
      throw error;
    }
  }
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const args = process.argv.slice(2);
  const underLock = args[0] === '--under-lock';
  if (underLock) args.shift();
  const lockPath = '/home/wowsync-dev/deploy/deploy.lock';
  await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const parentCommand = (await readFile(`/proc/${process.ppid}/cmdline`, 'utf8').catch(() => '')).replaceAll('\0', ' ');
  const validLockParent = underLock && parentCommand.includes('/usr/bin/flock') && parentCommand.includes(lockPath);
  if (!validLockParent) {
    const result = spawnSync('/usr/bin/flock', ['--nonblock', lockPath, '/usr/bin/node', path.resolve(process.argv[1]), '--under-lock', ...args], { stdio: 'inherit', env: process.env });
    process.exitCode = result.status ?? 1;
  } else {
    main(args).catch((error) => {
      console.error(`wowsync-dev-deploy: ${error.message}`);
      process.exitCode = 1;
    });
  }
}
