'use strict';
/**
 * git.cjs — lightweight Git service for the YOYcode desktop.
 *
 * All operations run via `git` CLI in the workspace root.  Every exported
 * function returns a plain-JSON-serialisable result so IPC can forward it
 * straight to the renderer without extra mapping.
 *
 * Supported operations
 * ────────────────────
 *  getStatus()       → staged / unstaged / untracked file lists + branch info
 *  getBranches()     → local + remote branch list, current branch
 *  getLog(n)         → last N commits on HEAD
 *  getDiff(staged)   → full text diff (unstaged by default, staged with flag)
 *  stage(paths[])    → git add
 *  unstage(paths[])  → git restore --staged
 *  discardChanges(p) → git restore (working-tree only, tracked files)
 *  commit(message)   → git commit -m
 *  push(remote,branch, force) → git push [--force-with-lease]
 *  pull(remote,branch)        → git pull
 *  checkout(branch)           → git checkout
 *  createBranch(name)         → git checkout -b
 *  deleteBranch(name, force)  → git branch -d / -D
 */

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs');
const path = require('node:path');

const execAsync = promisify(execFile);

// Max bytes read from stdout per call – keeps IPC payloads manageable.
const MAX_DIFF_BYTES = 512 * 1024; // 512 KB

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Run a git command in the given working directory.
 * Returns { stdout, stderr }.  Throws on non-zero exit.
 */
async function git(cwd, args, opts = {}) {
  if (!cwd) throw new Error('No workspace open');
  const { stdout, stderr } = await execAsync('git', args, {
    cwd,
    maxBuffer: opts.maxBuffer ?? MAX_DIFF_BYTES,
    windowsHide: true,
  });
  return { stdout: (stdout || '').trimEnd(), stderr: (stderr || '').trimEnd() };
}

/**
 * Like git() but returns { ok, stdout, stderr, error } and never throws,
 * so IPC handlers can always return a structured result.
 */
async function safeGit(cwd, args, opts = {}) {
  try {
    const { stdout, stderr } = await git(cwd, args, opts);
    return { ok: true, stdout, stderr };
  } catch (err) {
    const stderr = err && err.stderr ? String(err.stderr).trimEnd() : '';
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, stdout: '', stderr, error: message };
  }
}

// ── public API ────────────────────────────────────────────────────────────────

/**
 * Full workspace status: branch, ahead/behind, changed files.
 *
 * Returns:
 *  {
 *    branch: string,
 *    upstream: string | null,
 *    ahead: number,
 *    behind: number,
 *    staged: FileStatus[],
 *    unstaged: FileStatus[],
 *    untracked: string[],
 *    hasConflicts: boolean,
 *  }
 *
 * FileStatus = { path: string, index: string, working: string }
 */
async function getStatus(root) {
  // --porcelain=v1 -b gives us branch info + per-file status in one call
  const res = await safeGit(root, ['status', '--porcelain=v1', '-b', '--untracked-files=all']);
  if (!res.ok) return { ok: false, error: res.error };

  const lines = res.stdout.split('\n');
  const branch_line = lines[0] || '';   // ## main...origin/main [ahead 1]

  // Parse branch / upstream / ahead / behind from the header
  const branchMatch = branch_line.match(/^## (.+?)(?:\.\.\.(.+?))?(?:\s+\[([^\]]+)\])?$/);
  const branchName  = branchMatch ? branchMatch[1] : 'HEAD';
  const upstream    = branchMatch && branchMatch[2] ? branchMatch[2] : null;
  let ahead = 0, behind = 0;
  if (branchMatch && branchMatch[3]) {
    const aheadM  = branchMatch[3].match(/ahead (\d+)/);
    const behindM = branchMatch[3].match(/behind (\d+)/);
    if (aheadM)  ahead  = parseInt(aheadM[1], 10);
    if (behindM) behind = parseInt(behindM[1], 10);
  }

  const staged = [], unstaged = [], untracked = [];
  let hasConflicts = false;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const X = line[0];   // index status
    const Y = line[1];   // working-tree status
    const filePath = line.slice(3);

    if (X === '?' && Y === '?') {
      untracked.push(filePath);
      continue;
    }
    // Conflict markers
    if ((X === 'U' || Y === 'U') || (X === 'A' && Y === 'A') || (X === 'D' && Y === 'D')) {
      hasConflicts = true;
    }
    if (X !== ' ' && X !== '?') staged.push({ path: filePath, index: X, working: Y });
    if (Y !== ' ' && Y !== '?') unstaged.push({ path: filePath, index: X, working: Y });
  }

  return { ok: true, branch: branchName, upstream, ahead, behind, staged, unstaged, untracked, hasConflicts };
}

/**
 * List local and remote branches.
 * Returns { ok, current: string, local: string[], remote: string[] }
 */
async function getBranches(root) {
  const [localRes, remoteRes] = await Promise.all([
    safeGit(root, ['branch', '--format=%(refname:short)']),
    safeGit(root, ['branch', '-r', '--format=%(refname:short)']),
  ]);
  if (!localRes.ok) return { ok: false, error: localRes.error };

  // Find current branch
  const currentRes = await safeGit(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const current = currentRes.ok ? currentRes.stdout : 'HEAD';

  const local  = localRes.stdout  ? localRes.stdout.split('\n').filter(Boolean)  : [];
  const remote = remoteRes.stdout ? remoteRes.stdout.split('\n').filter(Boolean) : [];

  return { ok: true, current, local, remote };
}

/**
 * Last N commits on HEAD.
 * Returns { ok, commits: Commit[] }
 * Commit = { hash: string, shortHash: string, author: string, date: string, message: string }
 */
async function getLog(root, n = 20) {
  const limit = Math.max(1, Math.min(200, Number(n) || 20));
  const sep   = '\x1e';   // ASCII record separator — safe delimiter
  const fmt   = `%H${sep}%h${sep}%an${sep}%ai${sep}%s`;
  const res = await safeGit(root, ['log', `--max-count=${limit}`, `--format=${fmt}`]);
  if (!res.ok) return { ok: false, error: res.error };

  const commits = res.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash, shortHash, author, date, ...rest] = line.split(sep);
      return { hash, shortHash, author, date, message: rest.join(sep) };
    });

  return { ok: true, commits };
}

/**
 * Full text diff — staged or unstaged.
 * Returns { ok, diff: string }
 */
async function getDiff(root, staged = false) {
  const args = staged ? ['diff', '--staged'] : ['diff'];
  const res = await safeGit(root, args, { maxBuffer: MAX_DIFF_BYTES });
  if (!res.ok) return { ok: false, error: res.error };
  // Truncate if giant — caller should paginate in practice
  const text = res.stdout.length > MAX_DIFF_BYTES
    ? `${res.stdout.slice(0, MAX_DIFF_BYTES)}\n\n[diff truncated — ${res.stdout.length} bytes total]`
    : res.stdout;
  return { ok: true, diff: text };
}

/**
 * Working-tree diff line stats — the "+427 −0" badge in the Git tools card.
 *
 * Counts added/removed lines across staged changes, unstaged changes, and
 * the full contents of untracked files (matching how VS Code / Codex report
 * "changes").  Untracked counting is capped so a huge drop of binary files
 * can never stall the panel.
 *
 * Returns { ok, added, removed, fileCount }.
 */
const UNTRACKED_LINE_CAP = 200000;   // stop counting lines past this point
const UNTRACKED_FILE_CAP = 2000;     // stop enumerating untracked files past this count

async function getDiffStats(root) {
  const [stagedRes, unstagedRes, untrackedRes] = await Promise.all([
    safeGit(root, ['diff', '--cached', '--numstat']),
    safeGit(root, ['diff', '--numstat']),
    safeGit(root, ['ls-files', '--others', '--exclude-standard']),
  ]);
  if (!stagedRes.ok) return { ok: false, error: stagedRes.error };

  // numstat lines: "<added>\t<removed>\t<path>" — binary files report "-".
  const parseNumstat = (text) => {
    let added = 0;
    let removed = 0;
    for (const line of text.split('\n')) {
      if (!line) continue;
      const tab1 = line.indexOf('\t');
      if (tab1 < 0) continue;
      const tab2 = line.indexOf('\t', tab1 + 1);
      if (tab2 < 0) continue;
      const a = Number(line.slice(0, tab1));
      const r = Number(line.slice(tab1 + 1, tab2));
      if (Number.isFinite(a)) added += a;
      if (Number.isFinite(r)) removed += r;
    }
    return { added, removed };
  };

  const staged = parseNumstat(stagedRes.stdout);
  const unstaged = parseNumstat(unstagedRes.stdout);

  // Untracked files contribute their whole content as "added" lines.
  // A path is only counted once even if it appears in both lists (git
  // numstat never reports untracked, but staged renames can overlap).
  let untrackedAdded = 0;
  const untrackedFiles = (untrackedRes.ok ? untrackedRes.stdout.split('\n').filter(Boolean) : [])
    .slice(0, UNTRACKED_FILE_CAP);
  let budget = UNTRACKED_LINE_CAP;
  for (const rel of untrackedFiles) {
    if (budget <= 0) break;
    try {
      const abs = path.resolve(root, rel);
      const stat = fs.statSync(abs);
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024) continue;
      const text = fs.readFileSync(abs, 'utf8');
      // Count newline-terminated lines; a trailing final line without a
      // newline still counts as one line if non-empty.
      let n = 0;
      for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
      if (text.length > 0 && text.charCodeAt(text.length - 1) !== 10) n++;
      const capped = Math.min(n, budget);
      untrackedAdded += capped;
      budget -= capped;
    } catch { /* unreadable or vanished — skip */ }
  }

  const fileCount = new Set([
    ...stagedRes.stdout.split('\n').map((l) => l.split('\t')[2]).filter(Boolean),
    ...unstagedRes.stdout.split('\n').map((l) => l.split('\t')[2]).filter(Boolean),
    ...untrackedFiles,
  ]).size;

  return {
    ok: true,
    added: staged.added + unstaged.added + untrackedAdded,
    removed: staged.removed + unstaged.removed,
    fileCount,
  };
}

/**
 * Changed line ranges for ONE file, parsed from `git diff -U0 -- <path>`.
 * Returns { ok, file, hunks: [{ start, end, type: 'added'|'modified' }] }
 * where start/end are 1-based line numbers in the CURRENT working file.
 * Used by the editor to draw inline "agent changed these lines" highlights.
 */
async function getFileChangeRanges(root, filePath) {
  // Resolved against the repo toplevel for the same reason as getFileDiff:
  // numstat/diff paths are repo-root-relative, and the workspace may be a
  // subdirectory of the repo.
  const abs = await toRepoPath(root, filePath);
  const res = await safeGit(root, ['diff', '-U0', '--', abs]);
  if (!res.ok) return { ok: false, error: res.error };
  const hunks = [];
  const hunkRe = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;
  for (const line of res.stdout.split(/\r?\n/)) {
    const match = line.match(hunkRe);
    if (!match) continue;
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    if (count > 0) hunks.push({ start, end: start + count - 1, type: 'added' });
  }
  return { ok: true, file: filePath, hunks };
}

/**
 * Turn a repo-root-relative path into an absolute one.
 *
 * `git diff --numstat` reports paths relative to the REPOSITORY ROOT, but the
 * desktop's workspace root may be a subdirectory of that repo. Passing such a
 * path back to git unchanged resolves it against the cwd, so it points at
 * `<workspace>/<repo-relative-path>` — a path that usually does not exist, and
 * the diff comes back empty. Resolving against the real toplevel is what makes
 * a file row in the inspector open its actual diff.
 */
async function toRepoPath(root, relPath) {
  const top = await safeGit(root, ['rev-parse', '--show-toplevel']);
  const base = top.ok && top.stdout.trim() ? top.stdout.trim() : root;
  return path.resolve(base, relPath);
}

/**
 * One file's text diff, for drilling into a single row of the review list.
 *
 * `getDiff` returns the whole workspace diff, which is useless when the user
 * clicked one file. An untracked file has no diff against HEAD at all, so it
 * is rendered as an all-added listing from its contents — otherwise the row
 * would open to an empty pane.
 *
 * With `ref`, the diff is that commit's change to the file (`git show ref`),
 * which is what "what did this commit do to this file" means. Without it, the
 * diff is the working tree.
 *
 * Returns { ok, file, diff, staged, untracked, ref }.
 */
async function getFileDiff(root, filePath, staged = false, ref = '') {
  const safe = sanitisePaths([filePath]);
  if (safe.length === 0) return { ok: false, error: 'No path provided' };
  const rel = safe[0];

  const commitRef = String(ref || '').trim();
  if (commitRef && (commitRef.startsWith('-') || /\s/.test(commitRef))) {
    return { ok: false, error: 'Invalid commit ref' };
  }

  const abs = await toRepoPath(root, rel);
  const args = commitRef
    ? ['show', '--format=', commitRef, '--', abs]
    : staged ? ['diff', '--cached', '--', abs] : ['diff', '--', abs];

  const res = await safeGit(root, args, { maxBuffer: MAX_DIFF_BYTES });
  if (!res.ok) return { ok: false, error: res.error };

  if (res.stdout.trim()) {
    return { ok: true, file: rel, diff: res.stdout, staged, untracked: false, ref: commitRef };
  }
  // A commit that did not touch the file legitimately has no diff; only look
  // for an untracked listing in the working-tree case.
  if (commitRef) {
    return { ok: true, file: rel, diff: '', staged, untracked: false, ref: commitRef };
  }

  // No tracked diff: the path may be untracked, in which case show its
  // contents as additions (matching how the review list counts it).
  const untrackedRes = await safeGit(root, ['ls-files', '--others', '--exclude-standard', '--', abs]);
  if (!untrackedRes.ok || !untrackedRes.stdout.trim()) {
    return { ok: true, file: rel, diff: '', staged, untracked: false };
  }
  try {
    const stat = fs.statSync(abs);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) {
      return { ok: true, file: rel, diff: '', staged, untracked: true };
    }
    const text = fs.readFileSync(abs, 'utf8');
    const body = text.split(/\r?\n/).slice(0, 2000).map((line) => `+${line}`).join('\n');
    return { ok: true, file: rel, diff: `--- /dev/null\n+++ b/${rel}\n${body}`, staged, untracked: true };
  } catch {
    return { ok: true, file: rel, diff: '', staged, untracked: true };
  }
}

/**
 * One commit's full message, stats and changed files — the second level of
 * the inspector's drill-down (graph → commit → file).
 *
 * Returns { ok, commit: { hash, shortHash, author, date, message, body,
 * files: [{ path, added, removed }] } }.
 */
async function getCommitDetail(root, ref) {
  const safeRef = String(ref || '').trim();
  // A ref is passed to git as an argument, not a shell string, but a leading
  // dash would still be read as an option.
  if (!safeRef || safeRef.startsWith('-') || /[\s]/.test(safeRef)) {
    return { ok: false, error: 'Invalid commit ref' };
  }

  const sep = '\x1e';
  const metaRes = await safeGit(root, ['show', '--no-patch', `--format=%H${sep}%h${sep}%an${sep}%ai${sep}%s${sep}%b`, safeRef]);
  if (!metaRes.ok) return { ok: false, error: metaRes.error };
  const [hash, shortHash, author, date, subject, ...bodyParts] = metaRes.stdout.split(sep);

  const statRes = await safeGit(root, ['show', '--numstat', '--format=', safeRef]);
  const files = [];
  if (statRes.ok) {
    for (const line of statRes.stdout.split('\n')) {
      if (!line) continue;
      const tab1 = line.indexOf('\t');
      if (tab1 < 0) continue;
      const tab2 = line.indexOf('\t', tab1 + 1);
      if (tab2 < 0) continue;
      const rel = line.slice(tab2 + 1);
      if (!rel) continue;
      const a = Number(line.slice(0, tab1));
      const r = Number(line.slice(tab1 + 1, tab2));
      // Binary files report "-"; keep the row, contribute no line counts.
      files.push({ path: rel, added: Number.isFinite(a) ? a : 0, removed: Number.isFinite(r) ? r : 0 });
    }
  }

  return {
    ok: true,
    commit: {
      hash,
      shortHash,
      author,
      date,
      message: subject ?? '',
      body: bodyParts.join(sep).trim(),
      files,
    },
  };
}

/**
 * Stage one or more paths (relative to workspace root).
 * Returns { ok, staged: string[] }
 */
async function stage(root, paths) {
  const safe = sanitisePaths(paths);
  if (safe.length === 0) return { ok: false, error: 'No paths provided' };
  const res = await safeGit(root, ['add', '--', ...safe]);
  return res.ok ? { ok: true, staged: safe } : { ok: false, error: res.error };
}

/**
 * Unstage one or more paths.
 * Returns { ok, unstaged: string[] }
 */
async function unstage(root, paths) {
  const safe = sanitisePaths(paths);
  if (safe.length === 0) return { ok: false, error: 'No paths provided' };
  const res = await safeGit(root, ['restore', '--staged', '--', ...safe]);
  return res.ok ? { ok: true, unstaged: safe } : { ok: false, error: res.error };
}

/**
 * Discard working-tree changes for one or more *tracked* files.
 * Irreversible — use with caution.  Untracked files are not touched.
 */
async function discardChanges(root, paths) {
  const safe = sanitisePaths(paths);
  if (safe.length === 0) return { ok: false, error: 'No paths provided' };
  const res = await safeGit(root, ['restore', '--', ...safe]);
  return res.ok ? { ok: true, discarded: safe } : { ok: false, error: res.error };
}

/**
 * Create a commit with the given message.
 * Returns { ok, hash: string, shortHash: string, message: string }
 */
async function commit(root, message) {
  const msg = String(message || '').trim();
  if (!msg) return { ok: false, error: 'Commit message is required' };
  const res = await safeGit(root, ['commit', '-m', msg]);
  if (!res.ok) return { ok: false, error: res.error };
  // Extract hash from output like "[main a1b2c3d] message"
  const hashMatch = res.stdout.match(/\[.+ ([a-f0-9]+)\]/);
  const shortHash = hashMatch ? hashMatch[1] : '';
  return { ok: true, shortHash, message: msg, output: res.stdout };
}

/**
 * Push to remote.
 * Returns { ok, output: string }
 */
async function push(root, remote = 'origin', branch = '', force = false) {
  const args = ['push'];
  if (force) args.push('--force-with-lease');
  args.push(remote);
  if (branch) args.push(branch);
  const res = await safeGit(root, args);
  return res.ok
    ? { ok: true, output: res.stdout || res.stderr }
    : { ok: false, error: res.error || res.stderr };
}

/**
 * Pull from remote.
 * Returns { ok, output: string }
 */
async function pull(root, remote = 'origin', branch = '') {
  const args = ['pull', remote];
  if (branch) args.push(branch);
  const res = await safeGit(root, args);
  return res.ok
    ? { ok: true, output: res.stdout || res.stderr }
    : { ok: false, error: res.error || res.stderr };
}

/**
 * Checkout an existing branch.
 * Returns { ok, branch: string }
 */
async function checkout(root, branch) {
  const safe = sanitiseBranchName(branch);
  const res  = await safeGit(root, ['checkout', safe]);
  return res.ok ? { ok: true, branch: safe } : { ok: false, error: res.error || res.stderr };
}

/**
 * Create and checkout a new branch.
 * Returns { ok, branch: string }
 */
async function createBranch(root, name) {
  const safe = sanitiseBranchName(name);
  const res  = await safeGit(root, ['checkout', '-b', safe]);
  return res.ok ? { ok: true, branch: safe } : { ok: false, error: res.error || res.stderr };
}

/**
 * Delete a local branch.
 * Returns { ok, branch: string }
 */
async function deleteBranch(root, name, force = false) {
  const safe = sanitiseBranchName(name);
  const flag = force ? '-D' : '-d';
  const res  = await safeGit(root, ['branch', flag, safe]);
  return res.ok ? { ok: true, branch: safe } : { ok: false, error: res.error || res.stderr };
}

// ── security helpers ──────────────────────────────────────────────────────────

/**
 * Strip any paths that look like shell options (starting with -) or that
 * try to escape the workspace root via '..'.  The caller's `cwd` is the root
 * so relative paths are safe, but we reject anything with '..' segments.
 */
function sanitisePaths(paths) {
  if (!Array.isArray(paths)) return [];
  return paths
    .map(String)
    .filter((p) => p.trim() && !p.startsWith('-') && !p.split(/[\\/]/).includes('..'));
}

/**
 * Reject branch names with characters that could inject shell arguments.
 * Allows: alphanumeric, /, -, _, .
 */
function sanitiseBranchName(name) {
  const n = String(name || '').trim();
  if (!n || !/^[A-Za-z0-9._/-]+$/.test(n)) throw new Error(`Invalid branch name: "${name}"`);
  return n;
}

/**
 * Create a pull request using the GitHub CLI (`gh`).
 *
 * Requires `gh` to be installed and authenticated. Calls:
 *   gh pr create --title <title> --body <body> [--draft] [--base <base>]
 *
 * Returns { ok, url, number, title } on success, { ok:false, error } on failure.
 */
async function createPr(root, { title, body = '', draft = false, base = '' }) {
  const t = String(title || '').trim();
  if (!t) return { ok: false, error: '标题不能为空' };

  const args = ['pr', 'create', '--title', t, '--body', body || ''];
  if (draft) args.push('--draft');
  if (base) {
    const safeBranch = sanitiseBranchName(base);
    args.push('--base', safeBranch);
  }

  try {
    const { stdout } = await execAsync('gh', args, { cwd: root, windowsHide: true, maxBuffer: 256 * 1024 });
    const out = (stdout || '').trim();
    // `gh pr create` outputs the PR URL on the last line
    const urlMatch = out.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/);
    const numMatch = urlMatch ? urlMatch[0].match(/\/pull\/(\d+)$/) : null;
    return {
      ok: true,
      url: urlMatch ? urlMatch[0] : out,
      number: numMatch ? parseInt(numMatch[1], 10) : null,
      title: t,
      output: out,
    };
  } catch (err) {
    const stderr = err && err.stderr ? String(err.stderr).trim() : '';
    const message = err instanceof Error ? err.message : String(err);
    // Surface friendly hints for common failures
    let error = stderr || message;
    if (error.includes('not found') || error.includes('command not found') || error.includes('ENOENT')) {
      error = '未找到 gh 命令。请先安装 GitHub CLI (https://cli.github.com) 并执行 gh auth login。';
    } else if (error.includes('not logged') || error.includes('GITHUB_TOKEN') || error.includes('auth')) {
      error = '未登录 GitHub CLI。请执行 gh auth login。';
    }
    return { ok: false, error };
  }
}

/**
 * Per-file working-tree line stats — the "+97 −0" figure next to each row in
 * the review list. `getDiffStats` only totals the whole workspace, which is
 * enough for a badge but not for a file list.
 *
 * Returns { ok, files: [{ path, added, removed, status }] } where status is
 * 'staged' | 'unstaged' | 'untracked'. A path changed both staged and
 * unstaged is reported once with the two sets summed, because the reviewer
 * cares about the file's total delta.
 */
async function getFileStats(root) {
  const [stagedRes, unstagedRes, untrackedRes] = await Promise.all([
    safeGit(root, ['diff', '--cached', '--numstat']),
    safeGit(root, ['diff', '--numstat']),
    safeGit(root, ['ls-files', '--others', '--exclude-standard']),
  ]);
  if (!stagedRes.ok) return { ok: false, error: stagedRes.error };

  const files = new Map();
  const bump = (rel, added, removed, status) => {
    const existing = files.get(rel);
    if (existing) {
      existing.added += added;
      existing.removed += removed;
      // Untracked is the strongest label; otherwise keep the first seen.
      if (status === 'untracked') existing.status = 'untracked';
      return;
    }
    files.set(rel, { path: rel, added, removed, status });
  };

  // numstat: "<added>\t<removed>\t<path>". Binary files report "-", which
  // parses as NaN — count the file but contribute no lines.
  const walkNumstat = (text, status) => {
    for (const line of text.split('\n')) {
      if (!line) continue;
      const tab1 = line.indexOf('\t');
      if (tab1 < 0) continue;
      const tab2 = line.indexOf('\t', tab1 + 1);
      if (tab2 < 0) continue;
      const rel = line.slice(tab2 + 1);
      if (!rel) continue;
      const a = Number(line.slice(0, tab1));
      const r = Number(line.slice(tab1 + 1, tab2));
      bump(rel, Number.isFinite(a) ? a : 0, Number.isFinite(r) ? r : 0, status);
    }
  };
  walkNumstat(stagedRes.stdout, 'staged');
  walkNumstat(unstagedRes.stdout, 'unstaged');

  const untrackedFiles = (untrackedRes.ok ? untrackedRes.stdout.split('\n').filter(Boolean) : [])
    .slice(0, UNTRACKED_FILE_CAP);
  let budget = UNTRACKED_LINE_CAP;
  for (const rel of untrackedFiles) {
    if (budget <= 0) break;
    try {
      const abs = path.resolve(root, rel);
      const stat = fs.statSync(abs);
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024) {
        bump(rel, 0, 0, 'untracked');
        continue;
      }
      const text = fs.readFileSync(abs, 'utf8');
      let n = 0;
      for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
      if (text.length > 0 && text.charCodeAt(text.length - 1) !== 10) n++;
      const capped = Math.min(n, budget);
      budget -= capped;
      bump(rel, capped, 0, 'untracked');
    } catch {
      // Unreadable or vanished between ls-files and stat — still list it.
      bump(rel, 0, 0, 'untracked');
    }
  }

  return { ok: true, files: [...files.values()] };
}

/**
 * Commit history with parent links, for the commit graph.
 *
 * `git log --graph` draws an ASCII picture, which is unusable for a real
 * renderer: we need the DAG to lay out lanes ourselves. So request parents
 * as well and let the renderer build the lanes.
 *
 * Returns { ok, commits: [{ hash, shortHash, parents[], author, date, message }] }.
 */
async function getGraph(root, n = 60) {
  const limit = Math.max(1, Math.min(500, Number(n) || 60));
  const sep = '\x1e';
  const fmt = `%H${sep}%h${sep}%P${sep}%an${sep}%ai${sep}%s`;
  // --all so the graph shows every branch, matching what a graph view is for.
  const res = await safeGit(root, ['log', '--all', `--max-count=${limit}`, `--format=${fmt}`]);
  if (!res.ok) return { ok: false, error: res.error };

  const commits = res.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash, shortHash, parents, author, date, ...rest] = line.split(sep);
      return {
        hash,
        shortHash,
        parents: String(parents || '').split(' ').filter(Boolean),
        author,
        date,
        message: rest.join(sep),
      };
    });

  return { ok: true, commits };
}

module.exports = {
  getStatus,
  getBranches,
  getLog,
  getGraph,
  getDiff,
  getDiffStats,
  getFileStats,
  getFileDiff,
  getCommitDetail,
  getFileChangeRanges,
  stage,
  unstage,
  discardChanges,
  commit,
  push,
  pull,
  checkout,
  createBranch,
  deleteBranch,
  createPr,
};
