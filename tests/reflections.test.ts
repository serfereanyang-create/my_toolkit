import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReflectionStore } from '../src/reflection/store.js';
import { deriveLesson, formatReflections } from '../src/reflection/types.js';

test('deriveLesson maps failure text to actionable lessons', () => {
  assert.match(deriveLesson('request timeout after 30s', 'exception'), /超时控制/);
  assert.match(deriveLesson('tool denied by user', 'exception'), /审批拒绝/);
  assert.match(deriveLesson('Stopped after reaching max steps (24)', 'max_steps'), /拆分/);
  assert.match(deriveLesson('something weird happened', 'exception'), /不要原样重试/);
});

test('store add/list/forget round-trips with dedupe and hits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'reflections-'));
  try {
    const store = new ReflectionStore(root);
    assert.equal((await store.list()).length, 0);

    await store.add({ topic: '重构 date.ts', failure: 'timeout', lesson: '拆分步骤', kind: 'exception' });
    await store.add({ topic: '重构 date.ts', failure: 'timeout', lesson: '拆分步骤', kind: 'exception' });
    const entries = await store.list();
    assert.equal(entries.length, 1, '同 topic+failure+kind 去重');
    assert.equal(entries[0]!.hits, 2);

    // 并发写不丢条目（串行队列）
    await Promise.all([
      store.add({ topic: 'A', failure: 'f1', lesson: 'l', kind: 'exception' }),
      store.add({ topic: 'B', failure: 'f2', lesson: 'l', kind: 'max_steps' }),
      store.add({ topic: 'C', failure: 'f3', lesson: 'l', kind: 'exception' }),
    ]);
    assert.equal((await store.list()).length, 4);

    const target = (await store.list()).find((e) => e.topic === 'B')!;
    assert.equal(await store.forget(target.id), true);
    assert.equal((await store.list()).length, 3);
    assert.equal(await store.forget('missing-id'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('selectRelevant scores topic overlap and recency', async () => {
  const store = new ReflectionStore(process.cwd());
  const now = new Date().toISOString();
  const entries = [
    { id: '1', topic: '修复 date.ts 的时区 bug', failure: 'ENOENT date.ts', lesson: '先确认路径', kind: 'exception' as const, at: now, hits: 1 },
    { id: '2', topic: '完全无关的部署任务', failure: 'deploy failed', lesson: 'x', kind: 'exception' as const, at: now, hits: 1 },
  ];
  const picked = store.selectRelevant(entries, '帮我再改一下 date.ts 的时区问题');
  assert.equal(picked.length, 1);
  assert.equal(picked[0]!.id, '1');
  assert.equal(store.selectRelevant(entries, '写一首诗').length, 0);
});

test('formatReflections renders injectable block', () => {
  const block = formatReflections([
    { id: '1', topic: 'T', failure: 'F', lesson: 'L', kind: 'exception', at: 'x', hits: 1 },
  ]);
  assert.ok(block.startsWith('<past-reflections>'));
  assert.ok(block.includes('教训：L'));
  assert.ok(block.endsWith('</past-reflections>'));
  assert.equal(formatReflections([]), '');
});

const reflectionsFile = (root: string) => join(root, '.aicode', 'reflections.json');

test('a damaged reflections file is kept, not overwritten by the next reflection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'reflections-'));
  try {
    const store = new ReflectionStore(root);
    await store.add({ topic: 't3', failure: 'f3', lesson: 'l3', kind: 'exception' });
    await store.add({ topic: 't2', failure: 'f2', lesson: 'l2', kind: 'exception' });
    const good = await readFile(reflectionsFile(root), 'utf8');
    // A crash mid-write (the old persist wrote the temp file and renamed it, so
    // this is a hand edit or a half-copied file) leaves the document truncated.
    const torn = good.slice(0, good.indexOf('"topic": "t3"') + 10);
    await writeFile(reflectionsFile(root), torn, 'utf8');

    assert.deepEqual(await store.list(), []);
    await store.add({ topic: 'new', failure: 'boom', lesson: 'retry', kind: 'exception' });

    const backups = (await readdir(join(root, '.aicode'))).filter((name) => name.includes('.corrupt-'));
    assert.equal(backups.length, 1, 'the unreadable copy must survive the next save');
    assert.equal(await readFile(join(root, '.aicode', backups[0]!), 'utf8'), torn);
    assert.equal((await store.list()).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('two store instances in one process never lose each other\'s reflections', async () => {
  const root = await mkdtemp(join(tmpdir(), 'reflections-'));
  try {
    // Exactly what the runtime does: tools.ts and commands.ts each construct
    // their own ReflectionStore, so an instance-level queue serialises nothing.
    const first = new ReflectionStore(root);
    const second = new ReflectionStore(root);
    await Promise.all([
      first.add({ topic: 'A', failure: 'f1', lesson: 'l', kind: 'exception' }),
      second.add({ topic: 'B', failure: 'f2', lesson: 'l', kind: 'exception' }),
      first.add({ topic: 'C', failure: 'f3', lesson: 'l', kind: 'max_steps' }),
      second.add({ topic: 'D', failure: 'f4', lesson: 'l', kind: 'max_steps' }),
    ]);
    const topics = (await first.list()).map((entry) => entry.topic).sort();
    assert.deepEqual(topics, ['A', 'B', 'C', 'D']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('unusable entries are ignored instead of breaking every reader', async () => {
  const root = await mkdtemp(join(tmpdir(), 'reflections-'));
  try {
    await mkdir(join(root, '.aicode'), { recursive: true });
    // A foreign or hand-edited file: readers used to get these raw, and
    // selectRelevant/buildBlock then threw on .toLowerCase of a number.
    await writeFile(
      reflectionsFile(root),
      JSON.stringify({ version: 1, entries: [1, null, { topic: 'only a topic' }, { topic: 'ok', failure: 'boom' }] }),
      'utf8',
    );
    const store = new ReflectionStore(root);
    const entries = await store.list();
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.topic, 'ok');
    assert.equal(entries[0]!.kind, 'exception');
    assert.equal(entries[0]!.hits, 1);
    assert.ok(Array.isArray(store.selectRelevant(entries, 'unrelated prompt')));
    assert.equal(store.buildBlock([]), '');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('add returns the entry that is actually stored when it dedupes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'reflections-'));
  try {
    const store = new ReflectionStore(root);
    const first = await store.add({ topic: 'T', failure: 'F', lesson: 'L', kind: 'exception' });
    const again = await store.add({ topic: 'T', failure: 'F', lesson: 'L2', kind: 'exception' });
    assert.equal(again.id, first.id, 'a fresh id here would point at nothing on disk');
    assert.ok((await store.list()).some((entry) => entry.id === again.id));
    assert.equal(await store.forget(again.id), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an empty but well-formed reflections file is not quarantined', async () => {
  const root = await mkdtemp(join(tmpdir(), 'reflections-'));
  try {
    await mkdir(join(root, '.aicode'), { recursive: true });
    const empty = `${JSON.stringify({ version: 1, entries: [] }, null, 2)}\n`;
    await writeFile(reflectionsFile(root), empty, 'utf8');
    const store = new ReflectionStore(root);
    assert.deepEqual(await store.list(), []);
    assert.deepEqual(await store.list(), []);
    assert.deepEqual((await readdir(join(root, '.aicode'))).filter((name) => name.includes('.corrupt-')), []);
    assert.equal(await readFile(reflectionsFile(root), 'utf8'), empty, 'reading must not rewrite the file');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
