// Iteration 9 — workspace statistics scanner (main process).
//
// Walks the workspace (same ignore rules as the search engine) and produces
// a codebase census: per-language file counts and line stats (total / code /
// comment / blank), largest files, directory weight, and TODO/FIXME counts.
// All numbers are computed with one streaming pass per file — line splitting
// happens once and every metric is derived from it.

const fs = require('node:fs/promises');
const path = require('node:path');
const { SKIP_DIRS, TEXT_EXTS } = require('./workspace-search.cjs');

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const TOP_FILES = 12;
const DEFAULT_SCAN_TIMEOUT_MS = 20_000;
const DEFAULT_FILE_OPERATION_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_FILES = 10_000;
const MAX_SCAN_TIMEOUT_MS = 120_000;
const MAX_FILE_OPERATION_TIMEOUT_MS = 10_000;
const MAX_CENSUS_FILES = 50_000;

// Extension -> canonical language name for the census table.
const LANG_BY_EXT = new Map(Object.entries({
  '.ts': 'TypeScript', '.tsx': 'TypeScript (tsx)', '.mts': 'TypeScript', '.cts': 'TypeScript',
  '.js': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript', '.jsx': 'JavaScript (jsx)',
  '.json': 'JSON', '.md': 'Markdown', '.mdx': 'Markdown',
  '.css': 'CSS', '.scss': 'SCSS', '.less': 'Less',
  '.html': 'HTML', '.htm': 'HTML', '.vue': 'Vue', '.svelte': 'Svelte',
  '.py': 'Python', '.rs': 'Rust', '.go': 'Go', '.java': 'Java',
  '.kt': 'Kotlin', '.c': 'C', '.h': 'C/C++ Header', '.cpp': 'C++', '.cc': 'C++', '.hpp': 'C++ Header',
  '.cs': 'C#', '.rb': 'Ruby', '.php': 'PHP', '.swift': 'Swift',
  '.sh': 'Shell', '.bash': 'Shell', '.ps1': 'PowerShell', '.bat': 'Batch',
  '.sql': 'SQL', '.yaml': 'YAML', '.yml': 'YAML', '.toml': 'TOML', '.xml': 'XML',
  '.tex': 'LaTeX', '.lua': 'Lua', '.r': 'R', '.pl': 'Perl',
}));

// Comment syntax families: block open/close + line prefix. C-style covers the
// vast majority; hash-style covers scripts/config; XML/HTML comment forms.
const LINE_PREFIXES = {
  cstyle: ['//'],
  hash: ['#'],
  sqlstyle: ['--'],
};
const BLOCK_PAIRS = {
  cstyle: [['/*', '*/']],
  hash: [],
  sqlstyle: [],
  markup: [['<!--', '-->']],
};

function commentFamily(language) {
  if (/^(TypeScript|JavaScript|C|C\+\+|C#|Java|Kotlin|Go|Rust|Swift|PHP|CSS|SCSS|Less|JSON|Vue|Svelte)/.test(language)) return 'cstyle';
  if (/^(Python|Shell|PowerShell|YAML|TOML|Ruby|Perl|R|Lua|Batch)/.test(language)) return 'hash';
  if (/^SQL$/.test(language)) return 'sqlstyle';
  if (/^(HTML|Markdown|XML|LaTeX)$/.test(language)) return 'markup';
  return null;
}

/** Classify one line given the block-comment state; returns the new state. */
function classifyLine(line, inBlock, family) {
  const trimmed = line.trim();
  if (!trimmed) return { kind: 'blank', inBlock };
  const prefixes = LINE_PREFIXES[family] ?? [];
  if (inBlock) {
    const pairs = BLOCK_PAIRS[family] ?? [];
    for (const [, close] of pairs) {
      const at = trimmed.indexOf(close);
      if (at >= 0) {
        const rest = trimmed.slice(at + close.length).trim();
        return { kind: rest ? 'code' : 'comment', inBlock: false };
      }
    }
    return { kind: 'comment', inBlock };
  }
  for (const prefix of prefixes) {
    if (trimmed.startsWith(prefix)) return { kind: 'comment', inBlock };
  }
  const pairs = BLOCK_PAIRS[family] ?? [];
  for (const [open, close] of pairs) {
    const at = trimmed.indexOf(open);
    if (at >= 0) {
      // Mixed line: code before the block opener counts as code.
      const closeAt = trimmed.indexOf(close, at + open.length);
      if (closeAt < 0) return { kind: at > 0 ? 'code' : 'comment', inBlock: true };
    }
  }
  return { kind: 'code', inBlock };
}

const TODO_RE = /\b(TODO|FIXME|HACK|XXX)\b[:\s]/i;

async function scanWorkspaceStats(root, resolveInside, options = {}) {
  const started = Date.now();
  const scanTimeoutMs = clampInteger(options.timeoutMs, DEFAULT_SCAN_TIMEOUT_MS, 1, MAX_SCAN_TIMEOUT_MS);
  const fileOperationTimeoutMs = clampInteger(options.fileOperationTimeoutMs, DEFAULT_FILE_OPERATION_TIMEOUT_MS, 1, MAX_FILE_OPERATION_TIMEOUT_MS);
  const maxFiles = clampInteger(options.maxFiles, DEFAULT_MAX_FILES, 1, MAX_CENSUS_FILES);
  const fileSystem = options.fs ?? fs;
  const scopeAbs = options.path ? resolveInside(options.path) : root;
  const languages = new Map(); // lang -> {files, lines, code, comment, blank}
  const dirs = new Map();      // top-level dir -> {files, bytes}
  let totalFiles = 0;
  let totalBytes = 0;
  let skippedLarge = 0;
  let truncated = false;
  let scanWarning = '';
  const todoHits = [];
  let largest = [];

  function stopIfOverBudget() {
    if (truncated) return true;
    if (totalFiles >= maxFiles) {
      truncated = true;
      scanWarning = `扫描已达到 ${maxFiles.toLocaleString()} 个文件上限，以下为部分结果。`;
      return true;
    }
    if (Date.now() - started >= scanTimeoutMs) {
      truncated = true;
      scanWarning = `扫描超过 ${scanTimeoutMs.toLocaleString()} ms 时间上限，以下为部分结果。`;
      return true;
    }
    return false;
  }

  async function withTimeout(operation, label) {
    let timer;
    try {
      return await Promise.race([
        operation(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${label} 超时`)), fileOperationTimeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function walk(dir, depth) {
    if (stopIfOverBudget()) return;
    let entries;
    try {
      entries = await withTimeout(() => fileSystem.readdir(dir, { withFileTypes: true }), '读取目录');
    } catch (error) {
      if (error instanceof Error && /超时$/.test(error.message)) {
        truncated = true;
        scanWarning = `${error.message}，以下为部分结果。`;
      }
      return;
    }
    for (const entry of entries) {
      if (stopIfOverBudget()) return;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        await walk(abs, depth + 1);
        if (truncated) return;
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!TEXT_EXTS.has(ext) && !entry.name.startsWith('.')) continue;
      let stat;
      try { stat = await withTimeout(() => fileSystem.stat(abs), '读取文件信息'); } catch (error) {
        if (error instanceof Error && /超时$/.test(error.message)) {
          truncated = true;
          scanWarning = `${error.message}，以下为部分结果。`;
          return;
        }
        continue;
      }
      if (stat.size > MAX_FILE_BYTES) { skippedLarge += 1; continue; }
      const rel = path.posix.normalize(path.relative(root, abs).split(path.sep).join('/'));
      let buffer;
      try { buffer = await withTimeout(() => fileSystem.readFile(abs), '读取文件'); } catch (error) {
        if (error instanceof Error && /超时$/.test(error.message)) {
          truncated = true;
          scanWarning = `${error.message}，以下为部分结果。`;
          return;
        }
        continue;
      }

      const language = LANG_BY_EXT.get(ext) ?? (entry.name.startsWith('.') ? 'Config' : ext.slice(1) || 'Unknown');
      const text = buffer.toString('utf8');
      const lines = text.length === 0 ? [] : text.split('\n');
      if (lines.length && lines[lines.length - 1] === '') lines.pop();
      const family = commentFamily(language);
      let inBlock = false;
      let code = 0;
      let comment = 0;
      let blank = 0;
      for (let li = 0; li < lines.length; li += 1) {
        const line = lines[li];
        if (family) {
          const res = classifyLine(line, inBlock, family);
          inBlock = res.inBlock;
          if (res.kind === 'code') code += 1;
          else if (res.kind === 'comment') comment += 1;
          else blank += 1;
        } else {
          if (!line.trim()) blank += 1; else code += 1;
        }
        if (lines.length <= 20_000 && TODO_RE.test(line)) {
          todoHits.push({ path: rel, line: li + 1, text: line.trim().slice(0, 160) });
        }
      }
      const lang = languages.get(language) ?? { files: 0, lines: 0, code: 0, comment: 0, blank: 0 };
      lang.files += 1;
      lang.lines += lines.length;
      lang.code += code;
      lang.comment += comment;
      lang.blank += blank;
      languages.set(language, lang);

      const top = rel.includes('/') ? rel.slice(0, rel.indexOf('/')) : '(root)';
      const dirEntry = dirs.get(top) ?? { files: 0, bytes: 0 };
      dirEntry.files += 1;
      dirEntry.bytes += stat.size;
      dirs.set(top, dirEntry);

      totalFiles += 1;
      totalBytes += stat.size;
      largest.push({ path: rel, bytes: stat.size, lines: lines.length });
    }
  }

  await walk(scopeAbs, 0);
  largest.sort((a, b) => b.bytes - a.bytes);

  const langRows = [...languages.entries()]
    .map(([language, s]) => ({ language, ...s }))
    .sort((a, b) => b.lines - a.lines);
  const dirRows = [...dirs.entries()]
    .map(([dir, s]) => ({ dir, ...s }))
    .sort((a, b) => b.bytes - a.bytes);

  return {
    totalFiles,
    totalBytes,
    totalLines: langRows.reduce((sum, r) => sum + r.lines, 0),
    codeLines: langRows.reduce((sum, r) => sum + r.code, 0),
    commentLines: langRows.reduce((sum, r) => sum + r.comment, 0),
    blankLines: langRows.reduce((sum, r) => sum + r.blank, 0),
    languages: langRows,
    directories: dirRows,
    largestFiles: largest.slice(0, TOP_FILES),
    todos: todoHits.slice(0, 300),
    todoCount: todoHits.length,
    skippedLarge,
    truncated,
    ...(scanWarning ? { scanWarning } : {}),
    elapsedMs: Date.now() - started,
  };
}

function clampInteger(value, fallback, min, max) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

module.exports = { scanWorkspaceStats, classifyLine, commentFamily };
