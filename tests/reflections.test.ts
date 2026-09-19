import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
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
