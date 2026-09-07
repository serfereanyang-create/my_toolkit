import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createDefaultToolRegistry } from '../src/tools/index.js';
import { isAutoAllowedCommand, isAutoAllowedWrite, isBlockedCommand } from '../src/safety/policy.js';

test('auto mode allows writing ordinary files inside the workspace', () => {
  const workspace = 'C:/work/app';
  assert.equal(isAutoAllowedWrite(workspace, 'note.md'), true);
  assert.equal(isAutoAllowedWrite(workspace, 'docs/guide.md'), true);
  assert.equal(isAutoAllowedWrite(workspace, 'src/index.ts'), true);
});

test('auto mode still refuses writes to protected workspace internals', () => {
  const workspace = 'C:/work/app';
  assert.equal(isAutoAllowedWrite(workspace, '.git/config'), false);
  assert.equal(isAutoAllowedWrite(workspace, 'node_modules/pkg/index.js'), false);
});

test('auto mode refuses writes that escape the workspace', () => {
  const workspace = 'C:/work/app';
  assert.throws(() => isAutoAllowedWrite(workspace, '../outside.txt'));
});

test('auto mode auto-approves a real workspace write end to end', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-auto-'));
  const registry = createDefaultToolRegistry();
  const result = await registry.execute(
    'write_file',
    { path: 'note.md', content: 'hello world\n' },
    { workspaceRoot: workspace, approval: 'auto' },
  );
  assert.equal(result.ok, true);
  assert.equal(await readFile(join(workspace, 'note.md'), 'utf8'), 'hello world\n');
  await rm(workspace, { recursive: true, force: true });
});

test('command policy allows read-only Windows disk inspection', () => {
  const command = 'powershell -NoProfile -Command "Get-PSDrive -Name C | Select-Object Name, @{Name=\'UsedGB\';Expression={[math]::Round($_.Used/1GB,2)}}, @{Name=\'FreeGB\';Expression={[math]::Round($_.Free/1GB,2)}}"';

  assert.equal(isBlockedCommand(command), false);
  assert.equal(isAutoAllowedCommand(command), true);
});

test('ask approval blocks write tools without a confirmation handler', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-approval-'));
  const registry = createDefaultToolRegistry();
  const result = await registry.execute('write_file', { path: '.smoke/ask.md', content: 'x' }, { workspaceRoot: workspace, approval: 'ask' });

  assert.equal(result.ok, false);
  assert.match(result.output, /no confirmation handler/);

  await rm(workspace, { recursive: true, force: true });
});

test('ask approval runs write tools after confirmation', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-approval-'));
  const registry = createDefaultToolRegistry();
  const prompts: string[] = [];
  const result = await registry.execute(
    'write_file',
    { path: '.smoke/ask.md', content: 'approved' },
    {
      workspaceRoot: workspace,
      approval: 'ask',
      confirm: async (message) => {
        prompts.push(message);
        return true;
      },
    },
  );

  assert.equal(result.ok, true);
  assert.match(prompts[0] ?? '', /Approve write tool write_file/);
  assert.equal(await readFile(join(workspace, '.smoke', 'ask.md'), 'utf8'), 'approved');

  await rm(workspace, { recursive: true, force: true });
});

test('ask approval cancels write tools when rejected', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-approval-'));
  const registry = createDefaultToolRegistry();
  const result = await registry.execute('write_file', { path: '.smoke/ask.md', content: 'rejected' }, { workspaceRoot: workspace, approval: 'ask', confirm: async () => false });

  assert.equal(result.ok, false);
  assert.match(result.output, /cancelled by user/);

  await rm(workspace, { recursive: true, force: true });
});

test('ask approval uses Chinese prompt when locale is zh', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-approval-zh-'));
  const registry = createDefaultToolRegistry();
  const prompts: string[] = [];
  const result = await registry.execute(
    'write_file',
    { path: '.smoke/ask-zh.md', content: 'ok' },
    {
      workspaceRoot: workspace,
      approval: 'ask',
      locale: 'zh',
      confirm: async (message) => {
        prompts.push(message);
        return true;
      },
    },
  );

  assert.equal(result.ok, true);
  assert.match(prompts[0] ?? '', /是否批准写入工具 write_file/);
  assert.doesNotMatch(prompts[0] ?? '', /^Approve /);

  await rm(workspace, { recursive: true, force: true });
});

test('ask approval cancels with Chinese outcome when locale is zh', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-approval-zh-cancel-'));
  const registry = createDefaultToolRegistry();
  const result = await registry.execute(
    'write_file',
    { path: '.smoke/ask.md', content: 'rejected' },
    { workspaceRoot: workspace, approval: 'ask', locale: 'zh', confirm: async () => false },
  );

  assert.equal(result.ok, false);
  assert.match(result.output, /已由用户取消/);
  await rm(workspace, { recursive: true, force: true });
});

test('write approval exposes a real diff and deny leaves write_file unchanged', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-diff-write-'));
  const target = join(workspace, 'note.md');
  await writeFile(target, 'before\n', 'utf8');
  const registry = createDefaultToolRegistry();
  let request: { diff?: { path: string; originalContent: string; modifiedContent: string } } | undefined;
  const result = await registry.execute('write_file', { path: 'note.md', content: 'after\n' }, {
    workspaceRoot: workspace,
    approval: 'ask',
    confirm: async (_message, approval) => { request = approval; return false; },
  });

  assert.equal(result.ok, false);
  assert.equal(request?.diff?.path, 'note.md');
  assert.equal(request?.diff?.originalContent, 'before\n');
  assert.equal(request?.diff?.modifiedContent, 'after\n');
  assert.equal(await readFile(target, 'utf8'), 'before\n');
  await rm(workspace, { recursive: true, force: true });
});

test('patch and line-edit approvals expose transformed content without writing on deny', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-diff-tools-'));
  const patchPath = join(workspace, 'patch.txt');
  const linesPath = join(workspace, 'lines.txt');
  await writeFile(patchPath, 'one\ntwo\n', 'utf8');
  await writeFile(linesPath, 'a\nb\nc\n', 'utf8');
  const registry = createDefaultToolRegistry();
  const requests: Array<{ diff?: { path: string; originalContent: string; modifiedContent: string } }> = [];
  const confirm = async (_message: string, approval?: { diff?: { path: string; originalContent: string; modifiedContent: string } }) => {
    if (approval) requests.push(approval);
    return false;
  };

  const patchResult = await registry.execute('apply_patch', { path: 'patch.txt', oldText: 'two', newText: 'TWO' }, { workspaceRoot: workspace, approval: 'ask', confirm });
  const editResult = await registry.execute('edit_lines', { path: 'lines.txt', start: 2, end: 2, mode: 'replace', text: 'B' }, { workspaceRoot: workspace, approval: 'ask', confirm });

  assert.equal(patchResult.ok, false);
  assert.equal(editResult.ok, false);
  assert.deepEqual(requests.map((item) => item.diff?.modifiedContent), ['one\nTWO\n', 'a\nB\nc\n']);
  assert.equal(await readFile(patchPath, 'utf8'), 'one\ntwo\n');
  assert.equal(await readFile(linesPath, 'utf8'), 'a\nb\nc\n');
  await rm(workspace, { recursive: true, force: true });
});
