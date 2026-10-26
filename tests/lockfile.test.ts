import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectMemoryStore } from '../src/memory/store.js';
import { LockTimeoutError, acquireFileLock, withFileLock } from '../src/utils/lockfile.js';

/*
 * 这把锁存在的唯一理由：两个进程同时「读—改—写」同一个整文件 JSON 时，
 * 后写的那份是它以为的最新版本，另一个进程刚加的条目直接没了，而且不报错。
 * 所以这里测的不是「锁 API 好不好用」，而是「读—改—写有没有真的互斥」，
 * 以及「活人的锁绝不抢、死人的锁必须能收」。
 */

const workspaceOf = () => mkdtemp(join(tmpdir(), 'aicode-lock-'));

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
  const pid = child.pid!;
  await new Promise<void>((done) => child.on('exit', () => done()));
  return pid;
}

test('同一把锁上的读—改—写真的串行：20 个并发写不丢一笔', async () => {
  const dir = await workspaceOf();
  const target = join(dir, 'counter.json');
  const lockPath = join(dir, 'counter.lock');
  await writeFile(target, '0');
  await Promise.all(Array.from({ length: 20 }, () => withFileLock(lockPath, async () => {
    const value = Number(await readFile(target, 'utf8'));
    // 刻意在临界区里让出事件循环：没有锁的话这里必然互相覆盖。
    await new Promise((done) => setTimeout(done, 1));
    await writeFile(target, String(value + 1));
  })));
  assert.equal(Number(await readFile(target, 'utf8')), 20);
});

test('等不到锁就报错，并且不删人家的锁', async () => {
  const dir = await workspaceOf();
  const lockPath = join(dir, 'busy.lock');
  const holder = await acquireFileLock(lockPath);

  await assert.rejects(
    () => acquireFileLock(lockPath, { timeoutMs: 150, retryDelayMs: 5 }),
    (error: unknown) => error instanceof LockTimeoutError && /等待文件锁超时/.test((error as Error).message),
  );
  const info = await stat(lockPath);
  assert.ok(info.size > 0, '超时不应该动到持有者的锁文件');

  await holder.release();
  await assert.rejects(() => stat(lockPath), /ENOENT/);
});

test('持有者已经死了的旧锁会被接管', async () => {
  const dir = await workspaceOf();
  const lockPath = join(dir, 'stale.lock');
  const pid = await deadPid();
  await writeFile(lockPath, `${JSON.stringify({ token: 'gone', pid, host: hostname(), startedAt: '2020-01-01T00:00:00.000Z' })}\n`);
  const old = new Date(Date.now() - 10 * 60_000);
  await utimes(lockPath, old, old);

  const handle = await acquireFileLock(lockPath, { timeoutMs: 500, staleMs: 1000 });
  const parsed = JSON.parse(await readFile(lockPath, 'utf8'));
  assert.notEqual(parsed.token, 'gone', '应当换成新持有者的 token');
  assert.equal(parsed.pid, process.pid);
  await handle.release();
});

test('活着但慢的持有者不抢，只等', async () => {
  const dir = await workspaceOf();
  const lockPath = join(dir, 'alive.lock');
  await writeFile(lockPath, `${JSON.stringify({ token: 'slow', pid: process.pid, host: hostname(), startedAt: '2020-01-01T00:00:00.000Z' })}\n`);
  const old = new Date(Date.now() - 10 * 60_000);
  await utimes(lockPath, old, old);

  await assert.rejects(
    () => acquireFileLock(lockPath, { timeoutMs: 200, staleMs: 1000, retryDelayMs: 5 }),
    (error: unknown) => error instanceof LockTimeoutError,
  );
  const parsed = JSON.parse(await readFile(lockPath, 'utf8'));
  assert.equal(parsed.token, 'slow', '活人的锁必须原样留着');
});

test('释放时按 token 认锁：别人的锁不删', async () => {
  const dir = await workspaceOf();
  const lockPath = join(dir, 'mine.lock');
  const handle = await acquireFileLock(lockPath);
  // 模拟「我们的锁被判死、别人已经重新拿到」。
  await writeFile(lockPath, `${JSON.stringify({ token: 'someone-else', pid: process.pid, host: 'x', startedAt: '' })}\n`);
  await handle.release();
  const parsed = JSON.parse(await readFile(lockPath, 'utf8'));
  assert.equal(parsed.token, 'someone-else', '不是自己的锁绝不能删，否则两个进程会同时进临界区');
});

test('记忆库写入遵守外部持有的锁：锁不放，add 不落盘', async () => {
  const workspace = await workspaceOf();
  const store = new ProjectMemoryStore(workspace, { lock: { timeoutMs: 400, retryDelayMs: 5 } });
  const lockPath = join(workspace, '.aicode', 'memory', 'entries.json.lock');
  const holder = await acquireFileLock(lockPath);

  let finished = false;
  const pending = store.add({ kind: 'decision', summary: '锁外的写入要先等锁', source: { type: 'user' } })
    .finally(() => { finished = true; });
  await new Promise((done) => setTimeout(done, 120));
  assert.equal(finished, false, '锁还握在别人手里，add 不该完成');

  await holder.release();
  const entry = await pending;
  const file = JSON.parse(await readFile(join(workspace, '.aicode', 'memory', 'entries.json'), 'utf8'));
  assert.equal(file.entries.length, 1);
  assert.equal(file.entries[0].id, entry.id);
});

test('记忆库写入完成后不留下锁文件', async () => {
  const workspace = await workspaceOf();
  const store = new ProjectMemoryStore(workspace, { lock: { timeoutMs: 400 } });
  await store.add({ kind: 'note', summary: '写完要放锁', source: { type: 'user' } });
  await assert.rejects(() => stat(join(workspace, '.aicode', 'memory', 'entries.json.lock')), /ENOENT/);
});
