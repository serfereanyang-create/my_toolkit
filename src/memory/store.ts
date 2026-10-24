import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { renameWithRetry, serializeWrites as serialize, writeFileAtomic } from '../utils/atomic.js';
import type { NewMemoryInput, ProjectMemoryEntry, ProjectMemoryFile } from './types.js';
import { memoryTokens } from './tokens.js';

const MAX_SUMMARY = 240;

/**
 * 只在测试里替换：「读不了」和「挪不开」在 Windows 上依赖文件被另一个进程
 * 占着，没法按需制造。生产路径永远走真实实现。
 */
export type ProjectMemoryStoreDeps = {
  readFile?: (path: string, encoding: BufferEncoding) => Promise<string>;
  rename?: (from: string, to: string) => Promise<void>;
};

export class ProjectMemoryStore {
  private readonly filePath: string;
  private readonly readFileImpl: (path: string, encoding: BufferEncoding) => Promise<string>;
  private readonly renameFile: (from: string, to: string) => Promise<void>;
  /** The unreadable file is moved aside at most once per store. */
  private quarantined = false;
  /**
   * 读不了又挪不开时置上：这份文件的内容我们既没读到、也没备份，写下去就是
   * 拿空库覆盖它。宁可这次记忆操作报错，也不能悄悄抹掉能手工救回来的数据。
   */
  private blockedReason: string | null = null;

  constructor(workspaceRoot: string, deps: ProjectMemoryStoreDeps = {}) {
    this.filePath = resolve(workspaceRoot, '.aicode', 'memory', 'entries.json');
    this.readFileImpl = deps.readFile ?? ((path, encoding) => readFile(path, encoding));
    this.renameFile = deps.rename ?? renameWithRetry;
  }

  async load(): Promise<ProjectMemoryFile> {
    let raw: string;
    try {
      raw = await this.readFileImpl(this.filePath, 'utf8');
    } catch (error) {
      // 只有 ENOENT 才是「还没有记忆库」。EACCES/EPERM/EBUSY/EISDIR 是读不了，
      // 把它当成空库，下一笔写入就会拿着空信封覆盖掉原文件。
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyFile(new Date().toISOString());
      await this.protectUnreadable(error);
      return emptyFile(new Date().toISOString());
    }
    try {
      const parsed = JSON.parse(raw) as ProjectMemoryFile;
      if (parsed && parsed.version === 1 && Array.isArray(parsed.entries)) return parsed;
    } catch {
      // fall through: the file is corrupt
    }
    // Returning an empty store is the right answer for a read, but the next
    // write would then replace the file and take the history with it. Move the
    // unreadable copy aside first so it can still be recovered by hand.
    await this.protectUnreadable();
    return emptyFile(new Date().toISOString());
  }

  /** 挪开读不了/解析不了的文件；挪不动就把本实例设成不可写。 */
  private async protectUnreadable(cause?: unknown) {
    if (await this.quarantine()) {
      // 上一次挪不动、这一次挪开了：解锁，别让一次临时占用永久禁写。
      this.blockedReason = null;
      return;
    }
    const code = (cause as NodeJS.ErrnoException | undefined)?.code ?? 'unreadable';
    this.blockedReason = `记忆库文件既读不出也挪不开（${code}）：为免覆盖原文件，本次未写入 ${this.filePath}`;
  }

  /** 成功挪开才置位；置位在尝试之前会把「暂时被占用」变成「永久放弃」。 */
  private async quarantine(): Promise<boolean> {
    if (this.quarantined) return true;
    try {
      // 空文件或已经不在了：没有内容可救，也算处理完毕。
      if ((await stat(this.filePath)).size === 0) {
        this.quarantined = true;
        return true;
      }
    } catch {
      this.quarantined = true;
      return true;
    }
    const target = `${this.filePath}.corrupt-${new Date().toISOString().replace(/[-:.TZ]/g, '')}.json`;
    try {
      await this.renameFile(this.filePath, target);
      this.quarantined = true;
      return true;
    } catch {
      // 不置位：下一次 load 还会再试；挪不开时由 protectUnreadable 封掉写入。
      return false;
    }
  }

  async save(file: ProjectMemoryFile) {
    await serialize(this.filePath, async () => {
      await this.write(file);
    });
  }

  async list(options?: { includeInactive?: boolean }) {
    const file = await this.load();
    const entries = options?.includeInactive ? file.entries : file.entries.filter((entry) => entry.active);
    return entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async add(input: NewMemoryInput): Promise<ProjectMemoryEntry> {
    const nowIso = input.nowIso ?? new Date().toISOString();
    const summary = truncateSummary(input.summary);
    if (!summary) throw new Error('Memory summary is required');
    const entry: ProjectMemoryEntry = {
      id: `mem_${nowIso.replace(/[-:.TZ]/g, '').slice(0, 14)}_${randomUUID().slice(0, 8)}`,
      kind: input.kind,
      summary,
      keywords: uniqueKeywords(input.keywords ?? deriveKeywords(summary)),
      source: input.source,
      createdAt: nowIso,
      updatedAt: nowIso,
      active: true,
    };
    await this.mutate((current) => {
      current.entries = [entry, ...current.entries];
      return true;
    }, nowIso);
    return entry;
  }

  async forget(idOrQuery: string): Promise<ProjectMemoryEntry | undefined> {
    const needle = idOrQuery.trim().toLowerCase();
    const nowIso = new Date().toISOString();
    let forgotten: ProjectMemoryEntry | undefined;
    await this.mutate((file) => {
      const index = file.entries.findIndex((entry) => {
        if (!entry.active) return false;
        if (entry.id === idOrQuery) return true;
        return entry.summary.toLowerCase().includes(needle) || entry.keywords.some((keyword) => keyword.includes(needle));
      });
      if (index < 0) return false;
      forgotten = file.entries[index] = { ...file.entries[index], active: false, updatedAt: nowIso };
      return true;
    }, nowIso);
    return forgotten;
  }

  /**
   * 整个「读—改—写」在同一个队列步骤里完成，并把结果带出来。
   *
   * 这是给 `memory_digest` 这类**算完再写**的调用方用的：它们在队列外面先
   * `load()` 一份快照、算完计划再 `save()`，中间别的会话写进来的条目就丢了。
   * 编辑函数拿到的一定是队列里最新的那一份。
   */
  async update<T>(
    edit: (file: ProjectMemoryFile) => Promise<{ changed: boolean; value: T }> | { changed: boolean; value: T },
    nowIso: string = new Date().toISOString(),
  ): Promise<T> {
    return serialize(this.filePath, async () => {
      const file = await this.load();
      const { changed, value } = await edit(file);
      if (!changed) return value;
      file.updatedAt = nowIso;
      await this.write(file);
      return value;
    });
  }

  /**
   * Read, edit and rewrite the file as one queued step. Editing a copy read
   * outside the queue would drop an entry a concurrent session added in
   * between. The edit reports whether it changed anything; an unchanged file is
   * not rewritten.
   */
  private async mutate(edit: (file: ProjectMemoryFile) => boolean, nowIso?: string) {
    await this.update((file) => ({ changed: edit(file), value: undefined }), nowIso);
  }

  private async write(file: ProjectMemoryFile) {
    if (this.blockedReason) throw new Error(this.blockedReason);
    await writeFileAtomic(this.filePath, `${JSON.stringify(file, null, 2)}\n`);
  }
}

export function truncateSummary(value: string) {
  return value.replace(/\s+/g, ' ').trim().slice(0, MAX_SUMMARY);
}

export function deriveKeywords(summary: string) {
  // Memory tokens, not a punctuation split: Chinese has no spaces, so the old
  // split kept a whole sentence as one keyword that nothing could ever match.
  return uniqueKeywords(memoryTokens(summary));
}

export function uniqueKeywords(values: string[]) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const normalized = value.toLowerCase().trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= 12) break;
  }
  return out;
}

function emptyFile(nowIso: string): ProjectMemoryFile {
  return { version: 1, updatedAt: nowIso, entries: [] };
}
