import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generatePrDescription, renderPrMarkdown } from '../src/prreview/prDescription.js';

const HEAVY_DIFF = [
  'diff --' + 'git a/src/app.ts b/src/app.ts',
  '@@ -1,3 +1,4 @@',
  ' a',
  '+b',
  ' c',
  ' d',
  'diff --' + 'git a/src/old.ts b/src/old.ts',
  'deleted file mode 100644',
  '@@ -1,1 +0,0 @@',
  '-x',
  'diff --' + 'git a/README.md b/README.md',
  'new file mode 100644',
  '@@ -0,0 +1,1 @@',
  '+docs',
].join('\n');

test('generatePrDescription aggregates stats and flags breaking deletes', () => {
  const desc = generatePrDescription({ diffA: HEAVY_DIFF, branchName: 'feature/demo', commits: ['fix: crash on boot'] });
  assert.equal(desc.conventionalType, 'fix');
  assert.equal(desc.breaking, false, '1 删除/3 文件 = 33% < 40% 阈值，不算破坏');
  assert.match(desc.title, /^fix: /);
  const srcDir = desc.impactDirs.find((d) => d.dir === 'src');
  assert.ok(srcDir && srcDir.files >= 2);
  assert.deepEqual(desc.deletedFiles, ['src/old.ts']);
  assert.deepEqual(desc.addedFiles, ['README.md']);
  assert.ok(desc.checklist.some((c) => c.includes('测试')));
});

test('generatePrDescription classifies pure docs change as docs', () => {
  const docDiff = [
    'diff --' + 'git a/docs/guide.md b/docs/guide.md',
    '@@ -1,1 +1,2 @@',
    ' text',
    '+added',
  ].join('\n');
  const desc = generatePrDescription({ diffA: docDiff, commits: ['docs: update guide'] });
  assert.equal(desc.conventionalType, 'docs');
  assert.equal(desc.breaking, false);
});

test('generatePrDescription honors explicit BREAKING markers in commits', () => {
  const desc = generatePrDescription({ diffA: HEAVY_DIFF, commits: ['chore: rename api! BREAKING CHANGE'] });
  assert.equal(desc.breaking, true);
});

test('renderPrMarkdown produces complete body sections', () => {
  const desc = generatePrDescription({ diffA: HEAVY_DIFF, branchName: 'feature/demo' });
  const md = renderPrMarkdown(desc);
  assert.match(md, /^## (fix|chore|feat|docs): /m);
  assert.match(md, /### 概述/);
  assert.match(md, /### 影响面/);
  assert.match(md, /### 自查清单/);
  if (desc.breaking) assert.match(md, /BREAKING CHANGE/);
});
