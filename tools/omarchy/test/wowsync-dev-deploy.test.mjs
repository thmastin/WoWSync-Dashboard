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
  makeConsistentBackup,
  parseRoute,
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

async function restoreMigrationFixture(root, alwaysFailHttp = false) {
  const f = await migrationFixture(root);
  const state = path.join(root, 'etc/wowsync/dev/runtime-path-migration');
  const backup = path.join(state, '20261004T000000Z-123');
  await mkdir(backup, { recursive: true });
  await writeFile(path.join(backup, 'wowsync-dev-dashboard.service'), f.dashboard);
  await writeFile(path.join(backup, 'wowsync-dev-mcp-tunnel.service'), f.mcp);
  await symlink(backup, path.join(state, 'current'));
  await writeFile(f.dashPath, f.dashboard.replaceAll(f.source, path.join(f.releases, 'current')));
  await writeFile(f.mcpPath, f.mcp.replaceAll(f.source, path.join(f.releases, 'current')));
  await writeFile(path.join(root, 'http-always-fails'), alwaysFailHttp ? 'yes' : 'no');
  await writeFile(path.join(root, 'http-count'), '0');
  await writeFile(path.join(root, 'bin/systemctl'), `#!/usr/bin/bash
printf '%s\\n' "$*" >> '${f.log}'
case "$1" in
  daemon-reload) exit 0 ;;
  --job-mode=ignore-dependencies)
    [[ "$2" == restart ]] || exit 9
    shift 2
    for unit in "$@"; do
      key=\${unit#wowsync-dev-}; key=\${key%.service}
      (cd '${f.source}' && exec /usr/bin/sleep 60) >/dev/null 2>&1 &
      echo $! > '${root}/pid-'"$key"
    done
    exit 0 ;;
  show)
    property=$3; unit=$5; key=\${unit#wowsync-dev-}; key=\${key%.service}
    pid=$(cat '${root}/pid-'"$key")
    case "$property" in
      ActiveState) printf 'active\\n' ;;
      Result) printf 'success\\n' ;;
      MainPID) printf '%s\\n' "$pid" ;;
      *) exit 7 ;;
    esac
    exit 0 ;;
esac
exit 8
`, { mode: 0o755 });
  await writeFile(path.join(root, 'bin/curl'), `#!/usr/bin/bash
url=\${!#}
count=$(cat '${root}/http-count'); count=$((count + 1)); echo "$count" > '${root}/http-count'
if [[ "$(cat '${root}/http-always-fails')" == yes || ( "$count" -eq 1 && "$url" == */ ) ]]; then code=503; else code=200; fi
printf '%s' "$code"
exit 0
`, { mode: 0o755 });
  await writeFile(path.join(root, 'bin/sleep'), '#!/usr/bin/bash\nexec /usr/bin/sleep "$1"\n', { mode: 0o755 });
  const stopWorkers = async () => {
    for (const key of ['dashboard', 'mcp-tunnel']) {
      const pid = await readFile(path.join(root, `pid-${key}`), 'utf8').catch(() => '');
      if (/^\d+\n?$/.test(pid)) spawnSync('/usr/bin/kill', ['-TERM', pid.trim()]);
    }
  };
  return { ...f, state, backup, stopWorkers };
}

test('topology restore retries refused HTTP, settles, and validates both source-checkout units', async (t) => {
  const root = await tempDir(t);
  const f = await restoreMigrationFixture(root);
  t.after(f.stopWorkers);
  const result = spawnSync(path.resolve('tools/omarchy/migrate-wowsync-dev-runtime-paths.sh'), ['restore', 'CURRENT'], {
    encoding: 'utf8', env: { ...process.env, WOWSYNC_MIGRATION_TEST_ROOT: root, WOWSYNC_MIGRATION_TEST_TIMEOUT_MS: '1000', WOWSYNC_MIGRATION_TEST_INTERVAL_MS: '20', WOWSYNC_MIGRATION_TEST_SETTLE_MS: '60' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /HTTP stable/);
  assert.equal(await readFile(f.dashPath, 'utf8'), f.dashboard);
  assert.equal(await readFile(f.mcpPath, 'utf8'), f.mcp);
  const commands = await readFile(f.log, 'utf8');
  assert.match(commands, /restart wowsync-dev-dashboard\.service wowsync-dev-mcp-tunnel\.service/);
  assert.match(commands, /show -p ActiveState --value wowsync-dev-dashboard\.service/);
  assert.match(commands, /show -p Result --value wowsync-dev-dashboard\.service/);
  assert.match(commands, /show -p MainPID --value wowsync-dev-dashboard\.service/);
  assert.ok(Number(await readFile(path.join(root, 'http-count'), 'utf8')) > 4, 'first refusal was retried and both routes were reprobed during settle');
  assert.match(commands, /daemon-reload/);
});

test('topology restore readiness timeout is bounded and diagnostic', async (t) => {
  const root = await tempDir(t);
  const f = await restoreMigrationFixture(root, true);
  t.after(f.stopWorkers);
  const result = spawnSync(path.resolve('tools/omarchy/migrate-wowsync-dev-runtime-paths.sh'), ['restore', 'CURRENT'], {
    encoding: 'utf8', env: { ...process.env, WOWSYNC_MIGRATION_TEST_ROOT: root, WOWSYNC_MIGRATION_TEST_TIMEOUT_MS: '100', WOWSYNC_MIGRATION_TEST_INTERVAL_MS: '10', WOWSYNC_MIGRATION_TEST_SETTLE_MS: '20' },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /readiness timed out after 100ms/);
  assert.match(result.stderr, /HTTP 503/);
  assert.ok(Number(await readFile(path.join(root, 'http-count'), 'utf8')) < 50, 'timeout prevents unbounded polling');
});

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
