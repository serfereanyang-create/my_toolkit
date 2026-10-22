import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { createDefaultToolRegistry } from '../src/tools/index.js';

const execFileAsync = promisify(execFile);

function ctx(workspaceRoot: string) {
  return { workspaceRoot, approval: 'auto' as const };
}

async function plainFolder(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'aicode-gitinit-'));
}

test('git_init turns a plain folder into a repository on the requested branch', async () => {
  const ws = await plainFolder();
  try {
    const registry = createDefaultToolRegistry();
    assert.ok(registry.get('git_init'), 'git_init should be registered');

    const created = await registry.execute('git_init', { branch: 'main' }, ctx(ws));
    assert.equal(created.ok, true);

    const entries = await readdir(ws);
    assert.ok(entries.includes('.git'), '.git should exist after git_init');
    const { stdout } = await execFileAsync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: ws });
    assert.equal(stdout.trim(), 'main');

    // Nothing was staged or committed by the init itself.
    const status = await execFileAsync('git', ['status', '--porcelain'], { cwd: ws });
    assert.equal(status.stdout.trim(), '');
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

test('git_init refuses a workspace that is already in a repository', async () => {
  const ws = await plainFolder();
  try {
    const registry = createDefaultToolRegistry();
    await execFileAsync('git', ['init'], { cwd: ws });
    const again = await registry.execute('git_init', {}, ctx(ws));
    assert.equal(again.ok, false);
    assert.match(again.output, /already inside a git repository/i);
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

test('git_init rejects a branch name that is not a branch name', async () => {
  const registry = createDefaultToolRegistry();
  const tool = registry.get('git_init');
  assert.ok(tool);
  assert.throws(() => tool.validate({ branch: 'bad name; rm -rf /' }), /branch may only contain/);

  const ws = await plainFolder();
  try {
    const refused = await registry.execute('git_init', { branch: '--upload-pack=evil' }, ctx(ws));
    assert.equal(refused.ok, false);
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});
