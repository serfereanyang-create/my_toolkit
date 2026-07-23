import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { extractSymbolsFromSource } from './extract.js';
import { detectNavLanguage, isIgnoredDirName, isIndexableSourceFile } from './ignore.js';
import type { NavFileEntry, NavIndexFile } from './types.js';

const INDEX_VERSION = 1 as const;
const DEFAULT_MAX_FILES = 5000;

export type NavCacheStats = {
  hits: number;
  misses: number;
  filesCached: number;
  filesParsed: number;
  builds: number;
};

const navCacheStats: NavCacheStats = {
  hits: 0,
  misses: 0,
  filesCached: 0,
  filesParsed: 0,
  builds: 0,
};

export function getNavCacheStats(): NavCacheStats {
  return { ...navCacheStats };
}

export function resetNavCacheStats() {
  navCacheStats.hits = 0;
  navCacheStats.misses = 0;
  navCacheStats.filesCached = 0;
  navCacheStats.filesParsed = 0;
  navCacheStats.builds = 0;
}

export class NavIndexStore {
  private readonly indexPath: string;

  constructor(private readonly workspaceRoot: string) {
    this.indexPath = resolve(workspaceRoot, '.aicode', 'nav', 'index.json');
  }

  async loadOrBuild(options?: { maxFiles?: number; force?: boolean }): Promise<NavIndexFile> {
    const maxFiles = options?.maxFiles ?? DEFAULT_MAX_FILES;
    const existing = options?.force ? undefined : await this.readIndex();
    if (existing) navCacheStats.hits += 1;
    else navCacheStats.misses += 1;
    navCacheStats.builds += 1;
    const built = await this.buildIncremental(existing, maxFiles);
    await this.writeIndex(built);
    return built;
  }

  async readIndex(): Promise<NavIndexFile | undefined> {
    try {
      const raw = await readFile(this.indexPath, 'utf8');
      const parsed = JSON.parse(raw) as NavIndexFile;
      if (parsed.version !== 1 || !Array.isArray(parsed.files)) return undefined;
      return parsed;
    } catch {
      return undefined;
    }
  }

  private async writeIndex(index: NavIndexFile): Promise<void> {
    await mkdir(dirname(this.indexPath), { recursive: true });
    await writeFile(this.indexPath, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
  }

  private async buildIncremental(existing: NavIndexFile | undefined, maxFiles: number): Promise<NavIndexFile> {
    const previous = new Map((existing?.files ?? []).map((file) => [file.path, file]));
    const files: NavFileEntry[] = [];
    await this.walk(this.workspaceRoot, files, previous, maxFiles);
    return {
      version: INDEX_VERSION,
      updatedAt: new Date().toISOString(),
      workspaceRoot: this.workspaceRoot,
      files,
    };
  }

  private async walk(
    current: string,
    files: NavFileEntry[],
    previous: Map<string, NavFileEntry>,
    maxFiles: number,
  ): Promise<void> {
    if (files.length >= maxFiles) return;
    let info;
    try {
      info = await stat(current);
    } catch {
      return;
    }

    if (info.isDirectory()) {
      let entries;
      try {
        entries = await readdir(current, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (files.length >= maxFiles) return;
        if (entry.isDirectory() && isIgnoredDirName(entry.name)) continue;
        await this.walk(join(current, entry.name), files, previous, maxFiles);
      }
      return;
    }

    if (!info.isFile()) return;
    const rel = relative(this.workspaceRoot, current).replace(/\\/g, '/');
    if (!rel || rel.startsWith('..')) return;

    const cached = previous.get(rel);
    if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
      navCacheStats.filesCached += 1;
      files.push(cached);
      return;
    }

    const language = detectNavLanguage(rel);
    let symbols = cached?.symbols ?? [];
    if (isIndexableSourceFile(rel) && info.size <= 500_000) {
      try {
        const source = await readFile(current, 'utf8');
        symbols = extractSymbolsFromSource(rel, source, language);
        navCacheStats.filesParsed += 1;
      } catch {
        symbols = [];
        navCacheStats.filesParsed += 1;
      }
    } else if (language === 'other') {
      symbols = [];
    } else {
      navCacheStats.filesParsed += 1;
    }

    files.push({
      path: rel,
      mtimeMs: info.mtimeMs,
      size: info.size,
      language,
      symbols,
    });
  }
}
