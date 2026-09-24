/*
 * Workspace checkpoints — ported from zcode packages/services gitCheckpoint*.
 *
 * A checkpoint is an immutable snapshot of the workspace files, stored as a
 * hidden git ref (refs/yoycode/checkpoints/<workspaceHash>/<id>) pointing at an
 * internal commit-tree. Nothing enters the user's index, branch history, or
 * stash; the snapshot reuses git's object store so it costs nothing when files
 * are unchanged.
 *
 * Restore is a three-way operation: the caller declares the worktree should
 * still match `from`, and asks to move files to `to`. Any affected path whose
 * current blob hash deviates from `from` is reported as a conflict instead of
 * being silently overwritten, unless force=true.
 */

const { execFile } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { isAbsolute, join, resolve, sep } = require('node:path');

const REF_PREFIX = 'refs/yoycode/checkpoints';

function normalizeGitPath(path) {
  return path.replace(/\\/g, '/');
}

function workspaceKey(workspacePath) {
  const normalized = normalizeGitPath(resolve(workspacePath));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function getWorkspaceHash(workspacePath) {
  return createHash('sha256').update(workspaceKey(workspacePath)).digest('hex').slice(0, 12);
}

function normalizeWorkspaceInRepoPath(path) {
  const normalized = normalizeGitPath(path).replace(/^\.?\//, '').replace(/\/+$/, '');
  return normalized.length > 0 ? normalized : '.';
}

function toWorkspaceRelativeGitPath(repoRelativePath, workspaceInRepoPath) {
  const normalizedPath = normalizeGitPath(repoRelativePath).replace(/^\.?\//, '');
  const normalizedWorkspace = normalizeWorkspaceInRepoPath(workspaceInRepoPath);
  if (normalizedWorkspace === '.') return normalizedPath;
  if (normalizedPath === normalizedWorkspace) return '.';
  if (normalizedPath.startsWith(`${normalizedWorkspace}/`)) {
    return normalizedPath.slice(normalizedWorkspace.length + 1);
  }
  return normalizedPath;
}

function toAbsolutePath(repoRoot, repoRelativePath) {
  return resolve(repoRoot, ...normalizeGitPath(repoRelativePath).split('/'));
}

function getCheckpointRefName(workspacePath, checkpointId) {
  return `${REF_PREFIX}/${getWorkspaceHash(workspacePath)}/${checkpointId}`;
}

function getWorkspacePathspec(workspaceInRepoPath) {
  return workspaceInRepoPath === '.' ? '.' : workspaceInRepoPath;
}

function buildCheckpointEnv(tempIndexPath) {
  return {
    ...process.env,
    GIT_INDEX_FILE: tempIndexPath,
    GIT_AUTHOR_NAME: 'YOYcode Checkpoint',
    GIT_AUTHOR_EMAIL: 'checkpoint@yoycode.local',
    GIT_COMMITTER_NAME: 'YOYcode Checkpoint',
    GIT_COMMITTER_EMAIL: 'checkpoint@yoycode.local',
  };
}

function runGit(cwd, args, env) {
  return new Promise((resolvePromise) => {
    execFile('git', args, { cwd, env: env ?? process.env, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error && typeof error.code === 'number' ? error.code : (error ? 1 : 0);
      resolvePromise({ exitCode: code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

function ensureGitCommandSucceeded(label, result, allowedExitCodes = [0]) {
  if (!allowedExitCodes.includes(result.exitCode)) {
    throw new Error(`git command failed (${label}): ${result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`}`);
  }
}

async function pathExists(path) {
  try { await lstat(path); return true; } catch { return false; }
}

async function removeFileIfExists(path) {
  await rm(path, { force: true, recursive: true });
}

function mapNameStatusKind(status) {
  const normalized = status[0] ?? 'M';
  if (normalized === 'A') return 'added';
  if (normalized === 'D') return 'deleted';
  if (normalized === 'R' || normalized === 'C') return 'renamed';
  return 'modified';
}

function parseNameStatus(stdout) {
  const records = stdout.split('\0').filter((record) => record.length > 0);
  const entries = [];
  for (let index = 0; index < records.length; index += 1) {
    const status = records[index];
    const kind = mapNameStatusKind(status);
    if (kind === 'renamed') {
      const originalPath = records[index + 1] ?? null;
      const path = records[index + 2] ?? null;
      index += 2;
      if (!originalPath || !path) continue;
      entries.push({ kind, originalPath: normalizeGitPath(originalPath), path: normalizeGitPath(path) });
      continue;
    }
    const path = records[index + 1] ?? null;
    index += 1;
    if (!path) continue;
    entries.push({ kind, originalPath: null, path: normalizeGitPath(path) });
  }
  return entries;
}

function parseNumstat(stdout) {
  const records = stdout.split('\0').filter((record) => record.length > 0);
  const stats = new Map();
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const fields = record.split('\t');
    if (fields.length < 3) continue;
    const added = fields[0] === '-' ? 0 : Number.parseInt(fields[0] ?? '0', 10) || 0;
    const removed = fields[1] === '-' ? 0 : Number.parseInt(fields[1] ?? '0', 10) || 0;
    const pathField = fields.slice(2).join('\t');
    if (pathField.length > 0) {
      stats.set(normalizeGitPath(pathField), { added, removed });
      continue;
    }
    const originalPath = records[index + 1] ?? '';
    const renamedPath = records[index + 2] ?? '';
    index += 2;
    if (!renamedPath) continue;
    stats.set(normalizeGitPath(renamedPath), { added, removed });
    if (originalPath) stats.set(normalizeGitPath(originalPath), { added, removed });
  }
  return stats;
}

function parseLsTree(stdout) {
  const records = stdout.split('\0').filter((record) => record.length > 0);
  const entries = new Map();
  for (const record of records) {
    const tabIndex = record.indexOf('\t');
    if (tabIndex < 0) continue;
    const header = record.slice(0, tabIndex).split(' ');
    if (header.length < 3) continue;
    const path = normalizeGitPath(record.slice(tabIndex + 1));
    entries.set(path, { mode: header[0] ?? '100644', type: header[1] ?? 'blob', objectId: header[2] ?? '', path });
  }
  return entries;
}

async function resolveRepository(workspacePath) {
  const version = await runGit(workspacePath, ['--version']);
  if (version.exitCode !== 0) {
    throw new Error('Git binary is not available in the current environment.');
  }
  const probe = await runGit(workspacePath, ['rev-parse', '--show-toplevel']);
  if (probe.exitCode !== 0) {
    throw new Error('Workspace is not inside a Git repository.');
  }
  const repoRoot = normalizeGitPath(probe.stdout.trim());
  const rootWithSep = repoRoot.endsWith('/') ? repoRoot : `${repoRoot}/`;
  const abs = normalizeGitPath(resolve(workspacePath));
  const relative = abs.toLowerCase().startsWith(rootWithSep.toLowerCase())
    ? abs.slice(rootWithSep.length)
    : '';
  return {
    repoRoot,
    workspaceInRepoPath: normalizeWorkspaceInRepoPath(relative.length > 0 ? relative : '.'),
  };
}

async function createCheckpoint(params) {
  const resolution = await resolveRepository(params.workspacePath);
  const refName = getCheckpointRefName(params.workspacePath, params.checkpointId);
  const tempIndexRoot = params.tempIndexRootDir ?? resolve(tmpdir(), 'yoycode-checkpoint-index');
  await mkdir(tempIndexRoot, { recursive: true });
  const tempIndexDir = await mkdtemp(join(tempIndexRoot, 'index-'));
  const tempIndexPath = join(tempIndexDir, 'index');
  const env = buildCheckpointEnv(tempIndexPath);
  const pathspec = getWorkspacePathspec(resolution.workspaceInRepoPath);

  try {
    // Prime the temp index from the user's real index so unchanged files hit
    // the stat-match fast path (git add -A on a cold index hashes every file,
    // which blows past any timeout on big repos with Defender active).
    const indexPathResult = await runGit(resolution.repoRoot, ['rev-parse', '--git-path', 'index']);
    let primed = false;
    if (indexPathResult.exitCode === 0 && indexPathResult.stdout.trim().length > 0) {
      const userIndexPath = resolve(resolution.repoRoot, indexPathResult.stdout.trim());
      try { await copyFile(userIndexPath, tempIndexPath); primed = true; } catch { /* empty repo */ }
    }
    if (!primed) {
      const readTree = await runGit(resolution.repoRoot, ['read-tree', 'HEAD'], env);
      primed = readTree.exitCode === 0;
    }

    const addResult = await runGit(resolution.repoRoot, ['add', '-A', '--', pathspec], env);
    ensureGitCommandSucceeded('git add checkpoint', addResult);

    const treeResult = await runGit(resolution.repoRoot, ['write-tree'], env);
    ensureGitCommandSucceeded('git write-tree checkpoint', treeResult);

    const commitResult = await runGit(resolution.repoRoot, [
      'commit-tree', treeResult.stdout.trim(), '-m', `yoycode checkpoint ${params.checkpointId}`,
    ], env);
    ensureGitCommandSucceeded('git commit-tree checkpoint', commitResult);
    const commitOid = commitResult.stdout.trim();

    const updateRef = await runGit(resolution.repoRoot, ['update-ref', refName, commitOid]);
    ensureGitCommandSucceeded('git update-ref checkpoint', updateRef);

    return {
      checkpointId: params.checkpointId,
      workspacePath: resolve(params.workspacePath),
      repoRoot: resolution.repoRoot,
      workspaceInRepoPath: resolution.workspaceInRepoPath,
      createdAt: Date.now(),
      refName,
      commitOid,
      scope: 'workspace',
    };
  } finally {
    await rm(tempIndexDir, { recursive: true, force: true });
  }
}

async function computeCheckpointDiff(params) {
  const resolution = await resolveRepository(params.workspacePath);
  const pathspec = getWorkspacePathspec(resolution.workspaceInRepoPath);
  const [nameStatus, numstat] = await Promise.all([
    runGit(resolution.repoRoot, ['diff', '--name-status', '--find-renames', '-z', params.from.commitOid, params.to.commitOid, '--', pathspec]),
    runGit(resolution.repoRoot, ['diff', '--numstat', '--find-renames', '-z', params.from.commitOid, params.to.commitOid, '--', pathspec]),
  ]);
  ensureGitCommandSucceeded('git diff --name-status checkpoint', nameStatus);
  ensureGitCommandSucceeded('git diff --numstat checkpoint', numstat);

  const stats = parseNumstat(numstat.stdout);
  const files = parseNameStatus(nameStatus.stdout).map((entry) => {
    const stat = stats.get(entry.path) ?? stats.get(entry.originalPath ?? '') ?? { added: 0, removed: 0 };
    return {
      path: toAbsolutePath(resolution.repoRoot, entry.path),
      repoRelativePath: entry.path,
      workspaceRelativePath: toWorkspaceRelativeGitPath(entry.path, resolution.workspaceInRepoPath),
      originalPath: entry.originalPath ? toAbsolutePath(resolution.repoRoot, entry.originalPath) : null,
      kind: entry.kind,
      added: stat.added,
      removed: stat.removed,
    };
  });
  return { fromCheckpointId: params.from.checkpointId, toCheckpointId: params.to.checkpointId, files };
}

function buildAffectedRepoPaths(files) {
  const values = new Set();
  for (const file of files) {
    values.add(file.repoRelativePath);
    if (file.originalPath) values.add(file.originalPath);
  }
  return [...values];
}

function normalizeAffectedRepoPath(repoRoot, path) {
  const normalized = normalizeGitPath(isAbsolute(path) ? path.replace(`${repoRoot}${sep}`, '') : path);
  return normalized.replace(/^\.?\//, '');
}

async function collectWorkspaceConflicts(params) {
  if (params.affectedRepoPaths.length === 0) return [];
  const treeResult = await runGit(params.repoRoot, ['ls-tree', '-r', '-z', params.from.commitOid, '--', ...params.affectedRepoPaths]);
  ensureGitCommandSucceeded('git ls-tree checkpoint paths', treeResult);
  const treeEntries = parseLsTree(treeResult.stdout);

  const conflicts = [];
  for (const repoRelativePath of params.affectedRepoPaths) {
    const absolutePath = toAbsolutePath(params.repoRoot, repoRelativePath);
    const expectedEntry = treeEntries.get(repoRelativePath);

    if (!expectedEntry) {
      if (!(await pathExists(absolutePath))) continue;
      conflicts.push({ path: absolutePath, repoRelativePath, workspaceRelativePath: toWorkspaceRelativeGitPath(repoRelativePath, params.workspaceInRepoPath), reason: 'unexpected-file-in-worktree' });
      continue;
    }

    let stats;
    try {
      stats = await lstat(absolutePath);
    } catch {
      conflicts.push({ path: absolutePath, repoRelativePath, workspaceRelativePath: toWorkspaceRelativeGitPath(repoRelativePath, params.workspaceInRepoPath), reason: 'missing-in-worktree' });
      continue;
    }

    const expectsSymlink = expectedEntry.mode === '120000';
    if (stats.isDirectory() || (expectsSymlink && !stats.isSymbolicLink())) {
      conflicts.push({ path: absolutePath, repoRelativePath, workspaceRelativePath: toWorkspaceRelativeGitPath(repoRelativePath, params.workspaceInRepoPath), reason: 'type-mismatch' });
      continue;
    }

    // Compare the blob the file WOULD produce if added now (clean filters
    // applied). Upstream hashes with --no-filters, but on Windows machines
    // with core.autocrlf=true a `git restore` writes CRLF back to the disk,
    // so a raw hash would report a false conflict on every untouched file.
    const hashResult = await runGit(params.repoRoot, ['hash-object', absolutePath]);
    ensureGitCommandSucceeded('git hash-object checkpoint verify', hashResult);
    if (hashResult.stdout.trim() === expectedEntry.objectId) continue;
    conflicts.push({ path: absolutePath, repoRelativePath, workspaceRelativePath: toWorkspaceRelativeGitPath(repoRelativePath, params.workspaceInRepoPath), reason: 'content-mismatch' });
  }

  const deduped = new Map();
  for (const conflict of conflicts) deduped.set(conflict.repoRelativePath, conflict);
  return [...deduped.values()];
}

async function restoreBetweenCheckpoints(params) {
  const resolution = await resolveRepository(params.workspacePath);
  const diff = await computeCheckpointDiff({ workspacePath: params.workspacePath, from: params.from, to: params.to });
  const affectedRepoPaths = buildAffectedRepoPaths(diff.files).map((path) => normalizeAffectedRepoPath(resolution.repoRoot, path));

  if (affectedRepoPaths.length === 0) {
    return { success: true, restoredPaths: [] };
  }

  const conflicts = await collectWorkspaceConflicts({
    repoRoot: resolution.repoRoot,
    workspaceInRepoPath: resolution.workspaceInRepoPath,
    from: params.from,
    affectedRepoPaths,
  });
  if (conflicts.length > 0 && params.force !== true) {
    return { success: false, conflicts };
  }

  const restoreRepoPaths = diff.files
    .filter((file) => file.kind !== 'deleted')
    .map((file) => file.repoRelativePath);
  if (restoreRepoPaths.length > 0) {
    // Worktree only — the user's staged index must never be touched by a rollback.
    const restoreResult = await runGit(resolution.repoRoot, [
      'restore', `--source=${params.to.commitOid}`, '--worktree', '--', ...restoreRepoPaths,
    ]);
    ensureGitCommandSucceeded('git restore checkpoint', restoreResult);
  }

  const deleteAbsolutePaths = new Set();
  for (const file of diff.files) {
    if (file.kind === 'deleted') {
      deleteAbsolutePaths.add(file.path);
      continue;
    }
    if (file.kind === 'renamed' && file.originalPath) {
      deleteAbsolutePaths.add(file.originalPath);
    }
  }
  for (const path of deleteAbsolutePaths) {
    await removeFileIfExists(path);
  }

  const verifyConflicts = await collectWorkspaceConflicts({
    repoRoot: resolution.repoRoot,
    workspaceInRepoPath: resolution.workspaceInRepoPath,
    from: params.to,
    affectedRepoPaths,
  });
  if (verifyConflicts.length > 0) {
    throw new Error('Checkpoint restore verification failed.');
  }

  return { success: true, restoredPaths: diff.files.map((file) => file.path) };
}

async function deleteCheckpointRef(params) {
  const resolution = await resolveRepository(params.workspacePath);
  const deleteRef = await runGit(resolution.repoRoot, ['update-ref', '-d', params.checkpoint.refName]);
  ensureGitCommandSucceeded('git update-ref -d checkpoint', deleteRef, [0, 1]);
}

// ---------------------------------------------------------------------------
// Manifest store: one JSON file per checkpoint under <rootDir>/<workspaceHash>.
// Writes are chained per file so concurrent saves cannot interleave; content is
// replaced atomically via temp file + rename.
// ---------------------------------------------------------------------------

function createCheckpointStore(rootDir) {
  const writeChains = new Map();

  function checkpointFilePath(workspacePath, checkpointId) {
    return join(rootDir, getWorkspaceHash(workspacePath), `${checkpointId}.json`);
  }

  function enqueueWrite(filePath, operation) {
    const previous = writeChains.get(filePath) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(operation);
    const completion = result.then(() => undefined, () => undefined);
    writeChains.set(filePath, completion);
    void completion.finally(() => {
      if (writeChains.get(filePath) === completion) writeChains.delete(filePath);
    });
    return result;
  }

  function isMeta(value) {
    if (typeof value !== 'object' || value === null) return false;
    const candidate = value;
    return (
      typeof candidate.checkpointId === 'string' &&
      typeof candidate.workspacePath === 'string' &&
      typeof candidate.repoRoot === 'string' &&
      typeof candidate.workspaceInRepoPath === 'string' &&
      typeof candidate.createdAt === 'number' &&
      typeof candidate.refName === 'string' &&
      typeof candidate.commitOid === 'string' &&
      candidate.scope === 'workspace'
    );
  }

  return {
    async save(meta) {
      const filePath = checkpointFilePath(meta.workspacePath, meta.checkpointId);
      await enqueueWrite(filePath, async () => {
        await mkdir(join(filePath, '..'), { recursive: true });
        const tempPath = `${filePath}.${process.pid}.${Date.now().toString(36)}.tmp`;
        await writeFile(tempPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf-8');
        await rename(tempPath, filePath);
      });
    },
    async load(workspacePath, checkpointId) {
      try {
        const raw = await readFile(checkpointFilePath(workspacePath, checkpointId), 'utf-8');
        const parsed = JSON.parse(raw);
        return isMeta(parsed) ? parsed : null;
      } catch {
        return null;
      }
    },
    async list(workspacePath) {
      const dir = join(rootDir, getWorkspaceHash(workspacePath));
      let entries;
      try {
        entries = await readdir(dir);
      } catch {
        return [];
      }
      const metas = [];
      for (const entry of entries) {
        if (!entry.endsWith('.json')) continue;
        const meta = await this.load(workspacePath, entry.slice(0, -'.json'.length));
        if (meta) metas.push(meta);
      }
      metas.sort((a, b) => a.createdAt - b.createdAt);
      return metas;
    },
    async delete(workspacePath, checkpointId) {
      const filePath = checkpointFilePath(workspacePath, checkpointId);
      await enqueueWrite(filePath, async () => {
        await rm(filePath, { force: true });
      });
    },
  };
}

function createCheckpointBackend(options = {}) {
  const store = options.store ?? createCheckpointStore(options.storeRootDir ?? join(tmpdir(), 'yoycode-checkpoints'));

  async function loadCheckpoint(workspacePath, checkpointId) {
    const meta = await store.load(workspacePath, checkpointId);
    if (!meta) throw new Error(`Checkpoint does not exist: ${checkpointId}`);
    if (workspaceKey(meta.workspacePath) !== workspaceKey(workspacePath)) {
      throw new Error(`Checkpoint workspace mismatch: ${meta.checkpointId}`);
    }
    return meta;
  }

  function ensureComparableCheckpoints(left, right) {
    if (left.repoRoot !== right.repoRoot) throw new Error('Checkpoint repoRoot mismatch.');
    if (left.scope !== right.scope) throw new Error('Checkpoint scope mismatch.');
    if (left.workspaceInRepoPath !== right.workspaceInRepoPath) throw new Error('Checkpoint workspace scope mismatch.');
  }

  return {
    async createCheckpoint({ workspacePath }) {
      const checkpointId = randomUUID();
      const meta = await createCheckpoint({ workspacePath, checkpointId });
      await store.save(meta);
      return meta;
    },
    async listCheckpoints({ workspacePath }) {
      return store.list(workspacePath);
    },
    async diffCheckpoints({ workspacePath, fromCheckpointId, toCheckpointId }) {
      const [from, to] = await Promise.all([
        loadCheckpoint(workspacePath, fromCheckpointId),
        loadCheckpoint(workspacePath, toCheckpointId),
      ]);
      ensureComparableCheckpoints(from, to);
      return computeCheckpointDiff({ workspacePath, from, to });
    },
    async restoreBetweenCheckpoints({ workspacePath, fromCheckpointId, toCheckpointId, force }) {
      const [from, to] = await Promise.all([
        loadCheckpoint(workspacePath, fromCheckpointId),
        loadCheckpoint(workspacePath, toCheckpointId),
      ]);
      ensureComparableCheckpoints(from, to);
      return restoreBetweenCheckpoints({ workspacePath, from, to, force });
    },
    async deleteCheckpoint({ workspacePath, checkpointId }) {
      const checkpoint = await loadCheckpoint(workspacePath, checkpointId);
      await deleteCheckpointRef({ workspacePath, checkpoint });
      await store.delete(workspacePath, checkpointId);
    },
  };
}

module.exports = {
  REF_PREFIX,
  createCheckpointBackend,
  createCheckpointStore,
  getWorkspaceHash,
  getCheckpointRefName,
  resolveRepository,
  createCheckpoint,
  computeCheckpointDiff,
  restoreBetweenCheckpoints,
  parseNameStatus,
  parseNumstat,
  parseLsTree,
  buildAffectedRepoPaths,
  normalizeAffectedRepoPath,
  toWorkspaceRelativeGitPath,
};
