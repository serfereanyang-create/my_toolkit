// Iteration 7 — local file save history (timeline snapshots).
//
// Every editor save records the content that was on disk *before* the save,
// so "File History" can walk back through manual edits even in projects
// without git (or between commits). Snapshots live under userData, keyed by a
// hash of the absolute file path, newest-first, capped per file.
//
// Storage layout (userData/file-history/):
//   index.json                      { "<sha1>": { path, entries: [{ ts, file, size }] } }
//   <sha1>/1700000000000.txt        the snapshot content
//
// Writes go through one serialized chain (same discipline as the snippets
// store) so two saves in the same tick can't interleave index updates.

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { renameWithRetry } = require('./atomic-file.cjs');

const MAX_SNAPSHOTS_PER_FILE = 24;
const MAX_SNAPSHOT_BYTES = 1024 * 1024; // skip history for >1 MiB saves
const INDEX_FILE = 'index.json';

function keyFor(absolutePath) {
  return crypto.createHash('sha1').update(String(absolutePath).replace(/\\/g, '/').toLowerCase()).digest('hex').slice(0, 24);
}

/** Snapshot content lands atomically: temp in the same directory, then renamed into place. */
async function writeSnapshot(snapshotPath, content) {
  const tmp = `${snapshotPath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(tmp, content, 'utf8');
  try {
    await renameWithRetry(tmp, snapshotPath);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

function createFileHistoryStore(userDataDir) {
  const baseDir = path.join(userDataDir, 'file-history');
  let chain = Promise.resolve();

  async function readIndex() {
    const indexPath = path.join(baseDir, INDEX_FILE);
    let raw;
    try {
      raw = await fs.readFile(indexPath, 'utf8');
    } catch {
      return {}; // missing: first run, nothing to preserve
    }
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      // fall through: the file is unreadable
    }
    // Returning {} is right for a read, but every mutation writes the index
    // back — which would drop the whole timeline, leaving its snapshots on disk
    // with nothing pointing at them. Keep a copy we can recover from.
    try {
      await renameWithRetry(indexPath, `${indexPath}.corrupt-${Date.now()}.json`);
    } catch { /* best effort: never fail a save over the backup copy */ }
    return {};
  }

  async function writeIndex(index) {
    await fs.mkdir(baseDir, { recursive: true });
    const tmp = path.join(baseDir, `index.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
    await fs.writeFile(tmp, JSON.stringify(index, null, 2), 'utf8');
    try {
      await renameWithRetry(tmp, path.join(baseDir, INDEX_FILE));
    } catch (error) {
      await fs.rm(tmp, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  function mutate(fn) {
    const task = chain.then(async () => {
      const index = await readIndex();
      const result = await fn(index);
      await writeIndex(index);
      return result;
    });
    chain = task.catch(() => undefined);
    return task;
  }

  /**
   * Record the pre-save content as a snapshot. Returns false when skipped
   * (unchanged vs latest, oversized, or identical bytes) — callers treat
   * history as best-effort and must never fail a save because of it.
   */
  async function recordSave(absolutePath, previousContent, savedContent) {
    if (typeof previousContent !== 'string') return false;
    if (previousContent === savedContent) return false; // no-op save
    if (Buffer.byteLength(previousContent, 'utf8') > MAX_SNAPSHOT_BYTES) return false;
    const key = keyFor(absolutePath);
    return await mutate(async (index) => {
      const entry = index[key] ?? { path: String(absolutePath).replace(/\\/g, '/'), entries: [] };
      // Newest first. Skip when the previous snapshot has identical bytes —
      // repeated saves of the same content shouldn't grow the timeline.
      if (entry.entries.length) {
        try {
          const newestAbs = path.join(baseDir, key, entry.entries[0].file);
          const newest = await fs.readFile(newestAbs, 'utf8');
          if (newest === previousContent) return false;
        } catch { /* snapshot file lost: record anyway */ }
      }
      const ts = Date.now();
      const fileName = `${ts}-${crypto.randomBytes(2).toString('hex')}.txt`;
      const snapshotPath = path.join(baseDir, key, fileName);
      await fs.mkdir(path.join(baseDir, key), { recursive: true });
      // Written through a temp file: a snapshot torn by a crash would otherwise
      // be offered as a version to restore — straight over the user's file.
      await writeSnapshot(snapshotPath, previousContent);
      entry.entries.unshift({ ts, file: fileName, size: Buffer.byteLength(previousContent, 'utf8') });
      // Prune overflow snapshots (oldest tail).
      while (entry.entries.length > MAX_SNAPSHOT_PER_FILE()) {
        const dropped = entry.entries.pop();
        fs.rm(path.join(baseDir, key, dropped.file), { force: true }).catch(() => undefined);
      }
      index[key] = entry;
      return true;
    });
  }

  // Keep the cap in one place so retention tests share the same number.
  function MAX_SNAPSHOT_PER_FILE() { return MAX_SNAPSHOTS_PER_FILE; }

  /** List snapshots (newest first) with path and size metadata. */
  async function list(absolutePath) {
    const key = keyFor(absolutePath);
    const index = await readIndex();
    const entry = index[key];
    if (!entry) return [];
    return entry.entries.map((e) => ({ ts: e.ts, size: e.size, id: e.file }));
  }

  /** Read one snapshot's content, or null when it was pruned/lost. */
  async function read(absolutePath, snapshotId) {
    const key = keyFor(absolutePath);
    const index = await readIndex();
    const entry = index[key];
    const found = entry?.entries?.find((e) => e.file === snapshotId);
    if (!found) return null;
    try {
      const content = await fs.readFile(path.join(baseDir, key, found.file), 'utf8');
      // The index already knows how big the snapshot was. A mismatch means the
      // file on disk is not the one that was recorded, and returning it would
      // hand the editor a truncated version to restore.
      if (typeof found.size === 'number' && Buffer.byteLength(content, 'utf8') !== found.size) return null;
      return content;
    } catch {
      return null;
    }
  }

  /**
   * Delete a single snapshot; returns the new list. Used by the UI's per-row
   * trash and by retention cleanup tests.
   */
  async function remove(absolutePath, snapshotId) {
    const key = keyFor(absolutePath);
    return await mutate(async (index) => {
      const entry = index[key];
      if (!entry) return [];
      const idx = entry.entries.findIndex((e) => e.file === snapshotId);
      if (idx >= 0) {
        const [dropped] = entry.entries.splice(idx, 1);
        fs.rm(path.join(baseDir, key, dropped.file), { force: true }).catch(() => undefined);
      }
      if (!entry.entries.length) delete index[key];
      return entry ? entry.entries.map((e) => ({ ts: e.ts, size: e.size, id: e.file })) : [];
    });
  }

  /** Drop the whole timeline for one file. */
  async function clear(absolutePath) {
    const key = keyFor(absolutePath);
    return await mutate(async (index) => {
      const entry = index[key];
      if (!entry) return { ok: true };
      for (const e of entry.entries) {
        fs.rm(path.join(baseDir, key, e.file), { force: true }).catch(() => undefined);
      }
      delete index[key];
      return { ok: true };
    });
  }

  /** Cross-file summary for the history browser. */
  async function listTracked() {
    const index = await readIndex();
    return Object.values(index)
      .map((entry) => ({
        path: entry.path,
        count: entry.entries.length,
        lastTs: entry.entries[0]?.ts ?? 0,
        totalBytes: entry.entries.reduce((sum, e) => sum + e.size, 0),
      }))
      .sort((a, b) => b.lastTs - a.lastTs);
  }

  return { recordSave, list, read, remove, clear, listTracked, baseDir };
}

module.exports = { createFileHistoryStore, keyFor, MAX_SNAPSHOTS_PER_FILE };
