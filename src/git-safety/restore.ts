/**
 * restore.ts — all-or-nothing filesystem restore for Git rollback.
 *
 * The rollback path used to write file after file with no undo journal, so a
 * failure on the k-th file (read-only target, EISDIR, a device name) left the
 * workspace HALF rolled back: files 1..k-1 were at their baseline content and
 * k..N at the turn's result content, while the audit log only said
 * "rollback_failed". That is the worst state for a recovery feature — neither
 * the old tree nor the new one.
 *
 * This module applies a restore plan transactionally:
 *   1. every target's prior state is captured (bytes + mode, link target, or
 *      "absent") BEFORE it is touched;
 *   2. on the first error the journal is replayed in reverse;
 *   3. if the undo itself fails (permissions changed mid-flight), the result
 *      says so explicitly (`undoError`) instead of reporting a clean failure.
 *
 * Paths come from {@link assertRestorablePath}, so a Windows device name,
 * trailing dot/space segment or UNC form fails before any write happens.
 */

import { lstat, mkdir, readFile, readlink, rm, rmdir, symlink, writeFile, chmod } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { assertRestorablePath } from './git.js';

export type RestorePlanStep =
  | { action: 'write'; path: string; contents: Buffer; mode?: string }
  | { action: 'symlink'; path: string; contents: string; mode?: string }
  | { action: 'delete'; path: string };

export type RestorePlanResult = {
  ok: boolean;
  /** Number of steps that were fully applied. */
  applied: number;
  error?: string;
  failedPath?: string;
  /**
   * Set only when the undo pass itself failed. When present the workspace may
   * be in an intermediate state and the caller MUST surface this to the user.
   */
  undoError?: string;
};

type PriorState =
  | { kind: 'absent' }
  | { kind: 'file'; contents: Buffer; mode: number }
  | { kind: 'symlink'; target: string };

type JournalEntry = { abs: string; path: string; prior: PriorState };

export interface RestoreGuardContext {
  action: RestorePlanStep['action'];
  /** Position inside the normalized plan. */
  index: number;
  /** Path being restored, repository-relative. */
  path: string;
  /** Repository-relative paths already restored by this plan. */
  restoredPaths: ReadonlySet<string>;
  /** Repository-relative paths whose prior state has been captured. */
  capturedPaths: ReadonlySet<string>;
}

/**
 * Apply every step or none of them.
 *
 * `guard` runs before a step mutates the filesystem and may throw to abort —
 * that is how a race (another turn wrote the same file after preview) turns
 * into a clean refusal instead of a mixed tree. It also sees which paths this
 * plan will restore, so a concurrent turn can be told apart from a real
 * post-result conflict.
 */
export async function applyRestorePlan(options: {
  repositoryRoot: string;
  steps: readonly RestorePlanStep[];
  guard?: (context: RestoreGuardContext) => Promise<void> | void;
}): Promise<RestorePlanResult> {
  const root = resolve(options.repositoryRoot);
  const normalized = normalizeSteps(options.steps);
  const journal: JournalEntry[] = [];
  const createdDirs = new Set<string>();
  const planned = new Set(normalized.map((step) => step.path));
  let applied = 0;

  try {
    for (const [index, step] of normalized.entries()) {
      const abs = safeResolve(root, step.path);
      if (options.guard) {
        await options.guard({
          action: step.action,
          index,
          path: step.path,
          restoredPaths: planned,
          capturedPaths: new Set(journal.map((entry) => entry.path)),
        });
      }
      const prior = await capturePrior(abs);
      journal.push({ abs, path: step.path, prior });
      await applyStep(abs, step, createdDirs, root);
      applied += 1;
    }
  } catch (error) {
    const undo = await undoJournal(journal, createdDirs, root);
    return {
      ok: false,
      applied,
      error: errorMessage(error),
      failedPath: failingPath(error, journal),
      undoError: undo,
    };
  }

  // Success: drop directories that only existed because the turn created them.
  await pruneCreatedDirs(createdDirs);
  return { ok: true, applied };
}

/** Make a path absolute and prove (lexically) that it stays under root. */
function safeResolve(root: string, repoRelative: string): string {
  assertRestorablePath(repoRelative);
  const abs = resolve(root, repoRelative);
  const rel = relative(root, abs);
  if (rel === '' || rel.startsWith(`..${sep}`) || rel === '..' || isAbsoluteLike(rel)) {
    throw new Error(`Restore path escapes the repository: ${repoRelative}`);
  }
  return abs;
}

function isAbsoluteLike(value: string): boolean {
  return /^[A-Za-z]:/.test(value) || value.startsWith(sep) || value.startsWith('/');
}

/**
 * Later steps for the same path win, but the first occurrence keeps its
 * position so a rename's "write source, delete destination" ordering is
 * preserved. Duplicates used to be written twice; harmless for content, but
 * the second capture then recorded the *already restored* state, which made
 * the undo journal lie.
 */
function normalizeSteps(steps: readonly RestorePlanStep[]): RestorePlanStep[] {
  const byPath = new Map<string, RestorePlanStep>();
  for (const step of steps) byPath.set(step.path, step);
  return [...byPath.values()];
}

async function capturePrior(abs: string): Promise<PriorState> {
  let stats;
  try {
    stats = await lstat(abs);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' };
    throw error;
  }
  if (stats.isSymbolicLink()) {
    return { kind: 'symlink', target: await readlink(abs) };
  }
  if (stats.isFile()) {
    // Bytes, never text: a rollback must restore binary and CRLF content
    // exactly, not through a UTF-8 round trip.
    return { kind: 'file', contents: await readFile(abs), mode: stats.mode };
  }
  throw new Error(`Refusing to overwrite a non-file path: ${abs}`);
}

async function applyStep(abs: string, step: RestorePlanStep, createdDirs: Set<string>, root: string): Promise<void> {
  if (step.action === 'delete') {
    // force: a missing destination is already the desired state.
    await rm(abs, { force: true });
    return;
  }
  await ensureParent(abs, createdDirs, root);
  // Remove an existing link (or a stale symlink) first: writing through a
  // symlink would modify the link TARGET instead of replacing the link.
  const existing = await lstat(abs).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (existing) {
    if (existing.isDirectory()) throw new Error(`Cannot restore over a directory: ${abs}`);
    await rm(abs, { force: true });
  }
  if (step.action === 'symlink') {
    await symlink(step.contents, abs, 'file');
    return;
  }
  await writeFile(abs, step.contents);
  try {
    await chmod(abs, step.mode === '100755' ? 0o755 : 0o644);
  } catch {
    // Windows has no POSIX mode bits; git records the bit but cannot apply it.
  }
}

async function ensureParent(abs: string, createdDirs: Set<string>, root: string): Promise<void> {
  const parent = dirname(abs);
  const chain: string[] = [];
  let cursor = parent;
  while (true) {
    try {
      const stats = await lstat(cursor);
      if (!stats.isDirectory()) throw new Error(`Parent path is not a directory: ${cursor}`);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      chain.push(cursor);
    }
    if (cursor === root || dirname(cursor) === cursor) break;
    cursor = dirname(cursor);
  }
  for (const dir of chain.reverse()) {
    await mkdir(dir, { recursive: false });
    createdDirs.add(dir);
  }
}

async function undoJournal(journal: JournalEntry[], createdDirs: Set<string>, root: string): Promise<string | undefined> {
  const failures: string[] = [];
  for (let index = journal.length - 1; index >= 0; index -= 1) {
    const entry = journal[index]!;
    try {
      await restorePrior(entry.abs, entry.prior);
    } catch (error) {
      failures.push(`${entry.abs}: ${errorMessage(error)}`);
    }
  }
  await pruneCreatedDirs(createdDirs);
  void root;
  return failures.length > 0 ? `Could not restore ${failures.length} path(s) after the failure: ${failures.join('; ')}` : undefined;
}

async function restorePrior(abs: string, prior: PriorState): Promise<void> {
  if (prior.kind === 'absent') {
    await rm(abs, { force: true });
    return;
  }
  await mkdir(dirname(abs), { recursive: true });
  await rm(abs, { force: true });
  if (prior.kind === 'symlink') {
    await symlink(prior.target, abs, 'file');
    return;
  }
  await writeFile(abs, prior.contents);
  try {
    await chmod(abs, prior.mode & 0o777);
  } catch {
    // best effort on platforms without POSIX bits
  }
}

async function pruneCreatedDirs(createdDirs: Set<string>): Promise<void> {
  const deepestFirst = [...createdDirs].sort((left, right) => right.length - left.length);
  for (const dir of deepestFirst) {
    // rmdir only succeeds when empty, which is exactly the condition we want.
    await rmdir(dir).catch(() => undefined);
  }
}

function failingPath(error: unknown, journal: JournalEntry[]): string | undefined {
  const path = (error as NodeJS.ErrnoException | undefined)?.path;
  if (typeof path === 'string') return path;
  return journal.length > 0 ? journal[journal.length - 1]!.abs : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
