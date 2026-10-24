import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { renameWithRetry, serializeWrites as serialize, writeFileAtomic } from '../utils/atomic.js';
import type { NewMemoryInput, ProjectMemoryEntry, ProjectMemoryFile } from './types.js';
import { memoryTokens } from './tokens.js';

const MAX_SUMMARY = 240;

export class ProjectMemoryStore {
  private readonly filePath: string;
  /** The unreadable file is moved aside at most once per store. */
  private quarantined = false;

  constructor(workspaceRoot: string) {
    this.filePath = resolve(workspaceRoot, '.aicode', 'memory', 'entries.json');
  }

  async load(): Promise<ProjectMemoryFile> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch {
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
    await this.quarantine();
    return emptyFile(new Date().toISOString());
  }

  private async quarantine() {
    if (this.quarantined) return;
    this.quarantined = true;
    try {
      if ((await stat(this.filePath)).size === 0) return;
    } catch {
      return;
    }
    const target = `${this.filePath}.corrupt-${new Date().toISOString().replace(/[-:.TZ]/g, '')}.json`;
    try {
      await renameWithRetry(this.filePath, target);
    } catch {
      // best effort: never fail a memory operation over the backup copy
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
   * Read, edit and rewrite the file as one queued step. Editing a copy read
   * outside the queue would drop an entry a concurrent session added in
   * between. The edit reports whether it changed anything; an unchanged file is
   * not rewritten.
   */
  private async mutate(edit: (file: ProjectMemoryFile) => boolean, nowIso = new Date().toISOString()) {
    await serialize(this.filePath, async () => {
      const file = await this.load();
      if (!edit(file)) return;
      file.updatedAt = nowIso;
      await this.write(file);
    });
  }

  private async write(file: ProjectMemoryFile) {
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
