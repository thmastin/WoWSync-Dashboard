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
  assertTargetActive,
  appendAudit,
  assertServiceStateHealthy,
  assertFreshReleaseServices,
  assertReleaseUnitInvocation,
  makeConsistentBackup,
  parseRoute,
  parseSystemdInvocationId,
  parseSystemdReleaseUnitState,
  parseSystemdServiceState,
  parseSystemdTargetState,
  prepareRelease,
  recoveryPolicy,
  recoverFailedPromotion,
  startCandidateConservatively,
  stopCandidateThenInspectSchema,
  resolveExactCommit,
  validateRemoteRef,
  validateSha,
  validateStartedRelease,
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

test('recovery policy allows old code only with unchanged schema', () => {
  assert.deepEqual(recoveryPolicy({ schemaChanged: false }), {
    action: 'restore-previous-release-and-validate', mayStartPreviousCode: true,
  });
  assert.equal(recoveryPolicy({ schemaChanged: null, candidateStarted: true }).mayStartPreviousCode, false);
  assert.equal(recoveryPolicy({ schemaChanged: true }).mayStartPreviousCode, false);
  assert.equal(recoveryPolicy({ schemaChanged: false }).mayStartPreviousCode, true);
});

test('promotion recovery runs prior code only after unchanged-schema validation', async () => {
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
  const unknown = await recoverFailedPromotion({ ...callbacks, schemaChanged: null, candidateStarted: true });
  assert.equal(unknown.state, 'stopped-review-required');
  assert.deepEqual(events, ['stop']);
});

test('a rejected candidate start is conservatively treated as possibly running', async () => {
  let candidateStarted = false;
  await assert.rejects(startCandidateConservatively(async () => {
    // Simulate systemd starting the process and then returning an error.
    throw new Error('helper lost its response after launch');
  }, () => { candidateStarted = true; }), /after launch/);
  assert.equal(candidateStarted, true);
  const events = [];
  const recovery = await recoverFailedPromotion({
    candidateStarted,
    schemaChanged: null,
    stop: async () => events.push('stop'),
    setPrevious: async () => events.push('set-previous'),
    startPrevious: async () => events.push('start-previous'),
    validatePrevious: async () => events.push('validate'),
  });
  assert.equal(recovery.state, 'stopped-review-required');
  assert.deepEqual(events, ['stop']);
});

test('candidate stop precedes schema inspection and stop/read failures leave compatibility unknown', async () => {
  const events = [];
  const inspected = await stopCandidateThenInspectSchema({
    candidateMayHaveRun: true,
    stop: async () => { events.push('stop'); },
    inspectSchema: async () => { events.push('schema'); return false; },
  });
  assert.deepEqual(events, ['stop', 'schema']);
  assert.deepEqual(inspected, { stopResult: 'succeeded', schemaChanged: false });
  const stopFailed = await stopCandidateThenInspectSchema({
    candidateMayHaveRun: true,
    stop: async () => { throw new Error('stop failed'); },
    inspectSchema: async () => { events.push('must-not-read'); return false; },
  });
  assert.deepEqual(stopFailed, { stopResult: 'failed: stop failed', schemaChanged: null });
  const readFailed = await stopCandidateThenInspectSchema({
    candidateMayHaveRun: true,
    stop: async () => {},
    inspectSchema: async () => { throw new Error('database unreadable'); },
  });
  assert.deepEqual(readFailed, { stopResult: 'succeeded', schemaChanged: null });
  events.length = 0;
  const review = await recoverFailedPromotion({
    schemaChanged: null,
    candidateStarted: true,
    priorStopResult: stopFailed.stopResult,
    stop: async () => events.push('retry-stop'),
    setPrevious: async () => events.push('set-previous'),
    startPrevious: async () => events.push('start-previous'),
    validatePrevious: async () => {},
  });
  assert.equal(review.stopResult, 'failed: stop failed');
  assert.deepEqual(events, [], 'failed stop is preserved without attempting old-code startup');
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

test('systemd service properties parse by key across order permutations and reject malformed health data', () => {
  const first = parseSystemdServiceState('ActiveState=active\nSubState=running\nMainPID=66648\nResult=success\nNRestarts=0\n');
  const second = parseSystemdServiceState('NRestarts=0\nResult=success\nMainPID=66648\nSubState=running\nActiveState=active\n');
  const expected = { ActiveState: 'active', SubState: 'running', MainPID: 66648, NRestarts: 0, Result: 'success' };
  assert.deepEqual(first, expected);
  assert.deepEqual(second, expected);
  assert.deepEqual(assertServiceStateHealthy('fixture.service', first), expected);
  assert.throws(() => parseSystemdServiceState('ActiveState=active\nSubState=running\nMainPID=\nResult=success\nNRestarts=0'), /Missing or empty.*MainPID/);
  assert.throws(() => parseSystemdServiceState('ActiveState=active\nSubState=running\nMainPID=not-a-pid\nResult=success\nNRestarts=0'), /Invalid numeric.*MainPID/);
  assert.throws(() => assertServiceStateHealthy('fixture.service', { ...expected, Result: '0' }), /not healthy/);
});

test('systemd target health uses only its named ActiveState and SubState properties', () => {
  const healthy = parseSystemdTargetState('ActiveState=active\nSubState=active\n');
  assert.deepEqual(healthy, { ActiveState: 'active', SubState: 'active' });
  assert.deepEqual(assertTargetActive(healthy), healthy);
  assert.throws(() => assertTargetActive(parseSystemdTargetState('SubState=dead\nActiveState=inactive\n')), /not active/);
  assert.throws(() => parseSystemdTargetState('SubState=active\n'), /Missing or empty.*ActiveState/);
});

const DASHBOARD = 'wowsync-dev-dashboard.service';
const MCP = 'wowsync-dev-mcp-tunnel.service';
const OLD_INVOCATIONS = { [DASHBOARD]: ['6a3e8aa522144508a0b34044d840b26d'], [MCP]: ['34554b2295dc4b17abaaa176578ade2f'] };
const NEW_INVOCATIONS = { [DASHBOARD]: 'aa11bb22cc33dd44ee55ff6600778899', [MCP]: '0123456789abcdef0123456789abcdef' };

function releaseUnitShow(unit, current, overrides = {}) {
  const entry = unit === DASHBOARD
    ? `/usr/bin/node ${current}/packages/server/src/index.ts`
    : `/opt/wowsync/dev-tools/tunnel-client/v0.0.15/tunnel-client run --control-plane.api-key=file:/run/credentials/${unit}/tunnel-api-key --mcp.command=/usr/bin/node ${current}/packages/mcp/src/index.ts`;
  const { InvocationID = NEW_INVOCATIONS[unit], NeedDaemonReload = 'no', WorkingDirectory = current, argv = entry } = overrides;
  return `NeedDaemonReload=${NeedDaemonReload}\nInvocationID=${InvocationID}\nExecStart={ path=${argv.split(' ')[0]} ; argv[]=${argv} ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=446694 ; code=(null) ; status=0/0 }\nWorkingDirectory=${WorkingDirectory}\n`;
}

async function releaseFixture(t) {
  const root = await tempDir(t);
  const releases = path.join(root, 'releases');
  const sha = '81f66eeb8a035acf3c633f6fa9d8693cc4f9a009';
  const other = '2'.repeat(40);
  await mkdir(path.join(releases, sha), { recursive: true });
  await mkdir(path.join(releases, other), { recursive: true });
  await atomicSetCurrent(releases, sha);
  const paths = { releases, current: path.join(releases, 'current') };
  const realpathCalls = [];
  // Simulates the real host: a just-started hardened unit's /proc entry is unreadable.
  const realpathFn = async (target) => {
    realpathCalls.push(target);
    if (target.startsWith('/proc/')) throw Object.assign(new Error(`EACCES: permission denied, realpath '${target}'`), { code: 'EACCES' });
    return realpath(target);
  };
  const unitOverrides = {};
  const options = {
    paths,
    realpathFn,
    readServiceState: async (unit) => ({ ActiveState: 'active', SubState: 'running', MainPID: unit === DASHBOARD ? 446694 : 446695, NRestarts: 0, Result: 'success' }),
    readReleaseUnitState: async (unit) => parseSystemdReleaseUnitState(releaseUnitShow(unit, paths.current, unitOverrides[unit])),
    readTargetState: async () => ({ ActiveState: 'active', SubState: 'active' }),
  };
  return { releases, sha, other, paths, options, realpathCalls, unitOverrides };
}

test('post-start release validation never inspects /proc and succeeds when /proc would return EACCES', async (t) => {
  const f = await releaseFixture(t);
  const result = await assertFreshReleaseServices(f.sha, OLD_INVOCATIONS, f.options);
  assert.equal(result.units[DASHBOARD].InvocationID, NEW_INVOCATIONS[DASHBOARD]);
  assert.equal(result.units[MCP].MainPID, 446695);
  assert.deepEqual(f.realpathCalls.filter((target) => target.startsWith('/proc/')), []);
  for (const fn of [assertFreshReleaseServices, validateStartedRelease, assertReleaseUnitInvocation]) {
    assert.doesNotMatch(fn.toString(), /\/proc\//, `${fn.name} must not inspect /proc`);
  }
});

test('post-start release validation rejects wrong topology, stale configuration, and reused invocations', async (t) => {
  const f = await releaseFixture(t);
  f.unitOverrides[DASHBOARD] = { WorkingDirectory: '/home/wowsync-dev/src/WoWSync-Dashboard' };
  await assert.rejects(assertFreshReleaseServices(f.sha, OLD_INVOCATIONS, f.options), /WorkingDirectory is \/home\/wowsync-dev\/src/);
  f.unitOverrides[DASHBOARD] = { argv: '/usr/bin/node packages/server/src/index.ts' };
  await assert.rejects(assertFreshReleaseServices(f.sha, OLD_INVOCATIONS, f.options), /ExecStart does not execute/);
  delete f.unitOverrides[DASHBOARD];
  f.unitOverrides[MCP] = { argv: '/opt/tunnel-client run --mcp.command=/usr/bin/node /home/wowsync-dev/src/WoWSync-Dashboard/packages/mcp/src/index.ts' };
  await assert.rejects(assertFreshReleaseServices(f.sha, OLD_INVOCATIONS, f.options), /mcp-tunnel.service ExecStart does not execute/);
  f.unitOverrides[MCP] = { NeedDaemonReload: 'yes' };
  await assert.rejects(assertFreshReleaseServices(f.sha, OLD_INVOCATIONS, f.options), /NeedDaemonReload=yes/);
  f.unitOverrides[MCP] = { InvocationID: OLD_INVOCATIONS[MCP][0] };
  await assert.rejects(assertFreshReleaseServices(f.sha, OLD_INVOCATIONS, f.options), /not a new invocation/);
  delete f.unitOverrides[MCP];
  await assert.rejects(assertFreshReleaseServices(f.sha, { [DASHBOARD]: OLD_INVOCATIONS[DASHBOARD] }, f.options), /no recorded pre-stop InvocationID/);
  await assert.doesNotReject(assertFreshReleaseServices(f.sha, OLD_INVOCATIONS, f.options));
});

test('post-start release validation rejects releases/current resolving to another SHA', async (t) => {
  const f = await releaseFixture(t);
  await atomicSetCurrent(f.releases, f.other);
  await assert.rejects(assertFreshReleaseServices(f.sha, OLD_INVOCATIONS, f.options), /resolves to .*2{40}, expected release 81f66ee/);
});

test('releases/current is re-checked after readiness and invocations must survive readiness', async (t) => {
  const f = await releaseFixture(t);
  const events = [];
  const result = await validateStartedRelease(f.sha, OLD_INVOCATIONS, { ...f.options, awaitReadiness: async () => events.push('ready') });
  assert.deepEqual(events, ['ready']);
  assert.equal(result.afterReadiness.units[DASHBOARD].InvocationID, NEW_INVOCATIONS[DASHBOARD]);
  await assert.rejects(validateStartedRelease(f.sha, OLD_INVOCATIONS, {
    ...f.options, awaitReadiness: async () => { await atomicSetCurrent(f.releases, f.other); },
  }), /resolves to .*2{40}, expected release 81f66ee/);
  await atomicSetCurrent(f.releases, f.sha);
  await assert.rejects(validateStartedRelease(f.sha, OLD_INVOCATIONS, {
    ...f.options, awaitReadiness: async () => { f.unitOverrides[DASHBOARD] = { InvocationID: 'ffffffffffffffffffffffffffffffff' }; },
  }), /invocation changed during readiness/);
});

test('systemd release-unit properties parse by key and reject malformed invocation data', () => {
  const current = '/home/wowsync-dev/releases/current';
  const text = releaseUnitShow(DASHBOARD, current);
  const reordered = text.trim().split('\n').reverse().join('\n');
  assert.deepEqual(parseSystemdReleaseUnitState(reordered), parseSystemdReleaseUnitState(text));
  assert.equal(parseSystemdInvocationId('InvocationID=6a3e8aa522144508a0b34044d840b26d\n'), '6a3e8aa522144508a0b34044d840b26d');
  assert.throws(() => parseSystemdInvocationId('InvocationID=\n'), /Missing or empty.*InvocationID/);
  assert.throws(() => parseSystemdInvocationId('InvocationID=not-an-id\n'), /Invalid.*InvocationID/);
  assert.throws(() => parseSystemdInvocationId('InvocationID=6a3e8aa522144508a0b34044d840b26d\nInvocationID=6a3e8aa522144508a0b34044d840b26d\n'), /Duplicate/);
  assert.throws(() => parseSystemdReleaseUnitState(text.replace(/^WorkingDirectory=.*$/m, '')), /Missing or empty.*WorkingDirectory/);
  assert.throws(() => parseSystemdReleaseUnitState(text.replace('NeedDaemonReload=no', 'NeedDaemonReload=maybe')), /Invalid.*NeedDaemonReload/);
  assert.throws(() => parseSystemdReleaseUnitState(`${text}garbage\n`), /Malformed/);
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

test('sudoers grants only the helper as root and only the deploy launcher as wowsync-dev', () => {
  const rules = spawnSync('/usr/bin/grep', ['-v', '^#', path.resolve('ops/sudoers/wowsync-dev-deploy')], { encoding: 'utf8' })
    .stdout.split('\n').filter((line) => line.trim());
  assert.deepEqual(rules, [
    'wowsync-dev ALL=(root) NOPASSWD: /usr/local/sbin/wowsync-dev-app-services',
    'thmastin ALL=(wowsync-dev) NOPASSWD: /usr/local/bin/wowsync-dev-deploy',
  ]);
  const syntax = spawnSync('/usr/sbin/visudo', ['-cf', 'ops/sudoers/wowsync-dev-deploy'], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stdout + syntax.stderr);
});

test('installer refuses unprivileged execution before touching host paths', () => {
  const result = spawnSync(path.resolve('tools/omarchy/install-wowsync-dev-deploy.sh'), [], { encoding: 'utf8' });
  assert.equal(result.status, 77);
  assert.match(result.stderr, /Run as administrator/);
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
