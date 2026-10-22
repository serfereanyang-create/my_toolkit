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
  const gitEnv = { ...process.env };
  for (const variable of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete gitEnv[variable];
  const pending = execAsync('git', ['--no-pager', '--literal-pathspecs', '-c', 'core.quotepath=false', '-c', 'color.ui=false', ...args], {
    cwd,
    env: gitEnv,
    maxBuffer: opts.maxBuffer ?? MAX_DIFF_BYTES,
    windowsHide: true,
  });
  let inputError;
  if (opts.input !== undefined) {
    pending.child.stdin.on('error', (error) => { inputError = error; });
    pending.child.stdin.end(opts.input);
  }
  const { stdout, stderr } = await pending;
  if (inputError) throw inputError;
  return { stdout: opts.preserveWhitespace ? stdout || '' : (stdout || '').trimEnd(), stderr: (stderr || '').trimEnd() };
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
    const diagnostic = err?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'Git 返回内容超过预览限制，请缩小查看范围' : stderr || message;
    return { ok: false, stdout: '', stderr, error: diagnostic };
  }
}

/**
 * Is this directory inside a git work tree? Only called on the failure path of
 * getStatus, so a healthy repo pays nothing for it.
 */
async function probeRepository(root) {
  const res = await safeGit(root, ['rev-parse', '--show-toplevel']);
  return res.ok ? { ok: true, toplevel: res.stdout } : { ok: false };
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
  const res = await safeGit(root, ['status', '--porcelain=v1', '-b', '-z', '--untracked-files=all'], { preserveWhitespace: true });
  if (!res.ok) {
    // A folder that has never been through `git init` is not a broken repo —
    // the panel offers to create one instead of repeating git's fatal message.
    const probe = await probeRepository(root);
    if (!probe.ok) return { ok: false, notRepo: true, error: '这个文件夹还不是 git 仓库' };
    return { ok: false, error: res.error };
  }

  const lines = res.stdout.split('\0');
  const branch_line = lines[0] || '';   // ## main...origin/main [ahead 1]

  // Parse branch / upstream / ahead / behind from the header
  const branchMatch = branch_line.match(/^## (.+?)(?:\.\.\.(.+?))?(?:\s+\[([^\]]+)\])?$/);
  const rawBranch = branchMatch ? branchMatch[1] : 'HEAD';
  const unborn = /^(No commits yet on |Initial commit on )/.test(rawBranch);
  const detached = rawBranch === 'HEAD (no branch)';
  const branchName = detached ? 'HEAD' : rawBranch.replace(/^(No commits yet on |Initial commit on )/, '');
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
    const originalPath = X === 'R' || X === 'C' || Y === 'R' || Y === 'C' ? lines[++i] : undefined;

    if (X === '?' && Y === '?') {
      untracked.push(filePath);
      continue;
    }
    // Conflict markers
    if ((X === 'U' || Y === 'U') || (X === 'A' && Y === 'A') || (X === 'D' && Y === 'D')) {
      hasConflicts = true;
    }
    const file = { path: filePath, index: X, working: Y, ...(originalPath ? { originalPath } : {}) };
    if (X !== ' ' && X !== '?') staged.push(file);
    if (Y !== ' ' && Y !== '?') unstaged.push(file);
  }

  return { ok: true, branch: branchName, upstream, ahead, behind, staged, unstaged, untracked, hasConflicts, unborn, detached };
}

/** Branch a brand-new repository starts on. */
const DEFAULT_INIT_BRANCH = 'main';

/**
 * Turn the workspace folder into a git repository (`git init`).
 *
 * Refused when the folder already belongs to a repository — a nested repo
 * inside a parent work tree is never what the caller meant. Nothing is staged,
 * committed or written besides the .git directory itself.
 */
async function initRepo(root, options = {}) {
  if (!root) return { ok: false, error: 'No workspace open' };
  let branch = DEFAULT_INIT_BRANCH;
  const requested = typeof options.branch === 'string' ? options.branch.trim() : '';
  if (requested) {
    try {
      branch = sanitiseBranchName(requested);
    } catch {
      return { ok: false, error: '分支名称只能包含字母、数字、点、下划线、短横线和斜杠' };
    }
  }
  const existing = await probeRepository(root);
  if (existing.ok) return { ok: false, alreadyRepo: true, error: '这个文件夹已经在 git 仓库里了', toplevel: existing.toplevel };

  let res = await safeGit(root, ['init', '-b', branch]);
  if (!res.ok) {
    // git older than 2.28 has no `init -b`; create the repo, then name HEAD.
    res = await safeGit(root, ['init']);
    if (!res.ok) return { ok: false, error: res.error };
    const head = await safeGit(root, ['symbolic-ref', 'HEAD', `refs/heads/${branch}`]);
    if (!head.ok) return { ok: false, error: head.error };
  }
  return { ok: true, branch, root };
}

/**
 * List local and remote branches.
 * Returns { ok, current: string, local: string[], remote: string[] }
 */
async function getBranches(root) {
  const [localRes, remoteRes, namesRes] = await Promise.all([
    safeGit(root, ['branch', '--format=%(refname:short)']),
    safeGit(root, ['branch', '-r', '--format=%(refname:short)']),
    safeGit(root, ['remote']),
  ]);
  if (!localRes.ok) return { ok: false, error: localRes.error };
  if (!remoteRes.ok || !namesRes.ok) return { ok: false, error: remoteRes.error || namesRes.error };

  // Find current branch
  const currentRes = await safeGit(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const symbolic = currentRes.ok ? null : await safeGit(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const current = currentRes.ok ? currentRes.stdout : symbolic?.ok ? symbolic.stdout : 'HEAD';

  const local  = localRes.stdout  ? localRes.stdout.split('\n').filter(Boolean)  : [];
  const remote = remoteRes.stdout ? remoteRes.stdout.split('\n').filter(Boolean) : [];
  const remotes = namesRes.stdout.split('\n').filter(Boolean);
  const keys = [`branch.${current}.remote`, `branch.${current}.merge`, `branch.${current}.pushRemote`, 'remote.pushDefault'];
  const values = await Promise.all(keys.map((key) => safeGit(root, ['config', '--get', key])));
  const [trackingRemote, trackingMerge, branchPush, globalPush] = values.map((value) => value.ok ? value.stdout : '');
  const knownRemote = (name) => name === '.' || remotes.includes(name);
  const trackingName = trackingMerge.startsWith('refs/heads/') ? trackingMerge.slice(11) : '';
  const trackingValid = knownRemote(trackingRemote) && trackingName && (await validateSyncBranch(root, trackingName)).ok;
  const tracking = trackingValid ? { remote: trackingRemote, branch: trackingName } : null;
  const configuredPush = branchPush || globalPush;
  const pushDefault = configuredPush ? knownRemote(configuredPush) ? configuredPush : null : tracking?.remote ?? null;
  const sync = { remotes, tracking, pushDefault, invalidTracking: Boolean((trackingRemote || trackingMerge) && !tracking), invalidPushDefault: Boolean(configuredPush && !knownRemote(configuredPush)) };
  return { ok: true, current, local, remote, sync };
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
  const res = await safeGit(root, args, { maxBuffer: MAX_DIFF_BYTES, preserveWhitespace: true });
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

function parseNumstatRecords(text) {
  const parts = text.split('\0');
  const files = [];
  for (let index = 0; index < parts.length; index += 1) {
    const record = parts[index];
    const first = record.indexOf('\t');
    const second = record.indexOf('\t', first + 1);
    if (first < 0 || second < 0) continue;
    let name = record.slice(second + 1);
    let originalPath;
    if (!name) { originalPath = parts[++index]; name = parts[++index]; }
    if (!name) continue;
    const added = Number(record.slice(0, first));
    const removed = Number(record.slice(first + 1, second));
    files.push({ path: name, added: Number.isFinite(added) ? added : 0, removed: Number.isFinite(removed) ? removed : 0, ...(originalPath ? { originalPath } : {}) });
  }
  return files;
}

function countUntrackedLines(root, relative, limit) {
  try {
    const actualRoot = fs.realpathSync(root);
    const absolute = fs.realpathSync(path.resolve(root, relative));
    const contained = path.relative(actualRoot, absolute);
    if (contained === '..' || contained.startsWith(`..${path.sep}`) || path.isAbsolute(contained)) return 0;
    const stat = fs.statSync(absolute);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) return 0;
    const buffer = fs.readFileSync(absolute);
    if (buffer.subarray(0, 8000).includes(0)) return 0;
    let lines = 0;
    for (const value of buffer) {
      if (value === 10 && ++lines >= limit) return limit;
    }
    if (buffer.length > 0 && buffer[buffer.length - 1] !== 10) lines += 1;
    return Math.min(lines, limit);
  } catch { return 0; }
}

async function getDiffStats(root) {
  const repository = await safeGit(root, ['rev-parse', '--show-toplevel']);
  if (!repository.ok) return { ok: false, error: repository.error };
  const base = repository.stdout;
  const [stagedRes, unstagedRes, untrackedRes] = await Promise.all([
    safeGit(base, ['diff', '--cached', '--numstat', '-z', '-M']),
    safeGit(base, ['diff', '--numstat', '-z', '-M']),
    safeGit(base, ['ls-files', '--others', '--exclude-standard', '-z']),
  ]);
  if (!stagedRes.ok) return { ok: false, error: stagedRes.error };

  // numstat lines: "<added>\t<removed>\t<path>" — binary files report "-".
  const parseNumstat = (text) => {
    let added = 0;
    let removed = 0;
    for (const file of parseNumstatRecords(text)) {
      added += file.added;
      removed += file.removed;
    }
    return { added, removed };
  };

  const staged = parseNumstat(stagedRes.stdout);
  const unstaged = parseNumstat(unstagedRes.stdout);

  // Untracked files contribute their whole content as "added" lines.
  // A path is only counted once even if it appears in both lists (git
  // numstat never reports untracked, but staged renames can overlap).
  let untrackedAdded = 0;
  const untrackedFiles = (untrackedRes.ok ? untrackedRes.stdout.split('\0').filter(Boolean) : [])
    .slice(0, UNTRACKED_FILE_CAP);
  let budget = UNTRACKED_LINE_CAP;
  for (const rel of untrackedFiles) {
    if (budget <= 0) break;
    const counted = countUntrackedLines(base, rel, budget);
    untrackedAdded += counted;
    budget -= counted;
  }

  const fileCount = new Set([
    ...parseNumstatRecords(stagedRes.stdout).map((file) => file.path),
    ...parseNumstatRecords(unstagedRes.stdout).map((file) => file.path),
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

  const repository = await safeGit(root, ['rev-parse', '--show-toplevel']);
  if (!repository.ok) return { ok: false, error: repository.error };
  const repoRoot = repository.stdout;
  const abs = path.resolve(repoRoot, rel);
  const workspaceRelative = path.relative(path.resolve(root), abs);
  const outsideWorkspace = workspaceRelative === '..' || workspaceRelative.startsWith(`..${path.sep}`) || path.isAbsolute(workspaceRelative);
  const pathInfo = { workspacePath: outsideWorkspace ? undefined : workspaceRelative.split(path.sep).join('/'), outsideWorkspace };
  let originalPath;
  if (staged || commitRef) {
    const summary = await safeGit(repoRoot, commitRef ? ['show', '--numstat', '-z', '-M', '--format=', commitRef] : ['diff', '--cached', '--numstat', '-z', '-M']);
    if (!summary.ok) return { ok: false, error: summary.error };
    const selected = path.relative(repoRoot, abs).split(path.sep).join('/');
    originalPath = parseNumstatRecords(summary.stdout).find((file) => file.path === selected)?.originalPath;
  }
  if (originalPath) pathInfo.originalPath = originalPath;
  const paths = [...(originalPath ? [path.resolve(repoRoot, originalPath)] : []), abs];
  const args = commitRef
    ? ['show', '-M', '--format=', commitRef, '--', ...paths]
    : staged ? ['diff', '--cached', '-M', '--', ...paths] : ['diff', '--', ...paths];

  const res = await safeGit(root, args, { maxBuffer: MAX_DIFF_BYTES, preserveWhitespace: true });
  if (!res.ok) return { ok: false, error: res.error };

  if (res.stdout.trim()) {
    return { ...pathInfo, ok: true, file: rel, diff: res.stdout, staged, untracked: false, ref: commitRef, binary: /^(Binary files .* differ|GIT binary patch)$/m.test(res.stdout) };
  }
  // A commit that did not touch the file legitimately has no diff; only look
  // for an untracked listing in the working-tree case.
  if (commitRef || staged) {
    return { ...pathInfo, ok: true, file: rel, diff: '', staged, untracked: false, ref: commitRef };
  }

  // No tracked diff: the path may be untracked, in which case show its
  // contents as additions (matching how the review list counts it).
  const untrackedRes = await safeGit(root, ['ls-files', '--others', '--exclude-standard', '--', abs]);
  if (!untrackedRes.ok || !untrackedRes.stdout.trim()) {
    return { ...pathInfo, ok: true, file: rel, diff: '', staged, untracked: false };
  }
  try {
    const actualFile = fs.realpathSync(abs);
    const actualRoot = fs.realpathSync(repoRoot);
    const relative = path.relative(actualRoot, actualFile);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      return { ok: false, error: '文件路径超出 Git 仓库范围' };
    }
    const stat = fs.statSync(actualFile);
    if (!stat.isFile()) return { ok: false, error: '所选路径不是普通文件' };
    if (stat.size > 2 * 1024 * 1024) return { ...pathInfo, ok: true, file: rel, diff: '', staged, untracked: true, truncated: true };
    const buffer = fs.readFileSync(actualFile);
    if (buffer.subarray(0, 8000).includes(0)) return { ...pathInfo, ok: true, file: rel, diff: '', staged, untracked: true, binary: true };
    const text = buffer.toString('utf8');
    if (!text) return { ...pathInfo, ok: true, file: rel, diff: '', staged, untracked: true };
    const lines = text.split(/\r?\n/);
    if (text.endsWith('\n')) lines.pop();
    const rows = [];
    let bytes = 0;
    for (const line of lines.slice(0, 2000)) {
      const size = Buffer.byteLength(line, 'utf8') + 2;
      if (bytes + size > MAX_DIFF_BYTES - 4096) break;
      rows.push(`+${line}`); bytes += size;
    }
    const truncated = rows.length < lines.length;
    const diff = rows.length ? `--- /dev/null\n+++ b/${rel}\n@@ -0,0 +1,${rows.length} @@\n${rows.join('\n')}` : '';
    return { ...pathInfo, ok: true, file: rel, diff, staged, untracked: true, truncated };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
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

  const statRes = await safeGit(root, ['show', '--numstat', '-z', '-M', '--format=', safeRef]);
  const files = statRes.ok ? parseNumstatRecords(statRes.stdout) : [];

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
 * Stage one or more repository-relative file selections.
 * Returns { ok, staged: string[] }
 */
function normaliseRepoSelection(repoRoot, paths) {
  if (!Array.isArray(paths) || paths.length === 0) return { ok: false, error: '请选择要操作的文件' };
  const selected = new Set();
  for (const value of paths) {
    if (typeof value !== 'string' || !value.trim() || value.includes('\0') || value.split(/[\\/]/).includes('..')) return { ok: false, error: '文件选择包含无效路径，操作已中止' };
    const relative = path.relative(repoRoot, path.resolve(repoRoot, value));
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return { ok: false, error: '文件选择超出当前 Git 仓库，操作已中止' };
    selected.add(relative.split(path.sep).join('/'));
  }
  return { ok: true, root: repoRoot, paths: [...selected] };
}

async function prepareRepoSelection(root, paths) {
  const repository = await safeGit(root, ['rev-parse', '--show-toplevel']);
  if (!repository.ok) return { ok: false, error: repository.error };
  return normaliseRepoSelection(repository.stdout, paths);
}

async function stage(root, paths) {
  const selection = await prepareRepoSelection(root, paths);
  if (!selection.ok) return selection;
  const res = await safeGit(selection.root, ['add', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: `${selection.paths.join('\0')}\0` });
  return res.ok ? { ok: true, staged: selection.paths } : { ok: false, error: res.error };
}

/**
 * Unstage one or more paths.
 * Returns { ok, unstaged: string[] }
 */
async function unstage(root, paths) {
  const selection = await prepareRepoSelection(root, paths);
  if (!selection.ok) return selection;
  const status = await getStatus(selection.root);
  if (!status.ok) return status;
  const originals = status.staged.filter((file) => file.index === 'R' && file.originalPath && selection.paths.includes(file.path)).map((file) => file.originalPath);
  const expanded = normaliseRepoSelection(selection.root, [...selection.paths, ...originals]);
  if (!expanded.ok) return expanded;
  const res = await safeGit(selection.root, ['reset', '-q', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: `${expanded.paths.join('\0')}\0` });
  return res.ok ? { ok: true, unstaged: expanded.paths } : { ok: false, error: res.error };
}

/**
 * Discard working-tree changes for one or more *tracked* files.
 * Irreversible — use with caution.  Untracked files are not touched.
 */
async function discardChanges(root, paths) {
  const selection = await prepareRepoSelection(root, paths);
  if (!selection.ok) return selection;
  const res = await safeGit(selection.root, ['restore', '--worktree', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: `${selection.paths.join('\0')}\0` });
  return res.ok ? { ok: true, discarded: selection.paths } : { ok: false, error: res.error };
}

/**
 * Create a commit with the given message.
 * Returns { ok, hash: string, shortHash: string, message: string }
 */
async function commit(root, message) {
  const msg = String(message || '').trim();
  if (!msg) return { ok: false, error: 'Commit message is required' };
  const res = await safeGit(root, ['commit', '-m', msg]);
  if (!res.ok) {
    // A fresh repository with no user.name/user.email fails here with a wall of
    // git advice; say what to do in one line instead.
    if (/Please tell me who you are|unable to auto-detect email|empty ident name/i.test(res.error || '')) {
      return { ok: false, error: '本机还没有配置 git 身份，先设置 user.name 与 user.email 再提交', missingIdentity: true };
    }
    return { ok: false, error: res.error };
  }
  // Extract hash from output like "[main a1b2c3d] message"
  const hashMatch = res.stdout.match(/\[.+ ([a-f0-9]+)\]/);
  const shortHash = hashMatch ? hashMatch[1] : '';
  return { ok: true, shortHash, message: msg, output: res.stdout };
}

/**
 * Push to remote.
 * Returns { ok, output: string }
 */
async function validateSyncBranch(root, name) {
  if (typeof name !== 'string' || !name || name.startsWith('-') || name === 'HEAD' || name.includes('@{') || name.includes('\0')) return { ok: false, error: '请选择有效的分支名称' };
  const result = await safeGit(root, ['check-ref-format', '--branch', name]);
  return result.ok ? { ok: true, name } : { ok: false, error: '分支名称无效，请刷新后重新选择' };
}

async function validateSyncRemote(root, name) {
  const result = await safeGit(root, ['remote']);
  if (!result.ok) return { ok: false, error: result.error };
  if (typeof name !== 'string' || !name || (name !== '.' && !result.stdout.split('\n').includes(name))) return { ok: false, error: '请选择仓库中已配置的远程名称' };
  return { ok: true, name };
}

async function push(root, remote = 'origin', branch = '', force = false, setUpstream = false) {
  const selectedRemote = await validateSyncRemote(root, remote);
  if (!selectedRemote.ok) return selectedRemote;
  if (typeof branch !== 'string') return { ok: false, error: '请选择要推送的分支' };
  const parts = branch.split(':');
  if (parts.length > 2 || !parts[0] || (parts.length === 2 && !parts[1].startsWith('refs/heads/'))) return { ok: false, error: '推送目标必须是完整的远程分支，不能删除或匹配多个分支' };
  const local = parts[0].startsWith('refs/heads/') ? parts[0].slice(11) : parts[0];
  const target = parts.length === 2 ? parts[1].slice(11) : local;
  const [localValid, targetValid] = await Promise.all([validateSyncBranch(root, local), validateSyncBranch(root, target)]);
  if (!localValid.ok || !targetValid.ok) return { ok: false, error: localValid.error || targetValid.error };
  const current = await safeGit(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (!current.ok || current.stdout !== local) return { ok: false, error: '当前分支已变化或 HEAD 已分离，请刷新后确认推送目标' };
  const exists = await safeGit(root, ['show-ref', '--verify', '--quiet', `refs/heads/${local}`]);
  if (!exists.ok) return { ok: false, error: '当前分支尚无提交，请先创建首次提交' };
  if (setUpstream) {
    const [previousRemote, previousMerge] = await Promise.all([safeGit(root, ['config', '--get', `branch.${local}.remote`]), safeGit(root, ['config', '--get', `branch.${local}.merge`])]);
    if ((previousRemote.ok || previousMerge.ok) && (previousRemote.stdout !== remote || previousMerge.stdout !== `refs/heads/${target}`)) return { ok: false, error: '分支追踪配置已变化，请刷新后重新确认' };
  }
  const args = ['push'];
  if (force) args.push('--force-with-lease');
  if (setUpstream) args.push('--set-upstream');
  args.push('--', remote, `refs/heads/${local}:refs/heads/${target}`);
  const res = await safeGit(root, args);
  return res.ok
    ? { ok: true, output: res.stdout || res.stderr }
    : { ok: false, error: res.error || res.stderr };
}

/**
 * Pull from remote.
 * Returns { ok, output: string }
 */
async function pull(root, remote = 'origin', branch = '', strategy = 'configured') {
  if (typeof branch !== 'string') return { ok: false, error: '请选择要拉取的分支' };
  const selectedRemote = await validateSyncRemote(root, remote);
  if (!selectedRemote.ok) return selectedRemote;
  const target = branch.startsWith('refs/heads/') ? branch.slice(11) : branch;
  const selectedBranch = await validateSyncBranch(root, target);
  if (!selectedBranch.ok) return selectedBranch;
  const policies = { configured: [], 'ff-only': ['--ff-only', '--no-rebase'], merge: ['--no-rebase', '--ff'], rebase: ['--rebase', '--ff'] };
  if (!Object.hasOwn(policies, strategy)) return { ok: false, error: '拉取策略无效，请重新选择' };
  const current = await safeGit(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (!current.ok) return { ok: false, error: '当前 HEAD 已分离，请先切换到本地分支' };
  const args = ['pull', '--no-edit', ...policies[strategy], '--', remote, `refs/heads/${target}`];
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
    .filter((p) => p.trim() && !p.includes('\0') && !p.split(/[\\/]/).includes('..'));
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
  const repository = await safeGit(root, ['rev-parse', '--show-toplevel']);
  if (!repository.ok) return { ok: false, error: repository.error };
  const base = repository.stdout;
  const [stagedRes, unstagedRes, untrackedRes] = await Promise.all([
    safeGit(base, ['diff', '--cached', '--numstat', '-z', '-M']),
    safeGit(base, ['diff', '--numstat', '-z', '-M']),
    safeGit(base, ['ls-files', '--others', '--exclude-standard', '-z']),
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
    for (const file of parseNumstatRecords(text)) {
      bump(file.path, file.added, file.removed, status);
      if (file.originalPath) files.get(file.path).originalPath = file.originalPath;
    }
  };
  walkNumstat(stagedRes.stdout, 'staged');
  walkNumstat(unstagedRes.stdout, 'unstaged');

  const untrackedFiles = (untrackedRes.ok ? untrackedRes.stdout.split('\0').filter(Boolean) : [])
    .slice(0, UNTRACKED_FILE_CAP);
  let budget = UNTRACKED_LINE_CAP;
  for (const rel of untrackedFiles) {
    if (budget <= 0) break;
    const counted = countUntrackedLines(base, rel, budget);
    budget -= counted;
    bump(rel, counted, 0, 'untracked');
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
  initRepo,
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
