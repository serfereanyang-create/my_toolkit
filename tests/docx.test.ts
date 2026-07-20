import assert from 'node:assert/strict';
import { access, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createDefaultToolRegistry } from '../src/tools/index.js';

test('create_docx creates a Word document on the Desktop', async () => {
  const registry = createDefaultToolRegistry();
  const fileName = `aicode-docx-test-${Date.now()}.docx`;
  const result = await registry.execute(
    'create_docx',
    { path: `desktop/${fileName}`, title: 'AICODE DOCX TEST', body: 'Created by create_docx.' },
    { workspaceRoot: process.cwd(), approval: 'auto' },
  );

  assert.equal(result.ok, true);
  const target = join(homedir(), 'Desktop', fileName);
  await access(target);
  const header = await readFile(target);
  assert.equal(header.subarray(0, 2).toString('utf8'), 'PK');

  await rm(target, { force: true });
});
