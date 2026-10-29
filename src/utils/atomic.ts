import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/**
 * Durable whole-file writes for the JSON stores ZCode keeps on disk.
 *
 * Two failures this prevents, both of which cost real data:
 *   - writing in place truncates the file first, so a crash or a kill in
 *     between leaves a half-written one — and every store here treats an
 *     unreadable file as empty, so the next save would erase the rest;
 *   - a store that reads, edits and rewrites the whole file loses whatever a
 *     concurrent writer added between its read and its write — within ONE
 *     process, tool batches do write concurrently and the queue below covers
 *     that.
 *
 * Both are silent: nothing throws, the entries simply stop existing.
 *
 * Cross-process writes (one CLI per desktop session, plus scheduled automation)
 * still need an OS-level lock on top: `queues` is an in-process Map, so it
 * cannot see the other process, and `writeFileAtomic` prevents a torn file, not
 * a lost update. `utils/lockfile.ts` provides that lock (`open(…, 'wx')` spin
 * lock with a stale-owner takeover) — the memory store takes it around every
 * read-modify-write via `ProjectMemoryStore#withLock`. A store that only calls
 * these helpers is still unsynchronised against other processes.
 */

/** One queue per file, so read-modify-write cycles on it never interleave. */
const queues = new Map<string, Promise<void>>();

/**
 * Keys held by the CURRENT async call chain — see the reentrancy guard below.
 * A plain "is this key running" set cannot be used: queuing behind somebody
 * else's in-flight write is the normal path (the session store's second save
 * waits for the first), and it must not look like reentrancy.
 */
const heldKeys = new AsyncLocalStorage<Set<string>>();

/** Same-key reentrancy would wait on its own queue forever; fail loudly instead. */
export class SerializeReentryError extends Error {
  constructor(key: string) {
    super(`serializeWrites 对同一个 key 重入会死锁：${key}`);
    this.name = 'SerializeReentryError';
  }
}

/** Run `task` after every earlier task queued for `key`.
 *
 * 重入（任务内部对同一 key 再排队）等的是自己，会永久挂住——而挂住发生在
 * 整文件 JSON 的写路径上，看起来就是「保存卡死」。这里按 AsyncLocalStorage
 * 记录当前调用链已持有的 key，只有同一链上再排队才抛
 * {@link SerializeReentryError}；别的调用方排在正在跑的写之后是正常排队。
 */
export async function serializeWrites<Result>(key: string, task: () => Promise<Result>): Promise<Result> {
  const inherited = heldKeys.getStore();
  if (inherited?.has(key)) throw new SerializeReentryError(key);
  const previous = queues.get(key) ?? Promise.resolve();
  let release = () => {};
  const current = new Promise<void>((done) => {
    release = done;
  });
  queues.set(key, current);
  await previous.catch(() => undefined);
  const held = new Set(inherited ?? []);
  held.add(key);
  try {
    return await heldKeys.run(held, () => task());
  } finally {
    held.delete(key);
    release();
    if (queues.get(key) === current) queues.delete(key);
  }
}

/**
 * rename() over a file another process has open fails with EPERM/EBUSY on
 * Windows; a reader holding the file for a moment is not a write failure.
 */
export async function renameWithRetry(from: string, to: string) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const transient = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
      if (!transient || attempt >= 4) throw error;
      await new Promise((done) => setTimeout(done, 20 * (attempt + 1)));
    }
  }
}

/**
 * 临时文件名的形状：`<target>.<pid>.<uuid|epoch-ms>.tmp`。
 * UUID 是当前写法；更早的版本用毫秒时间戳，仓库里那条 2026-10-17 的残留
 * （`reflections.json.40816.1792249444537.tmp`）就是后一种，两种都要能回收。
 */
const TEMP_NAME_RE = /^(.+)\.\d+\.(?:\d+|[0-9a-f]{8}-[0-9a-f-]{27})\.tmp$/i;
/** 超过这个年龄的临时文件才回收：正在写的那个必须留着。 */
const ORPHAN_TEMP_MS = 10 * 60_000;

/**
 * 回收上次崩溃留下的临时文件。
 *
 * 写临时文件与 rename 之间进程被杀（桌面 app 关窗即杀子进程、任务被杀、
 * 断电），`finally` 不会跑，`.tmp` 就永远留在目录里。实测过一次：仓库的
 * `.aicode/reflections.json.40816.1792249444537.tmp` 从 2026-10-17 留到现在。
 * 每次写到同一目标时顺手清掉同前缀、够老的孤儿文件——只按名字前缀匹配，
 * 不碰别人的文件；年龄门槛保证不会误删另一个进程正在写的那个。
 */
async function sweepOrphanTemps(targetPath: string, now = Date.now()): Promise<void> {
  const dir = dirname(targetPath);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  await Promise.all(names
    .filter((name) => {
      const match = TEMP_NAME_RE.exec(name);
      return match !== null && match[1] === basename(targetPath);
    })
    .map(async (name) => {
      const full = join(dir, name);
      try {
        const info = await stat(full);
        if (now - info.mtimeMs < ORPHAN_TEMP_MS) return;
        await unlink(full);
      } catch {
        // 已经被别人收走，或被短暂占用：下次再试。
      }
    }));
}

/** Write to a sibling temp file and rename it into place: the target is never observable half-written. */
export async function writeFileAtomic(path: string, content: string | Uint8Array) {
  await mkdir(dirname(path), { recursive: true });
  await sweepOrphanTemps(path);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: typeof content === 'string' ? 'utf8' : undefined, flag: 'wx' });
  } catch (error) {
    // 磁盘满/配额/权限：`writeFile` 可能已经把文件建出来再写了一半，这里
    // 直接抛会让半个 .tmp 留在目录里。只删「本次刚创建的那个名字」，不会
    // 误伤别人——uuid 是本进程这次生成的。
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  try {
    await renameWithRetry(temporary, path);
  } catch (error) {
    // Windows 上刚写完的文件可能还被索引/杀毒短暂持有，一次 unlink 失败就
    // 会留下 .tmp；多试几次，仍失败就交给 sweepOrphanTemps 回收。
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await unlink(temporary);
        break;
      } catch {
        if (attempt < 2) await new Promise((done) => setTimeout(done, 20 * (attempt + 1)));
      }
    }
    throw error;
  }
}
