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
const BASE_SCHEMA = 'CREATE TABLE observations(id INTEGER PRIMARY KEY, name TEXT);';

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
  const schemaRuns = [];
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
      for (const sql of faults.startSql?.[sha] ?? []) write(sql);
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
    // The simulated application's schema initialization for the pre-stop
    // plan: every release creates the base table; faults.releaseSchema adds
    // per-release statements. Records every disposable database it is given.
    runSchemaStore: async (releasePath, dbFile) => {
      const release = path.basename(releasePath);
      schemaRuns.push({ release, dbFile });
      if (faults.planFailsOn === release) throw new Error(`injected schema plan failure for ${release}`);
      const db = new DatabaseSync(dbFile);
      try {
        db.exec(BASE_SCHEMA);
        for (const sql of faults.releaseSchema?.[release] ?? []) db.exec(sql);
      } finally { db.close(); }
    },
    readiness: { timeoutMs: 150, intervalMs: 2, settleMs: 0 },
  };
  return { ops, calls, units, herdr, schemaRuns };
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
  db.exec(`PRAGMA journal_mode=WAL; ${BASE_SCHEMA} INSERT INTO observations(name) VALUES ('before-deploy');`);
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

// --- Expected additive schema changes (D01-D35) ------------------------------

// The exact Slice A table (1832aba), written the way the application writes it.
const SLICE_A_SQL = `CREATE TABLE IF NOT EXISTS snapshot_equipment_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id INTEGER NOT NULL REFERENCES characters(id),
  snapshot_id INTEGER NOT NULL REFERENCES snapshots(id),
  observed_at INTEGER NOT NULL,
  capture INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  completeness TEXT NOT NULL CHECK (completeness IN ('complete', 'partial')),
  evidence_json TEXT NOT NULL,
  stored_at INTEGER NOT NULL,
  UNIQUE (character_id, observed_at, capture, revision)
);`;
// What SQLite stores in sqlite_master for it (no IF NOT EXISTS, no semicolon).
const SLICE_A_STORED = SLICE_A_SQL.replace('CREATE TABLE IF NOT EXISTS', 'CREATE TABLE').replace(/;$/, '');
const EXTRA_SQL = 'CREATE TABLE extra_evidence(id INTEGER PRIMARY KEY, note TEXT)';
const OTHER_SQL = 'CREATE TABLE other_evidence(id INTEGER PRIMARY KEY, note TEXT)';
const NAME_INDEX_SQL = 'CREATE INDEX observations_name ON observations(name)';
const decl = (type, name, sql) => ({ type, name, sqlSha256: deployTool.schemaSqlSha256(sql) });
const declString = (type, name, sql) => `${type}:${name}@${deployTool.schemaSqlSha256(sql)}`;
// The candidate both predicts (disposable plan DB) and performs (real DB at start) these statements.
const candidateAdds = (f, sqls) => { f.faults.releaseSchema = { ...f.faults.releaseSchema, [f.shaB]: sqls }; f.faults.startSql = { ...f.faults.startSql, [f.shaB]: sqls }; };
const objectNames = (dbPath) => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try { return db.prepare("SELECT type, name FROM sqlite_master ORDER BY name").all().map((row) => `${row.type}:${row.name}`); }
  finally { db.close(); }
};
const planDirs = async (f) => (await readdir(f.paths.staging).catch(() => [])).filter((name) => name.startsWith('schema-plan-'));

test('D01 no declaration and no schema change deploys exactly as before, after a NONE plan on disposable databases', async (t) => {
  const f = await deployFixture(t);
  const result = await deploy({ ref: 'feature', expectedSha: f.shaB }, { paths: f.paths, ops: f.ops });
  assert.equal(result.state, 'DEPLOYED');
  assert.deepEqual(f.host.calls, ['stop', 'start']);
  assert.equal(result.record.schemaChanged, false);
  assert.equal(result.record.schemaChange.classification, 'NONE');
  assert.equal(result.record.schemaPlan.state, 'NONE');
  assert.deepEqual(f.host.schemaRuns.map((run) => run.release), [f.shaA, f.shaB], 'previous (current) and candidate releases each initialized once');
  assert.match(formatResult(result), /Schema:\s+unchanged/);
  assert.deepEqual((await f.audit()).map((item) => item.operation), ['PREPARE_SUCCESS', 'PROMOTE_INTENT', 'PROMOTE_SUCCESS']);
});

test('D02 a predicted but undeclared schema change is refused UNCHANGED before any service stop, naming the declaration', async (t) => {
  const f = await deployFixture(t);
  candidateAdds(f, [EXTRA_SQL]);
  const outcome = await failure(deploy({ ref: 'feature', expectedSha: f.shaB }, { paths: f.paths, ops: f.ops }));
  assert.equal(outcome.state, 'UNCHANGED');
  assert.equal(outcome.manualIntervention, false);
  assert.deepEqual(f.host.calls, [], 'nothing stopped');
  assert.equal(await currentSha(f.paths.releases), f.shaA);
  assert.match(outcome.cause, new RegExp(`--expect-schema-add ${declString('table', 'extra_evidence', EXTRA_SQL)}`));
  assert.deepEqual(objectNames(f.paths.database), ['table:observations'], 'real database untouched');
  assert.equal(deployTool.exitCodeFor(outcome), 1);
  const text = formatResult(outcome);
  assert.match(text, /^DEV DEPLOY FAILED — DEV UNCHANGED\n/);
  assert.match(text, /Schema plan: additive/);
  const audit = await f.audit();
  assert.equal(audit.at(-1).operation, 'PROMOTE_COMMAND_FAILURE');
  assert.equal(audit.at(-1).schemaPlan.state, 'ADDITIVE');
  assert.ok(!audit.some((item) => item.operation === 'PROMOTE_INTENT'));
});

test('D02 a runtime-only (unpredicted) schema change still stops Dashboard/MCP for review', async (t) => {
  const f = await deployFixture(t);
  f.faults.startSql = { [f.shaB]: [EXTRA_SQL] };
  const outcome = await failure(deploy({ ref: 'feature', expectedSha: f.shaB }, { paths: f.paths, ops: f.ops }));
  assert.equal(outcome.state, 'STOPPED_REVIEW_REQUIRED');
  assert.equal(outcome.schemaChange.classification, 'UNDECLARED');
  assert.deepEqual(f.host.calls, ['stop', 'start', 'stop'], 'previous code never started');
  assert.equal(deployTool.exitCodeFor(outcome), 2);
});

test('D03 D26 an exactly declared table deploys, and the audit records the authorization and the observed change', async (t) => {
  const f = await deployFixture(t);
  candidateAdds(f, [EXTRA_SQL]);
  const result = await deploy({ ref: 'feature', expectedSha: f.shaB, schemaDeclarations: [decl('table', 'extra_evidence', EXTRA_SQL)] }, { paths: f.paths, ops: f.ops });
  assert.equal(result.state, 'DEPLOYED');
  assert.equal(await currentSha(f.paths.releases), f.shaB);
  const change = result.record.schemaChange;
  assert.equal(change.classification, 'DECLARED_ADDITIVE');
  assert.deepEqual(change.added.map((item) => [item.type, item.name, item.tbl_name, item.sqlSha256]), [['table', 'extra_evidence', 'extra_evidence', deployTool.schemaSqlSha256(EXTRA_SQL)]]);
  assert.equal(change.added[0].sql, EXTRA_SQL);
  assert.deepEqual(change.declared, [declString('table', 'extra_evidence', EXTRA_SQL)]);
  assert.equal(change.previousCodeCompatible, false);
  assert.equal(result.record.schemaChanged, true);
  assert.ok(result.record.dataAfter.schema.some((item) => item.name === 'extra_evidence'), 'post-start schema array persisted');
  assert.equal(result.record.dataBefore.schemaSha256 !== result.record.dataAfter.schemaSha256, true);
  assert.match(formatResult(result), /Schema:\s+ADDED \(declared\) extra_evidence/);
  const [intent] = (await f.audit()).filter((item) => item.operation === 'PROMOTE_INTENT');
  assert.deepEqual(intent.declaredSchemaAdditions, [declString('table', 'extra_evidence', EXTRA_SQL)]);
  const success = (await f.audit()).at(-1);
  assert.equal(success.operation, 'PROMOTE_SUCCESS');
  assert.equal(success.schemaChange.classification, 'DECLARED_ADDITIVE');
});

test('D04 a declared table that the candidate does not add is refused before stop; absence seen only after start recovers', async (t) => {
  const f = await deployFixture(t);
  const outcome = await failure(deploy({ ref: 'feature', expectedSha: f.shaB, schemaDeclarations: [decl('table', 'extra_evidence', EXTRA_SQL)] }, { paths: f.paths, ops: f.ops }));
  assert.equal(outcome.state, 'UNCHANGED');
  assert.match(outcome.cause, /No schema change is predicted/);
  assert.deepEqual(f.host.calls, []);

  const g = await deployFixture(t);
  g.faults.releaseSchema = { [g.shaB]: [EXTRA_SQL] }; // predicted, but the real start never creates it
  const late = await failure(deploy({ ref: 'feature', expectedSha: g.shaB, schemaDeclarations: [decl('table', 'extra_evidence', EXTRA_SQL)] }, { paths: g.paths, ops: g.ops }));
  assert.equal(late.state, 'RECOVERED', 'the real schema is unchanged, so the previous release is safe');
  assert.match(late.cause, /not exactly the declared additions/);
  assert.equal(await currentSha(g.paths.releases), g.shaA);
  assert.deepEqual(g.host.calls, ['stop', 'start', 'stop', 'start']);
});

test('D05 a different table than the declared one is refused before stop, and stopped for review if it appears only at runtime', async (t) => {
  const f = await deployFixture(t);
  candidateAdds(f, [OTHER_SQL]);
  const outcome = await failure(deploy({ ref: 'feature', expectedSha: f.shaB, schemaDeclarations: [decl('table', 'extra_evidence', EXTRA_SQL)], previousCodeCompatible: true }, { paths: f.paths, ops: f.ops }));
  assert.equal(outcome.state, 'UNCHANGED');
  assert.match(outcome.cause, /other_evidence was added but not declared/);
  assert.deepEqual(f.host.calls, []);

  const g = await deployFixture(t);
  g.faults.releaseSchema = { [g.shaB]: [EXTRA_SQL] };
  g.faults.startSql = { [g.shaB]: [OTHER_SQL] };
  const late = await failure(deploy({ ref: 'feature', expectedSha: g.shaB, schemaDeclarations: [decl('table', 'extra_evidence', EXTRA_SQL)], previousCodeCompatible: true }, { paths: g.paths, ops: g.ops }));
  assert.equal(late.state, 'STOPPED_REVIEW_REQUIRED', 'the acknowledgement never widens a mismatch');
  assert.deepEqual(g.host.calls, ['stop', 'start', 'stop']);
});

test('D06 the declared table plus an undeclared one fails closed before stop and at runtime', async (t) => {
  const f = await deployFixture(t);
  candidateAdds(f, [EXTRA_SQL, OTHER_SQL]);
  const outcome = await failure(deploy({ ref: 'feature', expectedSha: f.shaB, schemaDeclarations: [decl('table', 'extra_evidence', EXTRA_SQL)] }, { paths: f.paths, ops: f.ops }));
  assert.equal(outcome.state, 'UNCHANGED');
  assert.deepEqual(f.host.calls, []);

  const g = await deployFixture(t);
  g.faults.releaseSchema = { [g.shaB]: [EXTRA_SQL] };
  g.faults.startSql = { [g.shaB]: [EXTRA_SQL, OTHER_SQL] };
  const late = await failure(deploy({ ref: 'feature', expectedSha: g.shaB, schemaDeclarations: [decl('table', 'extra_evidence', EXTRA_SQL)], previousCodeCompatible: true }, { paths: g.paths, ops: g.ops }));
  assert.equal(late.state, 'STOPPED_REVIEW_REQUIRED');
  assert.equal(late.schemaChange.classification, 'UNDECLARED');
});

test('D07 a changed existing table definition is NON-ADDITIVE and cannot be declared', async (t) => {
  const f = await deployFixture(t);
  f.faults.releaseSchema = { [f.shaB]: ['DROP TABLE observations', 'CREATE TABLE observations(id INTEGER PRIMARY KEY, name TEXT, extra TEXT)'] };
  const outcome = await failure(deploy({ ref: 'feature', expectedSha: f.shaB, schemaDeclarations: [decl('table', 'extra_evidence', EXTRA_SQL)] }, { paths: f.paths, ops: f.ops }));
  assert.equal(outcome.state, 'UNCHANGED');
  assert.match(outcome.cause, /NON-ADDITIVE .*table observations changed definition.*declarations cannot authorize it/);
  assert.equal(outcome.schemaPlan.state, 'NON_ADDITIVE');
  assert.match(formatResult(outcome), /Schema plan: NON-ADDITIVE/);
  assert.deepEqual(f.host.calls, []);
});

test('D08 a removed object is refused in the plan and stops for review at runtime', async (t) => {
  const f = await deployFixture(t);
  f.faults.releaseSchema = { [f.shaA]: [EXTRA_SQL] }; // the running release has a table the candidate lacks
  const outcome = await failure(deploy({ ref: 'feature', expectedSha: f.shaB }, { paths: f.paths, ops: f.ops }));
  assert.equal(outcome.state, 'UNCHANGED');
  assert.match(outcome.cause, /table extra_evidence was removed/);

  const g = await deployFixture(t);
  const db = new DatabaseSync(g.paths.database); db.exec(EXTRA_SQL); db.close();
  g.faults.startSql = { [g.shaB]: ['DROP TABLE extra_evidence'] };
  const late = await failure(deploy({ ref: 'feature', expectedSha: g.shaB }, { paths: g.paths, ops: g.ops }));
  assert.equal(late.state, 'STOPPED_REVIEW_REQUIRED');
  assert.deepEqual(late.schemaChange.removed.map((item) => item.name), ['extra_evidence']);
});

test('D09 an undeclared index is refused before stop (the runtime case is the existing index test above)', async (t) => {
  const f = await deployFixture(t);
  candidateAdds(f, [NAME_INDEX_SQL]);
  const outcome = await failure(deploy({ ref: 'feature', expectedSha: f.shaB }, { paths: f.paths, ops: f.ops }));
  assert.equal(outcome.state, 'UNCHANGED');
  assert.match(outcome.cause, new RegExp(`--expect-schema-add ${declString('index', 'observations_name', NAME_INDEX_SQL)}`));
  assert.deepEqual(f.host.calls, []);
});

test('D10 an exactly declared index on a pre-existing table deploys', async (t) => {
  const f = await deployFixture(t);
  candidateAdds(f, [NAME_INDEX_SQL]);
  const result = await deploy({ ref: 'feature', expectedSha: f.shaB, schemaDeclarations: [decl('index', 'observations_name', NAME_INDEX_SQL)] }, { paths: f.paths, ops: f.ops });
  assert.equal(result.state, 'DEPLOYED');
  assert.deepEqual(result.record.schemaChange.added.map((item) => `${item.type}:${item.name}:${item.tbl_name}`), ['index:observations_name:observations']);
});

test('D11 D12 triggers and views are NON-ADDITIVE in the plan and fail closed at runtime even beside a declared table', async (t) => {
  for (const sql of ['CREATE TRIGGER observations_audit AFTER INSERT ON observations BEGIN SELECT 1; END', 'CREATE VIEW observation_names AS SELECT name FROM observations']) {
    const f = await deployFixture(t);
    candidateAdds(f, [EXTRA_SQL, sql]);
    const outcome = await failure(deploy({ ref: 'feature', expectedSha: f.shaB, schemaDeclarations: [decl('table', 'extra_evidence', EXTRA_SQL)] }, { paths: f.paths, ops: f.ops }));
    assert.equal(outcome.state, 'UNCHANGED');
    assert.match(outcome.cause, /NON-ADDITIVE/);
    assert.deepEqual(f.host.calls, []);

    const g = await deployFixture(t);
    g.faults.releaseSchema = { [g.shaB]: [EXTRA_SQL] };
    g.faults.startSql = { [g.shaB]: [EXTRA_SQL, sql] };
    const late = await failure(deploy({ ref: 'feature', expectedSha: g.shaB, schemaDeclarations: [decl('table', 'extra_evidence', EXTRA_SQL)], previousCodeCompatible: true }, { paths: g.paths, ops: g.ops }));
    assert.equal(late.state, 'STOPPED_REVIEW_REQUIRED');
    assert.match(late.cause, /only tables and indexes can be declared/);
  }
});

test('D13 a user_version change is NON-ADDITIVE in the plan and fails closed at runtime', async (t) => {
  const f = await deployFixture(t);
  candidateAdds(f, [EXTRA_SQL, 'PRAGMA user_version = 2']);
  const outcome = await failure(deploy({ ref: 'feature', expectedSha: f.shaB, schemaDeclarations: [decl('table', 'extra_evidence', EXTRA_SQL)] }, { paths: f.paths, ops: f.ops }));
  assert.equal(outcome.state, 'UNCHANGED');
  assert.match(outcome.cause, /user_version changed 0 -> 2/);

  const g = await deployFixture(t);
  g.faults.releaseSchema = { [g.shaB]: [EXTRA_SQL] };
  g.faults.startSql = { [g.shaB]: [EXTRA_SQL, 'PRAGMA user_version = 2'] };
  const late = await failure(deploy({ ref: 'feature', expectedSha: g.shaB, schemaDeclarations: [decl('table', 'extra_evidence', EXTRA_SQL)], previousCodeCompatible: true }, { paths: g.paths, ops: g.ops }));
  assert.equal(late.state, 'STOPPED_REVIEW_REQUIRED');
});

test('D14 D28 the Slice A table: prepare plans exactly one declaration, the UNIQUE autoindex is implied, and deploy accepts it', async (t) => {
  const f = await deployFixture(t);
  candidateAdds(f, [SLICE_A_SQL]);
  const prepared = await deployTool.prepare({ ref: 'feature', expectedSha: f.shaB }, { paths: f.paths, ops: f.ops });
  assert.equal(prepared.schemaPlan.state, 'ADDITIVE');
  assert.deepEqual(prepared.schemaPlan.added.map((item) => item.declaration), [declString('table', 'snapshot_equipment_observations', SLICE_A_STORED)]);
  assert.deepEqual(f.host.calls, [], 'prepare never touches DEV');
  const text = formatResult(prepared);
  assert.match(text, /Schema plan: additive/);
  assert.ok(text.includes(`--expect-schema-add ${prepared.schemaPlan.added[0].declaration}`));
  assert.doesNotMatch(text, /sqlite_autoindex/);

  let output = '';
  const code = await runCli(['deploy', 'feature', f.shaB, '--expect-schema-add', prepared.schemaPlan.added[0].declaration, '--previous-code-compatible'], { paths: f.paths, ops: f.ops, write: (value) => { output = value; } });
  assert.equal(code, 0, output);
  assert.match(output, /Schema:\s+ADDED \(declared\) snapshot_equipment_observations/);
  assert.ok(objectNames(f.paths.database).includes('index:sqlite_autoindex_snapshot_equipment_observations_1'), 'SQLite created the implied autoindex');
  const success = (await f.audit()).at(-1);
  assert.deepEqual(success.schemaChange.added.map((item) => item.name), ['snapshot_equipment_observations'], 'autoindex is not a separate object');
  assert.equal(success.schemaChange.previousCodeCompatible, true);
});

test('D15 a health failure after the exact declared addition: with the acknowledgement the previous release returns and the table stays', async (t) => {
  const f = await deployFixture(t);
  candidateAdds(f, [SLICE_A_SQL]);
  f.faults.unhealthySha = f.shaB;
  const declaration = decl('table', 'snapshot_equipment_observations', SLICE_A_STORED);
  const outcome = await failure(deploy({ ref: 'feature', expectedSha: f.shaB, schemaDeclarations: [declaration], previousCodeCompatible: true }, { paths: f.paths, ops: f.ops }));
  assert.equal(outcome.state, 'RECOVERED');
  assert.equal(outcome.runningSha, f.shaA);
  assert.equal(outcome.databaseRestored, false);
  assert.deepEqual(outcome.schemaAdditionsRetained, [{ type: 'table', name: 'snapshot_equipment_observations' }]);
  assert.deepEqual(f.host.calls, ['stop', 'start', 'stop', 'start']);
  assert.equal(await currentSha(f.paths.releases), f.shaA);
  assert.ok(objectNames(f.paths.database).includes('table:snapshot_equipment_observations'), 'declared addition left in place');
  assert.ok(!objectNames(outcome.backupPath).includes('table:snapshot_equipment_observations'), 'backup is the pre-addition database');
  const text = formatResult(outcome);
  assert.match(text, /^DEV DEPLOY FAILED — RECOVERED\n/);
  assert.match(text, /Schema:\s+additions retained: table snapshot_equipment_observations/);
  assert.equal(deployTool.exitCodeFor(outcome), 1);
  const failureRecord = (await f.audit()).at(-1);
  assert.equal(failureRecord.operation, 'PROMOTE_FAILURE');
  assert.deepEqual(failureRecord.schemaAdditionsRetained, [{ type: 'table', name: 'snapshot_equipment_observations' }]);
  assert.equal(failureRecord.schemaChange.classification, 'DECLARED_ADDITIVE');
  assert.equal(failureRecord.recoveryAction, 'restore-previous-release-retaining-declared-additions');
});

test('D15 the same health failure without the acknowledgement stops Dashboard/MCP for review', async (t) => {
  const f = await deployFixture(t);
  candidateAdds(f, [SLICE_A_SQL]);
  f.faults.unhealthySha = f.shaB;
  const outcome = await failure(deploy({ ref: 'feature', expectedSha: f.shaB, schemaDeclarations: [decl('table', 'snapshot_equipment_observations', SLICE_A_STORED)] }, { paths: f.paths, ops: f.ops }));
  assert.equal(outcome.state, 'STOPPED_REVIEW_REQUIRED');
  assert.equal(outcome.schemaChange.classification, 'DECLARED_ADDITIVE');
  assert.deepEqual(f.host.calls, ['stop', 'start', 'stop']);
  assert.equal(deployTool.exitCodeFor(outcome), 2);
});

test('D16 a candidate that fails to start before any schema change recovers through the existing path', async (t) => {
  const f = await deployFixture(t);
  candidateAdds(f, [EXTRA_SQL]);
  f.faults.startFailsOn = [1];
  const outcome = await failure(deploy({ ref: 'feature', expectedSha: f.shaB, schemaDeclarations: [decl('table', 'extra_evidence', EXTRA_SQL)] }, { paths: f.paths, ops: f.ops }));
  assert.equal(outcome.state, 'RECOVERED', 'no schema change happened, so no acknowledgement is needed');
  assert.equal(outcome.schemaAdditionsRetained, undefined);
  assert.equal(await currentSha(f.paths.releases), f.shaA);
});

test('D17 an interrupted switch to the requested SHA is reported for review instead of a no-op', async (t) => {
  const f = await deployFixture(t);
  await prepareRelease(f.shaB, 'refs/heads/feature', f.paths, async (stage) => { await mkdir(path.join(stage, 'node_modules')); });
  const at = '2026-10-07T12:00:00.000Z';
  await deployTool.appendAudit({ operation: 'PROMOTE_INTENT', requestedSha: f.shaB, previousSha: f.shaA, candidateSha: f.shaB, at }, f.paths);
  await mkdir(f.paths.backups, { recursive: true });
  const backup = path.join(f.paths.backups, `20261007T120000.000Z-abcdef12-${f.shaA}-to-${f.shaB}.sqlite`);
  await writeFile(backup, '');
  await atomicSetCurrent(f.paths.releases, f.shaB); // the tool died after switching the pointer
  let output = '';
  const code = await runCli(['deploy', 'feature', f.shaB], { paths: f.paths, ops: f.ops, write: (value) => { output = value; } });
  assert.equal(code, 2);
  assert.match(output, /^DEV DEPLOY INTERRUPTED — REVIEW REQUIRED\n/);
  assert.match(output, /Manual intervention:\s+REQUIRED/);
  assert.ok(output.includes(backup));
  assert.deepEqual(f.host.calls, []);
  const operations = (await f.audit()).map((item) => item.operation);
  assert.ok(!operations.includes('PROMOTE_NOOP'), 'never silently accepted');
  assert.equal(operations.at(-1), 'PROMOTE_INTERRUPTED_REVIEW_REQUIRED');
  const outcome = await failure(deploy({ ref: 'feature', expectedSha: f.shaB }, { paths: f.paths, ops: f.ops }));
  assert.equal(outcome.state, 'INTERRUPTED_REVIEW_REQUIRED', 'still review-required until a switch completes');
  assert.equal(outcome.manualIntervention, true);
  assert.deepEqual(outcome.interrupted, { operation: 'PROMOTE_INTENT', at, previousSha: f.shaA, candidateSha: f.shaB });

  const g = await deployFixture(t);
  await writeFile(g.paths.audit, '{"operation":"PROMOTE_SUCCESS"}\n{"operation":"PROMOTE_IN');
  const torn = await failure(deploy({ ref: 'fixture', expectedSha: g.shaA }, { paths: g.paths, ops: g.ops }));
  assert.equal(torn.state, 'INTERRUPTED_REVIEW_REQUIRED', 'a torn final journal line is treated as an interruption');
});

test('D18 multiple exact declarations (a new table and an index on it) deploy', async (t) => {
  const f = await deployFixture(t);
  const indexSql = 'CREATE INDEX extra_evidence_note ON extra_evidence(note)';
  candidateAdds(f, [EXTRA_SQL, indexSql]);
  const result = await deploy({ ref: 'feature', expectedSha: f.shaB, schemaDeclarations: [decl('table', 'extra_evidence', EXTRA_SQL), decl('index', 'extra_evidence_note', indexSql)] }, { paths: f.paths, ops: f.ops });
  assert.equal(result.state, 'DEPLOYED');
  assert.match(formatResult(result), /ADDED \(declared\) extra_evidence, extra_evidence_note|ADDED \(declared\) extra_evidence_note, extra_evidence/);
});

test('D24 rollback from a release with a declared addition to old code keeps the table and needs no declaration', async (t) => {
  const f = await deployFixture(t);
  candidateAdds(f, [SLICE_A_SQL]);
  await deploy({ ref: 'feature', expectedSha: f.shaB, schemaDeclarations: [decl('table', 'snapshot_equipment_observations', SLICE_A_STORED)] }, { paths: f.paths, ops: f.ops });
  const runs = f.host.schemaRuns.length;
  const result = await deployTool.rollback({ sha: f.shaA }, { paths: f.paths, ops: f.ops });
  assert.equal(result.state, 'ROLLED_BACK');
  assert.equal(result.record.schemaChange.classification, 'NONE', 'old code leaves the added table alone');
  assert.equal(f.host.schemaRuns.length, runs, 'rollback runs no schema plan');
  assert.ok(objectNames(f.paths.database).includes('table:snapshot_equipment_observations'));
  assert.throws(() => parseArgs(['rollback', f.shaA, '--expect-schema-add', declString('table', 'x', EXTRA_SQL)]), /accepted only by deploy/);
});

test('D24 deploying an older release over a newer schema is refused before stop; rollback is the supported path', async (t) => {
  const f = await deployFixture(t);
  candidateAdds(f, [EXTRA_SQL]);
  await deploy({ ref: 'feature', expectedSha: f.shaB, schemaDeclarations: [decl('table', 'extra_evidence', EXTRA_SQL)] }, { paths: f.paths, ops: f.ops });
  f.host.calls.length = 0;
  const outcome = await failure(deploy({ ref: 'fixture', expectedSha: f.shaA }, { paths: f.paths, ops: f.ops }));
  assert.equal(outcome.state, 'UNCHANGED');
  assert.match(outcome.cause, /NON-ADDITIVE .*extra_evidence was removed/);
  assert.deepEqual(f.host.calls, []);
});

test('D25 a declared deploy still backs up first, integrity-checks, and keeps the pre-addition backup', async (t) => {
  const f = await deployFixture(t);
  candidateAdds(f, [EXTRA_SQL]);
  const result = await deploy({ ref: 'feature', expectedSha: f.shaB, schemaDeclarations: [decl('table', 'extra_evidence', EXTRA_SQL)] }, { paths: f.paths, ops: f.ops });
  assert.equal(result.record.backup.integrityCheck, 'ok');
  assert.match(result.record.backup.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(rows(result.record.backup.path), ['before-deploy']);
  assert.ok(!result.record.backup.data.schema.some((item) => item.name === 'extra_evidence'));
  assert.ok(!objectNames(result.record.backup.path).includes('table:extra_evidence'));
});

test('D29 a Slice A table definition that differs from the declared hash is refused before stop', async (t) => {
  const f = await deployFixture(t);
  candidateAdds(f, [SLICE_A_SQL.replace(',\n  UNIQUE (character_id, observed_at, capture, revision)', '')]);
  const outcome = await failure(deploy({ ref: 'feature', expectedSha: f.shaB, schemaDeclarations: [decl('table', 'snapshot_equipment_observations', SLICE_A_STORED)], previousCodeCompatible: true }, { paths: f.paths, ops: f.ops }));
  assert.equal(outcome.state, 'UNCHANGED');
  assert.match(outcome.cause, /SQL hash .* does not match the declared/);
  assert.deepEqual(f.host.calls, []);
});

test('D31 D32 the plan uses only disposable databases under staging, cleans them, and a plan failure leaves DEV untouched', async (t) => {
  const f = await deployFixture(t);
  candidateAdds(f, [EXTRA_SQL]);
  await deploy({ ref: 'feature', expectedSha: f.shaB, schemaDeclarations: [decl('table', 'extra_evidence', EXTRA_SQL)] }, { paths: f.paths, ops: f.ops });
  for (const run of f.host.schemaRuns) {
    assert.ok(run.dbFile.startsWith(`${f.paths.staging}${path.sep}schema-plan-`), run.dbFile);
    assert.notEqual(run.dbFile, f.paths.database);
  }
  assert.deepEqual(await planDirs(f), [], 'plan workspace removed after success');

  const g = await deployFixture(t);
  g.faults.planFailsOn = g.shaB;
  const outcome = await failure(deploy({ ref: 'feature', expectedSha: g.shaB }, { paths: g.paths, ops: g.ops }));
  assert.equal(outcome.state, 'UNCHANGED');
  assert.match(outcome.cause, /Schema plan failed before any service was stopped: injected schema plan failure/);
  assert.deepEqual(g.host.calls, []);
  assert.equal(await currentSha(g.paths.releases), g.shaA);
  assert.deepEqual(await planDirs(g), [], 'plan workspace removed after a thrown error');
  assert.deepEqual(rows(g.paths.database), ['before-deploy']);
});

test('D35 re-deploying a cleanly deployed SHA is still a normal no-op, and declarations do not apply to it', async (t) => {
  const f = await deployFixture(t);
  await deploy({ ref: 'feature', expectedSha: f.shaB }, { paths: f.paths, ops: f.ops });
  f.host.calls.length = 0;
  const again = await deploy({ ref: 'feature', expectedSha: f.shaB }, { paths: f.paths, ops: f.ops });
  assert.equal(again.state, 'NOOP');
  assert.deepEqual(f.host.calls, []);
  const declared = await failure(deploy({ ref: 'feature', expectedSha: f.shaB, schemaDeclarations: [decl('table', 'extra_evidence', EXTRA_SQL)] }, { paths: f.paths, ops: f.ops }));
  assert.equal(declared.state, 'UNCHANGED');
  assert.match(declared.cause, /does not apply to a no-op deployment/);
});

test('prepare reports a NONE schema plan and stays read-only with respect to DEV', async (t) => {
  const f = await deployFixture(t);
  const prepared = await deployTool.prepare({ ref: 'feature', expectedSha: f.shaB }, { paths: f.paths, ops: f.ops });
  assert.equal(prepared.schemaPlan.state, 'NONE');
  assert.match(formatResult(prepared), /Schema plan: none/);
  assert.deepEqual(f.host.calls, []);
  assert.deepEqual(rows(f.paths.database), ['before-deploy']);
});
