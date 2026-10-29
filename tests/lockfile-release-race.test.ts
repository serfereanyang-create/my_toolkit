import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, open, stat, readFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { LockTimeoutError, acquireFileLock, withFileLock } from '../src/utils/lockfile.js';

/*
 * 抢占与释放的交错。
 *
 * 场景：A 的锁被判 stale（比如 A 在另一台机器上、或 A 的进程卡住超过
 * staleMs），被另一个进程摘掉；B 用 open(…, 'wx') 建了新锁，但还没把
 * payload 写进去（这一小段窗口里文件是空的）；此时 A 的 finally 跑
 * release()。旧的 releaseLock 只要「读不出 token」就 unlink——B 的锁被
 * A 删掉，C 立刻就能拿到锁，B 和 C 同时进临界区，读—改—写丢更新。
 *
 * 这里不 mock fs：用真实的 open('wx') 复刻 B 的「已创建、未写入」窗口，
 * 再用短超时的第三次抢锁证明临界区没有被第二个持有者进入。
 */

const workspaceOf = () => mkdtemp(join(tmpdir(), 'aicode-lock-race-'));

test('release 不得删除「别人刚创建、还没写内容」的锁', async () => {
  const dir = await workspaceOf();
  const lockPath = join(dir, 'entries.json.lock');

  // A 曾经持有这把锁。
  const a = await acquireFileLock(lockPath);

  // 抢占交错：A 的锁被判死并摘除（unlink），B 紧接着用 wx 新建了锁，
  // 但还没把 payload 写进去——这一小段窗口里文件是空的。
  const { unlink } = await import('node:fs/promises');
  await unlink(lockPath);
  const bFile = await open(lockPath, 'wx');
  try {
    // A 的 finally 释放。它读不出 token（文件是空的），但绝不许删 B 的锁。
    await a.release();

    // 最坏结果检查：B 仍持有锁，第三个进程不能进来。
    await assert.rejects(
      () => acquireFileLock(lockPath, { timeoutMs: 150, retryDelayMs: 5 }),
      (error: unknown) => error instanceof LockTimeoutError,
      'B 的空壳锁被 A 删掉后，C 会同时进入临界区',
    );

    // B 随后正常写入了自己的 payload，B 的句柄仍然有效。
    await bFile.writeFile(`${JSON.stringify({ token: 'b-token', pid: process.pid, host: hostname(), startedAt: '' })}\n`, 'utf8');
    const parsed = JSON.parse(await readFile(lockPath, 'utf8'));
    assert.equal(parsed.token, 'b-token');
  } finally {
    await bFile.close().catch(() => undefined);
  }
});

test('release 遇到无法归属的锁（空文件 / 坏 JSON）都保持原样', async () => {
  const dir = await workspaceOf();
  const lockPath = join(dir, 'mixed.lock');
  const a = await acquireFileLock(lockPath);
  const { writeFile } = await import('node:fs/promises');

  for (const raw of ['', 'not-json', '{"token":']) {
    await writeFile(lockPath, raw, 'utf8');
    await a.release();
    assert.equal(await readFile(lockPath, 'utf8'), raw, `release 动到了无法归属的内容：${JSON.stringify(raw)}`);
  }
});

test('release 在锁已被别人摘掉时不抛错', async () => {
  const dir = await workspaceOf();
  const lockPath = join(dir, 'gone.lock');
  const a = await acquireFileLock(lockPath);
  const { unlink } = await import('node:fs/promises');
  await unlink(lockPath);
  await a.release();
  await a.release(); // 幂等
  await assert.rejects(() => stat(lockPath), /ENOENT/);
});

test('release 按 token 认锁（正常路径）后锁文件消失', async () => {
  const dir = await workspaceOf();
  const lockPath = join(dir, 'normal.lock');
  const a = await acquireFileLock(lockPath);
  await a.release();
  await assert.rejects(() => stat(lockPath), /ENOENT/);
});

test('withFileLock 的任务抛错后锁仍被释放，下一次写入不被挂住', async () => {
  const dir = await workspaceOf();
  const lockPath = join(dir, 'throw.lock');
  await assert.rejects(() => withFileLock(lockPath, async () => { throw new Error('task boom'); }), /task boom/);
  const handle = await acquireFileLock(lockPath, { timeoutMs: 200, retryDelayMs: 5 });
  await handle.release();
});

/** mulberry32：定种子、可复现的伪随机序列。 */
function mulberry32(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/*
 * 随机化：B 的「建锁—写 token」与 A 的 release 以随机顺序交错。
 *
 * 固定前缀是抢占的真实形态——A 的锁先被摘掉（takeover），B 才能用 wx 建成。
 * 之后 A.release / B.write / C 的试探以随机顺序出现。不变量：
 *   - B 建锁之后、到它就义之前，锁文件始终存在；
 *   - B 持锁期间，C 用短超时抢锁必须超时；
 *   - B 最终写进去的 token 原样留在文件里。
 */
test('随机交错：A 的 release 永远不会让 B 的锁消失（定种子）', async () => {
  const seeds = [1, 20261029, 0x5eed];
  let caseNo = 0;
  for (const seed of seeds) {
    const rng = mulberry32(seed);
    for (let iteration = 0; iteration < 8; iteration += 1) {
      caseNo += 1;
      const caseId = `seed=${seed} case=${caseNo}`;
      const dir = await workspaceOf();
      const lockPath = join(dir, 'race.lock');
      const a = await acquireFileLock(lockPath);
      const { unlink, readFile: read } = await import('node:fs/promises');

      // takeover：旧锁被摘除，B 立刻 wx 建了一个空壳（不变量从此刻开始）。
      await unlink(lockPath);
      const bFile = await open(lockPath, 'wx');

      type Step = 'a.release' | 'b.write' | 'c.probe';
      const steps: Step[] = ['a.release', 'b.write', 'c.probe'];
      for (let i = steps.length - 1; i > 0; i -= 1) {
        const j = Math.floor(rng() * (i + 1));
        [steps[i], steps[j]] = [steps[j]!, steps[i]!];
      }

      let bWrote = false;
      try {
        for (const step of steps) {
          if (step === 'a.release') {
            await a.release();
          } else if (step === 'b.write') {
            await bFile.writeFile(`${JSON.stringify({ token: 'b-token', pid: 1, host: hostname(), startedAt: '' })}\n`, 'utf8');
            bWrote = true;
          } else {
            const probed = await acquireFileLock(lockPath, { timeoutMs: 60, retryDelayMs: 3 })
              .then((handle) => handle.release().then(() => 'acquired' as const), () => 'timeout' as const);
            assert.equal(probed, 'timeout', `${caseId}: B 还持着锁，C 却进来了（步骤 ${steps.join(',')}）`);
          }
          const exists = await stat(lockPath).then(() => true, () => false);
          assert.equal(exists, true, `${caseId}: B 的锁在 ${step} 之后消失了（步骤 ${steps.join(',')}）`);
          if (bWrote) {
            const parsed = JSON.parse(await read(lockPath, 'utf8'));
            assert.equal(parsed.token, 'b-token', `${caseId}: 锁内容被改写（步骤 ${steps.join(',')}）`);
          }
        }
      } finally {
        await bFile.close().catch(() => undefined);
      }
    }
  }
});
