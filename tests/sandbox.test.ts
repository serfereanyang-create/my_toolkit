import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  assertNoPosixDrivePath,
  buildSandboxEnv,
  buildWindowsShellCommand,
  findPosixDrivePath,
  isSandboxScrubEnabled,
  isSecretEnvKey,
  runSandboxedCommand,
  unescapeAmpEntities,
  validateSandboxCommand,
} from '../src/safety/sandbox.js';
import { createDefaultToolRegistry } from '../src/tools/index.js';

test('unescapeAmpEntities repairs &amp;&amp; outside quotes only', () => {
  // The observed corruption: model-emitted `npm run build && npm test` arrives
  // as `npm run build &amp;&amp; npm test`; cmd.exe split it and ran "amp".
  assert.equal(unescapeAmpEntities('npm run build &amp;&amp; npm test'), 'npm run build && npm test');
  assert.equal(unescapeAmpEntities('a &amp; b &amp;&amp; c'), 'a & b && c');
  // Quoted payloads (URLs, literal text) must survive untouched.
  assert.equal(unescapeAmpEntities('fetch "https://x/?a=1&amp;b=2"'), 'fetch "https://x/?a=1&amp;b=2"');
  // Commands without the entity are byte-identical.
  assert.equal(unescapeAmpEntities('git status &amp;'), 'git status &');
  assert.equal(unescapeAmpEntities('node --version'), 'node --version');
});

test('buildWindowsShellCommand prefixes UTF-8 codepage flip without leaking output', () => {
  const built = buildWindowsShellCommand('node --version');
  assert.ok(built.startsWith('chcp 65001'));
  assert.ok(built.endsWith('&& node --version'));
});

test('Windows runSandboxedCommand chain: entity repair + UTF-8 output end to end', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-sandbox-win-'));
  try {
    const command = process.platform === 'win32'
      ? 'node -e "console.log(\'构建成功\')" &amp;&amp; node -e "console.log(2)"'
      : 'node -e "console.log(1)"';
    const result = await runSandboxedCommand({ command, cwd: workspace, timeoutMs: 20000, scrubSecrets: true });
    assert.equal(result.timedOut, false);
    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    if (process.platform === 'win32') {
      // No "'amp' is not recognized" and Chinese survives as real UTF-8.
      assert.ok(!result.stderr.toLowerCase().includes("'amp'"), `entity leaked: ${result.stderr}`);
      assert.match(result.stdout, /构建成功/);
      assert.match(result.stdout, /2/);
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

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

/*
 * Windows commands run through cmd.exe, so an MSYS drive path like
 * /c/Users/me/x.txt is not a path at all. The guard is Windows-only and must
 * not touch anything that is not a drive path — a regex, a quoted literal or a
 * POSIX-only command would otherwise be rejected for no reason.
 */
test('findPosixDrivePath finds MSYS drive paths and nothing else', () => {
  const found = process.platform === 'win32'
    ? [
        '/c/Users/34516/x.txt',
        'node /c/Users/34516/x.js',
        'type "C:\\x" && cat /d/data/log.txt',
        '/mnt/c/Users/me/x.txt',
        '--out=/e/tmp/out.json',
      ]
    : [];
  for (const command of found) {
    assert.ok(findPosixDrivePath(command), `expected a hit: ${command}`);
  }

  const clean = [
    'node --version',
    'npm run build && npm test',
    'sed -i "s/a/b/g" file.txt',
    'ls /tmp',
    'git log --format=%h/%an',
    'echo "C:/Users/me/x.txt"',
    'curl https://example.com/a/b',
    'grep -o "/c/" file.txt.bak',
  ];
  for (const command of clean) {
    // `grep -o "/c/"` is a pattern inside quotes, not a drive path: the guard
    // matches a following path segment, so it stays clean.
    if (process.platform !== 'win32') continue;
    assert.equal(findPosixDrivePath(command), undefined, `expected no hit: ${command}`);
  }
});

test('assertNoPosixDrivePath names the offending path and the fix', () => {
  if (process.platform !== 'win32') return;
  assert.throws(
    () => assertNoPosixDrivePath('cat /c/Users/34516/notes.md'),
    /cmd\.exe.*\/c\/Users\/34516\/notes\.md.*C:\\Users\\34516\\notes\.md/s,
  );
  assert.doesNotThrow(() => assertNoPosixDrivePath('cat C:\\Users\\34516\\notes.md'));
  assert.doesNotThrow(() => assertNoPosixDrivePath('cat notes.md'));
});

/*
 * The guard is only worth anything if it is actually wired into the paths a
 * command travels. Two of them: the shared sandbox validator (used by /run,
 * projectops and plugin commands) and run_command's own validate, which fires
 * before the approval prompt so the user is never asked to approve a command
 * that cmd.exe cannot run.
 */
test('the sandbox validator and run_command both refuse MSYS drive paths', async () => {
  if (process.platform !== 'win32') return;
  assert.throws(() => validateSandboxCommand('cat /c/Users/34516/notes.md'), /MSYS path/);

  const tool = createDefaultToolRegistry().list().find((item) => item.name === 'run_command');
  assert.ok(tool, 'run_command must be registered');
  assert.throws(
    () => tool!.validate({ command: 'cat /c/Users/34516/notes.md', timeoutMs: 1000, background: false }),
    /MSYS path/,
  );
  assert.doesNotThrow(() => tool!.validate({ command: 'type notes.md', timeoutMs: 1000, background: false }));
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
