import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const instructionFiles = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', 'README.md'];
const maxFileBytes = 4000;
const maxContextBytes = 12000;

type CacheEntry = {
  context: ProjectContext;
  hits: number;
  misses: number;
  lastAccessAt: number;
};

const cache = new Map<string, CacheEntry>();

export type ProjectContext = {
  text: string;
  /** Stable key for prompt-cache / reuse; derived only from instruction file signatures. */
  cacheKey: string;
  files: Array<{ path: string; mtimeMs: number; size: number }>;
  /** Preformatted provider block so callers don't re-string on every step. */
  formatted: string;
};

export type ProjectContextCacheStats = {
  entries: number;
  hits: number;
  misses: number;
};

export async function readProjectContext(workspaceRoot: string): Promise<ProjectContext | undefined> {
  const files = await projectInstructionStats(workspaceRoot);
  const cacheKey = hashSignature(files);
  const existing = cache.get(workspaceRoot);
  if (existing?.context.cacheKey === cacheKey) {
    existing.hits += 1;
    existing.lastAccessAt = Date.now();
    return existing.context;
  }

  const sections: string[] = [];
  for (const file of files) {
    const content = await readOptionalText(join(workspaceRoot, file.path));
    if (!content) continue;
    sections.push(`## ${file.path}\n${content.slice(0, maxFileBytes)}`);
  }
  const text = sections.join('\n\n').slice(0, maxContextBytes);
  if (!text) {
    if (existing) existing.misses += 1;
    return undefined;
  }

  // Keep formatted text byte-stable for the same cacheKey so hosted prompt caches can hit.
  const formatted = [
    `cacheKey=${cacheKey}`,
    `files=${files.map((file) => file.path).join(',') || 'none'}`,
    text,
  ].join('\n');

  const context: ProjectContext = { text, cacheKey, files, formatted };
  const prevMisses = existing?.misses ?? 0;
  cache.set(workspaceRoot, {
    context,
    hits: existing?.hits ?? 0,
    misses: prevMisses + 1,
    lastAccessAt: Date.now(),
  });
  return context;
}

export function formatProjectContext(context: ProjectContext | undefined) {
  if (!context) return undefined;
  return context.formatted;
}

export function getProjectContextCacheStats(): ProjectContextCacheStats {
  let hits = 0;
  let misses = 0;
  for (const entry of cache.values()) {
    hits += entry.hits;
    misses += entry.misses;
  }
  return { entries: cache.size, hits, misses };
}

/** Test helper / memory hygiene. */
export function clearProjectContextCache() {
  cache.clear();
}

async function projectInstructionStats(workspaceRoot: string) {
  const files: ProjectContext['files'] = [];
  for (const path of instructionFiles) {
    try {
      const info = await stat(join(workspaceRoot, path));
      if (info.isFile()) files.push({ path, mtimeMs: info.mtimeMs, size: info.size });
    } catch {
      // Missing instruction files are expected.
    }
  }
  return files;
}

async function readOptionalText(path: string) {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

function hashSignature(files: ProjectContext['files']) {
  const hash = createHash('sha1');
  // Order is fixed by instructionFiles walk — stable across processes.
  hash.update(JSON.stringify(files));
  return hash.digest('hex').slice(0, 12);
}
