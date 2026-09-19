import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeFileComments } from '../src/prreview/commentDensity.js';

test('analyzeFileComments splits comment/blank/code lines and detects jsdoc', () => {
  const src = `// heading
const x = 1;

/**
 * Doc block
 */
const y = 2;`;
  const s = analyzeFileComments('a.ts', src);
  assert.equal(s.totalLines, 7);
  assert.deepEqual(
    { c: s.commentLines, b: s.blankLines, code: s.codeLines, jsdoc: s.jsdocBlocks },
    { c: 4, b: 1, code: 2, jsdoc: 1 },
  );
});
