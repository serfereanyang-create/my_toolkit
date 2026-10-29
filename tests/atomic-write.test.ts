import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readdir, readFile, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serializeWrites, SerializeReentryError, writeFileAtomic } from '../src/utils/atomic.js';

/*
 * writeFileAtomic / serializeWrites 的失败面。
 *
 * 目标只有一个：任何一次失败之后，目录里除了目标文件之外不应留下别的
 * 东西；队列在任务失败之后必须继续工作，而不是把同一个 key 永久挂住。
 */

const dirOf = () => mkdtemp(join(tmpdir(), 'aicode-atomic-'));

const tmpNames = async (dir: string) => (await readdir(dir)).filter((name) => name.endsWith('.tmp'));

test('writeFileAtomic 自动建父目录、内容完整、不留 .tmp', async () => {
  const dir = await dirOf();
  const target = join(dir, 'a', 'b', 'c.json');
  await writeFileAtomic(target, '{"x":1}');
  assert.equal(await readFile(target, 'utf8'), '{"x":1}');
  assert.deepEqual(await tmpNames(join(dir, 'a', 'b')), []);
});

test('rename 目标被占（这里是同名目录）时抛错且清掉自己的 .tmp', async () => {
  const dir = await dirOf();
  const target = join(dir, 'target');
  await mkdir(target);
  await assert.rejects(() => writeFileAtomic(target, 'nope'));
  assert.deepEqual(await tmpNames(dir), []);
});

test('崩溃残留的旧 .tmp 会在下一次写同一目标时被回收，新 .tmp 与无关文件不动', async () => {
  const dir = await dirOf();
  const target = join(dir, 'store.json');
  await writeFile(target, 'old');

  const orphan = `${target}.40816.1792249444537.tmp`;
  const other = join(dir, 'other.json.1.0193a9d2-1111-4222-8333-444455556666.tmp');
  const unrelated = join(dir, 'store.json.notes.tmp');
  const fresh = `${target}.999.aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.tmp`;
  await writeFile(orphan, 'crashed writer');
  await writeFile(other, 'other target');
  await writeFile(unrelated, 'not our shape');
  await writeFile(fresh, 'another live writer');

  const stale = new Date(Date.now() - 60 * 60_000);
  await utimes(orphan, stale, stale);

  await writeFileAtomic(target, 'new');
  const names = (await readdir(dir)).sort();
  assert.ok(!names.includes('store.json.40816.1792249444537.tmp'), '同目标的旧 .tmp 应被回收');
  assert.ok(names.includes('other.json.1.0193a9d2-1111-4222-8333-444455556666.tmp'), '别的目标不归这次写管');
  assert.ok(names.includes('store.json.notes.tmp'), '形状不符的文件不动');
  assert.ok(names.includes('store.json.999.aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.tmp'), '新 .tmp 不能删（可能是另一个进程正在写）');
  assert.equal(await readFile(target, 'utf8'), 'new');
});

test('serializeWrites：1 万个同 key 调用者严格按序执行，结束后 key 不被挂住', async () => {
  const order: number[] = [];
  const results = await Promise.all(
    Array.from({ length: 10_000 }, (_, i) => serializeWrites('hot-key', async () => { order.push(i); return i; })),
  );
  assert.equal(results.length, 10_000);
  assert.ok(order.every((value, index) => value === index), '同 key 的写必须按入队顺序串行');

  // 队列已经收敛：新调用立即完成，不需要等前面的任何东西。
  const outcome = await Promise.race([
    serializeWrites('hot-key', async () => 'ran'),
    new Promise((resolve) => setTimeout(() => resolve('TIMEOUT'), 1000)),
  ]);
  assert.equal(outcome, 'ran');
});

test('serializeWrites：任务 reject 之后同 key 的后续调用照常执行', async () => {
  await assert.rejects(() => serializeWrites('reject-key', async () => { throw new Error('boom'); }), /boom/);
  const outcome = await Promise.race([
    serializeWrites('reject-key', async () => 'recovered'),
    new Promise((resolve) => setTimeout(() => resolve('TIMEOUT'), 1000)),
  ]);
  assert.equal(outcome, 'recovered');
});

test('serializeWrites：任务同步抛错不动到后续调用', async () => {
  // task() 在 await 前就抛：调用方拿到 rejected promise，队列释放仍然走 finally。
  const syncTask = (() => { throw new Error('sync'); }) as unknown as () => Promise<never>;
  const queued = serializeWrites('sync-key', syncTask);
  await assert.rejects(() => queued, /sync/);
  assert.equal(await serializeWrites('sync-key', async () => 'ok'), 'ok');
});

test('serializeWrites：不同 key 不互相阻塞', async () => {
  let releaseA: () => void = () => {};
  const a = serializeWrites('a', () => new Promise<void>((resolve) => { releaseA = resolve; }));
  const b = await Promise.race([
    serializeWrites('b', async () => 'b-done'),
    new Promise((resolve) => setTimeout(() => resolve('TIMEOUT'), 1000)),
  ]);
  assert.equal(b, 'b-done');
  releaseA();
  await a;
});

test('serializeWrites：同 key 重入明确报错，而不是把调用方永久挂住', async () => {
  await assert.rejects(
    () => serializeWrites('self-key', async () => serializeWrites('self-key', async () => 'inner')),
    (error: unknown) => error instanceof SerializeReentryError,
  );
  // 重入错误之后队列仍然可用。
  assert.equal(await serializeWrites('self-key', async () => 'after'), 'after');
  // 不同 key 的嵌套是合法的。
  assert.equal(await serializeWrites('outer', async () => serializeWrites('inner', async () => 'nested')), 'nested');
});
