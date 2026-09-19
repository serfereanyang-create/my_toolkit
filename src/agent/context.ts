import { readFile, stat } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { createHash } from 'node:crypto';

/**
 * Project instruction discovery, ported from openai/codex
 * (codex-rs/core/src/agents_md.rs + config defaults, Apache-2.0):
 * - per directory: AGENTS.override.md, then AGENTS.md, then fallback names
 *   (upstream `project_doc_fallback_filenames`; ours are CLAUDE/GEMINI/README
 *   for backwards compatibility)
 * - directory set: project root (nearest ancestor with `.git`, else the
 *   workspace root itself) down to the workspace root, root first
 * - shared 32 KiB budget across all discovered files, deducted root→cwd,
 *   over-budget files truncated by bytes (DEFAULT_PROJECT_DOC_MAX_BYTES)
 * - `\n\n--- project-doc ---\n\n` inserted once between user instructions
 *   (persona) and the first project doc (AGENTS_MD_SEPARATOR)
 */

const rootMarker = '.git';
const overrideDocName = 'AGENTS.override.md';
const primaryDocName = 'AGENTS.md';
const fallbackDocNames = ['CLAUDE.md', 'GEMINI.md', 'README.md'];
const personaPath = '.aicode/persona.md';

const personaMaxBytes = 4000;
/** config/src/config_toml.rs DEFAULT_PROJECT_DOC_MAX_BYTES. */
const PROJECT_DOC_MAX_BYTES = 32 * 1024;
/** agents_md.rs AGENTS_MD_SEPARATOR — inserted once, before the first project doc. */
const AGENTS_MD_SEPARATOR = '--- project-doc ---';

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
  const files = await discoverInstructionFiles(workspaceRoot);
  const cacheKey = hashSignature(files);
  const existing = cache.get(workspaceRoot);
  if (existing?.context.cacheKey === cacheKey) {
    existing.hits += 1;
    existing.lastAccessAt = Date.now();
    return existing.context;
  }

  const blocks: string[] = [];
  let separatorInserted = false;
  let remaining = PROJECT_DOC_MAX_BYTES;

  // Persona = the user-instructions slot (upstream injects those separately
  // from project docs); it keeps its own small budget and never gets the
  // project-doc separator.
  const persona = await readOptionalText(join(workspaceRoot, personaPath));
  if (persona?.trim()) {
    blocks.push(`## ${personaPath}\n${persona.slice(0, personaMaxBytes)}`);
  }

  for (const file of files) {
    if (file.path === personaPath) continue;
    if (remaining <= 0) break;
    const content = await readOptionalText(join(workspaceRoot, file.path));
    if (!content?.trim()) continue;
    const take = content.length <= remaining ? content : content.slice(0, remaining);
    remaining -= take.length;
    if (blocks.length > 0 && !separatorInserted) {
      blocks.push(AGENTS_MD_SEPARATOR);
      separatorInserted = true;
    }
    blocks.push(`## ${file.path}\n${take}`);
  }

  const text = blocks.join('\n\n');
  if (!text.trim()) {
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

/**
 * agents_md.rs directory walk: nearest ancestor with `.git` is the project
 * root; without a marker only the workspace root itself is scanned. Returns
 * discovered files ordered root → workspace root, one doc per directory.
 */
export async function discoverInstructionFiles(workspaceRoot: string): Promise<ProjectContext['files']> {
  const files: ProjectContext['files'] = [];
  const persona = await statOptional(join(workspaceRoot, personaPath));
  if (persona?.isFile()) {
    files.push({ path: personaPath, mtimeMs: persona.mtimeMs, size: persona.size });
  }

  const root = await findProjectRoot(workspaceRoot);
  const dirs = hierarchyRootToCwd(root, workspaceRoot);
  for (const dir of dirs) {
    const label = dir === workspaceRoot ? '' : relative(workspaceRoot, dir).replace(/\\/g, '/');
    const names = [overrideDocName, primaryDocName, ...fallbackDocNames];
    for (const name of names) {
      const info = await statOptional(join(dir, name));
      if (!info?.isFile()) continue;
      const path = label ? `${label}/${name}` : name;
      files.push({ path, mtimeMs: info.mtimeMs, size: info.size });
      break; // one doc per directory, first match wins
    }
  }
  return files;
}

async function findProjectRoot(startDir: string): Promise<string> {
  let current = startDir;
  for (;;) {
    if (await exists(join(current, rootMarker))) return current;
    const parent = dirname(current);
    if (parent === current) return startDir; // volume root without marker: scan cwd only
    current = parent;
  }
}

function hierarchyRootToCwd(root: string, cwd: string): string[] {
  const dirs: string[] = [cwd];
  let current = cwd;
  while (current !== root) {
    const parent = dirname(current);
    if (parent === current) break; // cwd not under root: cwd only
    dirs.unshift(parent);
    current = parent;
  }
  return dirs;
}

async function statOptional(path: string) {
  try {
    return await stat(path);
  } catch {
    return undefined;
  }
}

async function exists(path: string): Promise<boolean> {
  return Boolean(await statOptional(path));
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
  // Order is fixed by the discovery walk — stable across processes.
  hash.update(JSON.stringify(files));
  return hash.digest('hex').slice(0, 12);
}
