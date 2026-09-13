const assert = require('node:assert/strict');
const { mkdtemp, mkdir, writeFile, utimes, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createQuickOpenIndex } = require('../electron/quick-open.cjs');
const { createWorkspaceService } = require('../electron/workspace.cjs');

async function fixture(files) {
  const root = await mkdtemp(path.join(tmpdir(), 'zcode-qopen-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  const service = createWorkspaceService();
  service.setRoot(root);
  const resolve = (p) => service.resolveInside(p);
  return {
    resolve,
    makeIndex: (opts) => createQuickOpenIndex(service.getRoot(), resolve, opts),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test('index lists files as forward-slash relative paths', async () => {
  const fx = await fixture({
    'src/app.ts': 'x',
    'README.md': 'y',
  });
  try {
    const idx = fx.makeIndex();
    const out = await idx.get(false);
    const paths = out.files.map((f) => f.path).sort();
    assert.deepEqual(paths, ['README.md', 'src/app.ts']);
    assert.equal(out.truncated, false);
  } finally { await fx.cleanup(); }
});

test('index skips hidden and ignored directories', async () => {
  const fx = await fixture({
    '.git/config': 'x',
    'node_modules/pkg/index.js': 'x',
    'dist/bundle.js': 'x',
    'src/keep.ts': 'x',
  });
  try {
    const out = await fx.makeIndex().get(false);
    assert.deepEqual(out.files.map((f) => f.path), ['src/keep.ts']);
  } finally { await fx.cleanup(); }
});

test('index keeps extensionless files but drops unknown extensions', async () => {
  const fx = await fixture({
    'Makefile': 'x',
    'notes.txt': 'x',
    'blob.bin': 'x',
    'image.png': 'x',
  });
  try {
    const out = await fx.makeIndex().get(false);
    const paths = out.files.map((f) => f.path).sort();
    assert.ok(paths.includes('Makefile'));
    assert.ok(paths.includes('notes.txt'));
    assert.ok(!paths.includes('blob.bin'));
    assert.ok(!paths.includes('image.png'));
  } finally { await fx.cleanup(); }
});

test('mtimeMs is recorded for each file', async () => {
  const fx = await fixture({ 'a.ts': 'x' });
  try {
    const out = await fx.makeIndex().get(false);
    assert.ok(out.files[0].mtimeMs > 0);
  } finally { await fx.cleanup(); }
});

test('second get within ttl returns cached flag without rewalking', async () => {
  const fx = await fixture({ 'a.ts': 'x' });
  try {
    const idx = fx.makeIndex();
    const first = await idx.get(false);
    assert.equal(first.cached, false);
    await writeFile(fx.resolve('b.ts'), 'y');
    const second = await idx.get(false);
    assert.equal(second.cached, true);
    assert.equal(second.files.length, 1);
  } finally { await fx.cleanup(); }
});

test('force rebuild picks up new files', async () => {
  const fx = await fixture({ 'a.ts': 'x' });
  try {
    const idx = fx.makeIndex();
    await idx.get(false);
    await writeFile(fx.resolve('b.ts'), 'y');
    const out = await idx.get(true);
    assert.equal(out.cached, false);
    assert.equal(out.files.length, 2);
  } finally { await fx.cleanup(); }
});

test('invalidate drops the cache', async () => {
  const fx = await fixture({ 'a.ts': 'x' });
  try {
    const idx = fx.makeIndex();
    await idx.get(false);
    idx.invalidate();
    const out = await idx.get(false);
    assert.equal(out.cached, false);
  } finally { await fx.cleanup(); }
});

test('expired ttl rebuilds', async () => {
  const fx = await fixture({ 'a.ts': 'x' });
  try {
    const idx = fx.makeIndex({ ttlMs: 0 });
    await idx.get(false);
    const out = await idx.get(false);
    assert.equal(out.cached, false);
  } finally { await fx.cleanup(); }
});

test('truncates at maxFiles and sets flag', async () => {
  const files = {};
  for (let i = 0; i < 20; i++) files['f' + i + '.ts'] = 'x';
  const fx = await fixture(files);
  try {
    const out = await fx.makeIndex({ maxFiles: 5 }).get(false);
    assert.equal(out.files.length, 5);
    assert.equal(out.truncated, true);
  } finally { await fx.cleanup(); }
});

test('concurrent gets share one walk', async () => {
  const fx = await fixture({ 'a.ts': 'x' });
  try {
    const idx = fx.makeIndex();
    const [a, b] = await Promise.all([idx.get(false), idx.get(false)]);
    assert.equal(a.files.length, 1);
    assert.equal(b.files.length, 1);
    assert.equal(a.cached, false);
    assert.equal(b.cached, false);
  } finally { await fx.cleanup(); }
});

test('unreadable root yields empty index instead of throwing', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zcode-qopen-miss-'));
  const service = createWorkspaceService();
  service.setRoot(dir);
  const root = service.getRoot();
  await rm(dir, { recursive: true, force: true });
  const idx = createQuickOpenIndex(root, (p) => service.resolveInside(p));
  const out = await idx.get(false);
  assert.deepEqual(out.files, []);
});
