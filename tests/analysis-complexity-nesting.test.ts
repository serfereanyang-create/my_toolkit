/**
 * analysis-complexity-nesting.test.ts — 复杂度统计不能把内层函数算进外层
 *
 * 旧实现里三个 visitor 都会继续下钻到嵌套函数：外层函数的圈复杂度把内层函数
 * 的 if 也算上（实测外层 3，正确值 2），函数越多层越虚高。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as ts from 'typescript';
import {
  analyzeFunctionComplexity,
  analyzeFileComplexity,
} from '../src/analysis/complexity.js';

function parse(code: string): ts.SourceFile {
  return ts.createSourceFile('sample.ts', code, ts.ScriptTarget.Latest, true);
}

const NESTED = [
  'function outer(a: boolean) {',
  '  function inner(b: boolean) {',
  '    if (b) { return 1; }',
  '    return 0;',
  '  }',
  '  if (a) { return inner(a); }',
  '  return 0;',
  '}',
  '',
].join('\n');

test('outer function does not inherit nested function decisions (cyclomatic)', () => {
  const sf = parse(NESTED);
  const outer = sf.statements.find(ts.isFunctionDeclaration)!;
  const metrics = analyzeFunctionComplexity(outer, sf).metrics;
  // 圈复杂度 = 1 + 判定点；outer 本身只有 `if (a)` 一个。
  assert.equal(metrics.cyclomatic, 2, `outer 圈复杂度应为 2，实际 ${metrics.cyclomatic}`);
});

test('nested function itself still counts its own decisions', () => {
  const sf = parse(NESTED);
  const outer = sf.statements.find(ts.isFunctionDeclaration)!;
  const inner = (outer.body as ts.Block).statements.find(ts.isFunctionDeclaration)!;
  const metrics = analyzeFunctionComplexity(inner, sf).metrics;
  assert.equal(metrics.cyclomatic, 2);
  assert.equal(metrics.maxNesting, 1);
});

test('arrow-function callback decisions are not charged to the enclosing function', () => {
  const code = [
    'export function collect(xs: number[]) {',
    '  return xs.map((x) => {',
    '    if (x > 0) return x * 2;',
    '    return x;',
    '  });',
    '}',
    '',
  ].join('\n');
  const sf = parse(code);
  const fn = sf.statements.find(ts.isFunctionDeclaration)!;
  const metrics = analyzeFunctionComplexity(fn, sf).metrics;
  assert.equal(metrics.cyclomatic, 1, `回调里的 if 不应算在外层，实际 ${metrics.cyclomatic}`);
});

test('file-level analysis still lists both functions', () => {
  const file = analyzeFileComplexity(parse(NESTED));
  assert.deepEqual(file.functions.map((f) => f.name).sort(), ['inner', 'outer']);
  assert.equal(file.functions.find((f) => f.name === 'outer')!.metrics.cyclomatic, 2);
});
