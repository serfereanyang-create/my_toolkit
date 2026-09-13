const assert = require('node:assert/strict');
const { mkdtemp, mkdir, writeFile, readFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createBookmarkStore, sanitizeRelPath, normalizeLine } = require('../electron/bookmarks-store.cjs');

async function freshWorkspace() {
  const root = await mkdtemp(path.join(tmpdir(), 'zcode-bm-'));
  await mkdir(path.join(root, '.aicode'), { recursive: true });
  let current = root;
  const store = createBookmarkStore(() => current);
  return {
    root,
    store,
    closeWorkspace: () => { current = ''; },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test('empty workspace has no bookmarks', async () => {
  const fx = await freshWorkspace();
  try {
    assert.deepEqual(await fx.store.listFor('src/a.ts'), []);
    assert.deepEqual(await fx.store.listAll(), []);
  } finally { await fx.cleanup(); }
});

test('toggle marks then unmarks a line', async () => {
  const fx = await freshWorkspace();
  try {
    const on = await fx.store.toggle('src/a.ts', 10, 'function main() {');
    assert.equal(on.marked, true);
    assert.equal(on.count, 1);
    const list = await fx.store.listFor('src/a.ts');
    assert.equal(list.length, 1);
    assert.equal(list[0].line, 10);
    assert.equal(list[0].anchor, 'function main() {');
    const off = await fx.store.toggle('src/a.ts', 10);
    assert.equal(off.marked, false);
    assert.deepEqual(await fx.store.listFor('src/a.ts'), []);
  } finally { await fx.cleanup(); }
});

test('listFor sorts by line; multiple files group in listAll', async () => {
  const fx = await freshWorkspace();
  try {
    await fx.store.toggle('b.ts', 30, '');
    await fx.store.toggle('b.ts', 5, '');
    await fx.store.toggle('a.md', 7, '');
    const one = await fx.store.listFor('b.ts');
    assert.deepEqual(one.map((x) => x.line), [5, 30]);
    const all = await fx.store.listAll();
    assert.deepEqual(all.map((x) => x.path), ['a.md', 'b.ts']);
  } finally { await fx.cleanup(); }
});

test('rejects invalid lines and traversal paths', async () => {
  const fx = await freshWorkspace();
  try {
    await assert.rejects(() => fx.store.toggle('a.ts', 0), /Invalid bookmark/);
    await assert.rejects(() => fx.store.toggle('a.ts', -3), /Invalid bookmark/);
    await fx.store.toggle('a.ts', 2.9, ''); // floors to 2, treated as valid
    assert.equal((await fx.store.listFor('a.ts'))[0].line, 2);
    await assert.rejects(() => fx.store.toggle('../evil.ts', 5), /Invalid bookmark/);
    assert.equal(sanitizeRelPath('..\\..\\x'), null);
    assert.equal(normalizeLine('12'), 12);
    assert.equal(normalizeLine('x'), null);
  } finally { await fx.cleanup(); }
});

test('annotate and move adjust an existing bookmark', async () => {
  const fx = await freshWorkspace();
  try {
    await fx.store.toggle('a.ts', 4, 'let x = 1;');
    const noted = await fx.store.annotate('a.ts', 4, '回头重构');
    assert.equal(noted.note, '回头重构');
    const moved = await fx.store.move('a.ts', 4, 9);
    assert.equal(moved.line, 9);
    await assert.rejects(() => fx.store.annotate('a.ts', 4), /书签不存在/);
    await fx.store.toggle('a.ts', 12);
    await assert.rejects(() => fx.store.move('a.ts', 9, 12), /目标行已有书签/);
  } finally { await fx.cleanup(); }
});

test('remove deletes a single bookmark; clearFile drops the file entry', async () => {
  const fx = await freshWorkspace();
  try {
    await fx.store.toggle('x.ts', 1);
    await fx.store.toggle('x.ts', 2);
    assert.deepEqual(await fx.store.remove('x.ts', 1), { ok: true });
    assert.deepEqual((await fx.store.listFor('x.ts')).map((b) => b.line), [2]);
    assert.deepEqual(await fx.store.remove('x.ts', 1), { ok: false });
    await fx.store.clearFile('x.ts');
    assert.deepEqual(await fx.store.listFor('x.ts'), []);
  } finally { await fx.cleanup(); }
});

test('bookmarks persist to disk in the sidecar location', async () => {
  const fx = await freshWorkspace();
  try {
    await fx.store.toggle('keep.ts', 6, 'anchor');
    const raw = JSON.parse(await readFile(path.join(fx.root, '.aicode', 'desktop', 'bookmarks.json'), 'utf8'));
    assert.ok(Array.isArray(raw['keep.ts']));
    assert.equal(raw['keep.ts'][0].anchor, 'anchor');
  } finally { await fx.cleanup(); }
});

test('corrupt store file reads empty and heals on next write', async () => {
  const fx = await freshWorkspace();
  try {
    const dir = path.join(fx.root, '.aicode', 'desktop');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'bookmarks.json'), '}{ not json', 'utf8');
    assert.deepEqual(await fx.store.listAll(), []);
    await fx.store.toggle('healed.ts', 3);
    assert.equal((await fx.store.listFor('healed.ts')).length, 1);
  } finally { await fx.cleanup(); }
});

test('entries are reshaped defensively (garbage dropped, oversized clamped)', async () => {
  const fx = await freshWorkspace();
  try {
    const dir = path.join(fx.root, '.aicode', 'desktop');
    await mkdir(dir, { recursive: true });
    const nasty = {
      'ok.ts': [
        { line: 3, anchor: 'x'.repeat(600), note: 'y'.repeat(900) },
        { line: 'bad' },
        { line: -1 },
      ],
      '../esc.ts': [{ line: 1 }],
      'notarray': 5,
    };
    await writeFile(path.join(dir, 'bookmarks.json'), JSON.stringify(nasty), 'utf8');
    const all = await fx.store.listAll();
    assert.deepEqual(all.map((x) => x.path), ['ok.ts']);
    const [first] = all[0].bookmarks;
    assert.equal(first.anchor.length, 240);
    assert.equal(first.note.length, 500);
  } finally { await fx.cleanup(); }
});

test('no workspace open: list calls resolve empty, toggles reject', async () => {
  const fx = await freshWorkspace();
  try {
    fx.closeWorkspace();
    assert.deepEqual(await fx.store.listFor('a.ts'), []);
    assert.deepEqual(await fx.store.listAll(), []);
    await assert.rejects(() => fx.store.toggle('a.ts', 1));
  } finally { await fx.cleanup(); }
});

test('concurrent toggles on different lines all survive (serialized)', async () => {
  const fx = await freshWorkspace();
  try {
    await Promise.all(Array.from({ length: 10 }, (_, i) => fx.store.toggle('c.ts', i + 1)));
    assert.equal((await fx.store.listFor('c.ts')).length, 10);
  } finally { await fx.cleanup(); }
});
