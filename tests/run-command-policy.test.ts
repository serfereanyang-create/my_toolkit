import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { handleSlashCommand } from '../src/cli/commands.js';
import { createMockProvider } from '../src/providers/mock.js';
import { SessionStore } from '../src/session/store.js';
import { createDefaultToolRegistry } from '../src/tools/index.js';

/*
 * `/run` used to call execFile directly with `shell: true` and no policy check,
 * so a slash command could execute what `run_command` refuses: destructive
 * patterns passed through unprompted, and auto mode ran anything at all.
 * These tests pin the shared policy layer onto the slash-command path.
 */
async function makeBase(workspace: string, approval: 'auto' | 'ask') {
  const sessions = new SessionStore(join(workspace, 'sessions'));
  const session = await sessions.create({ provider: 'mock', model: 'mock', workspaceRoot: workspace });
  return {
    config: {
      provider: 'mock' as const,
      model: 'mock',
      approval,
      workspaceRoot: workspace,
      sessionDir: join(workspace, 'sessions'),
      maxSteps: 4,
      noBanner: true,
    },
    provider: createMockProvider(),
    tools: createDefaultToolRegistry(),
    sessions,
    session,
  };
}

test('/run refuses a destructive command in auto mode', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-run-policy-'));
  try {
    const base = await makeBase(workspace, 'auto');
    const marker = join(workspace, 'survivor.txt');
    await writeFile(marker, 'still here');

    const output = await handleSlashCommand({ line: '/run rm -rf /', ...base });

    assert.match(output, /blocked/);
    // Nothing may have executed: the file is untouched and no prompt was asked.
    assert.equal(await (await import('node:fs/promises')).readFile(marker, 'utf8'), 'still here');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('/run blocks an arbitrary command in auto mode without executing it', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-run-policy-'));
  try {
    const base = await makeBase(workspace, 'auto');
    const output = await handleSlashCommand({
      line: '/run node -e "require(\'fs\').writeFileSync(\'ran.txt\', \'x\')"',
      ...base,
      confirm: async () => true,
    });

    // auto mode is an allowlist: an unlisted command is refused outright, and
    // even an approving confirm handler must not be able to run it.
    assert.match(output, /blocked/);
    await assert.rejects(
      (await import('node:fs/promises')).readFile(join(workspace, 'ran.txt'), 'utf8'),
      { code: 'ENOENT' },
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('/run prompts in ask mode and cancels when denied', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-run-policy-'));
  try {
    const base = await makeBase(workspace, 'ask');
    const prompts: string[] = [];

    const output = await handleSlashCommand({
      line: '/run node -e "require(\'fs\').writeFileSync(\'ran.txt\', \'x\')"',
      ...base,
      confirm: async (message: string) => {
        prompts.push(message);
        return false;
      },
    });

    assert.equal(prompts.length, 1);
    assert.match(prompts[0]!, /run_command/);
    assert.match(output, /cancelled by user/);
    await assert.rejects(
      (await import('node:fs/promises')).readFile(join(workspace, 'ran.txt'), 'utf8'),
      { code: 'ENOENT' },
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('/run runs an allowlisted command without a prompt', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-run-policy-'));
  try {
    const base = await makeBase(workspace, 'auto');
    const output = await handleSlashCommand({ line: '/run node --version', ...base });
    assert.match(output, /^v\d+\./m);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('/run refuses without a confirmation handler when a prompt is required', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-run-policy-'));
  try {
    const base = await makeBase(workspace, 'ask');
    const output = await handleSlashCommand({ line: '/run node --version', ...base });
    assert.match(output, /no confirmation handler/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
