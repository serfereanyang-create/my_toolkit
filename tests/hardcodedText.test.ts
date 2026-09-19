import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeFile } from '../src/prreview/hardcodedText.js';

test('analyzeFile finds Chinese string literals, skips imports and t()', () => {
  const source = `
import { hello } from './util';
const a = '确定要删除吗？';
const b = t('取消操作');
const c = './中文路径.ts';
const jsx = <div>确认提交</div>;
const plain = 'ok';
`;
  const hits = analyzeFile('sample.tsx', source);
  const texts = hits.map((h) => h.text);
  assert.ok(texts.includes('确定要删除吗？'));
  assert.ok(texts.includes('确认提交'));
  assert.ok(!texts.includes('取消操作'), 't() 包裹的应被跳过');
  assert.ok(!texts.includes('./中文路径.ts'), '模块路径不算');
});

test('analyzeFile marks JSX usage', () => {
  const source = 'const jsx = <button>提交审核</button>;';
  const hits = analyzeFile('x.tsx', source);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.inJsx, true);
  assert.equal(hits[0]!.text, '提交审核');
});
