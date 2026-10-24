import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectMemoryStore } from '../src/memory/store.js';
import { memoryDigestTool } from '../src/memory/memoryDigestTool.js';
import type { ToolContext } from '../src/tools/types.js';

/*
 * 记忆库存的是「上一个会话知道、下一个会话必须知道」的东西，所以它的失败
 * 模式全是**静默丢数据**：不抛错，条目就是不见了。这个文件锁住三条防线：
 * 读不了不等于空库、挪不走的文件绝不让空库覆盖、以及「算完再写」必须落在
 * store 的写队列里（否则并发会话写进来的条目会被覆盖）。
 */

const memoryDir = (workspace: string) => join(workspace, '.aicode', 'memory');
const memoryFile = (workspace: string) => join(memoryDir(workspace), 'entries.json');

const errno = (code: string) => Object.assign(new Error(code), { code });

async function corruptWorkspace() {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-memory-safety-'));
  await mkdir(memoryDir(workspace), { recursive: true });
  await writeFile(memoryFile(workspace), '{"version": 1, "entries": [ 半截\n');
  return workspace;
}

const context = (workspaceRoot: string) => ({ workspaceRoot, approval: 'auto' }) as unknown as ToolContext;

test('挪不开的损坏记忆库不会被空库覆盖', async () => {
  const workspace = await corruptWorkspace();
  try {
    const before = await readFile(memoryFile(workspace), 'utf8');
    // Windows 上另一个进程占着文件时 rename 会 EPERM，重试完还是失败。
    const store = new ProjectMemoryStore(workspace, { rename: async () => { throw errno('EPERM'); } });

    assert.deepEqual((await store.load()).entries, []);
    await assert.rejects(
      () => store.add({ kind: 'note', summary: '想写进去', source: { type: 'user' } }),
      /挪不开/,
    );

    // 关键：原文件一个字节都没动，也没有假装备份成功。
    assert.equal(await readFile(memoryFile(workspace), 'utf8'), before);
    assert.deepEqual((await readdir(memoryDir(workspace))).filter((name) => name.includes('.corrupt-')), []);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('挪得开的损坏记忆库备份后照常可写', async () => {
  const workspace = await corruptWorkspace();
  try {
    const before = await readFile(memoryFile(workspace), 'utf8');
    const store = new ProjectMemoryStore(workspace);
    assert.deepEqual((await store.load()).entries, []);

    const backups = (await readdir(memoryDir(workspace))).filter((name) => name.includes('.corrupt-'));
    assert.equal(backups.length, 1);
    assert.equal(await readFile(join(memoryDir(workspace), backups[0]), 'utf8'), before);

    await store.add({ kind: 'note', summary: '备份之后照写', source: { type: 'user' } });
    assert.equal((await store.list()).length, 1);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('隔离失败不会把「暂时占用」变成「永久放弃」', async () => {
  const workspace = await corruptWorkspace();
  try {
    let locked = true;
    const store = new ProjectMemoryStore(workspace, {
      rename: async (from, to) => {
        if (locked) throw errno('EBUSY');
        await rename(from, to);
      },
    });

    await store.load();
    await assert.rejects(() => store.add({ kind: 'note', summary: '占用中', source: { type: 'user' } }), /挪不开/);

    // 占用解除：同一个 store 实例必须再试，而不是永久放弃。
    locked = false;
    await store.load();
    await store.add({ kind: 'note', summary: '解除后再写', source: { type: 'user' } });
    assert.deepEqual((await store.list()).map((entry) => entry.summary), ['解除后再写']);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('读文件报 EACCES 不是「空库」', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-memory-eacces-'));
  try {
    // 文件真实存在（所以不是「还没有记忆库」），只是读不了。
    await mkdir(memoryDir(workspace), { recursive: true });
    await writeFile(memoryFile(workspace), JSON.stringify({ version: 1, entries: [] }));
    const store = new ProjectMemoryStore(workspace, {
      readFile: async () => { throw errno('EACCES'); },
      rename: async () => { throw errno('EBUSY'); },
    });
    assert.deepEqual((await store.load()).entries, []);
    await assert.rejects(
      () => store.save({ version: 1, updatedAt: new Date().toISOString(), entries: [] }),
      /EACCES/,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('ENOENT 才是空库：不隔离、不封锁写入', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-memory-enoent-'));
  try {
    const store = new ProjectMemoryStore(workspace);
    assert.deepEqual((await store.load()).entries, []);
    await store.add({ kind: 'note', summary: '第一次记忆', source: { type: 'user' } });
    assert.equal((await store.list()).length, 1);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('update 读到的是队列里的最新文件，而不是调用前的快照', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-memory-update-'));
  try {
    const store = new ProjectMemoryStore(workspace);
    // 先排队一笔写、不等它完成，再让 update 去读：它必须看见这一笔。
    const queued = store.add({ kind: 'note', summary: '先写的', source: { type: 'user' } });
    const seen = await store.update((file) => ({ changed: false, value: file.entries.map((entry) => entry.summary) }));
    await queued;
    assert.deepEqual(seen, ['先写的']);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('memory_digest 应用计划后什么也没丢，且只写一次', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-memory-digest-'));
  try {
    const store = new ProjectMemoryStore(workspace);
    await store.add({ kind: 'convention', summary: 'always use tabs', keywords: ['tabs'], source: { type: 'user' }, nowIso: '2026-01-01T00:00:00.000Z' });
    await store.add({ kind: 'convention', summary: 'always use tabs；新写法', keywords: ['tabs'], source: { type: 'user' }, nowIso: '2026-06-01T00:00:00.000Z' });
    await store.add({ kind: 'note', summary: '陈年笔记', keywords: ['note'], source: { type: 'user' }, nowIso: '2020-01-01T00:00:00.000Z' });

    const result = await memoryDigestTool.execute({ dryRun: false }, context(workspace));
    assert.equal(result.ok, true);
    assert.match(result.output, /记忆整理已应用/);

    // 软删除：三条都还在文件里，一条都没被覆盖掉。
    const all = await store.list({ includeInactive: true });
    assert.equal(all.length, 3);
    assert.equal(all.filter((entry) => entry.active).length, 1);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('记忆库为空时 memory_digest 直接说没得整理', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-memory-digest-empty-'));
  try {
    for (const dryRun of [true, false]) {
      const result = await memoryDigestTool.execute({ dryRun }, context(workspace));
      assert.equal(result.ok, true);
      assert.match(result.output, /记忆库为空/);
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
