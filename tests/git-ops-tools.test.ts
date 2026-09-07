import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { createDefaultToolRegistry } from '../src/tools/index.js';

const execFileAsync = promisify(execFile);

function ctx(workspaceRoot: string) {
  return { workspaceRoot, approval: 'auto' as const };
}

// Initialise a throwaway git repo with an identity so commits work offline.
async function initRepo(): Promise<string> {
  const ws = await mkdtemp(join(tmpdir(), 'aicode-gitops-'));
  await execFileAsync('git', ['init'], { cwd: ws });
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: ws });
  await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: ws });
  return ws;
}

test('git_add + git_commit stage and record a real commit', async () => {
  const ws = await initRepo();
  const registry = createDefaultToolRegistry();
  await writeFile(join(ws, 'a.txt'), 'hello');

  const add = await registry.execute('git_add', { paths: ['a.txt'] }, ctx(ws));
  assert.equal(add.ok, true);

  const commit = await registry.execute('git_commit', { message: 'feat: add a.txt', all: false }, ctx(ws));
  assert.equal(commit.ok, true);

  // Verify the commit really exists in the log.
  const { stdout } = await execFileAsync('git', ['log', '--oneline'], { cwd: ws });
  assert.match(stdout, /add a\.txt/);

  await rm(ws, { recursive: true, force: true });
});

test('git_checkout create=true makes and switches to a new branch', async () => {
  const ws = await initRepo();
  const registry = createDefaultToolRegistry();
  await writeFile(join(ws, 'a.txt'), 'hello');
  await execFileAsync('git', ['add', '.'], { cwd: ws });
  await execFileAsync('git', ['commit', '-m', 'init'], { cwd: ws });

  const co = await registry.execute('git_checkout', { target: 'feature/x', create: true }, ctx(ws));
  assert.equal(co.ok, true);

  const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: ws });
  assert.match(stdout.trim(), /feature\/x/);

  await rm(ws, { recursive: true, force: true });
});

test('git_stash push then pop preserves working changes', async () => {
  const ws = await initRepo();
  const registry = createDefaultToolRegistry();
  await writeFile(join(ws, 'a.txt'), 'v1');
  await execFileAsync('git', ['add', '.'], { cwd: ws });
  await execFileAsync('git', ['commit', '-m', 'init'], { cwd: ws });
  await writeFile(join(ws, 'a.txt'), 'v2-uncommitted');

  const push = await registry.execute('git_stash', { action: 'push' }, ctx(ws));
  assert.equal(push.ok, true);

  const pop = await registry.execute('git_stash', { action: 'pop' }, ctx(ws));
  assert.equal(pop.ok, true);

  await rm(ws, { recursive: true, force: true });
});

test('git_show and git_blame are read-only inspections', async () => {
  const ws = await initRepo();
  const registry = createDefaultToolRegistry();
  await writeFile(join(ws, 'a.txt'), 'line1\nline2\n');
  await execFileAsync('git', ['add', '.'], { cwd: ws });
  await execFileAsync('git', ['commit', '-m', 'init a.txt'], { cwd: ws });

  const show = await registry.execute('git_show', { ref: 'HEAD' }, ctx(ws));
  assert.equal(show.ok, true);
  assert.match(show.output, /init a\.txt/);

  const blame = await registry.execute('git_blame', { path: 'a.txt' }, ctx(ws));
  assert.equal(blame.ok, true);
  assert.match(blame.output, /line1/);

  await rm(ws, { recursive: true, force: true });
});

test('list_scripts reads package.json scripts', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'aicode-projops-'));
  const registry = createDefaultToolRegistry();
  await writeFile(join(ws, 'package.json'), JSON.stringify({ scripts: { build: 'tsc', test: 'node --test' } }));

  const result = await registry.execute('list_scripts', {}, ctx(ws));
  assert.equal(result.ok, true);
  assert.match(result.output, /build/);
  assert.match(result.output, /test/);

  await rm(ws, { recursive: true, force: true });
});

test('git_merge integrates a feature branch into the current branch', async () => {
  const ws = await initRepo();
  const registry = createDefaultToolRegistry();
  await writeFile(join(ws, 'base.txt'), 'base');
  await execFileAsync('git', ['add', '.'], { cwd: ws });
  await execFileAsync('git', ['commit', '-m', 'init'], { cwd: ws });

  await execFileAsync('git', ['checkout', '-b', 'feature/m'], { cwd: ws });
  await writeFile(join(ws, 'feat.txt'), 'feat');
  await execFileAsync('git', ['add', '.'], { cwd: ws });
  await execFileAsync('git', ['commit', '-m', 'feat work'], { cwd: ws });
  await execFileAsync('git', ['checkout', '-'], { cwd: ws });

  const merge = await registry.execute('git_merge', { ref: 'feature/m', noFf: true }, ctx(ws));
  assert.equal(merge.ok, true);

  const { stdout } = await execFileAsync('git', ['log', '--oneline'], { cwd: ws });
  assert.match(stdout, /feat work|Merge/);

  await rm(ws, { recursive: true, force: true });
});

test('git_cherry_pick applies a commit from another branch', async () => {
  const ws = await initRepo();
  const registry = createDefaultToolRegistry();
  await writeFile(join(ws, 'base.txt'), 'base');
  await execFileAsync('git', ['add', '.'], { cwd: ws });
  await execFileAsync('git', ['commit', '-m', 'init'], { cwd: ws });

  await execFileAsync('git', ['checkout', '-b', 'feature/cp'], { cwd: ws });
  await writeFile(join(ws, 'cp.txt'), 'cherry');
  await execFileAsync('git', ['add', '.'], { cwd: ws });
  await execFileAsync('git', ['commit', '-m', 'cherry target'], { cwd: ws });
  const { stdout: shaOut } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: ws });
  const sha = shaOut.trim();
  await execFileAsync('git', ['checkout', '-'], { cwd: ws });

  const pick = await registry.execute('git_cherry_pick', { commits: [sha] }, ctx(ws));
  assert.equal(pick.ok, true);

  const { stdout } = await execFileAsync('git', ['log', '--oneline'], { cwd: ws });
  assert.match(stdout, /cherry target/);

  await rm(ws, { recursive: true, force: true });
});

test('git_tag creates and lists an annotated tag', async () => {
  const ws = await initRepo();
  const registry = createDefaultToolRegistry();
  await writeFile(join(ws, 'a.txt'), 'v');
  await execFileAsync('git', ['add', '.'], { cwd: ws });
  await execFileAsync('git', ['commit', '-m', 'init'], { cwd: ws });

  const create = await registry.execute('git_tag', { name: 'v1.0.0', message: 'release 1' }, ctx(ws));
  assert.equal(create.ok, true);

  const list = await registry.execute('git_tag', { list: true }, ctx(ws));
  assert.equal(list.ok, true);
  assert.match(list.output, /v1\.0\.0/);

  await rm(ws, { recursive: true, force: true });
});

test('git_fetch and git_pull validate defaults without a remote', async () => {
  const ws = await initRepo();
  const registry = createDefaultToolRegistry();
  await writeFile(join(ws, 'a.txt'), 'v');
  await execFileAsync('git', ['add', '.'], { cwd: ws });
  await execFileAsync('git', ['commit', '-m', 'init'], { cwd: ws });

  // No remote configured — tools should return ok:false with git's error, not throw.
  const fetch = await registry.execute('git_fetch', { remote: 'origin' }, ctx(ws));
  assert.equal(fetch.ok, false);

  const pull = await registry.execute('git_pull', { remote: 'origin' }, ctx(ws));
  assert.equal(pull.ok, false);

  await rm(ws, { recursive: true, force: true });
});
