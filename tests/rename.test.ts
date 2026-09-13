import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { planLocalFallback } from '../src/agent/fallback.js';
import { CheckpointStore } from '../src/session/checkpoint.js';
import type { SessionRecord } from '../src/session/store.js';
import { createDefaultToolRegistry } from '../src/tools/index.js';

test('rename_file renames a Desktop docx file', async () => {
  const registry = createDefaultToolRegistry();
  const fromName = `aicode-rename-from-${Date.now()}.docx`;
  const toName = `aicode-rename-to-${Date.now()}.docx`;
  const from = join(homedir(), 'Desktop', fromName);
  const to = join(homedir(), 'Desktop', toName);
  await writeFile(from, 'placeholder');

  const result = await registry.execute('rename_file', { from: `desktop/${fromName}`, to: `desktop/${toName}` }, { workspaceRoot: process.cwd(), approval: 'auto' });

  assert.equal(result.ok, true);
  await access(to);
  assert.equal(await readFile(to, 'utf8'), 'placeholder');

  await rm(to, { force: true });
});

test('rename_file reports path and checkpointId for the undo rollup', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-rename-cp-'));
  const relativeFrom = 'notes/original.md';
  const relativeTo = 'notes/renamed.md';
  const from = join(workspace, relativeFrom);
  const to = join(workspace, relativeTo);
  await mkdir(join(workspace, 'notes'), { recursive: true });
  await writeFile(from, 'hello');
  const checkpoints = new CheckpointStore(workspace);
  const registry = createDefaultToolRegistry();

  const result = await registry.execute(
    'rename_file',
    { from: relativeFrom, to: relativeTo },
    { workspaceRoot: workspace, approval: 'auto', checkpoints },
  );

  assert.equal(result.ok, true);
  const data = result.data as { from: string; to: string; path: string; checkpointId?: string };
  assert.equal(data.from, from);
  assert.equal(data.to, to);
  assert.equal(data.path, to, 'data.path should be the resulting (new) path');
  assert.match(data.checkpointId ?? '', /^cp_/, 'checkpointId should reference the rename undo entry');

  const entries = await checkpoints.list();
  assert.ok(entries.some((entry) => entry.id === data.checkpointId && entry.action === 'rename' && entry.from === from && entry.to === to));

  await rm(workspace, { recursive: true, force: true });
});

test('local fallback plans rename for the previously created document', () => {
  const session: SessionRecord = {
    id: 'sess_test',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    provider: 'openai',
    model: 'gpt-5.5',
    workspaceRoot: process.cwd(),
    messages: [
      { role: 'user', content: '新建个word放到桌面', createdAt: new Date().toISOString() },
      { role: 'assistant', content: '已在桌面新建 Word 文档', createdAt: new Date().toISOString() },
      { role: 'user', content: '更改他的名字为测试文档', createdAt: new Date().toISOString() },
    ],
    toolCalls: [
      {
        id: 'tool_1',
        tool: 'create_docx',
        input: { path: 'desktop/新建文档.docx' },
        ok: true,
        output: 'Created Word document: C:/Users/example/Desktop/新建文档.docx',
        data: { path: 'C:/Users/example/Desktop/新建文档.docx' },
        createdAt: new Date().toISOString(),
      },
    ],
    finalAnswers: ['已在桌面新建 Word 文档'],
  };

  assert.deepEqual(planLocalFallback('更改他的名字为测试文档', session), [
    { type: 'tool', tool: 'rename_file', input: { from: 'desktop/新建文档.docx', to: 'desktop/测试文档.docx' } },
  ]);
});
