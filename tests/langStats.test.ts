import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeFileText, classify } from '../src/workspace/langStats.js';

test('classify extension to language', () => {
  assert.equal(classify('/x/Foo.ts'), 'TypeScript');
  assert.equal(classify('/x/Foo.py'), 'Python');
  assert.equal(classify('/x/Foo.unknown'), null);
});

test('analyzeFileText buckets lines correctly', () => {
  const src = `// leading comment
const x = 1;
/* multi
 * line
 */
function foo() {
  return 1;
}`;
  const s = analyzeFileText(src);
  assert.equal(s.total, 8);
  assert.equal(s.blank, 0);
  assert.equal(s.comment, 4); // leading + 3 block lines
  assert.equal(s.code, 4); // const + function + return + }
});
