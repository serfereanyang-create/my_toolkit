/**
 * store.ts — 反思条目的工作区持久化（.aicode/reflections.json）。
 *
 * 与 ProjectMemoryStore 同构：串行写队列 + temp/rename 原子落盘 +
 * 上限裁剪（按 hits+recency 保留最近 200 条）。
 *
 * 这个文件只有一份：它是智能体在项目里"踩过的坑"。因此三条纪律：
 *   - 读取失败（不是"还没创建"，而是锁住/EPERM）时绝不回写，否则一次瞬时
 *     占用就把整份教训清空；
 *   - 解析失败时先另存副本再当空文件用，副本还留在磁盘上可人工恢复；
 *   - 串行队列按文件路径共享（ReflectionStore 每次调用都是新实例：
 *     tools.ts、commands.ts、runtime 各持一个，实例级队列根本挡不住并发）。
 */

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { renameWithRetry, serializeWrites as serialize, writeFileAtomic } from '../utils/atomic.js';
import { withFileLock, type LockOptions } from '../utils/lockfile.js';
import { formatReflections, type ReflectionEntry, type ReflectionKind } from './types.js';

const MAX_ENTRIES = 200;
const TOPIC_LIMIT = 160;
const FAILURE_LIMIT = 400;

const KINDS: ReflectionKind[] = ['tool_failure', 'max_steps', 'exception', 'cancelled', 'manual'];

export interface AddReflectionInput {
  topic: string;
  failure: string;
  lesson: string;
  kind: ReflectionKind;
}

/** 读到的条目 + 能不能安全回写（读不到内容时不能）。 */
type ReflectionRead = { entries: ReflectionEntry[]; writable: boolean };

/**
 * 只留下所有读取方都能用的条目：`selectRelevant` 会对 topic/failure 做
 * 词法切分、`formatReflections` 会拼字符串，一个数字或 null 就会让它们抛
 * TypeError —— 而调用点（loadReflectionBlock）是静默 catch 的，表现为
 * "反思从此再也不出现"，很难查。
 */
function normalizeStoredEntry(value: unknown): ReflectionEntry | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.topic !== 'string' || typeof raw.failure !== 'string') return undefined;
  const hits = typeof raw.hits === 'number' && Number.isFinite(raw.hits) ? Math.max(1, Math.floor(raw.hits)) : 1;
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : `ref_${randomUUID()}`,
    topic: raw.topic,
    failure: raw.failure,
    lesson: typeof raw.lesson === 'string' ? raw.lesson : '',
    kind: KINDS.includes(raw.kind as ReflectionKind) ? (raw.kind as ReflectionKind) : 'exception',
    at: typeof raw.at === 'string' && !Number.isNaN(Date.parse(raw.at)) ? raw.at : new Date(0).toISOString(),
    hits,
  };
}

export type ReflectionStoreDeps = {
  /** 测试注入：Windows 上「文件被占用导致 rename EPERM」没法按需制造。 */
  rename?: (from: string, to: string) => Promise<void>;
  lock?: LockOptions;
};

export class ReflectionStore {
  private readonly filePath: string;
  private readonly lockOptions: LockOptions;
  private readonly renameFile: (from: string, to: string) => Promise<void>;
  /** 损坏的副本最多挪走一次。 */
  private quarantined = false;

  constructor(workspaceRoot: string, deps: ReflectionStoreDeps = {}) {
    this.filePath = join(workspaceRoot, '.aicode', 'reflections.json');
    this.lockOptions = deps.lock ?? {};
    this.renameFile = deps.rename ?? renameWithRetry;
  }

  async list(): Promise<ReflectionEntry[]> {
    return (await this.readEntries()).entries;
  }

  /** 追加（按 topic+kind 去重：命中则 hits+1 并刷新 lesson）。 */
  async add(input: AddReflectionInput): Promise<ReflectionEntry> {
    const entry: ReflectionEntry = {
      id: randomUUID(),
      topic: input.topic.slice(0, TOPIC_LIMIT),
      failure: input.failure.slice(0, FAILURE_LIMIT),
      lesson: input.lesson,
      kind: input.kind,
      at: new Date().toISOString(),
      hits: 1,
    };
    // 命中既有条目时返回的就是那一条：返回一个没落盘的 id 会让调用方
    // （例如之后按 id 去 forget）永远找不到它。
    let stored: ReflectionEntry = entry;
    await this.enqueue((entries) => {
      const existing = entries.find(
        (e) => e.kind === entry.kind && e.topic === entry.topic && e.failure === entry.failure,
      );
      if (existing) {
        existing.hits += 1;
        existing.at = entry.at;
        if (entry.lesson) existing.lesson = entry.lesson;
        stored = existing;
        return undefined;
      }
      entries.unshift(entry);
      // 保留上限：按 hits * recency 粗排（list 已近似插入序，直接截断）
      if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES;
      return undefined;
    });
    return stored;
  }

  async forget(id: string): Promise<boolean> {
    let removed = false;
    await this.enqueue((entries) => {
      const before = entries.length;
      const kept = entries.filter((e) => e.id !== id);
      removed = kept.length < before;
      return kept;
    });
    return removed;
  }

  /** 记录检索命中（注入后调用），同样串行化。 */
  async touchHits(ids: string[]): Promise<void> {
    const idSet = new Set(ids);
    if (idSet.size === 0) return;
    await this.enqueue((entries) => {
      for (const entry of entries) {
        if (idSet.has(entry.id)) entry.hits += 1;
      }
    });
  }

  /** 读取当前词法检索打分选 top N。 */
  selectRelevant(reflections: ReflectionEntry[], prompt: string, limit = 3): ReflectionEntry[] {
    if (reflections.length === 0) return [];
    const lower = prompt.toLowerCase();
    const scored = reflections.map((entry) => {
      let score = 0;
      for (const word of tokenize(entry.topic)) {
        if (word.length >= 2 && lower.includes(word)) score += 2;
      }
      for (const word of tokenize(entry.failure)) {
        if (word.length >= 3 && lower.includes(word)) score += 1;
      }
      // 轻微 recency：近期失败更可能复现
      const ageDays = (Date.now() - Date.parse(entry.at)) / 86_400_000;
      if (Number.isFinite(ageDays) && ageDays < 30) score += 1;
      score += Math.min(2, entry.hits / 5);
      return { entry, score };
    });
    return scored
      .filter((s) => s.score > 2)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => s.entry);
  }

  buildBlock(reflections: ReflectionEntry[]): string {
    return formatReflections(reflections);
  }

  /**
   * 串行写队列：读-改-写全部经过同一队列。队列按文件路径在模块级共享，
   * 因为同一进程里同时存在多个 ReflectionStore 实例（见文件头注释）。
   */
  private enqueue(mutate: (entries: ReflectionEntry[]) => void | ReflectionEntry[]): Promise<void> {
    // 队列只挡同一进程；反射库和记忆库一样会被「桌面会话 + 定时任务」两个
    // 进程同时写，读—改—写必须整段在跨进程文件锁里，否则两边各读一份旧内容，
    // 后落盘的那份把另一份新增的教训抹掉。
    return serialize(this.filePath, () => withFileLock(`${this.filePath}.lock`, async () => {
      const { entries, writable } = await this.readEntries();
      const result = mutate(entries);
      // 读不到原文件内容时宁可丢掉这次新增，也不要把整份教训覆盖掉。
      if (!writable) return;
      const next = Array.isArray(result) ? result : entries;
      await this.persist(next);
    }, this.lockOptions));
  }

  /** 读回条目数组（兼容 {version, entries} 信封与裸数组两种落盘形态）。 */
  private async readEntries(): Promise<ReflectionRead> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { entries: [], writable: true };
      // 文件在，但我们读不到（被占用/权限）：内容未知，禁止回写。
      return { entries: [], writable: false };
    }
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      data = undefined;
    }
    const list = Array.isArray(data)
      ? (data as unknown[])
      : data && typeof data === 'object' && Array.isArray((data as { entries?: unknown }).entries)
        ? ((data as { entries: unknown[] }).entries)
        : undefined;
    const entries = (list ?? []).map(normalizeStoredEntry).filter((entry): entry is ReflectionEntry => entry !== undefined);
    // 整个文件没有一条能用（截断/外来格式）：先留副本，再当作空历史继续。
    // 只要还有能用的条目就保持原文件不动（多出来的未知条目只是被忽略）；
    // 结构完好但内容为空的文件也不算损坏——不然每次读空文件都要挪一个副本。
    const unusable = list === undefined || (list.length > 0 && entries.length === 0);
    if (unusable) {
      const preserved = await this.quarantine();
      if (!preserved) return { entries, writable: false };
    }
    return { entries, writable: true };
  }

  /**
   * 把损坏的文件挪到 *.corrupt-*.json；返回 true 表示原路径已经空出来了。
   *
   * 只有「确实挪开」或「本来就不在」才算处理完。之前的实现先把 `quarantined`
   * 置位再尝试 rename：一次 EPERM（Windows 上另一个进程正读着这个文件）会
   * 让下一次读直接返回 true，接着就把损坏文件所在的路径覆盖掉——正是内存库
   * 用 `quarantine()` 修掉的那个「暂时占用变成永久丢数据」。
   */
  private async quarantine(): Promise<boolean> {
    if (this.quarantined) return true;
    const target = `${this.filePath}.corrupt-${new Date().toISOString().replace(/[-:.TZ]/g, '')}.json`;
    try {
      await this.renameFile(this.filePath, target);
      this.quarantined = true;
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.quarantined = true;
        return true;
      }
      return false;
    }
  }

  private async persist(entries: ReflectionEntry[]): Promise<void> {
    await writeFileAtomic(this.filePath, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`);
  }
}

function tokenize(text: string): string[] {
  const words: string[] = [];
  let current = '';
  for (const ch of text.toLowerCase()) {
    const isWordChar = /[a-z0-9_\u4e00-\u9fff]/.test(ch);
    if (isWordChar) {
      current += ch;
    } else {
      if (current) words.push(current);
      current = '';
    }
  }
  if (current) words.push(current);
  // 中文按 2-gram 粗切，提高召回（"路径不存在" 命中 "路径"）
  for (const word of [...words]) {
    if (/[\u4e00-\u9fff]/.test(word) && word.length >= 3) {
      for (let i = 0; i + 2 <= word.length; i += 1) {
        words.push(word.slice(i, i + 2));
      }
    }
  }
  return words;
}
