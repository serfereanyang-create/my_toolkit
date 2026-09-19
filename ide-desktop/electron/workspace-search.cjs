// Iteration 3 — workspace full-text search engine (main process).
//
// A ripgrep-flavoured content search implemented on Node fs: walks the
// workspace tree with the same ignore rules the file tree uses, reads text
// files (skipping huge/binary ones) and returns line matches with context.
// Supports case sensitivity, whole-word, regex mode, a glob include/exclude
// filter and a hard result cap so the UI never floods.

const fs = require('node:fs/promises');
const path = require('node:path');

const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', '.next', 'out', 'coverage',
  '.aicode', '.cache', '.venv', 'venv', '__pycache__', '.idea', '.vscode',
  'target', '.gradle', '.svelte-kit', '.turbo', '.parcel-cache',
]);

// Extension whitelist doubles as a binary guard: anything not obviously text
// is stat-size capped and sniffed instead.
const TEXT_EXTS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.md', '.mdx', '.css', '.scss', '.less',
  '.html', '.htm', '.xml', '.yaml', '.yml', '.toml', '.ini', '.env', '.txt', '.rs', '.go',
  '.py', '.java', '.kt', '.kts', '.c', '.h', '.cpp', '.cc', '.hpp', '.cs', '.rb', '.php',
  '.swift', '.sh', '.bash', '.zsh', '.ps1', '.bat', '.cmd', '.sql', '.graphql', '.gql',
  '.vue', '.svelte', '.astro', '.lua', '.r', '.m', '.mm', '.pl', '.tex', '.gitignore',
  '.dockerignore', '.editorconfig', '.eslintrc', '.prettierrc', '.npmrc', '.nvmrc',
]);

const MAX_FILE_BYTES = 2 * 1024 * 1024; // 2 MiB per file
const CONTEXT_LINES = 2;

// Scan budgets. A workspace can be an entire home directory (AppData, caches,
// thousands of small files); without a ceiling the walk never returns and the
// UI sits on "搜索中…" forever. Returning partial results with a flag is far
// better than an unbounded spinner — the same fix applied to the code census.
const DEFAULT_MAX_FILES = 20000;
const DEFAULT_BUDGET_MS = 15000;
const MAX_READDIR_MS = 2000;
const MAX_READFILE_MS = 2000;

/** Race a filesystem promise against a deadline; resolve to `fallback` on timeout. */
function withDeadline(promise, ms, fallback) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(fallback);
    }, ms);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Translate a simplified include/exclude glob (e.g. "*.ts" or
 * "src/ + ** + "/*.tsx", written out to keep this comment parseable)
 * into a RegExp matched against the posix relative path.
 * `**` crosses directory separators; `*` does not. Ripgrep semantics: a bare
 * filename (no slash) matches at any depth; a pattern with a slash anchors to
 * the workspace root.
 */
function globToRegExp(glob) {
  const raw = String(glob);
  // A leading slash (or any slash in the pattern) anchors to the workspace
  // root; bare filenames match at any depth.
  const anchored = raw.startsWith('/') || raw.includes('/');
  const g = raw.replace(/^\/+/, '');
  let source = '';
  for (let i = 0; i < g.length; i += 1) {
    const ch = g[i];
    if (ch === '*') {
      if (g[i + 1] === '*') {
        i += 1; // consume the second star
        if (g[i + 1] === '/') {
          i += 1; // "**/" may also match zero directories
          source += '(?:.*/)?';
        } else {
          source += '.*';
        }
      } else {
        source += '[^/]*';
      }
    } else if (ch === '?') {
      source += '[^/]';
    } else {
      source += escapeRegExp(ch);
    }
  }
  const prefix = anchored ? '' : '(?:.*/)?';
  return new RegExp(`^${prefix}${source}$`);
}

function buildMatcher(query, options) {
  const useRegex = Boolean(options.regex);
  const source = useRegex ? String(query) : escapeRegExp(String(query));
  if (useRegex) {
    try {
      new RegExp(source); // compile-check before walking the tree
    } catch (error) {
      const wrapped = new Error(`无效的正则表达式：${error.message}`);
      wrapped.code = 'BAD_REGEX';
      throw wrapped;
    }
  }
  const withBoundaries = options.wholeWord ? `\\b(?:${source})\\b` : source;
  const flags = options.caseSensitive ? 'g' : 'gi';
  return new RegExp(withBoundaries, flags);
}

/** NUL byte or a dense run of control chars => treat as binary and skip. */
function looksBinary(buffer) {
  const n = Math.min(buffer.length, 8000);
  let suspicious = 0;
  for (let i = 0; i < n; i += 1) {
    const byte = buffer[i];
    if (byte === 0) return true;
    if (byte < 9 || (byte > 13 && byte < 32)) suspicious += 1;
  }
  return n > 0 && suspicious / n > 0.3;
}

/**
 * Search workspace text files for `query`. Returns per-line matches with
 * context, scan stats and a truncation flag. `resolveInside` is the
 * workspace service path guard (must throw when a path escapes root).
 */
async function searchWorkspaceText(root, resolveInside, query, options = {}) {
  // Injectable clock so the time budget is deterministically testable; callers
  // never pass this and get the real Date.now.
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const started = now();
  const maxResults = Math.min(Math.max(1, options.maxResults || 200), 2000);
  const maxFiles = Math.min(Math.max(1, Number(options.maxFiles) || DEFAULT_MAX_FILES), 200000);
  const budgetMs = Math.min(Math.max(1, Number(options.budgetMs) || DEFAULT_BUDGET_MS), 120000);
  const deadline = started + budgetMs;
  const includeRe = options.include ? globToRegExp(options.include) : null;
  const excludeRe = options.exclude ? globToRegExp(options.exclude) : null;
  const matcher = buildMatcher(String(query || ''), options);
  const results = [];
  let filesScanned = 0;
  let truncated = false;
  let scanWarning = null;
  let skippedBinary = 0;
  let skippedLarge = 0;

  const scopeAbs = options.path ? resolveInside(options.path) : root;

  async function walk(dir) {
    if (truncated) return;
    if (now() > deadline) {
      truncated = true;
      scanWarning = `扫描超过 ${budgetMs} ms 时间上限，以下为部分结果。`;
      return;
    }
    if (filesScanned >= maxFiles) {
      truncated = true;
      scanWarning = `扫描达到 ${maxFiles} 个文件上限，以下为部分结果。`;
      return;
    }
    const entries = await withDeadline(fs.readdir(dir, { withFileTypes: true }), MAX_READDIR_MS, null);
    if (!entries) return; // unreadable or stalled directory: skip
    // Dirs first, alphabetical — stable output and top-down folder grouping.
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (truncated) return;
      if (now() > deadline) {
        truncated = true;
        scanWarning = `扫描超过 ${budgetMs} ms 时间上限，以下为部分结果。`;
        return;
      }
      if (filesScanned >= maxFiles) {
        truncated = true;
        scanWarning = `扫描达到 ${maxFiles} 个文件上限，以下为部分结果。`;
        return;
      }
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        await walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = path.posix.normalize(path.relative(root, abs).split(path.sep).join('/'));
      if (includeRe && !includeRe.test(rel)) continue;
      if (excludeRe && excludeRe.test(rel)) continue;
      const ext = path.extname(entry.name);
      // Unknown extension AND not a dotfile (like .gitignore): skip.
      if (ext && !TEXT_EXTS.has(ext) && !entry.name.startsWith('.')) continue;
      const stat = await withDeadline(fs.stat(abs), MAX_READFILE_MS, null);
      if (!stat) continue;
      if (stat.size > MAX_FILE_BYTES) { skippedLarge += 1; continue; }
      if (stat.size === 0) continue;
      const buffer = await withDeadline(fs.readFile(abs), MAX_READFILE_MS, null);
      if (!buffer) continue;
      if (looksBinary(buffer)) { skippedBinary += 1; continue; }
      filesScanned += 1;
      const lines = buffer.toString('utf8').split(/\r?\n/);
      for (let li = 0; li < lines.length; li += 1) {
        matcher.lastIndex = 0;
        const hit = matcher.exec(lines[li]);
        if (!hit) continue;
        if (results.length + 1 > maxResults) { truncated = true; break; }
        const from = Math.max(0, li - CONTEXT_LINES);
        const to = Math.min(lines.length - 1, li + CONTEXT_LINES);
        results.push({
          path: rel,
          line: li + 1,
          column: hit.index + 1,
          matched: hit[0],
          preview: lines[li],
          context: lines.slice(from, to + 1).map((content, ci) => ({
            line: from + ci + 1,
            content,
            matched: from + ci === li,
          })),
        });
      }
      if (truncated) break;
    }
  }

  await walk(scopeAbs);

  return {
    query: String(query || ''),
    options: {
      caseSensitive: Boolean(options.caseSensitive),
      wholeWord: Boolean(options.wholeWord),
      regex: Boolean(options.regex),
      include: options.include || null,
      exclude: options.exclude || null,
    },
    results,
    filesScanned,
    skippedBinary,
    skippedLarge,
    truncated,
    scanWarning,
    elapsedMs: now() - started,
  };
}

module.exports = { searchWorkspaceText, globToRegExp, looksBinary, SKIP_DIRS, TEXT_EXTS };
