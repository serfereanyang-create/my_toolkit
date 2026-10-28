import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readPackageVersion } from '../src/runtime/packageVersion.js';

// Resolve the manifest layout-independently: a fixed '../package.json' is
// correct from tests/ but points at dist/package.json once compiled, and tsc
// never emits that file.
const packageVersion = await readPackageVersion(import.meta.url);

const execFileAsync = promisify(execFile);
const cliPath = resolve('dist/src/index.js');

test('CLI prints package version', async () => {
  const result = await execFileAsync(process.execPath, [cliPath, '--version']);
  assert.equal(result.stdout.trim(), packageVersion);
  assert.equal(result.stderr, '');
});

test('CLI prints help without starting the REPL', async () => {
  const result = await execFileAsync(process.execPath, [cliPath, '--help']);
  assert.match(result.stdout, /Commands:/);
  assert.match(result.stdout, /\/status/);
  assert.equal(result.stderr, '');
});

test('CLI emits JSON events for prompt mode', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-cli-json-'));
  const result = await execFileAsync(process.execPath, [cliPath, '--provider', 'mock', '--approval', 'auto', '--workspace', workspace, '--session-dir', join(workspace, 'sessions'), '--json', '--prompt', '帮我看看项目索引'], {
    env: { ...process.env, MSYS2_ARG_CONV_EXCL: '*' },
  });

  const events = result.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line) as { type: string; tool?: string; ok?: boolean });
  assert.equal(events[0]?.type, 'turn_start');
  assert.ok(events.some((event) => event.type === 'tool_result' && event.tool === 'project_index'));
  assert.equal(events.at(-1)?.type, 'final');
  assert.equal(events.at(-1)?.ok, true);
  assert.equal(result.stderr, '');

  await rm(workspace, { recursive: true, force: true });
});

test('CLI --no-color suppresses ANSI escape sequences', async () => {
  // 隔离会话目录：不带 --session-dir 时 CLI 会往当前工作区（仓库根的
  // .aicode/sessions）写一条会话，于是每跑一次测试就在侧边栏多一个「你好」。
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-cli-nocolor-'));
  const result = await execFileAsync(process.execPath, [
    cliPath, '--provider', 'mock', '--approval', 'auto', '--no-color',
    '--workspace', workspace, '--session-dir', join(workspace, 'sessions'),
    '--prompt', '你好',
  ]);
  assert.doesNotMatch(result.stdout, /\u001b\[/);
  await rm(workspace, { recursive: true, force: true });
});

test('CLI --no-input exits nonzero without a prompt', async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [cliPath, '--provider', 'mock', '--no-input']),
    (error: unknown) => {
      const failure = error as { code?: number; stderr?: string };
      assert.equal(failure.code, 1);
      assert.match(failure.stderr ?? '', /No prompt supplied/);
      return true;
    },
  );
});

test('CLI doctor reports local readiness', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-cli-doctor-'));
  const result = await execFileAsync(process.execPath, [cliPath, '--provider', 'mock', '--workspace', workspace, '--session-dir', join(workspace, 'sessions'), '--doctor']);

  assert.match(result.stdout, /ok node:/);
  assert.match(result.stdout, /ok tools:/);
  assert.equal(result.stderr, '');

  await rm(workspace, { recursive: true, force: true });
});

test('CLI doctor supports JSON output', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-cli-doctor-json-'));
  const result = await execFileAsync(process.execPath, [cliPath, '--provider', 'mock', '--workspace', workspace, '--session-dir', join(workspace, 'sessions'), '--json', '--doctor']);
  const payload = JSON.parse(result.stdout.trim()) as { type: string; ok: boolean; checks: Array<{ name: string }> };

  assert.equal(payload.type, 'doctor');
  assert.equal(payload.ok, true);
  assert.ok(payload.checks.some((check) => check.name === 'sessionDir'));

  await rm(workspace, { recursive: true, force: true });
});

test('CLI prints bash completion script', async () => {
  const result = await execFileAsync(process.execPath, [cliPath, 'completion', 'bash']);

  assert.match(result.stdout, /complete -F _aicode_completion aicode/);
  assert.match(result.stdout, /--provider/);
  assert.equal(result.stderr, '');
});
