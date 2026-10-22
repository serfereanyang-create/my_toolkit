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

function parseLedger(raw) {
  const records = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed?.at === 'string' && typeof parsed?.path === 'string' && typeof parsed?.workspace === 'string') {
        records.push({
          at: parsed.at,
          project: typeof parsed.project === 'string' ? parsed.project : path.basename(parsed.workspace),
          workspace: parsed.workspace,
          action: parsed.action === 'rename' ? 'rename' : parsed.action === 'delete' ? 'delete' : 'write',
          path: parsed.path,
          from: typeof parsed.from === 'string' ? parsed.from : undefined,
          created: parsed.created === true,
        });
      }
    } catch {
      // A half-written line from a killed process: skip, never fail the read.
    }
  }
  return records.slice(-MAX_LEDGER_RECORDS);
}

/** Group raw records into one entry per workspace, newest project first. */
function summariseProjects(records) {
  const projects = new Map();
  for (const record of records) {
    let entry = projects.get(record.workspace);
    if (!entry) {
      entry = { project: record.project, workspace: record.workspace, edits: 0, lastAt: record.at, files: new Map() };
      projects.set(record.workspace, entry);
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
      }
    } else {
      entry.files.set(record.path, {
        path: record.path,
        at: record.at,
        count: 1,
        created: record.created,
        renamed: record.action === 'rename',
        deleted: record.action === 'delete',
      });
    }
  }
  return [...projects.values()]
    .sort((a, b) => b.lastAt.localeCompare(a.lastAt))
    .map((entry) => ({
      project: entry.project,
      workspace: entry.workspace,
      edits: entry.edits,
      lastAt: entry.lastAt,
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
  try {
    records = parseLedger(await readFile(ledgerPath, 'utf8'));
  } catch (error) {
    if (!isNotFound(error)) return { ok: false, error: error instanceof Error ? error.message : String(error), root };
  }

  return {
    ok: true,
    root,
    indexPath,
    markdown,
    updatedAt,
    totalEdits: records.length,
    projects: summariseProjects(records),
    // Recent activity for the timeline strip; the full ledger stays on disk.
    records: records.slice(-200),
  };
}

module.exports = { readGlobalMemory, globalMemoryRoot };
