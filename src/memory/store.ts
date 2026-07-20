import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { NewMemoryInput, ProjectMemoryEntry, ProjectMemoryFile } from './types.js';

const MAX_SUMMARY = 240;

export class ProjectMemoryStore {
  private readonly filePath: string;

  constructor(workspaceRoot: string) {
    this.filePath = resolve(workspaceRoot, '.aicode', 'memory', 'entries.json');
  }

  async load(): Promise<ProjectMemoryFile> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as ProjectMemoryFile;
      if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.entries)) {
        return emptyFile(new Date().toISOString());
      }
      return parsed;
    } catch {
      return emptyFile(new Date().toISOString());
    }
  }

  async save(file: ProjectMemoryFile) {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
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
    const file = await this.load();
    file.entries = [entry, ...file.entries];
    file.updatedAt = nowIso;
    await this.save(file);
    return entry;
  }

  async forget(idOrQuery: string): Promise<ProjectMemoryEntry | undefined> {
    const file = await this.load();
    const needle = idOrQuery.trim().toLowerCase();
    const index = file.entries.findIndex((entry) => {
      if (!entry.active) return false;
      if (entry.id === idOrQuery) return true;
      return entry.summary.toLowerCase().includes(needle) || entry.keywords.some((keyword) => keyword.includes(needle));
    });
    if (index < 0) return undefined;
    const nowIso = new Date().toISOString();
    file.entries[index] = { ...file.entries[index], active: false, updatedAt: nowIso };
    file.updatedAt = nowIso;
    await this.save(file);
    return file.entries[index];
  }
}

export function truncateSummary(value: string) {
  return value.replace(/\s+/g, ' ').trim().slice(0, MAX_SUMMARY);
}

export function deriveKeywords(summary: string) {
  return uniqueKeywords(
    summary
      .toLowerCase()
      .split(/[^a-z0-9\u4e00-\u9fff]+/i)
      .map((part) => part.trim())
      .filter((part) => part.length >= 2),
  );
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
