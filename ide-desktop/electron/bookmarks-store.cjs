// Iteration 6 — line bookmarks (main process persistence).
//
// Bookmarks are stored per workspace under the existing sidecar pattern used
// for session metadata: one JSON file in .aicode, never touched by the CLI.
// Each record keeps the line number AND a text anchor (the trimmed line
// content) so bookmarks can be re-applied after edits shift lines around —
// the same trick editors use for "sticky" breakpoints.
//
// Concurrency: all mutations go through a serialized promise chain, so two
// rapid toggles can't interleave read-modify-write and lose one.

const path = require('node:path');
const { createJsonStore } = require('./json-store.cjs');

const MAX_BOOKMARKS_PER_FILE = 200;
const MAX_FILES = 500;

function normalizeLine(line) {
  const n = Math.floor(Number(line));
  if (!Number.isFinite(n) || n < 1) return null;
  return n;
}

function sanitizeRelPath(relPath) {
  const s = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!s) return null;
  // Reject traversal segments outright — this is a display key, never a real
  // filesystem path here, so a clean reject beats silent normalization.
  if (s.split('/').some((seg) => seg === '..')) return null;
  return s.slice(0, 500);
}

function createBookmarkStore(workspaceProvider) {
  function storeFile() {
    const root = workspaceProvider();
    if (!root) throw new Error('No workspace open');
    return path.join(root, '.aicode', 'desktop', 'bookmarks.json');
  }

  // Durable plumbing (atomic replace, rename retry, corrupt-file quarantine,
  // serialized mutations) lives in json-store.cjs; this file only decides what
  // a bookmark record looks like.
  const store = createJsonStore({ file: storeFile, normalize: shapeAll });

  function shapeAll(parsed) {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    // Defensively re-shape every entry: unknown files or malformed records
    // are dropped rather than propagated to the renderer.
    const out = {};
    for (const [key, value] of Object.entries(parsed)) {
      const rel = sanitizeRelPath(key);
      if (!rel || !Array.isArray(value)) continue;
      const items = [];
      for (const entry of value) {
        const line = normalizeLine(entry?.line);
        if (line === null) continue;
        items.push({
          line,
          anchor: String(entry?.anchor ?? '').slice(0, 240),
          note: String(entry?.note ?? '').slice(0, 500),
          createdAt: String(entry?.createdAt ?? ''),
        });
        if (items.length >= MAX_BOOKMARKS_PER_FILE) break;
      }
      if (items.length) out[rel] = items;
      if (Object.keys(out).length >= MAX_FILES) break;
    }
    return out;
  }

  const readAll = () => store.read();
  const mutate = (fn) => store.mutate(fn);

  /** Snapshot for a single file, sorted by line. */
  async function listFor(relPath) {
    const rel = sanitizeRelPath(relPath);
    const data = await readAll();
    return rel && Array.isArray(data[rel]) ? [...data[rel]].sort((a, b) => a.line - b.line) : [];
  }

  /** Whole-workspace snapshot grouped by path, for the jump list UI. */
  async function listAll() {
    const data = await readAll();
    return Object.entries(data)
      .map(([rel, items]) => ({ path: rel, bookmarks: [...items].sort((a, b) => a.line - b.line) }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Toggle a bookmark at a line; `anchor` records the line text for drift. */
  async function toggle(relPath, line, anchor) {
    const rel = sanitizeRelPath(relPath);
    const n = normalizeLine(line);
    if (!rel || n === null) throw new Error('Invalid bookmark target');
    return await mutate(async (data) => {
      const items = Array.isArray(data[rel]) ? data[rel] : [];
      const idx = items.findIndex((b) => b.line === n);
      if (idx >= 0) {
        items.splice(idx, 1);
        if (!items.length) delete data[rel];
        return { ok: true, path: rel, line: n, marked: false };
      }
      if (items.length >= MAX_BOOKMARKS_PER_FILE) throw new Error('单文件书签数量已达上限');
      items.push({
        line: n,
        anchor: String(anchor ?? '').trim().slice(0, 240),
        note: '',
        createdAt: new Date().toISOString(),
      });
      data[rel] = items;
      if (Object.keys(data).length > MAX_FILES) {
        throw new Error('书签文件数量已达上限，请先清理');
      }
      return { ok: true, path: rel, line: n, marked: true, count: items.length };
    });
  }

  /** Attach a user note to an existing bookmark. */
  async function annotate(relPath, line, note) {
    const rel = sanitizeRelPath(relPath);
    const n = normalizeLine(line);
    if (!rel || n === null) throw new Error('Invalid bookmark target');
    return await mutate(async (data) => {
      const items = data[rel];
      const found = Array.isArray(items) ? items.find((b) => b.line === n) : null;
      if (!found) throw new Error('书签不存在');
      found.note = String(note ?? '').slice(0, 500);
      return found;
    });
  }

  /** Move a bookmark to a new line (drag in the gutter). */
  async function move(relPath, fromLine, toLine) {
    const rel = sanitizeRelPath(relPath);
    const from = normalizeLine(fromLine);
    const to = normalizeLine(toLine);
    if (!rel || from === null || to === null || from === to) throw new Error('Invalid move');
    return await mutate(async (data) => {
      const items = data[rel];
      const found = Array.isArray(items) ? items.find((b) => b.line === from) : null;
      if (!found) throw new Error('书签不存在');
      if (items.some((b) => b.line === to)) throw new Error('目标行已有书签');
      found.line = to;
      return found;
    });
  }

  async function remove(relPath, line) {
    const rel = sanitizeRelPath(relPath);
    const n = normalizeLine(line);
    if (!rel || n === null) throw new Error('Invalid bookmark target');
    return await mutate(async (data) => {
      const items = data[rel];
      if (!Array.isArray(items)) return { ok: false };
      const idx = items.findIndex((b) => b.line === n);
      if (idx < 0) return { ok: false };
      items.splice(idx, 1);
      if (!items.length) delete data[rel];
      return { ok: true };
    });
  }

  async function clearFile(relPath) {
    const rel = sanitizeRelPath(relPath);
    if (!rel) throw new Error('Invalid path');
    return await mutate(async (data) => {
      delete data[rel];
      return { ok: true };
    });
  }

  return { listFor, listAll, toggle, annotate, move, remove, clearFile, readAll };
}

module.exports = { createBookmarkStore, sanitizeRelPath, normalizeLine };
