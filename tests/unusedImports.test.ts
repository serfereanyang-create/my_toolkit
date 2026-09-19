import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeFileUnusedImports } from '../src/prreview/unusedImports.js';

test('analyzeFileUnusedImports detects unused named/default/namespace', () => {
  const src = `
import defaultA from './a';
import { usedB, unusedB } from './b';
import * as ns from './c';

console.log(usedB, defaultA);
`;
  const list = analyzeFileUnusedImports('m.ts', src);
  const names = list.map((u) => u.localName).sort();
  assert.deepEqual(names, ['ns', 'unusedB']);
});
