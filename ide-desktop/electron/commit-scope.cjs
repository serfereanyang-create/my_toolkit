/*
 * Commit message file scope — ported from zcode's commitMessageFileScope plus
 * a session-path extractor for this app's toolCalls records.
 *
 * The scope answers one question for commit-message generation: of all changed
 * files in the repo, which ones did THIS session actually touch? A null scope
 * (nothing useful recorded) means "no filter" rather than "no files".
 */

const { isAbsolute, relative } = require('node:path');

function normalizeGitPath(path) {
  return path.replace(/\\/g, '/');
}

function normalizeScopePath(path) {
  return normalizeGitPath(String(path).trim())
    .replace(/^\.?\//, '')
    .replace(/\/+$/, '');
}

function isRelativePathInsideScope(path) {
  const normalizedPath = normalizeGitPath(path);
  return (
    normalizedPath.length > 0 &&
    normalizedPath !== '..' &&
    !normalizedPath.startsWith('../') &&
    !isAbsolute(normalizedPath)
  );
}

function buildCommitMessageFileScope(params) {
  const sourcePaths = (params.currentSessionFilePaths ?? [])
    .map((path) => String(path ?? '').trim())
    .filter((path) => path.length > 0);
  if (sourcePaths.length === 0) return null;

  const scope = new Set();
  const workspaceInRepoPath = params.workspaceInRepoPath;

  function addCandidate(path) {
    const normalizedPath = normalizeScopePath(path);
    if (!normalizedPath) return;
    scope.add(normalizedPath);
  }

  for (const path of sourcePaths) {
    addCandidate(path);
    if (isAbsolute(path)) {
      const repoRelativePath = relative(params.repoRoot, path);
      if (isRelativePathInsideScope(repoRelativePath)) {
        addCandidate(repoRelativePath);
      }
      const workspaceRelativePath = relative(params.workspacePath, path);
      if (isRelativePathInsideScope(workspaceRelativePath)) {
        addCandidate(workspaceRelativePath);
      }
      continue;
    }
    const normalizedPath = normalizeScopePath(path);
    if (workspaceInRepoPath !== '.' && !normalizedPath.startsWith(`${workspaceInRepoPath}/`)) {
      addCandidate(`${workspaceInRepoPath}/${normalizedPath}`);
    }
  }
  return scope.size > 0 ? scope : null;
}

function filterCommitMessageFilesByCurrentSession(params) {
  const scope = buildCommitMessageFileScope({
    workspacePath: params.workspacePath,
    repoRoot: params.repoRoot,
    workspaceInRepoPath: params.workspaceInRepoPath,
    currentSessionFilePaths: params.currentSessionFilePaths,
  });
  if (!scope) return [...params.files];
  return params.files.filter((file) =>
    [file.path, file.repoRelativePath, file.workspaceRelativePath].some((path) =>
      path !== undefined && scope.has(normalizeScopePath(path)),
    ),
  );
}

// Path-like keys this app records in toolCalls[].input. Everything else in the
// input objects is skipped (queries, flags, booleans...).
const PATH_INPUT_KEYS = ['path', 'file', 'filePath', 'relativePath', 'absolutePath', 'target', 'source'];

/**
 * Collect file paths a session touched from its toolCalls records. Tool
 * results are ignored on purpose — reading a file does not make it part of a
 * commit-message scope's *intent*; but write-shaped tools always do.
 */
function extractSessionFilePaths(toolCalls = []) {
  const paths = [];
  for (const call of toolCalls) {
    if (!call || typeof call !== 'object') continue;
    const input = call.input;
    if (!input || typeof input !== 'object') continue;
    for (const key of PATH_INPUT_KEYS) {
      const value = input[key];
      if (typeof value === 'string' && value.trim() && value !== '.') {
        paths.push(value.trim());
      }
    }
  }
  return [...new Set(paths)];
}

module.exports = {
  filterCommitMessageFilesByCurrentSession,
  buildCommitMessageFileScope,
  extractSessionFilePaths,
  normalizeScopePath,
};
