#!/usr/bin/node
import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, open, readFile, readdir, realpath, rename, rm, lstat, readlink, writeFile, appendFile, symlink, chmod } from 'node:fs/promises';
import path from 'node:path';
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
    const rowDigests = {};
    for (const table of tables) {
      const safeTable = table.replaceAll('"', '""');
      counts[table] = db.prepare(`SELECT COUNT(*) AS count FROM "${safeTable}"`).get().count;
      const columns = db.prepare(`PRAGMA table_info("${safeTable}")`).all().map((column) => `"${column.name.replaceAll('"', '""')}"`);
      const query = db.prepare(`SELECT * FROM "${safeTable}" ORDER BY ${columns.join(', ')}`);
      const digest = createHash('sha256');
      for (const row of query.iterate()) digest.update(JSON.stringify(row)).update('\n');
      rowDigests[table] = digest.digest('hex');
    }
    let demand = null;
    if (tables.includes('demands')) {
      demand = {
        total: db.prepare('SELECT COUNT(*) AS count FROM demands').get().count,
        byStatus: db.prepare('SELECT status, COUNT(*) AS count FROM demands GROUP BY status ORDER BY status').all(),
        latestUpdatedAt: db.prepare('SELECT MAX(updated_at) AS value FROM demands').get().value,
      };
    }
    return { integrityCheck: 'ok', counts, rowDigests, demand };
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

function assertExistingDataPreserved(before, after) {
  if (before.integrityCheck !== 'ok' || after.integrityCheck !== 'ok') throw new Error('SQLite integrity_check did not pass before and after deployment.');
  for (const [table, count] of Object.entries(before.counts)) {
    if (after.counts[table] !== count) throw new Error(`Persistent row count changed for ${table}: ${count} -> ${after.counts[table] ?? 'table missing'}`);
    if (after.rowDigests[table] !== before.rowDigests[table]) throw new Error(`Persistent row contents changed for ${table}.`);
  }
  if (JSON.stringify(before.demand) !== JSON.stringify(after.demand)) throw new Error(`Demand state changed during deployment: before=${JSON.stringify(before.demand)} after=${JSON.stringify(after.demand)}`);
}

async function sha256File(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

async function serviceState(unit) {
  const fields = ['ActiveState', 'SubState', 'MainPID', 'NRestarts', 'Result'];
  const output = await run('/usr/bin/systemctl', ['show', ...fields.flatMap((field) => ['-p', field]), '--value', unit]);
  const values = output.split('\n');
  return Object.fromEntries(fields.map((field, index) => [field, values[index] ?? '']));
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
    if (states[unit].ActiveState !== 'active' || states[unit].Result !== 'success' || Number(states[unit].MainPID) <= 0) {
      throw new Error(`${unit} is not healthy: ${JSON.stringify(states[unit])}`);
    }
    if (expectedCwd) {
      const cwd = await realpath(`/proc/${states[unit].MainPID}/cwd`);
      if (cwd !== expectedCwd) throw new Error(`${unit} runs from ${cwd}, expected release ${expectedSha} at ${expectedCwd}.`);
    }
  }
  const target = await serviceState('wowsync-dev.target');
  if (target.ActiveState !== 'active') throw new Error(`wowsync-dev.target is not active: ${JSON.stringify(target)}`);
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

function assertRestartCountersStable(before, after) {
  for (const unit of APP_UNITS) {
    const beforeCount = before.units[unit].NRestarts;
    const afterCount = after.units[unit].NRestarts;
    if (beforeCount !== afterCount) throw new Error(`${unit} NRestarts changed during deployment: ${beforeCount} -> ${afterCount}`);
  }
}

async function appendAudit(record, paths = PATHS) {
  await mkdir(path.dirname(paths.audit), { recursive: true, mode: 0o700 });
  await appendFile(paths.audit, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

async function shaAtSource(paths = PATHS) {
  const sha = await gitAt(['rev-parse', 'HEAD'], paths.source);
  validateSha(sha);
  const dirty = await gitAt(['status', '--porcelain=v1', '--untracked-files=all'], paths.source);
  if (dirty) throw new Error('Developer/source checkout is dirty; refusing first topology promotion.');
  return sha;
}

async function verifyInitialRuntime(previousSha, targetSha, paths = PATHS) {
  validateSha(previousSha);
  const sourceHead = await shaAtSource(paths);
  const sourceReal = await realpath(paths.source);
  const dashboard = await serviceState(APP_UNITS[0]);
  const dashboardCwd = await realpath(`/proc/${dashboard.MainPID}/cwd`);
  if (dashboardCwd !== sourceReal) throw new Error(`No current release pointer exists and Dashboard is not running from the source checkout (${dashboardCwd}).`);
  const diff = spawnSync('/usr/bin/git', ['-C', paths.source, 'diff', '--exit-code', previousSha, sourceHead, '--', 'packages', 'package-lock.json', 'tsconfig.base.json'], { encoding: 'utf8' });
  if (diff.status !== 0) throw new Error(`Source checkout application tree differs from declared previous runtime SHA ${previousSha}.`);
  const oldPackage = JSON.parse(await gitAt(['show', `${previousSha}:package.json`], paths.source));
  const newPackage = JSON.parse(await readFile(path.join(paths.source, 'package.json'), 'utf8'));
  const significant = (manifest) => ({ name: manifest.name, version: manifest.version, type: manifest.type, workspaces: manifest.workspaces, engines: manifest.engines, dependencies: manifest.dependencies, devDependencies: manifest.devDependencies, scripts: Object.fromEntries(['start', 'test', 'build:web', 'dev:server', 'dev:web'].map((key) => [key, manifest.scripts?.[key]])) });
  if (JSON.stringify(significant(oldPackage)) !== JSON.stringify(significant(newPackage))) throw new Error(`Source checkout package runtime configuration differs from ${previousSha}.`);
  const targetManifest = await validateRelease(path.join(paths.releases, targetSha), targetSha, paths);
  const previousReleaseSource = targetManifest.sourceManifest;
  if (targetSha !== previousSha || previousReleaseSource.length === 0) throw new Error(`Initial topology migration must seed the running exact SHA ${previousSha}; requested ${targetSha}.`);
  return previousSha;
}

async function promote(sha, ref, routes, previousRuntimeSha = null, paths = PATHS) {
  await resolveExactCommit(sha, ref, paths);
  await assertReleaseUnitPaths();
  let releasePath = path.join(paths.releases, sha);
  try {
    await lstat(releasePath);
    await validateRelease(releasePath, sha, paths);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    releasePath = await prepareRelease(sha, ref, paths);
  }

  const activeSha = await currentSha(paths.releases);
  const previousSha = activeSha ?? await verifyInitialRuntime(previousRuntimeSha ?? '', sha, paths);
  if (activeSha === sha) {
    const services = await assertApplicationServices(sha);
    const http = await validateHttp(routes);
    const result = { operation: 'no-op', previousSha, deployedSha: sha, at: new Date().toISOString(), services, http, validation: 'passed' };
    await appendAudit(result, paths);
    console.log(`Already running ${sha}; no restart or backup performed.`);
    return;
  }

  const preparedAt = new Date().toISOString();
  await readJournalWarnings(preparedAt, paths);
  const wasActive = await assertApplicationServices(activeSha);
  const herdrBefore = await serviceState('wowsync-dev-herdr.service');
  let stopped = false;
  let backupPath;
  let backupSha256;
  let beforeEvidence;
  try {
    await invokeServiceHelper('stop', paths);
    stopped = true;
    beforeEvidence = databaseEvidence(paths.database);
    const stamp = `${preparedAt.replaceAll(':', '').replaceAll('-', '')}-${randomUUID().slice(0, 8)}`;
    backupPath = path.join(paths.backups, `${stamp}-${previousSha}-to-${sha}.sqlite`);
    await makeConsistentBackup(paths.database, backupPath);
    const backupEvidence = databaseEvidence(backupPath);
    if (JSON.stringify(beforeEvidence) !== JSON.stringify(backupEvidence)) throw new Error('SQLite online backup data evidence does not match the stopped runtime database.');
    backupSha256 = await sha256File(backupPath);
    await atomicSetCurrent(paths.releases, sha);
    await invokeServiceHelper('start', paths);
    stopped = false;

    const serviceStates = await assertApplicationServices(sha);
    assertRestartCountersStable(wasActive, serviceStates);
    const http = await validateHttp(routes);
    const afterEvidence = databaseEvidence(paths.database);
    assertExistingDataPreserved(beforeEvidence, afterEvidence);
    const herdrAfter = await serviceState('wowsync-dev-herdr.service');
    if (herdrBefore.MainPID !== herdrAfter.MainPID || herdrAfter.ActiveState !== 'active') {
      throw new Error(`Herdr changed during application deployment: before=${JSON.stringify(herdrBefore)} after=${JSON.stringify(herdrAfter)}`);
    }
    const result = {
      schemaVersion: 1,
      operation: 'promote',
      previousSha,
      deployedSha: sha,
      expectedRef: ref,
      at: new Date().toISOString(),
      backup: { path: backupPath, sha256: backupSha256, integrityCheck: 'ok', data: backupEvidence },
      dataBefore: beforeEvidence,
      dataAfter: afterEvidence,
      previousServices: wasActive,
      services: serviceStates,
      herdr: herdrAfter,
      http,
      journalWarnings: await readJournalWarnings(preparedAt, paths),
      validation: 'passed',
    };
    await appendAudit(result, paths);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    try {
      await invokeServiceHelper('stop', paths);
      if (previousSha) await atomicSetCurrent(paths.releases, previousSha);
      else await rm(paths.current, { force: true });
      await invokeServiceHelper('start', paths);
    } catch (rollbackError) {
      await appendAudit({ schemaVersion: 1, operation: 'failed-promotion', previousSha, attemptedSha: sha, expectedRef: ref, at: new Date().toISOString(), backupPath, backupSha256, error: error.message, rollbackError: rollbackError.message, validation: 'failed; manual recovery required' }, paths).catch(() => {});
      throw new Error(`Deployment failed (${error.message}); automatic code rollback/restart also failed (${rollbackError.message}). Inspect services immediately.`);
    }
    await appendAudit({ schemaVersion: 1, operation: 'failed-promotion', previousSha, attemptedSha: sha, expectedRef: ref, at: new Date().toISOString(), backupPath, backupSha256, error: error.message, validation: 'failed; previous code restored; database unchanged' }, paths).catch(() => {});
    throw new Error(`Deployment validation failed; code pointer restored to ${previousSha ?? 'source checkout'}; database was not restored. ${error.message}`);
  }
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
  if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(label)) throw new Error('Backup label must be 1-48 lowercase letters, digits, or hyphens.');
  const at = new Date().toISOString();
  const services = {};
  for (const unit of [...APP_UNITS, 'wowsync-dev.target', 'wowsync-dev-herdr.service']) services[unit] = await serviceState(unit);
  const http = await validateHttp(routes);
  const filename = `${at.replaceAll(':', '').replaceAll('-', '')}-${randomUUID().slice(0, 8)}-${label}.sqlite`;
  const backupPath = path.join(paths.backups, filename);
  await makeConsistentBackup(paths.database, backupPath);
  const backupEvidence = databaseEvidence(backupPath);
  const record = { schemaVersion: 1, operation: 'backup', label, at, backup: { path: backupPath, sha256: await sha256File(backupPath), integrityCheck: 'ok', data: backupEvidence }, services, http };
  await appendAudit(record, paths);
  console.log(JSON.stringify(record, null, 2));
}

async function promoteRetained(sha, previousSha, routes, paths) {
  const at = new Date().toISOString();
  await readJournalWarnings(at, paths);
  const servicesBefore = await assertApplicationServices(previousSha).catch(() => null);
  const herdrBefore = await serviceState('wowsync-dev-herdr.service');
  let stopped = false;
  let backupPath;
  let backupSha256;
  try {
    await invokeServiceHelper('stop', paths);
    stopped = true;
    const before = databaseEvidence(paths.database);
    backupPath = path.join(paths.backups, `${at.replaceAll(':', '').replaceAll('-', '')}-${randomUUID().slice(0, 8)}-${previousSha}-to-${sha}.sqlite`);
    await makeConsistentBackup(paths.database, backupPath);
    const backupEvidence = databaseEvidence(backupPath);
    if (JSON.stringify(before) !== JSON.stringify(backupEvidence)) throw new Error('SQLite online backup data evidence does not match the stopped runtime database.');
    backupSha256 = await sha256File(backupPath);
    await atomicSetCurrent(paths.releases, sha);
    await invokeServiceHelper('start', paths);
    stopped = false;
    const services = await assertApplicationServices(sha);
    if (servicesBefore) assertRestartCountersStable(servicesBefore, services);
    const http = await validateHttp(routes);
    const after = databaseEvidence(paths.database);
    assertExistingDataPreserved(before, after);
    const herdrAfter = await serviceState('wowsync-dev-herdr.service');
    if (herdrBefore.MainPID !== herdrAfter.MainPID || herdrAfter.ActiveState !== 'active') throw new Error('Herdr was restarted or became inactive.');
    const record = { schemaVersion: 1, operation: 'rollback', previousSha, deployedSha: sha, at: new Date().toISOString(), backup: { path: backupPath, sha256: backupSha256, integrityCheck: 'ok', data: backupEvidence }, dataBefore: before, dataAfter: after, services, herdr: herdrAfter, http, journalWarnings: await readJournalWarnings(at, paths), validation: 'passed' };
    await appendAudit(record, paths);
    console.log(JSON.stringify(record, null, 2));
  } catch (error) {
    try {
      await invokeServiceHelper('stop', paths);
      await atomicSetCurrent(paths.releases, previousSha);
      await invokeServiceHelper('start', paths);
    } catch (rollbackError) {
      await appendAudit({ schemaVersion: 1, operation: 'failed-rollback', previousSha, attemptedSha: sha, at: new Date().toISOString(), backupPath, backupSha256, error: error.message, rollbackError: rollbackError.message, validation: 'failed; manual recovery required' }, paths).catch(() => {});
      throw new Error(`Rollback validation failed (${error.message}); restoring previous code ${previousSha} also failed (${rollbackError.message}).`);
    }
    await appendAudit({ schemaVersion: 1, operation: 'failed-rollback', previousSha, attemptedSha: sha, at: new Date().toISOString(), backupPath, backupSha256, error: error.message, validation: 'failed; previous code restored; database unchanged' }, paths).catch(() => {});
    throw new Error(`Rollback validation failed; code pointer restored to ${previousSha}; database was not restored. ${error.message}`);
  }
}

function usage() {
  console.error(`Usage:
  wowsync-dev-deploy backup <label> [--route /path=HTTP_STATUS ...]
  wowsync-dev-deploy prepare <full-sha> <refs/heads/branch|refs/tags/tag>
  wowsync-dev-deploy promote <full-sha> <refs/heads/branch|refs/tags/tag> [--previous-runtime-sha <full-sha>] [--route /path=HTTP_STATUS ...]
  wowsync-dev-deploy rollback <retained-full-sha> [--route /path=HTTP_STATUS ...]

Default post-promotion checks are GET / and GET /api/versions => HTTP 200.
Use --route to add a feature-specific expected HTTP status (for example an expected
404 on the pre-feature SHA).`);
}

function parseArgs(args) {
  const command = args.shift();
  if (!['backup', 'prepare', 'promote', 'rollback'].includes(command)) { usage(); process.exit(64); }
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
    else if (option === '--previous-runtime-sha' && command === 'promote') previousRuntimeSha = validateSha(args.shift());
    else throw new Error(`Unknown option: ${option}`);
  }
  return { command, sha, ref, routes, previousRuntimeSha };
}

async function main(argv) {
  const username = await run('/usr/bin/id', ['-un']);
  if (username !== 'wowsync-dev') throw new Error('Run this command as wowsync-dev; root and other identities must not run release builds.');
  const parsed = parseArgs([...argv]);
  if (parsed.command === 'backup') {
    await backupOnly(parsed.label, parsed.routes);
  } else if (parsed.command === 'prepare') {
    const release = await prepareRelease(parsed.sha, parsed.ref);
    console.log(`Prepared immutable SHA release: ${release}`);
  } else if (parsed.command === 'promote') {
    await promote(parsed.sha, parsed.ref, parsed.routes, parsed.previousRuntimeSha);
  } else {
    await rollback(parsed.sha, parsed.routes);
  }
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`wowsync-dev-deploy: ${error.message}`);
    process.exitCode = 1;
  });
}
