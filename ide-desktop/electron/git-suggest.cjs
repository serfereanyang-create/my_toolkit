/*
 * Commit message suggestion — composes the ported pieces (commitMessageFileScope
 * filter + heuristic generator) on top of `git status` output. Pure and
 * testable: the caller supplies status/numstat; this module never runs git.
 */

const { execFile } = require('node:child_process');
const { extractSessionFilePaths, filterCommitMessageFilesByCurrentSession } = require('./commit-scope.cjs');
const { generateHeuristicCommitMessage } = require('./commit-message.cjs');
const { parseNumstat } = require('./checkpoints.cjs');

function kindFromStatus(entry, untracked) {
  if (untracked) return 'added';
  const code = (entry.index && entry.index !== ' ') ? entry.index : entry.working;
  if (code === 'A') return 'added';
  if (code === 'D') return 'deleted';
  if (code === 'R' || code === 'C') return 'renamed';
  return 'modified';
}

function buildChangedFiles(status, numstat) {
  const files = [];
  const seen = new Set();
  function push(entry, { untracked = false } = {}) {
    const repoRelativePath = String(entry.path ?? entry).replace(/\\/g, '/');
    if (!repoRelativePath || seen.has(repoRelativePath)) return;
    seen.add(repoRelativePath);
    const stat = numstat.get(repoRelativePath) ?? { added: 0, removed: 0 };
    files.push({
      path: repoRelativePath,
      repoRelativePath,
      workspaceRelativePath: repoRelativePath,
      kind: kindFromStatus(entry, untracked),
      added: stat.added,
      removed: stat.removed,
    });
  }
  for (const entry of status.staged ?? []) push(entry);
  for (const entry of status.unstaged ?? []) push(entry);
  for (const path of status.untracked ?? []) push(path, { untracked: true });
  return files;
}

/** `git diff HEAD --numstat -z` → Map<path, {added, removed}> (covers staged+unstaged). */
function collectNumstat(root) {
  return new Promise((resolvePromise) => {
    execFile('git', ['diff', 'HEAD', '--numstat', '-z'], { cwd: root, maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => {
      resolvePromise(error ? new Map() : parseNumstat(String(stdout ?? '')));
    });
  });
}

function suggestCommitMessage({ status, numstat, toolCalls, workspacePath, repoRoot, workspaceInRepoPath }) {
  const allFiles = buildChangedFiles(status, numstat ?? new Map());
  const sessionPaths = extractSessionFilePaths(toolCalls ?? []);
  const scopedFiles = filterCommitMessageFilesByCurrentSession({
    files: allFiles,
    workspacePath,
    repoRoot,
    workspaceInRepoPath,
    currentSessionFilePaths: sessionPaths,
  });
  const message = generateHeuristicCommitMessage({ files: scopedFiles });
  return {
    ...message,
    changedFileCount: allFiles.length,
    scopedFileCount: scopedFiles.length,
    sessionFileCount: sessionPaths.length,
  };
}

module.exports = { buildChangedFiles, collectNumstat, suggestCommitMessage, kindFromStatus };
