/*
 * Global memory reader — the cross-session, cross-project edit record.
 *
 * The CLI owns the writes: <root>/edits.jsonl (append-only JSONL) and
 * <root>/MEMORY.md (index regenerated from the ledger tail). This module only
 * reads them, and it never invents an entry: a project shows up here because
 * the agent really wrote a file in it.
 *
 * Root: %USERPROFILE%\.zcode\cli\memories\global
 *       (AICODE_GLOBAL_MEMORY_ROOT overrides it, matching the CLI)
 */

const { lstat, readFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const LEDGER_FILE_NAME = 'edits.jsonl';
const INDEX_FILE_NAME = 'MEMORY.md';
/** Ledger lines read per request; the panel only ever shows the recent tail. */
const MAX_LEDGER_RECORDS = 2000;
const MAX_FILES_PER_PROJECT = 40;

function globalMemoryRoot() {
  const override = process.env.AICODE_GLOBAL_MEMORY_ROOT;
  if (typeof override === 'string' && override.trim()) return override.trim();
  return path.join(os.homedir(), '.zcode', 'cli', 'memories', 'global');
}

function isNotFound(error) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

/**
 * Parse the ledger once into both shapes the panel needs.
 *
 * `records` is only the recent tail the timeline renders, but the counts must
 * cover the whole file: aggregating from the tail alone made a project whose
 * history had scrolled past the window disappear from the panel entirely, while
 * the header above it still claimed "共 3000 次编辑". A project with 1000 older
 * edits and 30 files showed up as nothing at all.
 */
function parseLedger(raw) {
  const records = [];
  const projects = new Map();
  let total = 0;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // A half-written line from a killed process: skip, never fail the read.
      continue;
    }
    if (typeof parsed?.at !== 'string' || typeof parsed?.path !== 'string' || typeof parsed?.workspace !== 'string') continue;
    total += 1;
    const record = {
      at: parsed.at,
      project: typeof parsed.project === 'string' ? parsed.project : path.basename(parsed.workspace),
      workspace: parsed.workspace,
      action: parsed.action === 'rename' ? 'rename' : parsed.action === 'delete' ? 'delete' : 'write',
      path: parsed.path,
      from: typeof parsed.from === 'string' ? parsed.from : undefined,
      created: parsed.created === true,
    };
    records.push(record);
    accumulate(projects, record);
  }
  return { records: records.slice(-MAX_LEDGER_RECORDS), total, projects };
}

/** Fold one record into its project's running totals. */
function accumulate(projects, record) {
  const key = workspaceKey(record.workspace);
  let entry = projects.get(key);
  if (!entry) {
    entry = { project: record.project, workspace: record.workspace, edits: 0, lastAt: record.at, files: new Map() };
    projects.set(key, entry);
  }
  entry.edits += 1;
  if (record.at > entry.lastAt) entry.lastAt = record.at;
  const file = entry.files.get(record.path);
  if (file) {
    file.count += 1;
    if (record.at >= file.at) {
      file.at = record.at;
      // Only the latest action describes the file's current state.
      file.renamed = record.action === 'rename';
      file.deleted = record.action === 'delete';
      // A file that was deleted and later written again is not "新建" any more,
      // and a file created earlier and recreated now is.
      if (record.created) file.created = true;
    }
    return;
  }
  entry.files.set(record.path, {
    path: record.path,
    at: record.at,
    count: 1,
    created: record.created,
    renamed: record.action === 'rename',
    deleted: record.action === 'delete',
  });
}


/**
 * Two spellings of the same folder (trailing separator, drive-letter case) must
 * not become two projects: the ledger stores whatever the CLI was given as the
 * workspace root, so grouping has to compare loosely while still showing — and
 * opening files from — the spelling that was recorded.
 */
function workspaceKey(workspace) {
  const trimmed = workspace.replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed;
}

/** Turn the folded per-workspace totals into what the panel renders. */
function summariseProjects(projects) {
  return [...projects.values()]
    .sort((a, b) => b.lastAt.localeCompare(a.lastAt))
    .map((entry) => ({
      project: entry.project,
      workspace: entry.workspace,
      edits: entry.edits,
      lastAt: entry.lastAt,
      // True number of files touched; `files` is only the newest slice.
      fileTotal: entry.files.size,
      files: [...entry.files.values()].sort((a, b) => b.at.localeCompare(a.at)).slice(0, MAX_FILES_PER_PROJECT),
    }));
}

/**
 * Read the global memory snapshot.
 * Returns { ok, root, indexPath, markdown, updatedAt, totalEdits, projects[] }.
 * Missing files are not an error: a fresh machine simply has no history yet.
 */
async function readGlobalMemory(options = {}) {
  const root = typeof options.root === 'string' && options.root.trim() ? options.root.trim() : globalMemoryRoot();
  const indexPath = path.join(root, INDEX_FILE_NAME);
  const ledgerPath = path.join(root, LEDGER_FILE_NAME);

  let markdown = '';
  let updatedAt = 0;
  try {
    const stat = await lstat(indexPath);
    if (stat.isFile()) {
      updatedAt = stat.mtimeMs;
      markdown = await readFile(indexPath, 'utf8');
    }
  } catch (error) {
    if (!isNotFound(error)) return { ok: false, error: error instanceof Error ? error.message : String(error), root };
  }

  let records = [];
  let total = 0;
  let projects = [];
  try {
    const parsed = parseLedger(await readFile(ledgerPath, 'utf8'));
    records = parsed.records;
    total = parsed.total;
    projects = summariseProjects(parsed.projects);
  } catch (error) {
    if (!isNotFound(error)) return { ok: false, error: error instanceof Error ? error.message : String(error), root };
  }
  return {
    ok: true,
    root,
    indexPath,
    markdown,
    updatedAt,
    totalEdits: total,
    totalFiles: projects.reduce((sum, project) => sum + project.fileTotal, 0),
    projects,
    // Recent activity for the timeline strip; the full ledger stays on disk.
    records: records.slice(-200),
  };
}

module.exports = { readGlobalMemory, globalMemoryRoot };
