// End-to-end tests of the routine `deploy` workflow against real Git remotes,
// real immutable releases, and real SQLite files, with systemd/sudo/HTTP
// replaced by a simulated DEV host.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import * as deployTool from '../wowsync-dev-deploy.mjs';

const {
  atomicSetCurrent, currentSha, deploy, formatResult, parseArgs, parseSystemdReleaseUnitState,
  prepareRelease, runCli, runUnderDeployLock, status,
} = deployTool;

const DASHBOARD = 'wowsync-dev-dashboard.service';
const MCP = 'wowsync-dev-mcp-tunnel.service';
const HERDR = 'wowsync-dev-herdr.service';
const TOOL = path.resolve('tools/omarchy/wowsync-dev-deploy.mjs');
const LAUNCHER = path.resolve('tools/omarchy/wowsync-dev-deploy');

async function tempDir(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wowsync-deploy-flow-'));
  t.after(async () => {
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

function rows(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try { return db.prepare('SELECT name FROM observations ORDER BY id').all().map((row) => row.name); }
  finally { db.close(); }
}

// A simulated DEV host: Dashboard/MCP start and stop through the "helper",
// each start yields fresh InvocationIDs, HTTP answers from whichever release
// releases/current resolves to, and Herdr has a PID the helper never touches.
function simulatedHost(paths, faults, validateBuild) {
  let counter = 0;
  const newId = () => (++counter).toString(16).padStart(32, '0');
  const units = { [DASHBOARD]: { active: true, id: newId(), pid: 100 }, [MCP]: { active: true, id: newId(), pid: 101 } };
  const herdr = { pid: 500 };
  const calls = [];
  let starts = 0;
  const runningSha = async () => path.basename(await realpath(paths.current));
  const write = (sql) => { const db = new DatabaseSync(paths.database); try { db.exec(sql); } finally { db.close(); } };
  const ops = {
    serviceHelper: async (operation) => {
      calls.push(operation);
      if (operation === 'stop') { for (const unit of Object.values(units)) unit.active = false; return; }
      if (operation !== 'start') throw new Error(`unexpected helper operation ${operation}`);
      starts += 1;
      if (faults.startFailsOn?.includes(starts)) throw new Error(`injected start failure #${starts}`);
      for (const unit of Object.values(units)) { unit.active = true; unit.id = newId(); unit.pid += 10; }
      const sha = await runningSha();
      if (faults.candidateWritesOn === sha) write("INSERT INTO observations(name) VALUES ('written-by-candidate');");
      if (faults.schemaChangeOn === sha) write('CREATE INDEX observations_name ON observations(name);');
      if (faults.herdrRestartsOn === sha) herdr.pid += 1;
    },
    journalWarnings: async () => '-- No entries --',
    serviceState: async (unit) => {
      if (unit === HERDR) return { ActiveState: 'active', SubState: 'running', MainPID: herdr.pid, NRestarts: 0, Result: 'success' };
      const state = units[unit];
      return state.active
        ? { ActiveState: 'active', SubState: 'running', MainPID: state.pid, NRestarts: 0, Result: 'success' }
        : { ActiveState: 'inactive', SubState: 'dead', MainPID: 0, NRestarts: 0, Result: 'success' };
    },
    targetState: async () => ({ ActiveState: 'active', SubState: 'active' }),
    releaseUnitState: async (unit) => {
      const entry = unit === DASHBOARD ? 'packages/server/src/index.ts' : 'packages/mcp/src/index.ts';
      return parseSystemdReleaseUnitState(`InvocationID=${units[unit].id}\nNeedDaemonReload=no\nWorkingDirectory=${paths.current}\nExecStart={ path=/usr/bin/node ; argv[]=/usr/bin/node ${paths.current}/${entry} ; ignore_errors=no }\n`);
    },
    invocationId: async (unit) => units[unit].id,
    unitConfig: async (unit) => ({
      WorkingDirectory: paths.current,
      ExecStart: `{ path=/usr/bin/node ; argv[]=/usr/bin/node ${paths.current}/packages/${unit === DASHBOARD ? 'server' : 'mcp'}/src/index.ts ; }`,
    }),
    processCwd: async () => realpath(paths.current),
    fetch: async (url) => {
      if (!units[DASHBOARD].active) throw new Error('connection refused');
      if (faults.unhealthySha && (await runningSha()) === faults.unhealthySha) return { status: 500 };
      return { status: 200 };
    },
    validateBuild,
    readiness: { timeoutMs: 150, intervalMs: 2, settleMs: 0 },
  };
  return { ops, calls, units, herdr };
}

// Remote with release A (deployed, current) on refs/heads/fixture and a newer
// validated commit B on refs/heads/feature.
async function deployFixture(t) {
  const root = await tempDir(t);
  const source = path.join(root, 'source');
  const bare = path.join(root, 'origin.git');
  await mkdir(path.join(source, 'packages', 'web'), { recursive: true });
  git(source, ['init', '-q', '-b', 'fixture']);
  git(source, ['config', 'user.name', 'Deployment Test']);
  git(source, ['config', 'user.email', 'deployment-test@example.invalid']);
  await writeFile(path.join(source, 'package.json'), '{"name":"deployment-fixture","version":"1.0.0"}\n');
  await writeFile(path.join(source, 'packages', 'web', 'index.html'), '<main>A</main>\n');
  git(source, ['add', '.']);
  git(source, ['commit', '-qm', 'release A']);
  const shaA = git(source, ['rev-parse', 'HEAD']);
  git(root, ['init', '-q', '--bare', bare]);
  git(source, ['remote', 'add', 'origin', bare]);
  git(source, ['push', '-q', 'origin', 'HEAD:refs/heads/fixture']);
  await writeFile(path.join(source, 'packages', 'web', 'index.html'), '<main>B</main>\n');
  git(source, ['commit', '-qam', 'feature B']);
  const shaB = git(source, ['rev-parse', 'HEAD']);
  git(source, ['push', '-q', 'origin', 'HEAD:refs/heads/feature']);
  const paths = {
    source,
    deploy: path.join(root, 'deploy'),
    cache: path.join(root, 'deploy', 'cache.git'),
    staging: path.join(root, 'deploy', 'staging'),
    releases: path.join(root, 'releases'),
    current: path.join(root, 'releases', 'current'),
    database: path.join(root, 'db', 'wowsync.sqlite'),
    backups: path.join(root, 'backups'),
    audit: path.join(root, 'deployments.jsonl'),
    serviceHelper: path.join(root, 'no-such-helper'),
    baseUrl: 'http://dev.fixture/',
  };
  await mkdir(path.dirname(paths.database));
  const db = new DatabaseSync(paths.database);
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE observations(id INTEGER PRIMARY KEY, name TEXT); INSERT INTO observations(name) VALUES ('before-deploy');");
  db.close();
  const faults = {};
  const builds = [];
  const validateBuild = async (stage) => {
    builds.push(stage);
    if (faults.buildFails) throw new Error('injected test-suite failure');
    await mkdir(path.join(stage, 'node_modules'), { recursive: true });
  };
  await prepareRelease(shaA, 'refs/heads/fixture', paths, validateBuild);
  await atomicSetCurrent(paths.releases, shaA);
  builds.length = 0;
  const host = simulatedHost(paths, faults, validateBuild);
  const audit = async () => (await readFile(paths.audit, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  return { root, paths, shaA, shaB, faults, builds, host, ops: host.ops, audit };
}

async function failure(promise) {
  try { await promise; } catch (error) {
    assert.ok(error instanceof deployTool.DeployError, `expected DeployError, got ${error.stack}`);
    return error.outcome;
  }
  assert.fail('expected the deployment to fail');
}

test('normal deploy moves DEV from release A to validated SHA B with backup and fresh services', async (t) => {
  const f = await deployFixture(t);
  const result = await deploy({ ref: 'feature', expectedSha: f.shaB }, { paths: f.paths, ops: f.ops });
  assert.equal(result.state, 'DEPLOYED');
  assert.equal(await currentSha(f.paths.releases), f.shaB);
  assert.deepEqual(f.host.calls, ['stop', 'start']);
  const record = result.record;
  assert.equal(record.previousSha, f.shaA);
  assert.equal(record.deployedSha, f.shaB);
  assert.equal(record.requestedRef, 'refs/heads/feature');
  assert.equal(record.schemaChanged, false);
  assert.equal(record.backup.integrityCheck, 'ok');
  assert.deepEqual(rows(record.backup.path), ['before-deploy']);
  assert.equal(record.herdr.before.MainPID, record.herdr.after.MainPID, 'Herdr untouched');
  const operations = (await f.audit()).map((item) => item.operation);
  assert.deepEqual(operations, ['PREPARE_SUCCESS', 'PROMOTE_INTENT', 'PROMOTE_SUCCESS']);
});

test('a ref that no longer points at the validated SHA fails before any DEV mutation', async (t) => {
  const f = await deployFixture(t);
  const outcome = await failure(deploy({ ref: 'refs/heads/feature', expectedSha: f.shaA }, { paths: f.paths, ops: f.ops }));
  assert.equal(outcome.state, 'UNCHANGED');
  assert.equal(outcome.runningSha, f.shaA);
  assert.equal(outcome.manualIntervention, false);
  assert.match(outcome.cause, /points to .* not the validated SHA/);
  assert.deepEqual(f.host.calls, []);
  assert.equal(await currentSha(f.paths.releases), f.shaA);
  await assert.rejects(lstat(path.join(f.paths.releases, f.shaB)), { code: 'ENOENT' });
  assert.equal(f.builds.length, 0);
});

test('deploying the already-deployed SHA is a clean no-op', async (t) => {
  const f = await deployFixture(t);
  const result = await deploy({ ref: 'fixture', expectedSha: f.shaA.slice(0, 12) }, { paths: f.paths, ops: f.ops });
  assert.equal(result.state, 'NOOP');
  assert.deepEqual(f.host.calls, []);
  await assert.rejects(readdir(f.paths.backups), { code: 'ENOENT' });
  assert.match(formatResult(result), new RegExp(`^DEV ALREADY AT ${f.shaA}\n`));
});

test('an unprepared release is built automatically; a prepared one is reused without rebuilding', async (t) => {
  const f = await deployFixture(t);
  const built = await deploy({ ref: 'feature', expectedSha: f.shaB }, { paths: f.paths, ops: f.ops });
  assert.equal(built.record.release, 'built');
  assert.equal(f.builds.length, 1);
  assert.equal((await lstat(path.join(f.paths.releases, f.shaB, 'release.json'))).mode & 0o222, 0, 'release is read-only');

  const g = await deployFixture(t);
  await prepareRelease(g.shaB, 'refs/heads/feature', g.paths, async (stage) => { await mkdir(path.join(stage, 'node_modules')); });
  const reused = await deploy({ ref: 'feature', expectedSha: g.shaB }, { paths: g.paths, ops: g.ops });
  assert.equal(reused.record.release, 'reused');
  assert.equal(g.builds.length, 0);
  assert.equal(await currentSha(g.paths.releases), g.shaB);
});

test('prepare builds a release without touching DEV', async (t) => {
  const f = await deployFixture(t);
  const result = await deployTool.prepare({ ref: 'feature', expectedSha: f.shaB }, { paths: f.paths, ops: f.ops });
  assert.equal(result.state, 'PREPARED');
  assert.equal(result.release, 'built');
  assert.deepEqual(f.host.calls, []);
  assert.equal(await currentSha(f.paths.releases), f.shaA);
  assert.match(formatResult(result), /^RELEASE PREPARED — DEV UNTOUCHED\n/);
  assert.equal((await deployTool.prepare({ ref: 'feature', expectedSha: f.shaB }, { paths: f.paths, ops: f.ops })).release, 'reused');
  assert.equal(f.builds.length, 1);
});

test('a build/test failure in staging leaves DEV untouched', async (t) => {
  const f = await deployFixture(t);
  f.faults.buildFails = true;
  const outcome = await failure(deploy({ ref: 'feature', expectedSha: f.shaB }, { paths: f.paths, ops: f.ops }));
  assert.equal(outcome.state, 'UNCHANGED');
  assert.match(outcome.cause, /Release build\/validation failed: injected test-suite failure/);
  assert.deepEqual(f.host.calls, []);
  assert.equal(await currentSha(f.paths.releases), f.shaA);
  await assert.rejects(lstat(path.join(f.paths.releases, f.shaB)), { code: 'ENOENT' });
  assert.deepEqual(await readdir(f.paths.staging), []);
  assert.ok((await f.audit()).some((item) => item.operation === 'PREPARE_FAILURE'));
});

test('an unhealthy candidate is rolled back to the previous release, and the database is not restored', async (t) => {
  const f = await deployFixture(t);
  f.faults.unhealthySha = f.shaB;
  f.faults.candidateWritesOn = f.shaB;
  const outcome = await failure(deploy({ ref: 'feature', expectedSha: f.shaB }, { paths: f.paths, ops: f.ops }));
  assert.equal(outcome.state, 'RECOVERED');
  assert.equal(outcome.runningSha, f.shaA);
  assert.equal(outcome.devHealthy, true);
  assert.equal(outcome.manualIntervention, false);
  assert.equal(outcome.databaseRestored, false);
  assert.deepEqual(f.host.calls, ['stop', 'start', 'stop', 'start']);
  assert.equal(await currentSha(f.paths.releases), f.shaA);
  assert.deepEqual(rows(f.paths.database), ['before-deploy', 'written-by-candidate'], 'live database keeps post-backup writes');
  assert.deepEqual(rows(outcome.backupPath), ['before-deploy'], 'backup is retained for an explicit decision');
  const text = formatResult(outcome);
  assert.match(text, /^DEV DEPLOY FAILED — RECOVERED\n/);
  assert.match(text, new RegExp(`Recovered to:\\s+${f.shaA}`));
  assert.match(text, /Manual intervention:\s+NO/);
  assert.equal(deployTool.exitCodeFor(outcome), 1);
});

test('a failed recovery is reported as requiring manual intervention', async (t) => {
  const f = await deployFixture(t);
  f.faults.unhealthySha = f.shaB;
  f.faults.startFailsOn = [2];
  const outcome = await failure(deploy({ ref: 'feature', expectedSha: f.shaB }, { paths: f.paths, ops: f.ops }));
  assert.equal(outcome.state, 'RECOVERY_FAILED');
  assert.equal(outcome.manualIntervention, true);
  assert.equal(outcome.lastKnownSha, f.shaA);
  assert.match(outcome.recoveryError, /injected start failure #2/);
  const text = formatResult(outcome);
  assert.match(text, /^DEV RECOVERY FAILED\n/);
  assert.match(text, /Manual intervention:\s+REQUIRED/);
  assert.match(text, new RegExp(`Last known release:\\s+${f.shaA}`));
  assert.equal(deployTool.exitCodeFor(outcome), 2);
});

test('a schema change stops Dashboard/MCP for review instead of starting old code', async (t) => {
  const f = await deployFixture(t);
  f.faults.schemaChangeOn = f.shaB;
  const outcome = await failure(deploy({ ref: 'feature', expectedSha: f.shaB }, { paths: f.paths, ops: f.ops }));
  assert.equal(outcome.state, 'STOPPED_REVIEW_REQUIRED');
  assert.equal(outcome.manualIntervention, true);
  assert.deepEqual(f.host.calls, ['stop', 'start', 'stop'], 'previous code is never started');
  assert.match(formatResult(outcome), /Manual intervention:\s+REQUIRED/);
});

test('Herdr is outside the restart boundary: a Herdr change fails validation and recovers', async (t) => {
  const f = await deployFixture(t);
  f.faults.herdrRestartsOn = f.shaB;
  const outcome = await failure(deploy({ ref: 'feature', expectedSha: f.shaB }, { paths: f.paths, ops: f.ops }));
  assert.equal(outcome.state, 'RECOVERED');
  assert.match(outcome.cause, /Herdr changed during application deployment/);
  assert.ok(f.host.calls.every((operation) => ['stop', 'start'].includes(operation)), 'only the fixed app-unit helper operations are used');
  const helper = spawnSync(path.resolve('tools/omarchy/wowsync-dev-app-services'), ['stop', HERDR], { encoding: 'utf8' });
  assert.equal(helper.status, 64, 'helper cannot be asked to stop Herdr');
});

test('routine deploy cannot enter the retired initial-migration path', async (t) => {
  for (const argv of [
    ['promote', 'a'.repeat(40), 'refs/heads/main', '--previous-runtime-sha', 'a'.repeat(40)],
    ['seed-initial', 'a'.repeat(40), 'refs/heads/main'],
    ['deploy', 'main', 'a'.repeat(40), '--previous-runtime-sha', 'a'.repeat(40)],
  ]) assert.throws(() => parseArgs(argv), /replaced|no longer|migration/);
  for (const name of ['promote', 'seedInitial', 'verifyInitialRuntime']) assert.equal(deployTool[name], undefined);
  assert.doesNotMatch(await readFile(TOOL, 'utf8'), /initialMode|previousRuntimeSha|migrate-runtime-paths/);
  const f = await deployFixture(t);
  await rm(f.paths.current);
  const outcome = await failure(deploy({ ref: 'feature', expectedSha: f.shaB }, { paths: f.paths, ops: f.ops }));
  assert.equal(outcome.state, 'UNCHANGED');
  assert.equal(outcome.manualIntervention, true);
  assert.deepEqual(f.host.calls, []);
});

test('lock contention reports that another deployment is running', async (t) => {
  const root = await tempDir(t);
  const lock = path.join(root, 'deploy.lock');
  const holder = spawn('/usr/bin/flock', ['--close', lock, '/usr/bin/bash', '-c', 'echo held; exec sleep 10'], { stdio: ['ignore', 'pipe', 'ignore'], detached: true });
  const release = () => { try { process.kill(-holder.pid, 'SIGKILL'); } catch {} };
  t.after(release);
  await new Promise((resolve) => holder.stdout.once('data', resolve));
  assert.deepEqual(runUnderDeployLock(lock, '/usr/bin/true', [], { stdio: 'ignore' }), { locked: true, status: 75 });
  const exited = new Promise((resolve) => holder.once('exit', resolve));
  release();
  await exited;
  assert.deepEqual(runUnderDeployLock(lock, '/usr/bin/true', [], { stdio: 'ignore' }), { locked: false, status: 0 });
  const text = formatResult({ state: 'LOCKED', kind: 'PROMOTE', manualIntervention: false });
  assert.match(text, /^DEV DEPLOY NOT STARTED — another deployment is running/);
  assert.equal(deployTool.exitCodeFor({ state: 'LOCKED' }), 75);
});

test('routine CLI output is concise; --json keeps the detailed evidence', async (t) => {
  const f = await deployFixture(t);
  let output = '';
  const code = await runCli(['deploy', 'feature', f.shaB], { paths: f.paths, ops: f.ops, write: (text) => { output = text; } });
  assert.equal(code, 0);
  const lines = output.split('\n');
  assert.ok(lines.length <= 12, output);
  assert.equal(lines[0], 'DEV DEPLOYED');
  for (const expected of [`SHA:\\s+${f.shaB}`, 'Ref:\\s+refs/heads/feature', `Previous:\\s+${f.shaA}`, 'Data backup:\\s+OK', 'Schema:\\s+unchanged', 'Dashboard:\\s+healthy', 'MCP:\\s+healthy', 'Herdr:\\s+untouched']) {
    assert.match(output, new RegExp(expected));
  }
  assert.doesNotMatch(output, /InvocationID|NRestarts|\{/);

  const g = await deployFixture(t);
  const jsonCode = await runCli(['deploy', 'refs/heads/feature', g.shaB, '--json'], { paths: g.paths, ops: g.ops, write: (text) => { output = text; } });
  assert.equal(jsonCode, 0);
  const detail = JSON.parse(output);
  assert.equal(detail.state, 'DEPLOYED');
  assert.match(detail.record.backup.sha256, /^[0-9a-f]{64}$/);
  assert.match(detail.record.dataBefore.schemaSha256, /^[0-9a-f]{64}$/);
  assert.match(detail.record.services.units[DASHBOARD].InvocationID, /^[0-9a-f]{32}$/);
  assert.equal(detail.record.services.units[MCP].NRestarts, 0);
  assert.ok(detail.record.journalDiagnostics.ok);
  assert.ok(detail.record.http.length >= 2);
});

test('status reports the deployed SHA and Dashboard/MCP health without changing anything', async (t) => {
  const f = await deployFixture(t);
  const healthy = await status({ paths: f.paths, ops: f.ops });
  assert.equal(healthy.sha, f.shaA);
  assert.equal(healthy.ref, 'refs/heads/fixture');
  assert.equal(healthy.healthy, true);
  assert.deepEqual(f.host.calls, []);
  const text = formatResult(healthy);
  assert.match(text, /^DEV STATUS: HEALTHY\n/);
  assert.match(text, new RegExp(`SHA:\\s+${f.shaA}`));
  assert.match(text, /Dashboard:\s+healthy/);
  assert.match(text, /MCP:\s+healthy/);
  for (const unit of Object.values(f.host.units)) unit.active = false;
  const down = await status({ paths: f.paths, ops: f.ops });
  assert.equal(down.healthy, false);
  assert.match(formatResult(down), /^DEV STATUS: NOT HEALTHY\n[\s\S]*MCP:\s+UNHEALTHY/);
  assert.equal(deployTool.exitCodeFor(down), 1);
});

test('the deploy tool depends only on Node built-ins, so nothing resolves through another checkout', async () => {
  const source = await readFile(TOOL, 'utf8');
  const specifiers = [...source.matchAll(/^import .* from '([^']+)';$/gm)].map((match) => match[1]);
  assert.ok(specifiers.length > 0);
  assert.deepEqual(specifiers.filter((specifier) => !specifier.startsWith('node:')), []);
  assert.doesNotMatch(source, /\bimport\(|require\(/);
});

// Run a copy of the launcher with its fixed constants pointed at a fixture.
async function launcherFixture(t, overrides) {
  const root = await tempDir(t);
  const bin = path.join(root, 'bin');
  await mkdir(bin);
  let text = await readFile(LAUNCHER, 'utf8');
  for (const [name, value] of Object.entries(overrides(root))) {
    const pattern = new RegExp(`^readonly ${name}='[^']*'$`, 'm');
    assert.match(text, pattern);
    text = text.replace(pattern, `readonly ${name}='${value}'`);
  }
  const launcher = path.join(bin, 'wowsync-dev-deploy');
  await writeFile(launcher, text, { mode: 0o755 });
  return { root, bin, launcher };
}

const ECHO_TOOL = `import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
console.log(JSON.stringify({ tool: fileURLToPath(import.meta.url), argv: process.argv.slice(2), cwd: realpathSync(process.cwd()), env: Object.keys(process.env).sort(), home: process.env.HOME }));
`;

test('launcher runs the deployed release tool with literal arguments and a reset environment', async (t) => {
  const me = spawnSync('/usr/bin/id', ['-un'], { encoding: 'utf8' }).stdout.trim();
  const sha = 'b'.repeat(40);
  const f = await launcherFixture(t, (root) => ({ DEV_USER: me, DEV_HOME: path.join(root, 'home'), CURRENT_RELEASE: path.join(root, 'releases', 'current') }));
  const releaseTool = path.join(f.root, 'releases', sha, 'tools', 'omarchy', 'wowsync-dev-deploy.mjs');
  await mkdir(path.dirname(releaseTool), { recursive: true });
  await writeFile(releaseTool, ECHO_TOOL);
  await symlink(path.join(f.root, 'releases', sha), path.join(f.root, 'releases', 'current'));
  const result = spawnSync(f.launcher, ['deploy', 'feature branch', '$(touch pwned)', ';id'], {
    encoding: 'utf8', cwd: f.root, env: { ...process.env, WOWSYNC_DEPLOY_LOCK: '/tmp/bypass', NODE_OPTIONS: '--require=/nonexistent' },
  });
  assert.equal(result.status, 0, result.stderr);
  const seen = JSON.parse(result.stdout);
  assert.equal(seen.tool, await realpath(releaseTool), 'tool is pinned to the SHA release, not the current symlink');
  assert.deepEqual(seen.argv, ['deploy', 'feature branch', '$(touch pwned)', ';id']);
  assert.equal(seen.cwd, await realpath(path.join(f.root, 'home', 'deploy')));
  assert.equal(seen.home, path.join(f.root, 'home'));
  assert.deepEqual(seen.env.filter((key) => !['HOME', 'LANG', 'LOGNAME', 'PATH', 'USER'].includes(key)), []);
  await assert.rejects(lstat(path.join(f.root, 'pwned')), { code: 'ENOENT' });

  // A copy beside its own .mjs (a checkout or release tree) runs that exact tool.
  await writeFile(path.join(f.bin, 'wowsync-dev-deploy.mjs'), ECHO_TOOL);
  const local = JSON.parse(spawnSync(f.launcher, ['status'], { encoding: 'utf8' }).stdout);
  assert.equal(local.tool, path.join(await realpath(f.bin), 'wowsync-dev-deploy.mjs'));

  await rm(path.join(f.bin, 'wowsync-dev-deploy.mjs'));
  await rm(releaseTool);
  const missing = spawnSync(f.launcher, ['status'], { encoding: 'utf8' });
  assert.equal(missing.status, 69);
  assert.match(missing.stderr, /predates this deploy tool/);
});

test('launcher switches identity only through non-interactive sudo of the fixed launcher path', async (t) => {
  const f = await launcherFixture(t, (root) => ({ DEV_USER: 'wowsync-dev-test-nobody', SUDO: path.join(root, 'bin', 'fake-sudo'), LAUNCHER: '/usr/local/bin/wowsync-dev-deploy' }));
  const log = path.join(f.root, 'sudo.log');
  const fakeSudo = path.join(f.bin, 'fake-sudo');
  await writeFile(fakeSudo, `#!/usr/bin/bash\nprintf '%s\\n' "$*" >> '${log}'\n[[ "$2" == -l ]] && exit "\${FAKE_SUDO_LIST_STATUS:-0}"\nexit 0\n`, { mode: 0o755 });
  const allowed = spawnSync(f.launcher, ['deploy', 'feature', 'a b'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.deepEqual((await readFile(log, 'utf8')).trim().split('\n'), [
    '-n -l -u wowsync-dev-test-nobody /usr/local/bin/wowsync-dev-deploy',
    '-n -u wowsync-dev-test-nobody -- /usr/local/bin/wowsync-dev-deploy deploy feature a b',
  ]);

  await rm(log);
  const denied = spawnSync(f.launcher, ['deploy', 'feature', 'abc1234'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, FAKE_SUDO_LIST_STATUS: '1' } });
  assert.equal(denied.status, 77);
  assert.match(denied.stderr, /cannot switch to wowsync-dev-test-nobody without a password/);
  assert.equal((await readFile(log, 'utf8')).trim().split('\n').length, 1, 'no further sudo attempt without a terminal');
});
