'use strict';
/**
 * Quick-open index: a lazily built, cached list of workspace file paths used
 * by the Ctrl+P "go to file" palette. Walks the tree with the same skip rules
 * as workspace-search, caches in memory with a TTL, and offers a small mtime
 * recency map so recently touched files rank higher on the renderer side.
 */
const fs = require('node:fs/promises');
const path = require('node:path');
const { SKIP_DIRS, TEXT_EXTS } = require('./workspace-search.cjs');

const DEFAULT_TTL_MS = 5 * 60 * 1000;   // five minutes
const DEFAULT_MAX_FILES = 20000;        // hard safety cap

/**
 * Build (or reuse) the file index for a workspace root.
 * @param {string} root workspace root (absolute)
 * @param {(rel: string) => string} resolveInside maps rel -> abs, rejects escape
 * @param {{ force?: boolean, maxFiles?: number, ttlMs?: number }} [opts]
 * @returns {Promise<{ files: Array<{path:string,mtimeMs:number}>, truncated: boolean, elapsedMs: number, cached: boolean }>}
 */
function createQuickOpenIndex(root, resolveInside, opts = {}) {
  const ttlMs = Number.isFinite(opts.ttlMs) && opts.ttlMs >= 0 ? opts.ttlMs : DEFAULT_TTL_MS;
  let cache = null; // { at: number, value: built object }
  let inflight = null;

  async function walk(relDir, out, state) {
    if (state.done) return;
    let entries;
    try {
      entries = await fs.readdir(resolveInside(relDir), { withFileTypes: true });
    } catch {
      return; // unreadable directory: skip silently
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (state.done) return;
      const rel = relDir === '.' ? entry.name : relDir + '/' + entry.name;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        await walk(rel, out, state);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase(); // TEXT_EXTS keeps the leading dot
      if (ext && !TEXT_EXTS.has(ext)) continue;
      let mtimeMs = 0;
      try {
        const st = await fs.stat(resolveInside(rel));
        mtimeMs = st.mtimeMs;
      } catch { /* keep 0 */ }
      out.push({ path: rel, mtimeMs });
      if (out.length >= state.maxFiles) {
        state.truncated = true;
        state.done = true;
        return;
      }
    }
  }

  async function build() {
    const started = Date.now();
    const maxFiles = Number.isFinite(opts.maxFiles) && opts.maxFiles > 0 ? opts.maxFiles : DEFAULT_MAX_FILES;
    const files = [];
    const state = { maxFiles, truncated: false, done: false };
    await walk('.', files, state);
    return { files, truncated: state.truncated, elapsedMs: Date.now() - started, cached: false };
  }

  async function get(force) {
    if (!force && cache && Date.now() - cache.at < ttlMs) {
      return { ...cache.value, cached: true };
    }
    if (inflight) return inflight;
    inflight = build().then((value) => {
      cache = { at: Date.now(), value };
      inflight = null;
      return value;
    }).catch((err) => {
      inflight = null;
      throw err;
    });
    return inflight;
  }

  function invalidate() { cache = null; }

  return { get, invalidate };
}

module.exports = { createQuickOpenIndex };
