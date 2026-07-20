import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createDefaultToolRegistry } from '../src/tools/index.js';
import { isAutoAllowedCommand, isBlockedCommand } from '../src/safety/policy.js';

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
