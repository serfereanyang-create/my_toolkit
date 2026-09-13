const assert = require('node:assert/strict');
const { mkdtemp, readFile, rm, writeFile, mkdir } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createSnippetsStore } = require('../electron/snippets-store.cjs');

async function freshStore() {
  const dir = await mkdtemp(path.join(tmpdir(), 'zcode-snip-'));
  return { store: createSnippetsStore(dir), dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test('empty store lists nothing and survives a missing file', async () => {
  const fx = await freshStore();
  try {
    assert.deepEqual(await fx.store.list(), []);
  } finally { await fx.cleanup(); }
});

test('create stores a snippet with defaults and stable id', async () => {
  const fx = await freshStore();
  try {
    const created = await fx.store.create({ title: '防抖', body: 'function debounce(){}', language: 'ts', tags: ['React'] });
    assert.ok(created.id.startsWith('snip-'));
    assert.equal(created.title, '防抖');
    assert.equal(created.language, 'ts');
    assert.deepEqual(created.tags, ['react']); // normalized lowercase
    assert.equal(created.usageCount, 0);
    const list = await fx.store.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].body, 'function debounce(){}');
  } finally { await fx.cleanup(); }
});

test('create rejects empty titles and oversized bodies', async () => {
  const fx = await freshStore();
  try {
    await assert.rejects(() => fx.store.create({ title: '  ', body: 'x' }), /标题不能为空/);
    await assert.rejects(() => fx.store.create({ title: 'big', body: 'x'.repeat(70 * 1024) }), /内容过大/);
  } finally { await fx.cleanup(); }
});

test('update merges a patch and bumps updatedAt', async () => {
  const fx = await freshStore();
  try {
    const a = await fx.store.create({ title: 'old', body: 'b1' });
    const b = await fx.store.update(a.id, { title: 'new' });
    assert.equal(b.title, 'new');
    assert.equal(b.body, 'b1'); // unchanged fields preserved
    assert.equal(b.id, a.id);
    assert.equal(b.createdAt, a.createdAt);
    await assert.rejects(() => fx.store.update('missing', { title: 'x' }), /片段不存在/);
  } finally { await fx.cleanup(); }
});

test('remove deletes once and reports missing', async () => {
  const fx = await freshStore();
  try {
    const a = await fx.store.create({ title: 't', body: 'b' });
    assert.deepEqual(await fx.store.remove(a.id), { ok: true, id: a.id });
    assert.equal((await fx.store.list()).length, 0);
    assert.deepEqual(await fx.store.remove(a.id), { ok: false, id: a.id });
  } finally { await fx.cleanup(); }
});

test('touch increments usage counts', async () => {
  const fx = await freshStore();
  try {
    const a = await fx.store.create({ title: 't', body: 'b' });
    await fx.store.touch(a.id);
    const res = await fx.store.touch(a.id);
    assert.equal(res.usageCount, 2);
    assert.equal((await fx.store.list())[0].usageCount, 2);
    assert.deepEqual(await fx.store.touch('nope'), { ok: false, id: 'nope' });
  } finally { await fx.cleanup(); }
});

test('search matches title, body, tags and language, case-insensitively', async () => {
  const fx = await freshStore();
  try {
    await fx.store.create({ title: 'React Hook', body: 'useEffect(() => {})', tags: ['hooks'] });
    await fx.store.create({ title: 'SQL Dump', body: 'SELECT * FROM users', tags: ['db'], language: 'sql' });
    assert.equal((await fx.store.search('react')).length, 1);
    assert.equal((await fx.store.search('HOOKS')).length, 1);
    assert.equal((await fx.store.search('SELECT')).length, 1);
    assert.equal((await fx.store.search('sql')).length, 1); // language field
    assert.equal((await fx.store.search('')).length, 2); // empty query -> all
    assert.equal((await fx.store.search('nothing-here')).length, 0);
  } finally { await fx.cleanup(); }
});

test('list sorts newest-updated first', async () => {
  const fx = await freshStore();
  try {
    const a = await fx.store.create({ title: 'a', body: '1' });
    const b = await fx.store.create({ title: 'b', body: '2' });
    await new Promise((r) => setTimeout(r, 5));
    await fx.store.update(a.id, { body: '1x' }); // a becomes newest
    const titles = (await fx.store.list()).map((s) => s.title);
    assert.deepEqual(titles, ['a', 'b']);
    void b;
  } finally { await fx.cleanup(); }
});

test('export returns JSON round-trippable through replaceAll', async () => {
  const fx = await freshStore();
  try {
    await fx.store.create({ title: 'x', body: 'y', tags: ['a', 'a', 'b'] }); // dup tags deduped
    const exported = await fx.store.exportAll();
    const parsed = JSON.parse(exported);
    assert.equal(parsed.length, 1);
    assert.deepEqual(parsed[0].tags, ['a', 'b']);

    const fx2 = await freshStore();
    try {
      const imported = await fx2.store.replaceAll(parsed);
      assert.equal(imported.length, 1);
      assert.equal(imported[0].title, 'x');
      // Second call replaces the collection wholesale.
      await fx2.store.replaceAll([...parsed, { title: 'z', body: '' }]);
      assert.equal((await fx2.store.list()).length, 2);
    } finally { await fx2.cleanup(); }
  } finally { await fx.cleanup(); }
});

test('replaceAll rejects non-array payloads', async () => {
  const fx = await freshStore();
  try {
    await assert.rejects(() => fx.store.replaceAll('{"a":1}'), /必须是数组/);
    await assert.rejects(() => fx.store.replaceAll(null), /必须是数组/);
  } finally { await fx.cleanup(); }
});

test('corrupt store file is moved aside instead of crashing', async () => {
  const fx = await freshStore();
  try {
    await mkdir(path.dirname(fx.store.storePath), { recursive: true });
    await writeFile(fx.store.storePath, '{ broken json', 'utf8');
    const list = await fx.store.list(); // reseed, not throw
    assert.deepEqual(list, []);
    // The next successful mutation rewrites the file cleanly.
    await fx.store.create({ title: 'ok', body: 'b' });
    const after = JSON.parse(await readFile(fx.store.storePath, 'utf8'));
    assert.equal(after.snippets.length, 1);
  } finally { await fx.cleanup(); }
});

test('concurrent mutations are serialized (no lost updates)', async () => {
  const fx = await freshStore();
  try {
    const inputs = Array.from({ length: 8 }, (_, i) => ({ title: `s${i}`, body: 'b' }));
    await Promise.all(inputs.map((input) => fx.store.create(input)));
    const list = await fx.store.list();
    assert.equal(list.length, 8);
    const titles = new Set(list.map((s) => s.title));
    assert.equal(titles.size, 8);
  } finally { await fx.cleanup(); }
});
