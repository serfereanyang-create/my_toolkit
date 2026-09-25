/*
 * Project memory browser — port of zcode's memoryService (list + read side).
 *
 * Reads the SAME store the CLI writes: <memoriesRoot>/<workspaceId>/MEMORY.md
 * plus <workspaceId>/memory/*.md items. Read-only by design — the CLI owns
 * writes. Path handling mirrors upstream: file names are validated segments,
 * reads resolve inside the project dir and are rejected otherwise.
 */

const { lstat, readdir, readFile, realpath } = require('node:fs/promises');
const { basename, join, resolve, sep } = require('node:path');

const PROJECT_MEMORY_INDEX_FILE_NAME = 'MEMORY.md';
const PROJECT_MEMORY_DIRECTORY_NAME = 'memory';
const PROJECT_KEY_SUFFIX_PATTERN = /^(.*)-[a-f0-9]{16}$/i;

function isNotFoundError(error) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function isValidPathSegment(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value !== '.' &&
    value !== '..' &&
    basename(value) === value &&
    !value.includes('/') &&
    !value.includes('\\')
  );
}

function isProjectMemoryFileName(fileName) {
  return (
    fileName === PROJECT_MEMORY_INDEX_FILE_NAME ||
    (fileName.endsWith('.md') && fileName !== PROJECT_MEMORY_INDEX_FILE_NAME)
  );
}

function resolveWorkspaceLabel(workspaceId) {
  const slug = PROJECT_KEY_SUFFIX_PATTERN.exec(workspaceId)?.[1];
  return slug?.trim() || workspaceId;
}

async function summarizeFile(filePath, kind) {
  const stat = await lstat(filePath);
  return {
    name: basename(filePath),
    path: filePath,
    kind,
    size: stat.size,
    updatedAt: stat.mtimeMs,
  };
}

async function listProjectMemories(memoriesRoot) {
  let projectDirs;
  try {
    projectDirs = await readdir(memoriesRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const summaries = [];
  for (const entry of projectDirs) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const workspaceId = entry.name;
    const projectDir = join(memoriesRoot, workspaceId);
    const files = [];

    const indexPath = join(projectDir, PROJECT_MEMORY_INDEX_FILE_NAME);
    try {
      files.push(await summarizeFile(indexPath, 'index'));
    } catch (error) {
      if (!isNotFoundError(error)) continue;
    }

    const memoryDir = join(projectDir, PROJECT_MEMORY_DIRECTORY_NAME);
    let items;
    try {
      items = await readdir(memoryDir, { withFileTypes: true });
    } catch (error) {
      if (!isNotFoundError(error)) continue;
      items = [];
    }
    for (const item of items) {
      if (!item.isFile() || item.isSymbolicLink() || !isProjectMemoryFileName(item.name)) continue;
      try {
        files.push(await summarizeFile(join(memoryDir, item.name), 'item'));
      } catch { /* best effort */ }
    }
    if (files.length === 0) continue;
    summaries.push({
      id: workspaceId,
      label: resolveWorkspaceLabel(workspaceId),
      updatedAt: Math.max(...files.map((file) => file.updatedAt)),
      files: files.sort((a, b) => (a.kind === 'index' ? -1 : b.kind === 'index' ? 1 : a.name.localeCompare(b.name))),
    });
  }
  summaries.sort((a, b) => b.updatedAt - a.updatedAt);
  return summaries;
}

async function readProjectMemoryFile({ memoriesRoot, workspaceId, fileName }) {
  if (!isValidPathSegment(workspaceId)) {
    throw new Error(`Invalid workspace id: ${workspaceId}`);
  }
  if (!isValidPathSegment(fileName) || !isProjectMemoryFileName(fileName)) {
    throw new Error(`Invalid memory file name: ${fileName}`);
  }
  const projectDir = await realpath(join(memoriesRoot, workspaceId)).catch(() => null);
  if (!projectDir) throw new Error(`Project memory not found: ${workspaceId}`);

  // MEMORY.md lives at the project root; items inside memory/.
  const candidate = fileName === PROJECT_MEMORY_INDEX_FILE_NAME
    ? join(projectDir, fileName)
    : join(projectDir, PROJECT_MEMORY_DIRECTORY_NAME, fileName);
  const resolved = resolve(candidate);
  if (!resolved.startsWith(projectDir + sep)) {
    throw new Error(`Invalid memory file name: ${fileName}`);
  }
  const content = await readFile(resolved, 'utf-8');
  const stat = await lstat(resolved);
  return { content, updatedAt: stat.mtimeMs };
}

module.exports = {
  PROJECT_MEMORY_INDEX_FILE_NAME,
  PROJECT_MEMORY_DIRECTORY_NAME,
  listProjectMemories,
  readProjectMemoryFile,
  resolveWorkspaceLabel,
  isProjectMemoryFileName,
};
