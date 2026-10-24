/*
 * Polled file watching, with a subscriber count per path.
 *
 * Two things live here rather than inline in ipc.cjs, and both are bug fixes
 * rather than refactors:
 *
 * 1. **Refcounting.** The map was `absolutePath → interval`, and a second
 *    `watchFile` for a path already being watched returned
 *    `{ alreadyWatching: true }` without registering the new caller — while the
 *    matching `unwatchFile` cleared the interval unconditionally. So the moment
 *    two consumers wanted the same file (the editor tab and a preview pane for
 *    the same document, say), the first `unwatch` silently killed the other's
 *    notifications, and they never came back.
 *
 * 2. **Testability.** This decision — coalescing, refcounts, change detection —
 *    is exactly the kind that reads correctly and behaves wrongly, and in
 *    ipc.cjs it cannot be exercised at all (`node --test` cannot require
 *    Electron). So it is written against an injected clock.
 *
 * Polling rather than `fs.watch`: one watcher per OPEN file only, no recursive
 * native watcher spam, and identical behaviour on Windows.
 */

const DEFAULT_POLL_MS = 1200;

/**
 * @param deps.stat      async (absolutePath) => ({ mtimeMs, size }) — throws when missing
 * @param deps.onChange  (absolutePath) => void, called once per observed change
 * @param deps.setInterval / clearInterval — injected so tests drive the clock
 */
function createFileWatchRegistry({ stat, onChange, setInterval: setIntervalFn = setInterval, clearInterval: clearIntervalFn = clearInterval, pollMs = DEFAULT_POLL_MS }) {
  /** absolutePath (normalized) → { absolutePath, timer, lastMtime, lastSize, subscribers } */
  const entries = new Map();

  const keyOf = (absolutePath) => String(absolutePath).replace(/\\/g, '/').toLowerCase();

  async function probe(absolutePath) {
    const info = await stat(absolutePath);
    return { mtimeMs: info.mtimeMs, size: info.size };
  }

  function startPolling(entry) {
    entry.timer = setIntervalFn(async () => {
      try {
        const snapshot = await probe(entry.absolutePath);
        if (snapshot.mtimeMs === entry.lastMtime && snapshot.size === entry.lastSize) return;
        entry.lastMtime = snapshot.mtimeMs;
        entry.lastSize = snapshot.size;
        onChange(entry.absolutePath);
      } catch {
        // Deleted, or briefly unreadable (a temp-file rename mid-save). Keep
        // polling so the file is picked up again if it returns, and do NOT
        // report a change: a failed stat is not evidence that the file changed,
        // and reporting it would make a pane re-render on every transient lock.
      }
    }, pollMs);
    // A watch must never hold the process open on its own.
    if (typeof entry.timer?.unref === 'function') entry.timer.unref();
  }

  /**
   * Watch one path for one subscriber.
   *
   * Returns `{ ok: false, error }` for a missing file so the caller can report
   * it, but the entry is still created: the file may appear later (the agent is
   * mid-write), and a watch that silently does nothing is worse than one that
   * starts working when the file shows up.
   */
  async function watch(absolutePath) {
    const key = keyOf(absolutePath);
    const existing = entries.get(key);
    if (existing) {
      existing.subscribers += 1;
      return { ok: true, alreadyWatching: true };
    }
    let lastMtime = 0;
    let lastSize = -1;
    try {
      const snapshot = await probe(absolutePath);
      lastMtime = snapshot.mtimeMs;
      lastSize = snapshot.size;
    } catch {
      // Missing: fall through and poll anyway. `lastMtime = 0` guarantees the
      // first successful stat reports a change, so the pane fills in.
    }
    const entry = { absolutePath, timer: null, lastMtime, lastSize, subscribers: 1 };
    startPolling(entry);
    entries.set(key, entry);
    return lastSize === -1 && lastMtime === 0 ? { ok: false, error: 'file not found' } : { ok: true };
  }

  /** Drop one subscriber. The interval stops only when the last one leaves. */
  function unwatch(absolutePath) {
    const key = keyOf(absolutePath);
    const entry = entries.get(key);
    if (!entry) return { ok: true };
    entry.subscribers -= 1;
    if (entry.subscribers > 0) return { ok: true };
    if (entry.timer) clearIntervalFn(entry.timer);
    entries.delete(key);
    return { ok: true };
  }

  /** Stop everything; used on workspace switch and shutdown. */
  function stopAll() {
    for (const entry of entries.values()) {
      if (entry.timer) clearIntervalFn(entry.timer);
    }
    entries.clear();
  }

  /** Test/diagnostic view of what is being watched. */
  function watched() {
    return [...entries.values()].map((entry) => ({
      absolutePath: entry.absolutePath,
      subscribers: entry.subscribers,
    }));
  }

  return { watch, unwatch, stopAll, watched };
}

module.exports = { createFileWatchRegistry, DEFAULT_POLL_MS };
