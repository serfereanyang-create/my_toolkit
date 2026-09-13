const assert = require('node:assert/strict');
const { mkdtemp, readFile, rm, mkdir, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createSessionTagsStore, sanitizeTag, sanitizeSessionId } = require('../electron/session-tags.cjs');

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'zcode-stags-'));
  let closed = false;
  const store = createSessionTagsStore(() => (closed ? null : root));
  return {
    root,
    store,
    close: () => { closed = true; },
    file: () => path.join(root, '.aicode', 'desktop', 'session-tags.json'),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test('sanitizeTag trims, collapses spaces, caps length', () => {
  assert.equal(sanitizeTag('  hello   world  '), 'hello world');
  assert.equal(sanitizeTag(''), null);
  assert.equal(sanitizeTag('x'.repeat(50)).length, 24);
});

test('sanitizeSessionId rejects traversal and dotted ids', () => {
  assert.equal(sanitizeSessionId('sess_abc123'), 'sess_abc123');
  assert.equal(sanitizeSessionId('..'), null);
  assert.equal(sanitizeSessionId('../evil'), null);
  assert.equal(sanitizeSessionId('a/b'), null);
  assert.equal(sanitizeSessionId('a\\b'), null);
  assert.equal(sanitizeSessionId('.hidden'), null);
});

test('toggleTag adds then removes', async () => {
  const fx = await fixture();
  try {
    const added = await fx.store.toggleTag('s1', 'bugfix');
    assert.equal(added.ok, true);
    assert.deepEqual(added.tags, ['bugfix']);
    const all = await fx.store.listAll();
    assert.deepEqual(all.s1, ['bugfix']);
    const removed = await fx.store.toggleTag('s1', 'bugfix');
    assert.deepEqual(removed.tags, []);
    assert.deepEqual(await fx.store.listAll(), {});
  } finally { await fx.cleanup(); }
});

test('setTags dedupes and caps per session', async () => {
  const fx = await fixture();
  try {
    const out = await fx.store.setTags('s1', ['a', 'a', ' b ', 'c', 'd', 'e', 'f', 'g']);
    assert.equal(out.ok, true);
    assert.deepEqual(out.tags, ['a', 'b', 'c', 'd', 'e', 'f']);
  } finally { await fx.cleanup(); }
});

test('sidecar file persists and reloads across store instances', async () => {
  const fx = await fixture();
  try {
    await fx.store.toggleTag('s1', 'wip');
    const raw = JSON.parse(await readFile(fx.file(), 'utf8'));
    assert.deepEqual(raw.s1, ['wip']);
    const again = createSessionTagsStore(() => fx.root);
    assert.deepEqual((await again.listAll()).s1, ['wip']);
  } finally { await fx.cleanup(); }
});

test('corrupt sidecar heals to empty', async () => {
  const fx = await fixture();
  try {
    await mkdir(path.dirname(fx.file()), { recursive: true });
    await writeFile(fx.file(), '{ not json', 'utf8');
    assert.deepEqual(await fx.store.listAll(), {});
    const out = await fx.store.toggleTag('s1', 'fresh');
    assert.equal(out.ok, true);
  } finally { await fx.cleanup(); }
});

test('remove drops tags for deleted session', async () => {
  const fx = await fixture();
  try {
    await fx.store.setTags('s1', ['a']);
    await fx.store.setTags('s2', ['b']);
    await fx.store.remove('s1');
    const all = await fx.store.listAll();
    assert.equal(all.s1, undefined);
    assert.deepEqual(all.s2, ['b']);
  } finally { await fx.cleanup(); }
});

test('no workspace returns empty list and error-free setTags failure', async () => {
  const fx = await fixture();
  try {
    fx.close();
    assert.deepEqual(await fx.store.listAll(), {});
    const out = await fx.store.setTags('s1', ['a']);
    assert.equal(out.ok, false);
  } finally { await fx.cleanup(); }
});

test('rejects illegal session ids', async () => {
  const fx = await fixture();
  try {
    assert.equal((await fx.store.setTags('../escape', ['a'])).ok, false);
    assert.equal((await fx.store.remove('..')).ok, false);
  } finally { await fx.cleanup(); }
});

test('global tag cap refuses new tags past 24', async () => {
  const fx = await fixture();
  try {
    for (let i = 0; i < 24; i++) await fx.store.toggleTag('s' + i, 'tag-' + i);
    const tooMany = await fx.store.toggleTag('s99', 'newtag');
    assert.equal(tooMany.ok, false);
    // reusing an existing tag is still allowed
    const reuse = await fx.store.toggleTag('s99', 'tag-0');
    assert.equal(reuse.ok, true);
  } finally { await fx.cleanup(); }
});

test('per-session cap refuses seventh distinct tag', async () => {
  const fx = await fixture();
  try {
    for (const t of ['a', 'b', 'c', 'd', 'e']) await fx.store.toggleTag('s1', t);
    const full = await fx.store.toggleTag('s1', 'f');
    assert.equal(full.ok, true);
    assert.equal(full.tags.length, 6);
    const over = await fx.store.toggleTag('s1', 'g');
    assert.equal(over.ok, false);
  } finally { await fx.cleanup(); }
});
