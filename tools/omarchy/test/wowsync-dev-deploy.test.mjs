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
  databaseEvidence,
  makeConsistentBackup,
  parseRoute,
  prepareRelease,
  resolveExactCommit,
  validateRemoteRef,
  validateSha,
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
