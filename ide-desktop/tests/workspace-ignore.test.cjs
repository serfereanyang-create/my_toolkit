'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  ensureIgnoreRules,
  builtinTemplateContent,
  IGNORE_FILE_NAME,
  BUILTIN_IGNORE_LINES,
} = require('../electron/workspace-ignore.cjs');

async function makeRoot(files = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wsignore-'));
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(root, name), content, 'utf-8');
  }
  return root;
}

test('creates .zcodeignore from .gitignore when one exists', async () => {
  const root = await makeRoot({ '.gitignore': 'build/\n*.log\n' });
  try {
    const { matcher, source } = await ensureIgnoreRules(root);
    assert.equal(source, 'created-from-gitignore');
    assert.equal(matcher.ignores('build/x.js'), true);
    assert.equal(matcher.ignores('debug.log'), true);
    assert.equal(matcher.ignores('src/a.ts'), false);
    const created = await fs.readFile(path.join(root, IGNORE_FILE_NAME), 'utf-8');
    assert.equal(created, 'build/\n*.log\n');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('creates the builtin template when no .gitignore exists', async () => {
  const root = await makeRoot();
  try {
    const { matcher, source } = await ensureIgnoreRules(root);
    assert.equal(source, 'created-from-template');
    assert.equal(matcher.ignores('node_modules/pkg/index.js'), true);
    assert.equal(matcher.ignores('src/a.ts'), false);
    assert.ok((await fs.readFile(path.join(root, IGNORE_FILE_NAME), 'utf-8')).includes('node_modules/'));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('an existing .zcodeignore is authoritative and supports negation', async () => {
  const root = await makeRoot({
    '.gitignore': 'should-not-win/\n',
    [IGNORE_FILE_NAME]: 'dist/\n*.log\n!important.log\n',
  });
  try {
    const { matcher, source } = await ensureIgnoreRules(root);
    assert.equal(source, 'file');
    assert.equal(matcher.ignores('dist/a.js'), true);
    assert.equal(matcher.ignores('debug.log'), true);
    assert.equal(matcher.ignores('important.log'), false, 'negation wins');
    assert.equal(matcher.ignores('should-not-win/x'), false, '.gitignore no longer affects search');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('template carries the builtin exclusion set', () => {
  for (const required of ['.git/', 'node_modules/', '__pycache__/', '.aicode/']) {
    assert.ok(BUILTIN_IGNORE_LINES.includes(required), `template includes ${required}`);
  }
  assert.ok(builtinTemplateContent().includes('.gitignore'));
});
