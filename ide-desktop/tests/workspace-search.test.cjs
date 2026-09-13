const assert = require('node:assert/strict');
const { mkdtemp, mkdir, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { searchWorkspaceText, globToRegExp, looksBinary } = require('../electron/workspace-search.cjs');
const { createWorkspaceService } = require('../electron/workspace.cjs');

async function fixture(files) {
  const root = await mkdtemp(path.join(tmpdir(), 'zcode-search-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, typeof content === 'string' ? content : Buffer.from(content));
  }
  const service = createWorkspaceService();
  service.setRoot(root);
  return {
    root: service.getRoot(),
    resolve: (p) => service.resolveInside(p),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test('search finds literal matches with line and column', async () => {
  const fx = await fixture({
    'src/app.ts': 'export function greet() {\n  return "hello world";\n}\n',
  });
  try {
    const out = await searchWorkspaceText(fx.root, fx.resolve, 'hello');
    assert.equal(out.results.length, 1);
    const hit = out.results[0];
    assert.equal(hit.path, 'src/app.ts');
    assert.equal(hit.line, 2);
    assert.equal(hit.column, 11);
    assert.equal(hit.matched, 'hello');
  } finally { await fx.cleanup(); }
});

test('search is case-insensitive by default and strict with caseSensitive', async () => {
  const fx = await fixture({ 'a.txt': 'Alpha ALPHA alpha\n' });
  try {
    const loose = await searchWorkspaceText(fx.root, fx.resolve, 'alpha');
    // One match per line only (first hit per line), line 1 contains all three.
    assert.equal(loose.results.length, 1);
    assert.ok(loose.results[0].matched.toLowerCase() === 'alpha');
    const strict = await searchWorkspaceText(fx.root, fx.resolve, 'ALPHA', { caseSensitive: true });
    assert.equal(strict.results.length, 1);
    assert.equal(strict.results[0].matched, 'ALPHA');
  } finally { await fx.cleanup(); }
});

test('whole-word mode ignores substring hits', async () => {
  const fx = await fixture({ 'w.txt': 'cat catalog category\n' });
  try {
    const partial = await searchWorkspaceText(fx.root, fx.resolve, 'cat');
    assert.equal(partial.results.length, 1); // first match per line
    const whole = await searchWorkspaceText(fx.root, fx.resolve, 'cat', { wholeWord: true });
    assert.equal(whole.results.length, 1);
    assert.equal(whole.results[0].column, 1); // matched the standalone "cat"
  } finally { await fx.cleanup(); }
});

test('regex mode compiles patterns and rejects invalid ones', async () => {
  const fx = await fixture({ 'n.txt': 'value = 42 and 7\n' });
  try {
    const out = await searchWorkspaceText(fx.root, fx.resolve, '\\d+', { regex: true });
    assert.equal(out.results[0].matched, '42');
    await assert.rejects(
      () => searchWorkspaceText(fx.root, fx.resolve, '[unclosed', { regex: true }),
      /无效的正则表达式/,
    );
  } finally { await fx.cleanup(); }
});

test('skips node_modules, hidden dirs and binary files', async () => {
  const fx = await fixture({
    'node_modules/pkg/i.js': 'needle',
    '.hidden/i.txt': 'needle',
    'assets/blob.bin': [0x00, 0x01, 0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65], // NUL => binary
    'real/i.ts': 'needle',
  });
  try {
    const out = await searchWorkspaceText(fx.root, fx.resolve, 'needle');
    assert.equal(out.results.length, 1);
    assert.equal(out.results[0].path, 'real/i.ts');
    assert.ok(out.skippedBinary >= 0); // binary skipped via ext or sniff
  } finally { await fx.cleanup(); }
});

test('include glob restricts candidate files', async () => {
  const fx = await fixture({
    'src/a.ts': 'needle',
    'src/a.js': 'needle',
    'docs/readme.md': 'needle',
  });
  try {
    const out = await searchWorkspaceText(fx.root, fx.resolve, 'needle', { include: '*.ts' });
    assert.equal(out.results.length, 1);
    assert.equal(out.results[0].path, 'src/a.ts');
    // Rooted glob anchors to the folder given.
    const both = await searchWorkspaceText(fx.root, fx.resolve, 'needle', { include: 'src/*.ts' });
    assert.equal(both.results.length, 1);
    assert.equal(both.results[0].path, 'src/a.ts');
  } finally { await fx.cleanup(); }
});

test('exclude glob drops files', async () => {
  const fx = await fixture({
    'src/a.ts': 'needle',
    'src/generated/b.ts': 'needle',
  });
  try {
    const out = await searchWorkspaceText(fx.root, fx.resolve, 'needle', { exclude: 'src/generated/**' });
    assert.equal(out.results.length, 1);
    assert.equal(out.results[0].path, 'src/a.ts');
  } finally { await fx.cleanup(); }
});

test('path scope confines the walk to a subfolder', async () => {
  const fx = await fixture({
    'src/a.ts': 'needle',
    'lib/b.ts': 'needle',
  });
  try {
    const out = await searchWorkspaceText(fx.root, fx.resolve, 'needle', { path: 'src' });
    assert.equal(out.results.length, 1);
    assert.equal(out.results[0].path, 'src/a.ts');
  } finally { await fx.cleanup(); }
});

test('maxResults truncates and flags', async () => {
  const many = {};
  for (let i = 0; i < 20; i += 1) many[`f${i}.txt`] = `hit ${i}\n`;
  const fx = await fixture(many);
  try {
    const out = await searchWorkspaceText(fx.root, fx.resolve, 'hit', { maxResults: 5 });
    assert.equal(out.results.length, 5);
    assert.equal(out.truncated, true);
  } finally { await fx.cleanup(); }
});

test('matches carry 2 lines of context on each side', async () => {
  const fx = await fixture({ 'ctx.ts': 'a\nb\nc\nd\ne\nf\ng' });
  try {
    const out = await searchWorkspaceText(fx.root, fx.resolve, 'd');
    const hit = out.results[0];
    assert.equal(hit.line, 4);
    assert.equal(hit.context.length, 5); // lines 2..6
    assert.equal(hit.context[2].matched, true);
  } finally { await fx.cleanup(); }
});

test('globToRegExp semantics', () => {
  assert.ok(globToRegExp('*.ts').test('src/deep/a.ts')); // bare name matches anywhere
  assert.ok(!globToRegExp('*.ts').test('src/a.js'));
  assert.ok(globToRegExp('src/**/*.tsx').test('src/components/x.tsx'));
  assert.ok(globToRegExp('src/**/*.tsx').test('src/x.tsx')); // ** may match zero dirs
  assert.ok(globToRegExp('package.json').test('package.json'));
  assert.ok(globToRegExp('package.json').test('sub/package.json')); // bare name: any depth
  assert.ok(globToRegExp('/package.json').test('package.json')); // leading slash anchors
  assert.ok(!globToRegExp('/package.json').test('sub/package.json'));
  assert.ok(!globToRegExp('src/*.ts').test('src/deep/a.ts')); // rooted single-star does not cross dirs
});

test('looksBinary sniffs NUL and control density', () => {
  assert.equal(looksBinary(Buffer.from('plain text')), false);
  assert.equal(looksBinary(Buffer.from([0x74, 0x00, 0x65])), true);
  assert.equal(looksBinary(Buffer.from([1, 2, 3, 4, 5, 31, 30, 29, 28, 27])), true);
});
