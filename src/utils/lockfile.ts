import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, stat, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname } from 'node:path';

/**
 * 跨进程的互斥锁，用「独占创建」这一个原子操作实现。
 *
 * 为什么需要它：`serializeWrites` 的队列是进程内的一个 Map，两个桌面会话
 * 各起一个 CLI、定时任务再起一个，彼此看不见；`writeFileAtomic` 只保证文件
 * 不会写一半，不保证「读—改—写」不丢更新。记忆库、检查点索引这类整文件
 * JSON 存储，一旦两个进程真的同时写，就是一份条目的静默消失。
 *
 * 拿锁 = `open(path, 'wx')`：文件已存在就 EEXIST，这是 POSIX 和 Windows 上
 * 都原子的一个系统调用，不需要新依赖。锁文件里写 JSON（token / pid / 主机 /
 * 起始时间），不是为了好看：释放时要按 token 确认这个锁还是自己的，抢占时
 * 要判断持有者是否已经死了。
 *
 * 明确不做的事：
 *   - 不保证「公平」，谁先退避完谁先抢到；
 *   - 不保证 NFS/SMB 上的正确性（`wx` 在有些网络文件系统上不是原子的）；
 *   - 不防「进程活着但卡死」。僵死锁由 staleMs + pid 存活探测兜底：超过
 *     staleMs 且持有者不在同一台机器上活着，才敢删。同一台机器上活着就继续等，
 *     因为一个慢但正常的写不该被抢走。
 */

export type LockOptions = {
  /** 等锁上限，超时抛错（默认 5s：一次整文件 JSON 写入远到不了这个量级）。 */
  timeoutMs?: number;
  /** 锁文件超过这个年龄才考虑抢占（默认 20s）。 */
  staleMs?: number;
  /** 首次重试等待，之后翻倍（默认 8ms，封顶 120ms）。 */
  retryDelayMs?: number;
  now?: () => number;
};

export type LockHandle = {
  /** 释放锁。重复调用是安全的。 */
  release: () => Promise<void>;
  /** 为了日志与测试：这把锁的身份。 */
  token: string;
};

type LockPayload = {
  token: string;
  pid: number;
  host: string;
  startedAt: string;
};

const DEFAULTS = { timeoutMs: 5000, staleMs: 20_000, retryDelayMs: 8 };

export class LockTimeoutError extends Error {
  readonly lockPath: string;
  constructor(lockPath: string, timeoutMs: number, holder: string, lastCode?: string) {
    super(`等待文件锁超时（${timeoutMs}ms）：${lockPath}${holder ? `（当前持有者 ${holder}）` : ''}${lastCode ? `，最后一次尝试 ${lastCode}` : ''}`);
    this.name = 'LockTimeoutError';
    this.lockPath = lockPath;
  }
}

export async function withFileLock<Result>(
  lockPath: string,
  task: () => Promise<Result>,
  options: LockOptions = {},
): Promise<Result> {
  const handle = await acquireFileLock(lockPath, options);
  try {
    return await task();
  } finally {
    await handle.release();
  }
}

export async function acquireFileLock(lockPath: string, options: LockOptions = {}): Promise<LockHandle> {
  const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
  const staleMs = options.staleMs ?? DEFAULTS.staleMs;
  const now = options.now ?? (() => Date.now());
  const payload: LockPayload = {
    token: randomUUID(),
    pid: process.pid,
    host: hostname(),
    startedAt: new Date(now()).toISOString(),
  };
  const deadline = now() + timeoutMs;
  let delay = options.retryDelayMs ?? DEFAULTS.retryDelayMs;
  let lastCode: string | undefined;
  /**
   * 「报冲突但看不见锁文件」连续出现了几次。
   *
   * 这不是疑心病：Windows 上 `unlink` 与 `open(...,'wx')` 撞在一起时，`open`
   * 报 EPERM，紧跟的 `stat` 也报 ENOENT（名字正在被删），于是「冲突码 + 文件
   * 不在场」这种组合会真实地闪一下——20 个并发写在跑测试时就这么撞过一次
   * （EPERM，但锁文件早已被上一个释放者删掉）。所以这里连续容忍几次，扛不过
   * 才认定是真的没权限，把原始错误抛出去。
   */
  let absentStreak = 0;

  for (;;) {
    await mkdir(dirname(lockPath), { recursive: true }).catch(() => undefined);
    try {
      const handle = await open(lockPath, 'wx');
      /**
       * 拿到文件之后、写 token 之前，这个锁还是「无名」的：释放者读不出
       * token 就无从确认它是不是自己的。所以写入失败时必须在同一个原子窗口
       * 里收尾——close 之后立刻 unlink，绝不能不声不响地把一把无名锁留在
       * 盘上，也不能让它一直挂到 staleMs。写入成功之后我们已经有归属
       * （release 按 token 认），这条路径才算安全。
       */
      try {
        await handle.writeFile(`${JSON.stringify(payload)}\n`, 'utf8');
      } catch (writeError) {
        await handle.close().catch(() => undefined);
        await unlink(lockPath).catch(() => undefined);
        throw writeError;
      }
      await handle.close().catch(() => undefined);
      let released = false;
      return {
        token: payload.token,
        release: async () => {
          if (released) return;
          released = true;
          await releaseLock(lockPath, payload.token);
        },
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? 'unknown';
      lastCode = code;
      if (!CONTENTION_CODES.has(code)) throw error;
      // Windows 上「文件已被别人打开」报 EPERM/EBUSY 而不是 EEXIST（`wx` 的
      // 独占语义落到 Win32 上是 share mode）。锁文件不在场时，同样的错误码
      // 多半是真的没权限——那要立刻抛，不能伪装成「在等锁」等到超时；但删锁
      // 与建锁撞车的那一瞬间也会长成这样，所以给几次机会再判死。
      if (code === 'EEXIST' || code === 'ENOENT' || (await exists(lockPath))) {
        absentStreak = 0;
      } else if (++absentStreak > MAX_ABSENT_STREAK) {
        throw error;
      } else {
        // 让正在进行的删锁先落地，否则重试还是同一个瞬间。
        await sleep(2);
      }
    }

    // 有人的锁在这儿。先看看是不是被抛下的（持有者已死），是就摘掉立刻再抢；
    // 不是就退避——不摘活人的锁，哪怕它慢了。
    const broken = await breakStaleLock(lockPath, { staleMs, now });
    if (!broken) {
      if (now() >= deadline) throw new LockTimeoutError(lockPath, timeoutMs, await describeHolder(lockPath), lastCode);
      await sleep(delay + Math.floor(Math.random() * delay));
      delay = Math.min(delay * 2, 120);
    }
  }
}

/** 「有人在用」的错误码。EEXIST 是标准答案，其余是 Windows 的几种说法。 */
const CONTENTION_CODES = new Set(['EEXIST', 'EPERM', 'EBUSY', 'EACCES', 'ENOENT']);

/** 冲突码连续「看不见锁文件」的上限，超过就认定是真的没权限（见 acquireFileLock）。 */
const MAX_ABSENT_STREAK = 5;

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** 只有「年龄超阈值」且「持有者确定不在了」才摘；摘下返回 true。 */
async function breakStaleLock(lockPath: string, options: { staleMs: number; now: () => number }): Promise<boolean> {
  let ageMs: number;
  try {
    const info = await stat(lockPath);
    ageMs = options.now() - info.mtimeMs;
  } catch {
    // 已经没了（别人刚释放）：不用摘，直接重试创建。
    return true;
  }
  if (ageMs < options.staleMs) return false;
  const holder = await readLock(lockPath);
  // 同一台机器上还活着 = 只是慢，继续等。换机器/pid 已死 = 抛下的锁。
  if (holder && holder.host === hostname() && processAlive(holder.pid)) return false;
  /**
   * 摘锁前再认一次。
   *
   * 两个进程可以同时判定同一把旧锁 stale：第一个 unlink 之后，B 可能已经
   * 用 `wx` 建好了新锁，第二个进程再 unlink 就删掉了活人的锁——双方同时
   * 进临界区。这里在 unlink 之前重读一次，token 变了（新锁）就放弃，
   * 回到下一轮重新判断；原本就读不出内容的坏锁仍然允许回收。
   */
  const again = await readLock(lockPath);
  if ((holder?.token ?? null) !== (again?.token ?? null)) return false;
  try {
    await unlink(lockPath);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // 别人先摘掉了，或者 Windows 上这个文件还被打开着：都按「没摘成」处理，
    // 下一轮重新判断，绝不当成拿到锁。
    if (code === 'ENOENT') return true;
    return false;
  }
}

async function releaseLock(lockPath: string, token: string) {
  /**
   * 只删「确定是自己的」锁。
   *
   * 旧实现是「读不出 token 就直接 unlink」，把三种情况混成了一种：
   *   - 文件已经不在了：close 到 unlink 之间的正常窗口，删不删都无所谓；
   *   - 文件在、但内容读不出/坏了/还没写完：这不是我们的锁——抢占交错里
   *     B 刚用 `wx` 建好、还没写 payload 的那一瞬就是空的，旧实现会把它
   *     删掉，C 随即拿到锁，B 和 C 同时进临界区；
   *   - Windows 上 readFile 撞到短暂的 EBUSY/EPERM：锁是活着的，删了就
   *     等于双持有。
   *
   * 因此这里只认一个结论：读到的 token 与自己的相同才 unlink。其余一律
   * 不动，留给 stale 逻辑按持有者存活情况回收。
   */
  const holder = await readLock(lockPath);
  if (!holder || holder.token !== token) return;
  try {
    await unlink(lockPath);
  } catch {
    // 已经不在了，或 Windows 上暂时删不掉——留下的锁会被 stale 逻辑回收。
  }
}

async function readLock(lockPath: string): Promise<LockPayload | null> {
  try {
    const raw = await readFile(lockPath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<LockPayload>;
    if (typeof parsed?.token !== 'string' || typeof parsed.pid !== 'number') return null;
    return { token: parsed.token, pid: parsed.pid, host: parsed.host ?? '', startedAt: parsed.startedAt ?? '' };
  } catch {
    return null;
  }
}

async function describeHolder(lockPath: string): Promise<string> {
  const holder = await readLock(lockPath);
  if (!holder) return '';
  return `pid ${holder.pid}@${holder.host || 'unknown'}, since ${holder.startedAt || 'unknown'}`;
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM = 进程在，只是不归我们管；ESRCH = 真的没了。
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function sleep(ms: number) {
  return new Promise<void>((done) => setTimeout(done, ms));
}
