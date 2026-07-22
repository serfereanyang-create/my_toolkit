import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  buildSandboxEnv,
  isSandboxScrubEnabled,
  isSecretEnvKey,
  runSandboxedCommand,
  validateSandboxCommand,
} from '../src/safety/sandbox.js';
import { createDefaultToolRegistry } from '../src/tools/index.js';

test('sandbox env scrub removes secrets and keeps PATH', () => {
  assert.equal(isSecretEnvKey('OPENAI_API_KEY'), true);
  assert.equal(isSecretEnvKey('PATH'), false);
  assert.equal(isSandboxScrubEnabled({}), true);
  assert.equal(isSandboxScrubEnabled({ AICODE_SANDBOX: '0' }), false);

  const scrubbed = buildSandboxEnv({
    PATH: '/usr/bin',
    OPENAI_API_KEY: 'sk-test',
    ANTHROPIC_API_KEY: 'anth-test',
    GITHUB_TOKEN: 'ghp_x',
    AICODE_CONTEXT_BUDGET_CHARS: '80000',
    RANDOM_APP_SETTING: 'keep-me-if-not-secret',
  }, { scrubSecrets: true });

  assert.equal(scrubbed.PATH, '/usr/bin');
  assert.equal(scrubbed.OPENAI_API_KEY, undefined);
  assert.equal(scrubbed.ANTHROPIC_API_KEY, undefined);
  assert.equal(scrubbed.GITHUB_TOKEN, undefined);
  assert.equal(scrubbed.AICODE_CONTEXT_BUDGET_CHARS, '80000');

  const unscrubbed = buildSandboxEnv({
    OPENAI_API_KEY: 'sk-test',
    PATH: '/bin',
  }, { scrubSecrets: false });
  assert.equal(unscrubbed.OPENAI_API_KEY, 'sk-test');
});

test('validateSandboxCommand rejects null bytes and empty commands', () => {
  assert.throws(() => validateSandboxCommand(''), /required/);
  assert.throws(() => validateSandboxCommand('echo\0hi'), /null bytes/);
  validateSandboxCommand('node --version');
});

test('runSandboxedCommand executes in workspace with scrubbed env', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-sandbox-'));
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'should-not-leak';
  try {
    const command = process.platform === 'win32'
      ? 'node -e "console.log(process.cwd()); console.log(process.env.OPENAI_API_KEY || \'missing\')"'
      : 'node -e \'console.log(process.cwd()); console.log(process.env.OPENAI_API_KEY || "missing")\'';
    const result = await runSandboxedCommand({
      command,
      cwd: workspace,
      timeoutMs: 15000,
      scrubSecrets: true,
    });
    assert.equal(result.timedOut, false);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /missing/);
    // cwd should be the workspace (normalize for Windows casing)
    assert.ok(result.stdout.toLowerCase().includes(workspace.toLowerCase()));
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
    await rm(workspace, { recursive: true, force: true });
  }
});

test('runSandboxedCommand times out and kills hanging process', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-sandbox-timeout-'));
  try {
    const command = process.platform === 'win32'
      ? 'node -e "setTimeout(()=>{}, 60000)"'
      : 'node -e \'setTimeout(()=>{}, 60000)\'';
    const started = Date.now();
    const result = await runSandboxedCommand({
      command,
      cwd: workspace,
      timeoutMs: 800,
      scrubSecrets: true,
    });
    const elapsed = Date.now() - started;
    assert.equal(result.timedOut, true);
    assert.ok(elapsed < 15000, `expected timeout kill under 15s, took ${elapsed}ms`);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('run_command tool uses sandbox and returns node version', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-sandbox-tool-'));
  const registry = createDefaultToolRegistry();
  const result = await registry.execute(
    'run_command',
    { command: 'node --version', timeoutMs: 15000 },
    { workspaceRoot: workspace, approval: 'auto' },
  );
  assert.equal(result.ok, true);
  assert.match(result.output, /^v\d+/);
  await rm(workspace, { recursive: true, force: true });
});

test('run_command tool reports timeout failures', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-sandbox-tool-timeout-'));
  await writeFile(join(workspace, 'hang.js'), 'setTimeout(() => {}, 60000);\n');
  const registry = createDefaultToolRegistry();
  const command = process.platform === 'win32' ? 'node hang.js' : 'node hang.js';
  const result = await registry.execute(
    'run_command',
    { command, timeoutMs: 700 },
    { workspaceRoot: workspace, approval: 'ask', confirm: async () => true },
  );
  assert.equal(result.ok, false);
  assert.match(result.output, /timed out/i);
  await rm(workspace, { recursive: true, force: true });
});
