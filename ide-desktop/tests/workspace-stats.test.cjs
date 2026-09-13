const assert = require('node:assert/strict');
const { mkdtemp, mkdir, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { scanWorkspaceStats, classifyLine } = require('../electron/workspace-stats.cjs');
const { createWorkspaceService } = require('../electron/workspace.cjs');

async function fixture(files) {
  const root = await mkdtemp(path.join(tmpdir(), 'zcode-stats-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  const service = createWorkspaceService();
  service.setRoot(root);
  return {
    root: service.getRoot(),
    resolve: (p) => service.resolveInside(p),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test('classifyLine handles code/comment/blank and block state (cstyle)', () => {
  assert.deepEqual(classifyLine('  ', false, 'cstyle'), { kind: 'blank', inBlock: false });
  assert.deepEqual(classifyLine('let x = 1;', false, 'cstyle'), { kind: 'code', inBlock: false });
  assert.deepEqual(classifyLine('// hi', false, 'cstyle'), { kind: 'comment', inBlock: false });
  assert.deepEqual(classifyLine('/* open', false, 'cstyle'), { kind: 'comment', inBlock: true });
  assert.deepEqual(classifyLine('middle', true, 'cstyle'), { kind: 'comment', inBlock: true });
  assert.deepEqual(classifyLine('*/', true, 'cstyle'), { kind: 'comment', inBlock: false });
  assert.deepEqual(classifyLine('*/ let y = 2;', true, 'cstyle'), { kind: 'code', inBlock: false });
  assert.deepEqual(classifyLine('a(); /* trailing */ b();', false, 'cstyle'), { kind: 'code', inBlock: false });
  assert.deepEqual(classifyLine('let z = 1; /* starts block', false, 'cstyle'), { kind: 'code', inBlock: true });
});

test('classifyLine handles hash and markup families', () => {
  assert.deepEqual(classifyLine('# comment', false, 'hash'), { kind: 'comment', inBlock: false });
  assert.deepEqual(classifyLine('key: value', false, 'hash'), { kind: 'code', inBlock: false });
  assert.deepEqual(classifyLine('<!-- note -->', false, 'markup'), { kind: 'code', inBlock: false }); // closed on same line
  assert.deepEqual(classifyLine('<!-- open', false, 'markup'), { kind: 'comment', inBlock: true });
  assert.deepEqual(classifyLine('still inside', true, 'markup'), { kind: 'comment', inBlock: true });
});

test('empty workspace reports zeroes', async () => {
  const fx = await fixture({});
  try {
    const stats = await scanWorkspaceStats(fx.root, fx.resolve);
    assert.equal(stats.totalFiles, 0);
    assert.equal(stats.totalLines, 0);
    assert.deepEqual(stats.languages, []);
  } finally { await fx.cleanup(); }
});

test('counts per-language files and line classes', async () => {
  const fx = await fixture({
    'src/a.ts': 'import x from "y";\n\n// note\nconst a = 1;\n/* block\nmore\n*/ end();\n',
    'README.md': '# title\n\nsome text\n',
  });
  try {
    const stats = await scanWorkspaceStats(fx.root, fx.resolve);
    assert.equal(stats.totalFiles, 2);
    const ts = stats.languages.find((l) => l.language === 'TypeScript');
    assert.equal(ts.files, 1);
    // Lines: import / blank / note / const / /* block / more / */ end
    assert.equal(ts.lines, 7);
    assert.equal(ts.comment, 3); // // note, /* block, more
    assert.equal(ts.blank, 1);
    assert.equal(ts.code, 3); // import, const, */ end();
    const md = stats.languages.find((l) => l.language === 'Markdown');
    assert.equal(md.files, 1);
    assert.equal(md.lines, 3);
  } finally { await fx.cleanup(); }
});

test('aggregates totals and directory weights', async () => {
  const fx = await fixture({
    'src/x.ts': 'a\nb\nc\n',
    'src/deep/y.ts': 'd\ne\n',
    'lib/z.js': 'z\n',
  });
  try {
    const stats = await scanWorkspaceStats(fx.root, fx.resolve);
    assert.equal(stats.totalLines, 6);
    const srcDir = stats.directories.find((d) => d.dir === 'src');
    assert.equal(srcDir.files, 2);
    const libDir = stats.directories.find((d) => d.dir === 'lib');
    assert.equal(libDir.files, 1);
  } finally { await fx.cleanup(); }
});

test('collects TODO/FIXME markers with locations', async () => {
  const fx = await fixture({
    'w/a.ts': 'const a = 1; // TODO: refactor this\n',
    'w/b.ts': '// FIXME missing input\nlet b = 2;\n// no marker here TODObutglued\n',
  });
  try {
    const stats = await scanWorkspaceStats(fx.root, fx.resolve);
    assert.equal(stats.todoCount, 2);
    const fixme = stats.todos.find((t) => t.text.includes('FIXME'));
    assert.equal(fixme.line, 1);
  } finally { await fx.cleanup(); }
});

test('largestFiles sorted by bytes descending', async () => {
  const fx = await fixture({
    'big.ts': 'x'.repeat(500),
    'small.ts': 'x',
  });
  try {
    const stats = await scanWorkspaceStats(fx.root, fx.resolve);
    assert.equal(stats.largestFiles[0].path, 'big.ts');
    assert.equal(stats.largestFiles.length, 2);
  } finally { await fx.cleanup(); }
});

test('skips ignored dirs and node_modules', async () => {
  const fx = await fixture({
    'src/a.ts': 'a\n',
    'node_modules/dep/i.ts': 'b\n',
    '.hidden/c.ts': 'c\n',
  });
  try {
    const stats = await scanWorkspaceStats(fx.root, fx.resolve);
    assert.equal(stats.totalFiles, 1);
    assert.equal(stats.languages[0].files, 1);
  } finally { await fx.cleanup(); }
});

test('path option scopes the census to a subfolder', async () => {
  const fx = await fixture({
    'src/a.ts': 'a\n',
    'lib/b.js': 'b\n',
  });
  try {
    const stats = await scanWorkspaceStats(fx.root, fx.resolve, { path: 'src' });
    assert.equal(stats.totalFiles, 1);
  } finally { await fx.cleanup(); }
});

test('binary-ish or unknown-extension files are excluded from the census', async () => {
  const fx = await fixture({
    'src/a.ts': 'x\n',
    'assets/logo.png': 'not really png bytes',
  });
  try {
    const stats = await scanWorkspaceStats(fx.root, fx.resolve);
    assert.equal(stats.totalFiles, 1);
  } finally { await fx.cleanup(); }
});
