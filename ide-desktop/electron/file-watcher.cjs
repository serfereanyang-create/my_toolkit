/*
 * Debounced workspace file watcher — ported from zcode's fileWatcherService.
 *
 * Raw fs events arrive in bursts (editors save via temp-file rename, git
 * checkouts touch hundreds of files). Callers get one coalesced batch per
 * quiet period, with ignored directories filtered out at the chokidar level.
 */

const chokidar = require('chokidar');
const { relative } = require('node:path');
const { IGNORED_DIRS } = require('./file-search.cjs');

function isIgnored(rootPath, absolutePath) {
  const rel = relative(rootPath, absolutePath).replace(/\\/g, '/');
  if (!rel || rel.startsWith('..')) return true;
  const segments = rel.split('/');
  if (segments.length === 1 && segments[0].startsWith('.')) return true; // root dotfiles
  return segments.some((segment) => IGNORED_DIRS.has(segment));
}

function createWorkspaceFileWatcher(options = {}) {
  const rootPath = options.rootPath;
  const debounceMs = options.debounceMs ?? 300;
  let watcher = null;
  let readyPromise = Promise.resolve();
  let pending = new Map(); // absolutePath -> latest event kind
  let timer = null;
  const listeners = new Set();

  function flush() {
    timer = null;
    if (pending.size === 0) return;
    const batch = [...pending.entries()].map(([path, kind]) => ({
      path,
      relativePath: relative(rootPath, path).replace(/\\/g, '/'),
      kind,
    }));
    pending = new Map();
    for (const listener of listeners) {
      try { listener({ changed: batch }); } catch { /* listener errors are isolated */ }
    }
  }

  function mark(kind) {
    return (absolutePath) => {
      if (isIgnored(rootPath, absolutePath)) return;
      pending.set(absolutePath, kind);
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, debounceMs);
    };
  }

  return {
    start() {
      if (watcher) return readyPromise;
      watcher = chokidar.watch(rootPath, {
        ignoreInitial: true,
        depth: 12,
        awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 60 },
      });
      readyPromise = new Promise((resolvePromise) => watcher.once('ready', resolvePromise));
      watcher.on('add', mark('added'));
      watcher.on('change', mark('modified'));
      watcher.on('unlink', mark('deleted'));
      watcher.on('addDir', mark('added'));
      watcher.on('unlinkDir', mark('deleted'));
      return readyPromise;
    },
    async stop() {
      if (timer) { clearTimeout(timer); timer = null; }
      pending = new Map();
      if (watcher) {
        const closing = watcher.close();
        watcher = null;
        await closing;
      }
    },
    onBatch(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

module.exports = { createWorkspaceFileWatcher, isIgnored };
