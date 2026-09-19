/**
 * store.ts — 反思条目的工作区持久化（.aicode/reflections.json）。
 *
 * 与 ProjectMemoryStore 同构：串行写队列 + temp/rename 原子落盘 +
 * 上限裁剪（按 hits+recency 保留最近 200 条）。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { formatReflections, type ReflectionEntry, type ReflectionKind } from './types.js';

const MAX_ENTRIES = 200;
const TOPIC_LIMIT = 160;
const FAILURE_LIMIT = 400;

export interface AddReflectionInput {
  topic: string;
  failure: string;
  lesson: string;
  kind: ReflectionKind;
}

export class ReflectionStore {
  private readonly filePath: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(workspaceRoot: string) {
    this.filePath = join(workspaceRoot, '.aicode', 'reflections.json');
  }

  async list(): Promise<ReflectionEntry[]> {
    return this.readEntries();
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
    await this.enqueue((entries) => {
      const existing = entries.find(
        (e) => e.kind === entry.kind && e.topic === entry.topic && e.failure === entry.failure,
      );
      if (existing) {
        existing.hits += 1;
        existing.at = entry.at;
        if (entry.lesson) existing.lesson = entry.lesson;
        return undefined;
      }
      entries.unshift(entry);
      // 保留上限：按 hits * recency 粗排（list 已近似插入序，直接截断）
      if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES;
      return undefined;
    });
    return entry;
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

  /** 串行写队列：读-改-写全部经过同一队列，避免并发覆盖。 */
  private enqueue(mutate: (entries: ReflectionEntry[]) => void | ReflectionEntry[]): Promise<void> {
    const task = this.writeQueue.then(async () => {
      const entries = await this.readEntries();
      const result = mutate(entries);
      const next = Array.isArray(result) ? result : entries;
      await this.persist(next);
    });
    // 队列永不 reject 到调用方之前的 await；错误在当前 task 抛出。
    this.writeQueue = task.catch(() => undefined);
    return task;
  }

  /** 读回条目数组（兼容 {version, entries} 信封与裸数组两种落盘形态）。 */
  private async readEntries(): Promise<ReflectionEntry[]> {
    try {
      const raw = await readFile(this.filePath, 'utf-8');
      const data = JSON.parse(raw) as unknown;
      if (Array.isArray(data)) return data as ReflectionEntry[];
      if (data && typeof data === 'object' && Array.isArray((data as { entries?: unknown }).entries)) {
        return (data as { entries: ReflectionEntry[] }).entries;
      }
      return [];
    } catch {
      return [];
    }
  }

  private async persist(entries: ReflectionEntry[]): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify({ version: 1, entries }, null, 2), 'utf-8');
    await rename(tmp, this.filePath);
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
