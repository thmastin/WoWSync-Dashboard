import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  assertReleaseSourceClean,
  assertWorkspaceSelfContained,
  atomicSetCurrent,
  currentSha,
  collectJournalWarnings,
  databaseEvidence,
  assertSchemaCompatible,
  assertRestartCountersStable,
  appendAudit,
  makeConsistentBackup,
  parseRoute,
  prepareRelease,
  recoveryPolicy,
  recoverFailedPromotion,
  resolveExactCommit,
  validateRemoteRef,
  validateSha,
  waitForReadiness,
} from '../wowsync-dev-deploy.mjs';

async function tempDir(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wowsync-deploy-test-'));
  t.after(async () => {
    const { chmod, readdir } = await import('node:fs/promises');
    const writable = async (current) => {
      for (const entry of await readdir(current, { withFileTypes: true }).catch(() => [])) {
        const child = path.join(current, entry.name);
        if (entry.isDirectory()) await writable(child);
        else if (!entry.isSymbolicLink()) await chmod(child, 0o600).catch(() => {});
      }
      await chmod(current, 0o700).catch(() => {});
    };
    await writable(directory);
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

function git(cwd, args) {
  const result = spawnSync('/usr/bin/git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function fixtureRemote(root, t) {
  const source = path.join(root, 'source');
  const bare = path.join(root, 'origin.git');
  await mkdir(source);
  git(source, ['init', '-q', '-b', 'fixture']);
  git(source, ['config', 'user.name', 'Deployment Test']);
  git(source, ['config', 'user.email', 'deployment-test@example.invalid']);
  await writeFile(path.join(source, 'package.json'), '{"name":"deployment-fixture","version":"1.0.0"}\n');
  await writeFile(path.join(source, 'package-lock.json'), '{"name":"deployment-fixture","version":"1.0.0","lockfileVersion":3,"packages":{}}\n');
  await mkdir(path.join(source, 'packages', 'web'), { recursive: true });
  await writeFile(path.join(source, 'packages', 'web', 'index.html'), '<main>fixture</main>\n');
  git(source, ['add', '.']);
  git(source, ['commit', '-qm', 'fixture release']);
  const sha = git(source, ['rev-parse', 'HEAD']);
  git(root, ['init', '-q', '--bare', bare]);
  git(source, ['remote', 'add', 'origin', bare]);
  git(source, ['push', '-q', 'origin', 'HEAD:refs/heads/fixture']);
  t.after(() => {});
  const paths = {
    source,
    deploy: path.join(root, 'deploy'),
    cache: path.join(root, 'deploy', 'cache.git'),
    staging: path.join(root, 'deploy', 'staging'),
    releases: path.join(root, 'releases'),
    current: path.join(root, 'releases', 'current'),
    database: path.join(root, 'db.sqlite'),
    backups: path.join(root, 'backups'),
    audit: path.join(root, 'audit.jsonl'),
    serviceHelper: path.join(root, 'service-helper'),
  };
  return { source, bare, sha, paths };
}

test('requires a full lowercase SHA and a full remote ref', () => {
  assert.throws(() => validateSha('51628e4'), /40 lowercase hexadecimal/);
  assert.throws(() => validateSha('G'.repeat(40)), /40 lowercase hexadecimal/);
  assert.throws(() => validateRemoteRef('feature/branch'), /full remote ref/);
  assert.equal(validateRemoteRef('refs/heads/feature/branch'), 'refs/heads/feature/branch');
  assert.deepEqual(parseRoute('/api/versions/retail/allocation-review=404'), {
    path: '/api/versions/retail/allocation-review', status: 404,
  });
  assert.throws(() => parseRoute('/../../etc/passwd=200'), /Invalid route/);
});

test('fetches the requested remote ref and rejects a SHA mismatch', async (t) => {
  const root = await tempDir(t);
  const { sha, paths } = await fixtureRemote(root, t);
  const resolved = await resolveExactCommit(sha, 'refs/heads/fixture', paths);
  assert.equal(resolved.sha, sha);
  await assert.rejects(resolveExactCommit('1'.repeat(40), 'refs/heads/fixture', paths), /not requested SHA/);
});

test('failed builds and dirty release sources are discarded', async (t) => {
  const root = await tempDir(t);
  const { sha, paths } = await fixtureRemote(root, t);
  await assert.rejects(prepareRelease(sha, 'refs/heads/fixture', paths, async () => {
    throw new Error('injected build failure');
  }), /injected build failure/);
  assert.deepEqual(await (await import('node:fs/promises')).readdir(paths.staging), []);
  await assert.rejects(prepareRelease(sha, 'refs/heads/fixture', paths, async (stage) => {
    await mkdir(path.join(stage, 'node_modules'), { recursive: true });
    await mkdir(path.join(stage, 'packages', 'web', 'dist'), { recursive: true });
    await writeFile(path.join(stage, 'packages', 'web', 'index.html'), 'changed after export');
  }), /modified after export/);
  assert.deepEqual(await (await import('node:fs/promises')).readdir(paths.staging), []);
});

test('refuses to overwrite an existing SHA release', async (t) => {
  const root = await tempDir(t);
  const { sha, paths } = await fixtureRemote(root, t);
  await mkdir(path.join(paths.releases, sha), { recursive: true });
  await assert.rejects(prepareRelease(sha, 'refs/heads/fixture', paths, async () => {}), /refusing to overwrite/);
});

test('prepared releases contain only matching source plus local dependencies/build assets', async (t) => {
  const root = await tempDir(t);
  const { sha, paths } = await fixtureRemote(root, t);
  const release = await prepareRelease(sha, 'refs/heads/fixture', paths, async (stage) => {
    await mkdir(path.join(stage, 'node_modules'), { recursive: true });
    await mkdir(path.join(stage, 'packages', 'web', 'dist'), { recursive: true });
    await writeFile(path.join(stage, 'packages', 'web', 'dist', 'index.html'), 'built');
  });
  assert.equal(path.basename(release), sha);
  await assertReleaseSourceClean(release, JSON.parse(await readFile(path.join(release, 'release.json'), 'utf8')).sourceManifest);
  assert.equal(await assertWorkspaceSelfContained(release), true);
  const dependencyRoot = path.join(root, 'dependency-check');
  await mkdir(path.join(dependencyRoot, 'node_modules'), { recursive: true });
  const outside = path.join(root, 'outside');
  await mkdir(outside);
  await symlink(outside, path.join(dependencyRoot, 'node_modules', 'escape'));
  await assert.rejects(assertWorkspaceSelfContained(dependencyRoot), /escapes release/);
});

test('current pointer changes atomically between retained releases and supports rollback', async (t) => {
  const root = await tempDir(t);
  const releases = path.join(root, 'releases');
  const first = '1'.repeat(40);
  const second = '2'.repeat(40);
  await mkdir(path.join(releases, first), { recursive: true });
  await mkdir(path.join(releases, second), { recursive: true });
  await atomicSetCurrent(releases, first);
  assert.equal(await currentSha(releases), first);
  await atomicSetCurrent(releases, second);
  assert.equal(await currentSha(releases), second);
  assert.equal(await realpath(path.join(releases, 'current')), path.join(releases, second));
  await atomicSetCurrent(releases, first);
  assert.equal(await currentSha(releases), first);
  assert.equal(await readlink(path.join(releases, 'current')), path.join(releases, first));
});

test('online backup contains committed WAL data and passes integrity_check', async (t) => {
  const root = await tempDir(t);
  const dbPath = path.join(root, 'live.sqlite');
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE demands(status TEXT, updated_at INTEGER); CREATE TABLE characters(name TEXT); INSERT INTO demands VALUES (\'INACTIVE\', 1791087954); INSERT INTO characters VALUES (\'fixture\');');
  const backupPath = path.join(root, 'backup', 'before.sqlite');
  await makeConsistentBackup(dbPath, backupPath);
  const evidence = databaseEvidence(backupPath);
  assert.deepEqual(evidence.counts, { characters: 1, demands: 1 });
  assert.equal(evidence.demand.total, 1);
  assert.equal(evidence.demand.byStatus[0].status, 'INACTIVE');
  assert.equal(evidence.demand.byStatus[0].count, 1);
  assert.equal(evidence.demand.latestUpdatedAt, 1791087954);
  db.close();
});

test('schema evidence detects structural changes while legitimate writes preserve compatibility', async (t) => {
  const root = await tempDir(t);
  const dbPath = path.join(root, 'schema.sqlite');
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE observations(id INTEGER PRIMARY KEY, name TEXT); INSERT INTO observations(name) VALUES ('before');");
  const before = databaseEvidence(dbPath);
  db.exec("INSERT INTO observations(name) VALUES ('capture-after-start');");
  const afterWrite = databaseEvidence(dbPath);
  assert.equal(assertSchemaCompatible(before, afterWrite), true);
  db.exec('CREATE INDEX observations_name ON observations(name);');
  const afterSchema = databaseEvidence(dbPath);
  assert.equal(assertSchemaCompatible(before, afterSchema), false);
  db.close();
});

test('recovery policy allows old code only with unchanged schema and non-initial promotion', () => {
  assert.deepEqual(recoveryPolicy({ initialMode: true, schemaChanged: false }), {
    action: 'stop-and-reverse-topology', mayStartPreviousCode: false,
  });
  assert.equal(recoveryPolicy({ schemaChanged: true }).mayStartPreviousCode, false);
  assert.equal(recoveryPolicy({ schemaChanged: false }).mayStartPreviousCode, true);
});

test('promotion recovery runs prior code only after unchanged-schema validation and handles initial mode explicitly', async () => {
  const events = [];
  const callbacks = {
    stop: async () => events.push('stop'),
    setPrevious: async () => events.push('pointer-previous'),
    startPrevious: async () => events.push('start-previous'),
    validatePrevious: async () => { events.push('validate-previous'); return { http: 'ok' }; },
  };
  const unchanged = await recoverFailedPromotion({ ...callbacks, schemaChanged: false, candidateStarted: true });
  assert.equal(unchanged.state, 'validated');
  assert.deepEqual(events, ['stop', 'pointer-previous', 'start-previous', 'validate-previous']);
  events.length = 0;
  const changed = await recoverFailedPromotion({ ...callbacks, schemaChanged: true, candidateStarted: true });
  assert.equal(changed.state, 'stopped-review-required');
  assert.deepEqual(events, ['stop']);
  events.length = 0;
  const initial = await recoverFailedPromotion({ ...callbacks, initialMode: true });
  assert.equal(initial.action, 'stop-and-reverse-topology');
  assert.deepEqual(events, ['stop']);
  events.length = 0;
  const unknown = await recoverFailedPromotion({ ...callbacks, schemaChanged: null, candidateStarted: true });
  assert.equal(unknown.state, 'stopped-review-required');
  assert.deepEqual(events, ['stop']);
});

test('bounded readiness polling accepts delayed startup and rejects timeout', async () => {
  let now = 0;
  let calls = 0;
  const delayed = async () => ({ status: ++calls < 3 ? 503 : 200 });
  const sleepFn = async (ms) => { now += ms; };
  const routes = [{ path: '/', status: 200 }];
  await waitForReadiness({ fetchFn: delayed, baseUrl: 'http://fixture/', routes, timeoutMs: 1000, intervalMs: 100, settleMs: 200, sleepFn, now: () => now });
  assert.ok(calls >= 4, 'readiness retried until healthy, then probed through settle window');
  now = 0;
  await assert.rejects(waitForReadiness({ fetchFn: async () => ({ status: 503 }), baseUrl: 'http://fixture/', routes, timeoutMs: 350, intervalMs: 100, settleMs: 100, sleepFn, now: () => now }), /timed out/);
});

test('restart counters are validated within the current start window', () => {
  const unit = 'wowsync-dev-dashboard.service';
  assert.doesNotThrow(() => assertRestartCountersStable({ units: { [unit]: { NRestarts: '0' } } }, { units: { [unit]: { NRestarts: '0' } } }));
  assert.throws(() => assertRestartCountersStable({ units: { [unit]: { NRestarts: '0' } } }, { units: { [unit]: { NRestarts: '1' } } }), /expected 0/);
});

test('root helper rejects arbitrary units and arguments before invoking systemctl', () => {
  const helper = path.resolve('tools/omarchy/wowsync-dev-app-services');
  const badOperation = spawnSync(helper, ['wowsync-dev-herdr.service'], { encoding: 'utf8' });
  assert.equal(badOperation.status, 64);
  const extraArg = spawnSync(helper, ['restart', 'wowsync-dev-herdr.service'], { encoding: 'utf8' });
  assert.equal(extraArg.status, 64);
  const badJournal = spawnSync(helper, ['warnings', '--unit=arbitrary.service'], { encoding: 'utf8' });
  assert.equal(badJournal.status, 64);
  const sudoers = spawnSync('/usr/bin/cat', [path.resolve('ops/sudoers/wowsync-dev-deploy')], { encoding: 'utf8' });
  assert.equal(sudoers.status, 0);
  assert.match(sudoers.stdout, /^wowsync-dev ALL=\(root\) NOPASSWD: \/usr\/local\/sbin\/wowsync-dev-app-services$/m);
  assert.doesNotMatch(sudoers.stdout, /systemctl|ALL\s*=\s*\(ALL\)/);
});

test('bootstrap and migration refuse unprivileged execution before touching host paths', async () => {
  const bootstrap = spawnSync(path.resolve('tools/omarchy/bootstrap-wowsync-dev-deploy.sh'), ['a'.repeat(40)], { encoding: 'utf8' });
  assert.equal(bootstrap.status, 77);
  assert.match(bootstrap.stderr, /Run as administrator/);
  const migration = spawnSync(path.resolve('tools/omarchy/migrate-wowsync-dev-runtime-paths.sh'), ['apply'], { encoding: 'utf8' });
  assert.equal(migration.status, 77);
  assert.match(migration.stderr, /requires root/);
});

test('pinned privileged artifact hashes and sudoers syntax validate', () => {
  const hashes = spawnSync('/usr/bin/sha256sum', ['--check', '--strict', 'ops/privileged-artifact-sha256.txt'], { encoding: 'utf8' });
  assert.equal(hashes.status, 0, hashes.stdout + hashes.stderr);
  const sudoers = spawnSync('/usr/sbin/visudo', ['-cf', 'ops/sudoers/wowsync-dev-deploy'], { encoding: 'utf8' });
  assert.equal(sudoers.status, 0, sudoers.stdout + sudoers.stderr);
});

test('audit records always carry schema version and are append-only JSONL', async (t) => {
  const root = await tempDir(t);
  const audit = path.join(root, 'var', 'deployments.jsonl');
  await appendAudit({ operation: 'PREPARE_FAILURE', requestedSha: 'a'.repeat(40) }, { audit });
  const record = JSON.parse((await readFile(audit, 'utf8')).trim());
  assert.equal(record.schemaVersion, 2);
  assert.equal(record.operation, 'PREPARE_FAILURE');
});

test('journal warning collection failure is diagnostic data, not a deployment failure', async () => {
  const diagnostic = await collectJournalWarnings('2026-10-04T00:00:00Z', {}, async () => { throw new Error('journal unavailable'); });
  assert.deepEqual(diagnostic, { ok: false, error: 'journal unavailable' });
});

async function migrationFixture(root) {
  const source = path.join(root, 'src', 'WoWSync-Dashboard');
  const releases = path.join(root, 'releases');
  const release = path.join(releases, '81f66eeb8a035acf3c633f6fa9d8693cc4f9a009');
  const unitDir = path.join(root, 'etc/systemd/system');
  const bin = path.join(root, 'bin');
  await mkdir(source, { recursive: true });
  await mkdir(release, { recursive: true });
  await mkdir(unitDir, { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(release, 'release.json'), '{"sha": "81f66eeb8a035acf3c633f6fa9d8693cc4f9a009"}\n');
  await symlink(release, path.join(releases, 'current'));
  const dashboard = '[Service]\nWorkingDirectory=' + source + '\nExecStart=/usr/bin/node packages/server/src/index.ts\n';
  const mcp = '[Service]\nWorkingDirectory=' + source + '\nEnvironment=WOWSYNC_MCP_RESEARCH_ROOT=' + source + '/docs\nExecStart=/test/tunnel --mcp.command=/usr/bin/node ' + source + '/packages/mcp/src/index.ts\n';
  const dashPath = path.join(unitDir, 'wowsync-dev-dashboard.service');
  const mcpPath = path.join(unitDir, 'wowsync-dev-mcp-tunnel.service');
  await writeFile(dashPath, dashboard);
  await writeFile(mcpPath, mcp);
  const log = path.join(root, 'commands.log');
  await writeFile(path.join(bin, 'systemd-analyze'), '#!/usr/bin/bash\nexit 0\n', { mode: 0o755 });
  await writeFile(path.join(bin, 'systemctl'), `#!/usr/bin/bash\nprintf '%s\\n' "$*" >> '${log}'\nexit 0\n`, { mode: 0o755 });
  await writeFile(path.join(bin, 'curl'), '#!/usr/bin/bash\nexit 0\n', { mode: 0o755 });
  return { source, releases, release, unitDir, dashPath, mcpPath, dashboard, mcp, log };
}

test('unit migration validates both proposals before replacement and leaves originals on preflight failure', async (t) => {
  const root = await tempDir(t);
  const f = await migrationFixture(root);
  await writeFile(f.mcpPath, '[Service]\nWorkingDirectory=/unexpected\n');
  const badMcp = await readFile(f.mcpPath, 'utf8');
  const result = spawnSync(path.resolve('tools/omarchy/migrate-wowsync-dev-runtime-paths.sh'), ['apply'], {
    encoding: 'utf8', env: { ...process.env, WOWSYNC_MIGRATION_TEST_ROOT: root },
  });
  assert.notEqual(result.status, 0);
  assert.equal(await readFile(f.dashPath, 'utf8'), f.dashboard);
  assert.equal(await readFile(f.mcpPath, 'utf8'), badMcp);
  assert.equal((await readFile(f.log, 'utf8').catch(() => '')).includes('daemon-reload'), false);
});

test('unit migration restores both original files after a simulated mid-replacement failure', async (t) => {
  const root = await tempDir(t);
  const f = await migrationFixture(root);
  await writeFile(path.join(root, 'fail-replace-once'), 'fail');
  const result = spawnSync(path.resolve('tools/omarchy/migrate-wowsync-dev-runtime-paths.sh'), ['apply'], {
    encoding: 'utf8', env: { ...process.env, WOWSYNC_MIGRATION_TEST_ROOT: root },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /originals restored/);
  assert.equal(await readFile(f.dashPath, 'utf8'), f.dashboard);
  assert.equal(await readFile(f.mcpPath, 'utf8'), f.mcp);
  assert.match(await readFile(f.log, 'utf8'), /daemon-reload/);
  assert.doesNotMatch(await readFile(f.log, 'utf8'), / start /);
});
