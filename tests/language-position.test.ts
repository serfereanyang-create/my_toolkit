import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { completionsAt, definitionAt, hoverAt, referencesAt } from '../src/language/tsService.js';

/*
 * Bridge 的入参由编辑器直接给出：行号可能是 0、负数、超过文件末尾，
 * 文件可能带 BOM，行尾可能混用。这些以前会让长驻子进程抛异常或把
 * 第 1 行的位置算偏一列；位置换算必须收敛在这些边界上。
 */

const workspaceOf = () => mkdtemp(join(tmpdir(), 'aicode-lang-'));

test('CRLF 文件上 hover / definition / references 的行列仍准确', async () => {
  const dir = await workspaceOf();
  await writeFile(
    join(dir, 'a.ts'),
    'const alpha = 1;\r\nconst beta = alpha + 1;\r\nfunction f(x: number) { return x * 2; }\r\nf(beta);\r\n',
  );
  const hover = hoverAt(dir, 'a.ts', 2, 14);
  assert.equal(hover?.type, 'const alpha: 1');
  assert.deepEqual(hover?.range, { line: 2, column: 14, endLine: 2, endColumn: 19 });

  const defs = definitionAt(dir, 'a.ts', 2, 14);
  assert.equal(defs.length, 1);
  assert.deepEqual(defs[0]!.range, { line: 1, column: 7, endLine: 1, endColumn: 12 });

  const refs = referencesAt(dir, 'a.ts', 3, 10);
  assert.ok(refs.some((ref) => ref.range.line === 4 && ref.range.column === 1));
});

test('越界/非法的行号不抛错：0、负数按 1 处理，超过末行按文件末尾处理', async () => {
  const dir = await workspaceOf();
  await writeFile(join(dir, 'a.ts'), 'const alpha = 1;\nconst beta = alpha + 1;\n');
  for (const [line, column] of [[0, 0], [-5, -2], [0, 999], [999, 3], [2, 0], [2, 999]]) {
    assert.doesNotThrow(() => hoverAt(dir, 'a.ts', line, column), `hover(${line},${column})`);
    assert.doesNotThrow(() => completionsAt(dir, 'a.ts', line, column, 5), `completions(${line},${column})`);
  }
  // 第 1 行第 7 列就是 alpha；0 行被夹到 1 行，结果必须一致而不是 null。
  assert.equal(hoverAt(dir, 'a.ts', 0, 7)?.type, hoverAt(dir, 'a.ts', 1, 7)?.type);
  assert.equal(hoverAt(dir, 'a.ts', -3, 7)?.type, 'const alpha: 1');
});

test('UTF-8 BOM 不让第 1 列的换算整体右移', async () => {
  const dir = await workspaceOf();
  await writeFile(join(dir, 'bom.ts'), '﻿const alpha = 1;\nconst beta = alpha + 1;\n');
  assert.equal(hoverAt(dir, 'bom.ts', 1, 7)?.type, 'const alpha: 1');
  assert.equal(hoverAt(dir, 'bom.ts', 2, 14)?.type, 'const alpha: 1');
});
