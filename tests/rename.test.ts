import assert from 'node:assert/strict';
import { access, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { planLocalFallback } from '../src/agent/fallback.js';
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
